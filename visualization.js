"use strict";

// Lokaler Canvas-Betrachter: Datenmodell/Parser, Filter und Bericht sind ausgelagert.
// rawData bleibt die Quelle jeder Filterung; data ist die aktuelle Darstellungsansicht.
// verifiedRecording bewahrt BIN-Originalbytes für einen ungefilterten CSV-Export.

(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("viewer-canvas"), overview = $("viewer-overview");
  const number = (value, digits = 3) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value)
    .toLocaleString("de-DE", { maximumFractionDigits: digits });
  let data = null, worker = null, currentFile = "", start = 0, end = 1;
  let duration = 1, minimum = .004, frame = 0, overviewDirty = true, cursorX = null;
  let yRange = { min: -1, max: 1 }, yDomain = { min: -1, max: 1 };
  let reportRows = [], currentReport = null;
  let plot = { left: 84, top: 22, width: 1, height: 1 }, drag = null;
  const pointers = new Map();
  let live = null;
  let verifiedRecording = null;
  let rawData = null, filterWorker = null;

  function stopFilter() {
    filterWorker?.terminate();
    filterWorker = null;
    $("viewer-filters").disabled = Boolean(live) || !rawData;
    $("viewer-export").disabled = Boolean(live) || !data;
  }

  function resetFilterControls() {
    for (const kind of ["hp", "lp", "notch", "qrs"]) $("viewer-filter-" + kind).checked = false;
    $("viewer-filter-status").textContent = "Aus · Rohdaten";
    $("viewer-filter-status").dataset.error = "false";
  }

  function showFiltered(next, description) {
    data = next;
    reportRows = EkgReport.summary(data, currentFile);
    reportRows.push(`Darstellungsfilter: ${description}`);
    $("viewer-description").textContent = reportRows.join("\n");
    $("viewer-filter-status").textContent = description;
    $("viewer-filter-status").dataset.error = "false";
    yDomain = padded(EkgCsv.extrema(data, 0, data.values.length));
    yRange = { ...yDomain };
    $("viewer-y-auto").checked = true;
    overviewDirty = true;
    cursorX = null;
    showMetadata();
    schedule();
  }

  $("viewer-filter-reset").addEventListener("click", () => {
    if (live || !rawData) return;
    stopFilter();
    showFiltered(rawData, "Aus · Rohdaten");
  });
  $("viewer-filter-apply").addEventListener("click", () => {
    if (live || !rawData || filterWorker) return;
    const settings = Object.fromEntries(["hp", "lp", "notch"].map((kind) => [kind, {
      enabled: $("viewer-filter-" + kind).checked,
      frequency: Number($("viewer-filter-" + kind + "-hz").value),
      q: Number($("viewer-filter-notch-q").value),
    }]));
    settings.qrs = { enabled: $("viewer-filter-qrs").checked, windowMs: Number($("viewer-filter-qrs-ms").value) };
    const fail = (message) => {
      stopFilter();
      $("viewer-filter-status").textContent = `${message} Die bisherige Darstellung bleibt erhalten.`;
      $("viewer-filter-status").dataset.error = "true";
    };
    try {
      EkgFilters.validate(rawData.rate, settings);
      const description = EkgFilters.describe(settings);
      if (!Object.values(settings).some((value) => value.enabled)) {
        showFiltered(rawData, description); return;
      }
      const source = rawData;
      const loader = new Worker("visualization-filter-worker.js");
      filterWorker = loader;
      $("viewer-filters").disabled = true;
      $("viewer-export").disabled = true;
      $("viewer-filter-status").textContent = "Filter werden auf die gesamte Aufnahme angewendet …";
      $("viewer-filter-status").dataset.error = "false";
      loader.onmessage = ({ data: result }) => {
        if (filterWorker !== loader || rawData !== source || live) return;
        if (result.error) { fail(result.error); return; }
        stopFilter();
        showFiltered({ ...source, values: result.values, ...result.index,
          metadata: { ...source.metadata, signal_format: settings.qrs.enabled ? "viewer_qrs_energy" : "viewer_filtered_adc_counts",
            viewer_filters: description, ...(settings.qrs.enabled ? {
              viewer_qrs_window_samples: Math.max(1, Math.round(settings.qrs.windowMs * source.rate / 1000)),
            } : {}) } }, description);
      };
      loader.onerror = (event) => { event.preventDefault(); if (filterWorker === loader) fail("Filter-Worker konnte nicht ausgeführt werden."); };
      // Clone inputs: never transfer/detach the original sample arrays.
      loader.postMessage({ values: source.values, gaps: source.gaps, rate: source.rate, settings });
    } catch (error) { fail(error.message); }
  });

  function status(message, error = false) {
    $("csv-status").textContent = message;
    $("csv-status").dataset.error = String(error);
  }

  function amplitudeUnit() {
    return data?.metadata.signal_format === "viewer_qrs_energy" ? "(Counts/s)²" : "Counts";
  }

  function stopLoading() {
    worker?.terminate();
    worker = null;
    $("csv-cancel").hidden = true;
    $("csv-drop").removeAttribute("aria-busy");
    $("viewer-filters").disabled = Boolean(live) || !rawData;
  }

  function load(file) {
    if (!file) return;
    if (live) { status("Bitte zuerst die laufende SD-Übertragung abbrechen."); return; }
    stopLoading();
    stopFilter();
    if (!file.size || file.size > EkgCsv.MAX_BYTES) {
      status("Bitte eine nicht leere CSV-/BIN-Datei auswählen (CSV maximal 256 MiB, BIN maximal 32 MiB). Die bisherige Ansicht bleibt erhalten.", true);
      return;
    }
    status(`„${file.name}“ wird eingelesen und für die Darstellung vorbereitet …`);
    $("csv-cancel").hidden = false;
    $("csv-drop").setAttribute("aria-busy", "true");
    try {
      worker = new Worker("visualization-worker.js");
      $("viewer-filters").disabled = true;
      const loader = worker;
      worker.onmessage = ({ data: result }) => {
        if (worker !== loader) return;
        stopLoading();
        if (result.error) { status(`${result.error} Die bisherige Ansicht bleibt erhalten.`, true); return; }
        data = result.data;
        rawData = data;
        resetFilterControls();
        $("viewer-filters").disabled = false;
        verifiedRecording = null;
        $("viewer-transfer").hidden = true;
        $("viewer-export").disabled = false;
        currentFile = file.name;
        if (result.binary) {
          verifiedRecording = { bytes: result.binary, name: currentFile, local: true };
          $("viewer-transfer").hidden = false;
          $("viewer-transfer-progress").hidden = true;
          $("viewer-transfer-cancel").hidden = true;
          $("viewer-transfer-csv").hidden = false;
          $("viewer-transfer-csv").disabled = false;
          $("viewer-transfer-csv-status").hidden = true;
          $("viewer-transfer-status").textContent = `${currentFile} · Lokal eingelesen: Header, Abschlussblock und Dateigröße geprüft. Kein SHA-256-Abgleich mit der SD-Datei auf dem Gerät.`;
          $("viewer-transfer-status").dataset.error = "false";
          $("viewer-transfer-status").dataset.state = "local";
        }
        reportRows = EkgReport.summary(data, currentFile);
        $("viewer-description").textContent = reportRows.join("\n");
        $("viewer-export-status").hidden = true;
        duration = Math.max(data.times[data.times.length - 1], 1 / (data.rate || 1));
        minimum = Math.min(duration, Math.max(.001, 2 / (data.rate || 500)));
        start = 0; end = Math.min(10, duration); cursorX = null;
        $("viewer-y-auto").checked = true;
        yDomain = padded(EkgCsv.extrema(data, 0, data.values.length));
        yRange = { ...yDomain };
        $("viewer-panel").hidden = false;
        showMetadata();
        status(`${currentFile} · ${number(data.values.length, 0)} Messpunkte · ${number(duration)} s · ${number(data.gapCount, 0)} erkannte Datenlücken`);
        overviewDirty = true;
        schedule();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (worker !== loader) return;
        stopLoading();
        status("Der Datei-Worker konnte nicht gestartet werden. Bitte die Anwendung über localhost oder HTTPS öffnen (siehe README). Die bisherige Ansicht bleibt erhalten.", true);
      };
      worker.postMessage(file);
    } catch {
      stopLoading();
      status("CSV-/BIN-Einlesen benötigt Web Worker. Bitte über localhost oder HTTPS in einem aktuellen Browser öffnen.", true);
    }
  }

  function showMetadata() {
    const list = $("csv-metadata");
    list.replaceChildren();
    const entries = {
      Datei: currentFile,
      Messpunkte: number(data.values.length, 0),
      "Abtastrate (Samples/s)": data.rate ? number(data.rate) : "Nicht bestimmbar",
      "Erster Zeitstempel (s)": number(data.origin, 6),
      "Erkannte Datenlücken": data.gapCount,
      ...data.metadata,
    };
    for (const [key, value] of Object.entries(entries)) {
      const term = document.createElement("dt"), description = document.createElement("dd");
      term.textContent = key;
      description.textContent = typeof value === "object" ? JSON.stringify(value) : String(value);
      list.append(term, description);
    }
    $("csv-info").hidden = false;
  }

  function setWindow(left, span) {
    if (!data) return;
    if (live) live.follow = false;
    const next = EkgCsv.clampWindow(left, span, duration, minimum);
    start = next.start; end = next.end;
    schedule();
  }

  function zoom(factor, fraction = .5) {
    const span = end - start, anchor = start + span * fraction;
    const nextSpan = Math.max(minimum, Math.min(duration, span * factor));
    setWindow(anchor - nextSpan * fraction, nextSpan);
  }

  function schedule() {
    // Mehrere Eingabe-/Transferereignisse in höchstens einen Bildschirmframe bündeln.
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function prepare(element) {
    const rect = element.getBoundingClientRect();
    const width = rect.width, height = rect.height, dpr = window.devicePixelRatio || 1;
    if (width < 2 || height < 2) return null;
    const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
    if (element.width !== pixelWidth || element.height !== pixelHeight) {
      element.width = pixelWidth; element.height = pixelHeight;
    }
    const ctx = element.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function padded(range) {
    if (!Number.isFinite(range.min)) return { min: -1, max: 1 };
    const padding = Math.max((range.max - range.min) * .06, Math.abs(range.max) * .000001, 1);
    return { min: range.min - padding, max: range.max + padding };
  }

  function visibleIndices(left, right) {
    return [EkgCsv.lowerBound(data.times, left), EkgCsv.lowerBound(data.times, right + 1e-9)];
  }

  function niceStep(span, divisions) {
    const raw = span / divisions, power = 10 ** Math.floor(Math.log10(raw)), fraction = raw / power;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  }

  function axes(ctx, area, range) {
    ctx.font = "11px system-ui, sans-serif";
    ctx.lineWidth = 1;
    const xStep = niceStep(end - start, Math.max(2, area.width / 110));
    const yStep = niceStep(range.max - range.min, 6);
    const xDigits = Math.min(6, Math.max(0, -Math.floor(Math.log10(xStep))));
    const yDigits = Math.min(3, Math.max(0, -Math.floor(Math.log10(yStep))));
    for (let t = Math.ceil(start / xStep) * xStep; t <= end + xStep * .00001; t += xStep) {
      const x = area.left + (t - start) / (end - start) * area.width;
      ctx.strokeStyle = "#dfe6ec"; ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.top + area.height); ctx.stroke();
      ctx.fillStyle = "#536675"; ctx.textAlign = "center";
      ctx.fillText(`${number(t, xDigits)} s`, x, area.top + area.height + 22);
    }
    for (let value = Math.ceil(range.min / yStep) * yStep; value <= range.max; value += yStep) {
      const y = area.top + (range.max - value) / (range.max - range.min) * area.height;
      ctx.strokeStyle = "#dfe6ec"; ctx.beginPath(); ctx.moveTo(area.left, y); ctx.lineTo(area.left + area.width, y); ctx.stroke();
      ctx.fillStyle = "#536675"; ctx.textAlign = "right";
      ctx.fillText(number(value, yDigits), area.left - 8, y + 4);
    }
    ctx.textAlign = "left"; ctx.fillText(amplitudeUnit() === "Counts" ? "ADC-Counts" : amplitudeUnit(), 8, area.top - 10);
  }

  function signal(ctx, area, left, right, range, resolution = 1, fullDetail = false) {
    // Interaktiv Min-/Max-Hüllkurve statt einfachem Auslassen von Samples nutzen.
    // PNG kann alle sichtbaren Originalpunkte zeichnen; Lücken werden nie verbunden.
    const [first, stop] = visibleIndices(left, right);
    const x = (time) => area.left + (time - left) / (right - left) * area.width;
    const y = (value) => area.top + (range.max - value) / (range.max - range.min) * area.height;
    ctx.save();
    ctx.beginPath(); ctx.rect(area.left, area.top, area.width, area.height); ctx.clip();
    ctx.strokeStyle = "#14685c"; ctx.lineWidth = .8;
    ctx.beginPath();
    if (fullDetail || stop - first <= area.width * 3) {
      // Include neighbours for an accurate line at viewport boundaries, never across a gap.
      const from = Math.max(0, first - 1), to = Math.min(data.values.length, stop + 1);
      for (let i = from; i < to; ++i) {
        if (i === from || data.gaps[i]) ctx.moveTo(x(data.times[i]), y(data.values[i]));
        else ctx.lineTo(x(data.times[i]), y(data.values[i]));
        // Bound path memory even when exporting millions of original samples.
        if ((i - from + 1) % 8192 === 0) {
          ctx.stroke(); ctx.beginPath(); ctx.moveTo(x(data.times[i]), y(data.values[i]));
        }
      }
      ctx.stroke();
      if (stop - first < area.width / 8) {
        ctx.fillStyle = "#14685c";
        for (let i = first; i < stop; ++i) { ctx.beginPath(); ctx.arc(x(data.times[i]), y(data.values[i]), 2, 0, Math.PI * 2); ctx.fill(); }
      }
    } else {
      // Exact min/max envelope per CSS pixel; spikes survive overview decimation.
      const columns = Math.max(1, Math.floor(area.width * resolution));
      let previous = -1;
      for (let pixel = 0; pixel < columns; ++pixel) {
        const a = EkgCsv.lowerBound(data.times, left + pixel / columns * (right - left));
        const b = pixel === columns - 1 ? stop : EkgCsv.lowerBound(data.times, left + (pixel + 1) / columns * (right - left));
        if (a >= b || data.gapPrefix[b] - data.gapPrefix[a + 1] > 0) { previous = -1; continue; }
        const rangeInPixel = EkgCsv.extrema(data, a, b), px = area.left + (pixel + .5) / columns * area.width;
        if (previous === a - 1 && !data.gaps[a]) {
          ctx.moveTo(x(data.times[previous]), y(data.values[previous])); ctx.lineTo(px, y(data.values[a]));
        }
        ctx.moveTo(px, y(rangeInPixel.min)); ctx.lineTo(px, y(rangeInPixel.max));
        // A constant-valued bin must still be visible.
        if (rangeInPixel.min === rangeInPixel.max) ctx.lineTo(px + area.width / columns, y(rangeInPixel.max));
        previous = b - 1;
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    if (!data || $("visualization-view").hidden) return;
    const [first, stop] = visibleIndices(start, end);
    if ($("viewer-y-auto").checked && first < stop) yRange = padded(EkgCsv.extrema(data, first, stop));
    const rangeText = `${number(start)} – ${number(end)} s · Zeitfenster ${number(end - start)} s · Y: ${number(yRange.min)} bis ${number(yRange.max)} ${amplitudeUnit()}`;
    const width = canvas.getBoundingClientRect().width;
    if (width < 2) return;
    currentReport = EkgReport.layout(canvas.getContext("2d"), width, reportRows, rangeText,
      Number(getComputedStyle(canvas).getPropertyValue("--viewer-plot-height")) || 420);
    canvas.style.height = `${currentReport.height}px`;
    const prepared = prepare(canvas);
    if (!prepared) return;
    const { ctx } = prepared;
    plot = currentReport.plot;
    paintReport(ctx, currentReport);
    drawCursor(ctx);
    $("viewer-range").textContent = rangeText;
    canvas.setAttribute("aria-label", `${data.metadata.signal_format === "viewer_qrs_energy" ? "QRS-Energiekurve" : "EKG-Signal"} von ${number(start)} bis ${number(end)} Sekunden. Y-Achse ${number(yRange.min)} bis ${number(yRange.max)} ${amplitudeUnit()}. Pfeiltasten verschieben, Plus und Minus zoomen.`);
    updateYSelection();
    const selection = $("viewer-selection");
    selection.style.left = `${start / duration * 100}%`;
    selection.style.width = `${(end - start) / duration * 100}%`;
    $("viewer-selection-start").setAttribute("aria-label", `Fensteranfang ${number(start)} Sekunden; Pfeiltasten zur Feineinstellung`);
    $("viewer-selection-end").setAttribute("aria-label", `Fensterende ${number(end)} Sekunden; Pfeiltasten zur Feineinstellung`);
    if (overviewDirty) {
      const preview = prepare(overview);
      if (preview) {
        signal(preview.ctx, { left: 0, top: 6, width: preview.width, height: preview.height - 12 }, 0, duration,
          padded(EkgCsv.extrema(data, 0, data.values.length)));
        overviewDirty = false;
      }
    }
  }

  function paintReport(ctx, report, resolution = 1, fullDetail = false) {
    EkgReport.paint(ctx, report);
    axes(ctx, report.plot, yRange);
    signal(ctx, report.plot, start, end, yRange, resolution, fullDetail);
    const [first, stop] = visibleIndices(start, end);
    if (first === stop) {
      ctx.fillStyle = "#536675"; ctx.textAlign = "center";
      ctx.fillText("Keine Messpunkte in diesem Zeitfenster", report.plot.left + report.plot.width / 2, report.plot.top + 24);
    }
  }

  $("viewer-export").addEventListener("click", async () => {
    if (!data || live || filterWorker) return;
    const button = $("viewer-export"), message = $("viewer-export-status");
    button.disabled = true;
    message.hidden = false;
    message.textContent = "PNG wird erstellt …";
    try {
      // Flush pending navigation before taking a snapshot; do not copy the hover cursor.
      draw();
      const report = $("viewer-export-plot-only").checked ? EkgReport.withoutInfo(currentReport) : currentReport;
      const image = document.createElement("canvas");
      const requestedScale = Number($("viewer-export-scale").value);
      const target = EkgReport.exportLayout(report, requestedScale);
      image.width = target.width;
      image.height = target.height;
      const ctx = image.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, image.width, image.height);
      ctx.translate(target.x, target.y);
      ctx.scale(target.scale, target.scale);
      paintReport(ctx, report, target.scale, true);
      const filename = `${currentFile.replace(/\.(csv|bin)$/i, "")}_${start.toFixed(3)}-${end.toFixed(3)}s.png`;
      const blob = await new Promise((resolve) => image.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Das PNG konnte nicht erstellt werden.");
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove();
      // Give the browser download manager time to acquire the blob before revoking it.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      message.textContent = "";
      message.hidden = true;
    } catch (error) {
      message.textContent = `Export fehlgeschlagen: ${error.message || "Unbekannter Fehler"}`;
    } finally {
      button.disabled = Boolean(live);
    }
  });

  function updateYSelection() {
    const span = yDomain.max - yDomain.min;
    const track = $("viewer-y-track"), selection = $("viewer-y-selection");
    track.style.top = `${plot.top}px`;
    track.style.height = `${plot.height}px`;
    $("viewer-y-auto").parentElement.style.top = `${plot.top - 54}px`;
    selection.style.top = `${(yDomain.max - yRange.max) / span * 100}%`;
    selection.style.height = `${(yRange.max - yRange.min) / span * 100}%`;
    for (const [mode, value] of [["upper", yRange.max], ["lower", yRange.min]]) {
      const handle = $("viewer-y-" + mode);
      handle.setAttribute("aria-valuemin", String(mode === "upper" ? yRange.min : yDomain.min));
      handle.setAttribute("aria-valuemax", String(mode === "lower" ? yRange.max : yDomain.max));
      handle.setAttribute("aria-valuenow", String(value));
      handle.setAttribute("aria-valuetext", `${number(value)} ${amplitudeUnit()}`);
      handle.title = `${mode === "upper" ? "Obere" : "Untere"} Grenze: ${number(value)} ${amplitudeUnit()}`;
    }
  }

  function drawCursor(ctx) {
    if (cursorX === null || cursorX < plot.left || cursorX > plot.left + plot.width) return;
    const time = start + (cursorX - plot.left) / plot.width * (end - start);
    let index = Math.min(data.times.length - 1, EkgCsv.lowerBound(data.times, time));
    if (index > 0 && Math.abs(data.times[index - 1] - time) < Math.abs(data.times[index] - time)) --index;
    ctx.strokeStyle = "#8098a8"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(cursorX, plot.top); ctx.lineTo(cursorX, plot.top + plot.height); ctx.stroke(); ctx.setLineDash([]);
    const inGap = data.rate && Math.abs(data.times[index] - time) > 1.8 / data.rate;
    $("viewer-cursor").textContent = inGap ? `Zeit: ${number(time, 6)} s · Datenlücke / kein Messpunkt`
      : `${number(data.times[index], 6)} s · ${number(data.values[index], 6)} ${amplitudeUnit()} · Punkt ${number(index + 1, 0)}`;
  }

  $("csv-file").addEventListener("change", (event) => {
    load(event.target.files[0]);
    event.target.value = "";
  });
  $("csv-cancel").addEventListener("click", () => {
    if (live) { status("SD-Übertragung wird abgebrochen …"); live.cancel(); return; }
    stopLoading(); status("Einlesen abgebrochen. Eine bereits geladene Aufnahme bleibt erhalten.");
  });
  const drop = $("csv-drop");
  for (const name of ["dragenter", "dragover"]) drop.addEventListener(name, (event) => {
    event.preventDefault(); drop.dataset.drag = "true";
  });
  drop.addEventListener("dragleave", (event) => { if (!drop.contains(event.relatedTarget)) delete drop.dataset.drag; });
  drop.addEventListener("drop", (event) => {
    event.preventDefault(); delete drop.dataset.drag;
    if (event.dataTransfer.files.length !== 1) { status("Bitte genau eine CSV-/BIN-Datei ablegen.", true); return; }
    load(event.dataTransfer.files[0]);
  });

  for (const button of document.querySelectorAll("[data-view-seconds]")) button.addEventListener("click", () => {
    if (!data) return;
    const span = button.dataset.viewSeconds === "all" ? duration : Number(button.dataset.viewSeconds);
    setWindow((start + end - span) / 2, span);
    if (live && button.dataset.viewSeconds === "all") live.follow = true;
  });
  $("viewer-y-auto").addEventListener("change", schedule);

  const helpBubble = $("viewer-help-bubble");
  document.addEventListener("pointerdown", (event) => {
    if (!helpBubble.contains(event.target)) helpBubble.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") canvas.dataset.keyboardFocus = "true";
    if (event.key === "Escape" && helpBubble.open) {
      helpBubble.open = false;
      helpBubble.querySelector("summary").focus({ preventScroll: true });
    }
  });

  canvas.addEventListener("wheel", (event) => {
    if (!data) return;
    const y = event.clientY - canvas.getBoundingClientRect().top;
    if (y < plot.top || y > plot.top + plot.height) return;
    event.preventDefault();
    const x = event.clientX - canvas.getBoundingClientRect().left;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    zoom(Math.exp(Math.max(-1, Math.min(1, delta * .002))), Math.max(0, Math.min(1, (x - plot.left) / plot.width)));
  }, { passive: false });

  canvas.addEventListener("keydown", (event) => {
    if (!data) return;
    const span = end - start;
    switch (event.key) {
      case "ArrowLeft": setWindow(start - span * (event.shiftKey ? .5 : .1), span); break;
      case "ArrowRight": setWindow(start + span * (event.shiftKey ? .5 : .1), span); break;
      case "+": case "=": zoom(.8); break;
      case "-": zoom(1.25); break;
      case "Home": setWindow(0, duration); break;
      default: return;
    }
    canvas.dataset.keyboardFocus = "true";
    event.preventDefault();
  });

  function beginGesture() {
    const points = Array.from(pointers.values());
    if (points.length >= 2) {
      const center = (points[0] + points[1]) / 2;
      drag = { mode: "pinch", distance: Math.max(1, Math.abs(points[1] - points[0])),
        span: end - start, anchor: start + (center - plot.left) / plot.width * (end - start) };
    } else if (points.length) drag = { mode: "pan", x: points[0], start, span: end - start };
    else drag = null;
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!data || event.button !== 0) return;
    const y = event.clientY - canvas.getBoundingClientRect().top;
    if (y < plot.top || y > plot.top + plot.height) return;
    event.preventDefault();
    canvas.dataset.keyboardFocus = "false";
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, event.clientX - canvas.getBoundingClientRect().left);
    beginGesture();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!data) return;
    const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    cursorX = y >= plot.top && y <= plot.top + plot.height ? x : null;
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, x);
      if (drag?.mode === "pan") setWindow(drag.start - (x - drag.x) / plot.width * drag.span, drag.span);
      else if (drag?.mode === "pinch") {
        const points = Array.from(pointers.values());
        const span = Math.max(minimum, Math.min(duration, drag.span * drag.distance / Math.max(1, Math.abs(points[1] - points[0]))));
        const fraction = ((points[0] + points[1]) / 2 - plot.left) / plot.width;
        setWindow(drag.anchor - span * fraction, span);
      }
    }
    schedule();
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(name, (event) => {
    if (pointers.delete(event.pointerId)) beginGesture();
  });
  canvas.addEventListener("pointerleave", () => {
    if (!pointers.size) { cursorX = null; $("viewer-cursor").textContent = "Zeiger im Plot: Zeit und Messwert"; schedule(); }
  });

  const overviewContainer = overview.parentElement;
  let overviewDrag = null;
  function resizeSelection(mode, delta, initialStart = start, initialEnd = end) {
    if (mode === "start") {
      const left = Math.max(0, Math.min(initialEnd - minimum, initialStart + delta));
      setWindow(left, initialEnd - left);
    } else if (mode === "end") {
      const right = Math.min(duration, Math.max(initialStart + minimum, initialEnd + delta));
      setWindow(initialStart, right - initialStart);
    } else setWindow(initialStart + delta, initialEnd - initialStart);
  }
  overviewContainer.addEventListener("pointerdown", (event) => {
    if (!data || event.button !== 0) return;
    event.preventDefault();
    let mode = "move";
    if (event.target.id === "viewer-selection-start") mode = "start";
    else if (event.target.id === "viewer-selection-end") mode = "end";
    else if (event.target === overview) {
      const rect = overviewContainer.getBoundingClientRect();
      setWindow((event.clientX - rect.left) / rect.width * duration - (end - start) / 2, end - start);
    }
    $("viewer-selection-" + mode).focus({ preventScroll: true });
    overviewContainer.setPointerCapture(event.pointerId);
    overviewDrag = { pointer: event.pointerId, mode, x: event.clientX, start, end };
  });
  overviewContainer.addEventListener("pointermove", (event) => {
    if (!overviewDrag || overviewDrag.pointer !== event.pointerId) return;
    const delta = (event.clientX - overviewDrag.x) / overviewContainer.getBoundingClientRect().width * duration;
    resizeSelection(overviewDrag.mode, delta, overviewDrag.start, overviewDrag.end);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) overviewContainer.addEventListener(name, (event) => {
    if (overviewDrag?.pointer === event.pointerId) overviewDrag = null;
  });
  for (const mode of ["start", "move", "end"]) $("viewer-selection-" + mode).addEventListener("keydown", (event) => {
    if (!data || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    resizeSelection(mode, (event.key === "ArrowLeft" ? -1 : 1) * (end - start) * (event.shiftKey ? .1 : .01));
  });

  const yTrack = $("viewer-y-track");
  let yDrag = null;
  function adjustY(mode, delta, initial = yRange) {
    $("viewer-y-auto").checked = false;
    yRange = EkgCsv.adjustValueRange(initial, yDomain, mode, delta);
    schedule();
  }
  yTrack.addEventListener("pointerdown", (event) => {
    if (!data || event.button !== 0 || yDrag) return;
    event.preventDefault();
    const mode = event.target.id === "viewer-y-upper" ? "upper" : event.target.id === "viewer-y-lower" ? "lower" : "move";
    $("viewer-y-" + mode).focus({ preventScroll: true });
    yTrack.setPointerCapture(event.pointerId);
    if (event.target === yTrack) {
      const rect = yTrack.getBoundingClientRect();
      const value = yDomain.max - (event.clientY - rect.top) / rect.height * (yDomain.max - yDomain.min);
      adjustY("move", value - (yRange.min + yRange.max) / 2);
    }
    yDrag = { pointer: event.pointerId, mode, y: event.clientY, range: { ...yRange } };
    adjustY(mode, 0);
  });
  yTrack.addEventListener("pointermove", (event) => {
    if (yDrag?.pointer !== event.pointerId) return;
    const delta = -(event.clientY - yDrag.y) / yTrack.getBoundingClientRect().height * (yDomain.max - yDomain.min);
    adjustY(yDrag.mode, delta, yDrag.range);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) yTrack.addEventListener(name, (event) => {
    if (yDrag?.pointer === event.pointerId) yDrag = null;
  });
  for (const mode of ["upper", "move", "lower"]) $("viewer-y-" + mode).addEventListener("keydown", (event) => {
    if (!data || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = Math.max(.01, (yRange.max - yRange.min) * (event.shiftKey ? .1 : .01));
    adjustY(mode, (event.key === "ArrowUp" ? 1 : -1) * step);
  });

  function refreshLive(view) {
    // SD-Daten bis zur Abschlussprüfung nur vorläufig zeigen, Export bleibt gesperrt.
    // Die geschätzte Gesamtdauer stabilisiert die Achse schon ab dem ersten Block.
    if (live !== view || !view.stream.count) return;
    data = view.stream.snapshot();
    currentFile = view.name;
    duration = view.verified ? Math.max(data.times[data.times.length - 1], 1 / data.rate)
      : view.stream.estimatedDuration();
    minimum = Math.min(duration, Math.max(.001, 2 / data.rate));
    if (view.follow) { start = 0; end = duration; }
    yDomain = padded(EkgCsv.extrema(data, 0, data.values.length));
    if (!view.shown) { yRange = { ...yDomain }; cursorX = null; view.shown = true; }
    reportRows = EkgReport.summary(data, currentFile);
    if (!view.verified) reportRows.push("Übertragung: VORLÄUFIG · SHA-256-Prüfung noch ausstehend");
    $("viewer-description").textContent = reportRows.join("\n");
    $("viewer-panel").hidden = false;
    showMetadata();
    status(`${currentFile} · ${number(data.values.length, 0)} Messpunkte · ${number(duration)} s`);
    overviewDirty = true;
    schedule();
  }

  function releaseLiveControls() {
    stopLoading();
    $("csv-file").disabled = false;
    $("csv-cancel").textContent = "Einlesen abbrechen";
    $("viewer-export").disabled = !data;
    $("viewer-transfer-cancel").hidden = true;
  }

  $("viewer-transfer-cancel").addEventListener("click", () => {
    if (!live) return;
    $("viewer-transfer-cancel").disabled = true;
    $("viewer-transfer-status").textContent = "Übertragung wird abgebrochen …";
    live.cancel();
  });

  $("viewer-transfer-csv").addEventListener("click", async () => {
    const recording = verifiedRecording;
    if (live || !recording || $("viewer-transfer-csv").disabled) return;
    const button = $("viewer-transfer-csv"), message = $("viewer-transfer-csv-status");
    button.disabled = true;
    message.hidden = false;
    message.textContent = "CSV wird aus den geprüften Daten erstellt …";
    message.dataset.error = "false";
    try {
      const blob = await recordingCsv(recording.bytes, recording.name, { verification: recording.verification, localFile: recording.local });
      if (verifiedRecording !== recording || live) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url;
      link.download = `${recording.name.replace(/\.(bin|csv)$/i, "")}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      message.textContent = "CSV an die Browser-Downloadverwaltung übergeben.";
    } catch (error) {
      if (verifiedRecording !== recording || live) return;
      message.textContent = `CSV konnte nicht erstellt werden: ${error.message}`;
      message.dataset.error = "true";
    } finally {
      button.disabled = Boolean(live) || !verifiedRecording;
    }
  });

  // Called by the SD monitor, not by a server. Handles are session-scoped so that
  // late callbacks from an aborted transfer cannot overwrite a newer view.
  window.EkgViewer = {
    begin(name, cancel) {
      if (live) throw new Error("Eine Visualisierungsübertragung läuft bereits.");
      stopLoading();
      stopFilter();
      const view = {
        name, cancel, stream: new EkgBinaryStream(name), follow: true, shown: false, verified: false, timer: null,
        backup: { data, currentFile, start, end, duration, minimum, yRange, yDomain, reportRows, currentReport },
        auto: $("viewer-y-auto").checked,
        filterStatus: $("viewer-filter-status").textContent,
        filterError: $("viewer-filter-status").dataset.error,
      };
      live = view;
      $("viewer-filters").disabled = true;
      $("viewer-filter-status").textContent = "Filter nach vollständigem Empfang verfügbar.";
      $("viewer-filter-status").dataset.error = "false";
      verifiedRecording = null;
      $("viewer-transfer-csv").disabled = true;
      $("viewer-transfer-csv").hidden = true;
      $("viewer-transfer-csv-status").hidden = true;
      $("viewer-transfer").hidden = false;
      $("viewer-transfer-progress").value = 0;
      $("viewer-transfer-progress").hidden = false;
      $("viewer-transfer-status").textContent = `${name} · Verbindung zur SD-Datei wird aufgebaut …`;
      $("viewer-transfer-status").dataset.error = "false";
      $("viewer-transfer-status").dataset.state = "loading";
      $("viewer-transfer-cancel").hidden = false;
      $("viewer-transfer-cancel").disabled = false;
      $("viewer-panel").hidden = true;
      $("csv-info").hidden = true;
      $("csv-file").disabled = true;
      $("viewer-export").disabled = true;
      $("viewer-export-status").hidden = true;
      $("viewer-y-auto").checked = true;
      $("viewer-cursor").textContent = "Zeiger im Plot: Zeit und Messwert";
      $("csv-cancel").textContent = "Übertragung abbrechen";
      $("csv-cancel").hidden = true;
      $("csv-drop").setAttribute("aria-busy", "true");
      $("visualization-tab").click();
      $("visualization-tab").focus({ preventScroll: true });
      $("visualization-view").scrollIntoView({ block: "start", behavior: "smooth" });
      status(`${name} ausgewählt`);
      return {
        append(chunk, offset, total) {
          if (live !== view) return;
          view.stream.push(chunk, offset, total);
          const percent = view.stream.received / total * 100;
          $("viewer-transfer-progress").value = percent;
          $("viewer-transfer-status").textContent = `${name} · ${number(percent, 0)} % empfangen · ${percent === 100 ? "SHA-256- und Formatprüfung läuft …" : "Daten noch vorläufig"}`;
          if (view.timer === null) view.timer = setTimeout(() => {
            view.timer = null;
            refreshLive(view);
          }, 100);
        },
        complete(metadata, verification, bytes) {
          if (live !== view) return;
          clearTimeout(view.timer);
          view.stream.finish({ ...metadata, transfer_verification: verification.algorithm,
            source_binary_sha256: verification.sha256, source_binary_bytes: verification.bytes,
            transfer_compression: verification.compression });
          view.verified = true;
          refreshLive(view);
          live = null;
          rawData = data;
          resetFilterControls();
          verifiedRecording = bytes ? { bytes, name: view.name, verification } : null;
          $("viewer-transfer-csv").disabled = !verifiedRecording;
          $("viewer-transfer-csv").hidden = !verifiedRecording;
          releaseLiveControls();
          $("viewer-transfer-status").dataset.state = "success";
          $("viewer-transfer-status").textContent = `${currentFile} · Übertragung erfolgreich: SHA-256 und Dateilänge stimmen mit der SD-Datei überein. Aufzeichnungsformat geprüft.`;
          status(`${currentFile} · ${number(data.values.length, 0)} Messpunkte · ${number(duration)} s`);
        },
        fail(error) {
          // Abgebrochene Teildaten nicht als neue Messung behalten: alte Ansicht zurück.
          if (live !== view) return;
          clearTimeout(view.timer);
          ({ data, currentFile, start, end, duration, minimum, yRange, yDomain, reportRows, currentReport } = view.backup);
          live = null;
          $("viewer-transfer-csv").disabled = !verifiedRecording;
          $("viewer-transfer-csv").hidden = true;
          $("viewer-transfer-csv-status").hidden = true;
          $("viewer-transfer-progress").hidden = true;
          $("viewer-transfer-progress").value = 0;
          releaseLiveControls();
          $("viewer-transfer-status").textContent = `${view.name} · ${error.name === "AbortError" ? "Übertragung abgebrochen." : `Übertragung fehlgeschlagen: ${error.message}.`} Vorläufige Daten verworfen.${data ? " Vorherige Ansicht wiederhergestellt." : ""}`;
          $("viewer-transfer-status").dataset.state = error.name === "AbortError" ? "cancelled" : "error";
          $("viewer-transfer-status").dataset.error = String(error.name !== "AbortError");
          $("viewer-y-auto").checked = view.auto;
          $("viewer-filter-status").textContent = view.filterStatus;
          $("viewer-filter-status").dataset.error = view.filterError || "false";
          $("viewer-panel").hidden = !data;
          $("csv-info").hidden = !data;
          $("viewer-description").textContent = reportRows.join("\n");
          cursorX = null;
          if (data) showMetadata();
          overviewDirty = true;
          schedule();
          status(data ? `${currentFile} · ${number(data.values.length, 0)} Messpunkte · ${number(duration)} s` : `${view.name} ausgewählt`);
        },
      };
    },
  };

  new ResizeObserver(() => { overviewDirty = true; schedule(); }).observe($("viewer-panel"));
  window.addEventListener("resize", () => { overviewDirty = true; schedule(); });
})();
