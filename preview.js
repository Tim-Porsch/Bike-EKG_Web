"use strict";

// Decoder und begrenzter Verlauf für das interne Vorschauprotokoll, nicht Display v2.
// Zahlenwerte sind signed int32 in Little Endian; Filtermodus kommt aus dem Status.

const PREVIEW_SERVICE = "7f520001-1212-efde-1523-785feabcd123";
const PREVIEW_DATA = "7f520002-1212-efde-1523-785feabcd123";
const PREVIEW_STATUS = "7f520003-1212-efde-1523-785feabcd123";

function decodePreviewStatus(view) {
  if (view.byteLength !== 20 || view.getUint8(0) !== 0xC1 || view.getUint8(1) !== 1
    || ![1, 2].includes(view.getUint8(7))) throw new Error("Unbekanntes Vorschauformat.");
  const result = {
    session: view.getUint16(2, true), rate: view.getUint16(4, true), active: Boolean(view.getUint8(6) & 1),
    filtered: view.getUint8(7) === 2,
    sourceEnd: view.getUint32(8, true), acquisitionDropped: view.getUint32(12, true), txDropped: view.getUint32(16, true),
  };
  if (![125, 250, 500].includes(result.rate) && (result.active || result.rate !== 0)) {
    throw new Error("Unbekannte Vorschau-Abtastrate.");
  }
  return result;
}

function decodePreviewData(view) {
  if (view.byteLength < 16 || view.getUint8(0) !== 0xD1 || view.getUint8(1) !== 1
    || view.getUint8(11) !== 0) throw new Error("Ungültiges Vorschaupaket.");
  const count = view.getUint8(10);
  if (!count || count > 58 || view.byteLength !== 12 + 4 * count) throw new Error("Ungültige Vorschau-Paketlänge.");
  return {
    session: view.getUint16(2, true), sequence: view.getUint16(4, true), first: view.getUint32(6, true),
    values: Array.from({ length: count }, (_, index) => view.getInt32(12 + 4 * index, true)),
  };
}

class PreviewModel {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.keepSeconds = 10;
    this.reset();
  }

  setKeepSeconds(seconds) {
    if (![5, 10, 20, 30, 60].includes(seconds)) throw new Error("Ungültiges Vorschau-Zeitfenster.");
    this.keepSeconds = seconds;
    this.trim();
  }

  trim() {
    // Ablauf des sichtbaren Zeitfensters ist kein Datenverlust; Gesamtzähler behalten.
    const cutoff = this.position - this.rate * this.keepSeconds;
    let remove = 0;
    while (remove < this.points.length && this.points[remove].position < cutoff) ++remove;
    if (remove) this.points.splice(0, remove);
  }

  reset() {
    this.session = null;
    this.rate = 0;
    this.active = false;
    this.filtered = false;
    this.points = [];
    this.received = this.missingBetweenFrames = this.packetGaps = this.invalid = 0;
    this.acquisitionDropped = this.txDropped = this.sourceEnd = 0;
    this.expectedSample = this.expectedSequence = this.position = 0;
    this.lastArrival = null;
  }

  status(view) {
    const status = decodePreviewStatus(view);
    if (!status.rate) return;
    if (status.session !== this.session) {
      if (this.session !== null && ((status.session - this.session) & 0xFFFF) >= 0x8000) return;
      this.reset();
      this.session = status.session;
      this.rate = status.rate;
    } else if (status.rate !== this.rate) {
      throw new Error("Abtastrate innerhalb der Vorschau geändert.");
    }
    this.active = status.active;
    this.filtered = status.filtered;
    this.sourceEnd = status.sourceEnd;
    this.acquisitionDropped = status.acquisitionDropped;
    this.txDropped = status.txDropped;
  }

  data(view) {
    const frame = decodePreviewData(view);
    if (frame.session !== this.session || !this.rate) return false;
    const gap = (frame.first - this.expectedSample) >>> 0;
    const packetGap = (frame.sequence - this.expectedSequence) & 0xFFFF;
    // Old/duplicate packets must not add samples or draw backwards. Natural
    // uint32 sample and uint16 sequence rollovers are accepted.
    if (gap >= 0x80000000) return false;
    this.missingBetweenFrames += gap;
    this.packetGaps += packetGap;
    this.position += gap;
    frame.values.forEach((value, index) => {
      this.points.push({ position: this.position++, value, gap: index === 0 && gap > 0 });
    });
    this.expectedSample = (frame.first + frame.values.length) >>> 0;
    this.expectedSequence = (frame.sequence + 1) & 0xFFFF;
    this.received += frame.values.length;
    this.lastArrival = this.now();
    this.trim();
    return true;
  }

  get missing() {
    // During transmission, some source samples are still in flight. Only final
    // metadata can account for an undelivered tail. These counters overlap and
    // must never be summed with the observed sample-number gaps.
    return this.active
      ? Math.max(this.missingBetweenFrames, this.acquisitionDropped + this.txDropped)
      : Math.max(0, this.sourceEnd - this.received);
  }

  rightEdge() {
    // Nur die Darstellung zwischen Paketen fortschieben, keine Samples interpolieren.
    return this.position + (this.active && this.lastArrival !== null
      ? Math.max(0, this.now() - this.lastArrival) / 1000 * this.rate : 0);
  }
}

