"use strict";

// Inkrementeller BEKG-v1-Dekoder für beliebige Transport-Chunkgrenzen.
// Header und unvollständigen 12-Byte-Record separat sammeln; Footer ist kein Sample.

// Incremental BIN decoding: bounded per-chunk work, no reparsing/copying the full prefix.
const EkgBinaryStream = (() => {
  const model = typeof module !== "undefined" && module.exports ? require("./visualization-data.js") : EkgCsv;
  const headerInfo = typeof module !== "undefined" && module.exports ? require("./files.js").recordingHeader : recordingHeader;

  return class {
    constructor(name) {
      this.name = name;
      this.received = this.count = this.gapCount = this.wrap = 0;
      this.size = null;
      this.metadata = null;
      this.header = new Uint8Array(512);
      this.record = new Uint8Array(12);
      this.pending = 0;
      this.previousTime = this.previousSample = null;
      this.origin = 0;
    }

    initialize(size) {
      if (!Number.isInteger(size) || size < 1024 || size > 32 * 1024 * 1024 || (size - 1024) % 12) {
        throw new Error("Kein unterstützter Bike-EKG-Datenstrom.");
      }
      this.expected = (size - 1024) / 12;
      if (this.expected > model.MAX_SAMPLES) throw new Error("Zu viele Messpunkte für die Visualisierung.");
      this.size = size;
      this.times = new Float64Array(this.expected);
      this.values = new Float64Array(this.expected);
      this.gaps = new Uint8Array(this.expected);
      this.gapPrefix = new Uint32Array(this.expected + 1);
      this.leaves = 1;
      while (this.leaves < Math.ceil(this.expected / model.BLOCK)) this.leaves *= 2;
      this.minima = new Float64Array(this.leaves * 2).fill(Infinity);
      this.maxima = new Float64Array(this.leaves * 2).fill(-Infinity);
    }

    push(chunk, offset, total) {
      if (this.size === null) this.initialize(total);
      if (total !== this.size || offset !== this.received || !chunk.length || offset + chunk.length > total) {
        throw new Error("Nicht zusammenhängender Visualisierungs-Datenstrom.");
      }
      const end = offset + chunk.length;
      if (offset < 512) this.header.set(chunk.subarray(0, Math.min(chunk.length, 512 - offset)), offset);
      if (!this.metadata && end >= 512) {
        this.metadata = headerInfo(this.header, this.name);
        this.rate = this.metadata.sample_rate_sps;
        if (![125, 250, 500].includes(this.rate)) throw new Error("Unbekannte Abtastrate im Aufzeichnungsheader.");
      }
      const first = this.count;
      for (let position = Math.max(offset, 512), stop = Math.min(end, total - 512); position < stop;) {
        const length = Math.min(12 - this.pending, stop - position);
        this.record.set(chunk.subarray(position - offset, position - offset + length), this.pending);
        this.pending += length;
        position += length;
        if (this.pending !== 12) continue;
        this.pending = 0;
        this.appendRecord();
      }
      // Recompute only the index branches affected by this chunk's new samples.
      if (this.count > first) {
        let left = this.leaves + Math.floor(first / model.BLOCK);
        let right = this.leaves + Math.floor((this.count - 1) / model.BLOCK);
        while (left > 1) {
          left = Math.floor(left / 2); right = Math.floor(right / 2);
          for (let node = left; node <= right; ++node) {
            this.minima[node] = Math.min(this.minima[node * 2], this.minima[node * 2 + 1]);
            this.maxima[node] = Math.max(this.maxima[node * 2], this.maxima[node * 2 + 1]);
          }
        }
      }
      this.received = end;
    }

    appendRecord() {
      const view = new DataView(this.record.buffer);
      const sample = view.getUint32(0, true), timestamp = view.getUint32(4, true), value = view.getInt32(8, true);
      if (this.previousTime !== null && this.previousTime - timestamp > 0x80000000) this.wrap += 0x100000000;
      const seconds = (timestamp + this.wrap) / 1000000;
      if (!this.count) this.origin = seconds;
      const time = seconds - this.origin;
      if (this.count && time <= this.times[this.count - 1]) throw new Error("Zeitstempel der Aufzeichnung steigen nicht an.");
      const gap = this.count && ((sample - this.previousSample + 0x100000000) % 0x100000000 !== 1
        || time - this.times[this.count - 1] > 1.8 / this.rate) ? 1 : 0;
      this.times[this.count] = time;
      this.values[this.count] = value;
      this.gaps[this.count] = gap;
      this.gapCount += gap;
      this.gapPrefix[this.count + 1] = this.gapCount;
      const node = this.leaves + Math.floor(this.count / model.BLOCK);
      this.minima[node] = Math.min(this.minima[node], value);
      this.maxima[node] = Math.max(this.maxima[node], value);
      this.previousTime = timestamp;
      this.previousSample = sample;
      ++this.count;
    }

    snapshot() {
      // subarray ist eine Sicht auf wachsende Arrays, keine unveränderliche Kopie.
      // Nur den tatsächlich gefüllten Bereich für Suche und Rendering freigeben.
      return {
        times: this.times.subarray(0, this.count), values: this.values.subarray(0, this.count),
        gaps: this.gaps.subarray(0, this.count), minima: this.minima, maxima: this.maxima,
        gapPrefix: this.gapPrefix, leaves: this.leaves, rate: this.rate,
        metadata: this.metadata, origin: this.origin, gapCount: this.gapCount,
      };
    }

    estimatedDuration() {
      return Math.max(1 / this.rate, (this.expected - 1) / this.rate,
        this.count ? this.times[this.count - 1] : 0);
    }

    finish(metadata) {
      // Der Aufrufer liefert separat geprüfte Footer-/ggf. Transportmetadaten.
      // Dieser Dekoder selbst berechnet keinen Gesamtdateihash.
      if (this.received !== this.size || this.count !== this.expected || this.pending
        || metadata.footer_samples_written !== this.count || !this.count) {
        throw new Error("Aufzeichnung ist unvollständig oder enthält keine Messpunkte.");
      }
      this.metadata = metadata;
      return this.snapshot();
    }
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EkgBinaryStream;
