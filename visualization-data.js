"use strict";

// Reines Datenmodell ohne DOM/BLE: strikter Bike-EKG-CSV-Parser und Suchindex.
// times sind relativ zum ersten Wert in Sekunden, values bleiben ADC-Counts.

// Shared by the CSV worker, the canvas viewer and the Node tests.
const EkgCsv = (() => {
  const MAX_BYTES = 256 * 1024 * 1024;
  const MAX_SAMPLES = 3000000;
  const BLOCK = 64;

  function* lines(text) {
    let start = text.charCodeAt(0) === 0xFEFF ? 1 : 0, number = 1;
    while (start < text.length) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = text.length;
      yield { text: text.slice(start, end).trim(), number: number++ };
      start = end + 1;
    }
  }

  function parse(text) {
    // Zwei Durchläufe: erst Größe/Metadaten, dann exakt dimensionierte Zahlenarrays.
    // Kein universeller CSV-Parser: Messwertzeilen enthalten unquotierte Zahlenfelder.
    const metadata = Object.create(null);
    let headers = null, count = 0;
    for (const line of lines(text)) {
      if (!line.text) continue;
      if (line.text.startsWith("#")) {
        const match = /^#\s*([^:]+):\s*(.*)$/.exec(line.text);
        if (!match) throw new Error(`Ungültige Metadaten in Zeile ${line.number}.`);
        try { metadata[match[1].trim()] = JSON.parse(match[2]); }
        catch { throw new Error(`Ungültige JSON-Metadaten in Zeile ${line.number}.`); }
      } else if (!headers) {
        headers = line.text.split(",").map((value) => value.trim());
        if (!headers.includes("timestamp_s") || !headers.includes("adc_counts") || new Set(headers).size !== headers.length) {
          throw new Error("Keine unterstützte Bike-EKG-CSV: Spalten timestamp_s und adc_counts fehlen oder sind doppelt.");
        }
      } else if (++count > MAX_SAMPLES) {
        throw new Error("Zu viele Messpunkte (maximal 3 Millionen). Bitte eine kürzere Aufnahme öffnen.");
      }
    }
    if (!count) throw new Error("Die CSV enthält keine Messpunkte.");
    if (metadata.csv_format_version !== undefined && metadata.csv_format_version !== 1) {
      throw new Error("Diese CSV-Formatversion wird noch nicht unterstützt.");
    }
    const times = new Float64Array(count), values = new Float64Array(count), gaps = new Uint8Array(count);
    const timeColumn = headers.indexOf("timestamp_s"), valueColumn = headers.indexOf("adc_counts"), sampleColumn = headers.indexOf("sample_number");
    let row = 0, foundHeader = false, previousSample = null, origin = 0;
    for (const line of lines(text)) {
      if (!line.text || line.text.startsWith("#")) continue;
      if (!foundHeader) { foundHeader = true; continue; }
      const columns = line.text.split(",");
      const time = Number(columns[timeColumn]), value = Number(columns[valueColumn]);
      const sample = sampleColumn < 0 ? null : Number(columns[sampleColumn]);
      if (columns.length !== headers.length || !columns[timeColumn]?.trim() || !columns[valueColumn]?.trim()
        || !Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER
        || !Number.isInteger(value) || value < -2147483648 || value > 2147483647
        || (sampleColumn >= 0 && (!columns[sampleColumn]?.trim() || !Number.isInteger(sample) || sample < 0 || sample > 0xFFFFFFFF))) {
        throw new Error(`Ungültiger Messwert in Zeile ${line.number}.`);
      }
      if (row === 0) origin = time;
      times[row] = time - origin;
      if (row && times[row] <= times[row - 1]) throw new Error(`Zeitstempel müssen streng ansteigen (Zeile ${line.number}).`);
      values[row] = value;
      if (row && sample !== null && (sample - previousSample + 0x100000000) % 0x100000000 !== 1) gaps[row] = 1;
      previousSample = sample;
      ++row;
    }
    let rate = Number(metadata.sample_rate_sps);
    if (!Number.isFinite(rate) || rate <= 0) {
      const deltas = [];
      for (let i = 1; i < Math.min(count, 1001); ++i) if (!gaps[i]) deltas.push(times[i] - times[i - 1]);
      deltas.sort((a, b) => a - b);
      rate = deltas.length ? 1 / deltas[Math.floor(deltas.length / 2)] : null;
    }
    let gapCount = 0;
    for (let i = 1; i < count; ++i) {
      if (rate && times[i] - times[i - 1] > 1.8 / rate) gaps[i] = 1;
      gapCount += gaps[i];
    }
    return { times, values, gaps, metadata, rate, origin, gapCount, ...buildIndex(values, gaps) };
  }

  function buildIndex(values, gaps) {
    // Min-/Max-Baum über 64er-Blöcke für spitzenerhaltende Pixelhüllkurven.
    // Präfixsummen erlauben die Lückenprüfung ohne erneutes Durchlaufen der Samples.
    let leaves = 1;
    while (leaves < Math.ceil(values.length / BLOCK)) leaves *= 2;
    const minima = new Float64Array(leaves * 2).fill(Infinity);
    const maxima = new Float64Array(leaves * 2).fill(-Infinity);
    const gapPrefix = new Uint32Array(values.length + 1);
    for (let i = 0; i < values.length; ++i) {
      const node = leaves + Math.floor(i / BLOCK);
      minima[node] = Math.min(minima[node], values[i]);
      maxima[node] = Math.max(maxima[node], values[i]);
      gapPrefix[i + 1] = gapPrefix[i] + gaps[i];
    }
    for (let node = leaves - 1; node; --node) {
      minima[node] = Math.min(minima[node * 2], minima[node * 2 + 1]);
      maxima[node] = Math.max(maxima[node * 2], maxima[node * 2 + 1]);
    }
    return { minima, maxima, gapPrefix, leaves };
  }

  function lowerBound(values, target) {
    // Erster Index mit Wert >= target; Arraylänge bedeutet rechts außerhalb.
    let low = 0, high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (values[mid] < target) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  // Exact extrema, even for a viewport cutting through an index block.
  function extrema(data, start, end) {
    let min = Infinity, max = -Infinity;
    function add(value) { min = Math.min(min, value); max = Math.max(max, value); }
    while (start < end && start % BLOCK) add(data.values[start++]);
    while (start < end && end % BLOCK) add(data.values[--end]);
    let left = data.leaves + start / BLOCK, right = data.leaves + end / BLOCK;
    while (left < right) {
      if (left % 2) { min = Math.min(min, data.minima[left]); max = Math.max(max, data.maxima[left++]); }
      if (right % 2) { --right; min = Math.min(min, data.minima[right]); max = Math.max(max, data.maxima[right]); }
      left = Math.floor(left / 2); right = Math.floor(right / 2);
    }
    return { min, max };
  }

  function clampWindow(start, span, duration, minimum) {
    span = Math.max(Math.min(minimum, duration), Math.min(duration, span));
    start = Math.max(0, Math.min(duration - span, start));
    return { start, end: start + span };
  }

  function adjustValueRange(range, domain, mode, delta, minimum = .01) {
    minimum = Math.min(minimum, domain.max - domain.min);
    if (mode === "upper") return { min: range.min, max: Math.max(range.min + minimum, Math.min(domain.max, range.max + delta)) };
    if (mode === "lower") return { min: Math.min(range.max - minimum, Math.max(domain.min, range.min + delta)), max: range.max };
    const span = range.max - range.min;
    const min = Math.max(domain.min, Math.min(domain.max - span, range.min + delta));
    return { min, max: min + span };
  }

  return { MAX_BYTES, MAX_SAMPLES, BLOCK, parse, buildIndex, lowerBound, extrema, clampWindow, adjustValueRange };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EkgCsv;