class PreviewPlot {
  constructor(canvas, model) { this.canvas = canvas; this.model = model; }

  draw() {
    const canvas = this.canvas;
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = Math.max(280, canvas.clientWidth || 800);
    const height = canvas.clientHeight || 420;
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    const left = 78, top = 28, bottom = height - 32, right = width - 16;
    const model = this.model;
    const end = model.rightEdge();
    const span = (model.rate || 250) * model.keepSeconds;
    const start = end - span;
    const points = model.points.filter((point) => point.position >= start);
    let minimum = Infinity, maximum = -Infinity;
    for (const point of points) { minimum = Math.min(minimum, point.value); maximum = Math.max(maximum, point.value); }
    if (!points.length) { minimum = -1; maximum = 1; }
    const pad = Math.max(1, (maximum - minimum) * 0.1);
    minimum -= pad; maximum += pad;
    context.font = "12px system-ui";
    context.fillStyle = "#536675";
    context.fillText(model.filtered ? "ADC-Wert (gefiltert)" : "ADC-Rohwert", left, 16);
    context.strokeStyle = "#e0e7ed";
    context.lineWidth = 1;
    for (let i = 0; i <= 5; ++i) {
      const x = left + (right - left) * i / 5;
      context.beginPath(); context.moveTo(x, top); context.lineTo(x, bottom); context.stroke();
      context.textAlign = "center";
      context.fillText(`${-model.keepSeconds + model.keepSeconds * i / 5} s`, x, height - 10);
    }
    for (let i = 0; i <= 4; ++i) {
      const y = top + (bottom - top) * i / 4;
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
      context.textAlign = "right";
      context.fillText(Math.round(maximum - (maximum - minimum) * i / 4).toLocaleString("de-DE"), left - 9, y + 4);
    }
    context.save();
    context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip();
    context.beginPath();
    let connected = false;
    context.fillStyle = "#14685c";
    for (const point of points) {
      const x = left + (point.position - start) / span * (right - left);
      const y = bottom - (point.value - minimum) / (maximum - minimum) * (bottom - top);
      if (!connected || point.gap) {
        context.moveTo(x, y);
        context.fillRect(x - 1, y - 1, 2, 2);
      } else context.lineTo(x, y);
      connected = true;
    }
    context.strokeStyle = "#14685c";
    context.lineWidth = 1.5;
    context.stroke();
    context.restore();
    if (!points.length) {
      context.textAlign = "center";
      context.fillText(model.active ? "Warte auf Messwerte …" : "Vorschau starten, um das Signal zu prüfen.", (left + right) / 2, height / 2);
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PREVIEW_SERVICE, PREVIEW_DATA, PREVIEW_STATUS, decodePreviewStatus, decodePreviewData, PreviewModel, PreviewPlot };
}
