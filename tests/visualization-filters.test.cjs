"use strict";

// Synthetische Sinusse prüfen Frequenzantwort; direkte Referenz prüft QRS-Arithmetik.
// Zusätzlich Segmentreset, unveränderte Rohdaten und Worker-Transfer prüfen.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Filters = require("../visualization-filters.js");
const Csv = require("../visualization-data.js");

const settings = (kind, frequency, q = 30) => ({ [kind]: { enabled: true, frequency, q } });
function gain(kind, cutoff, frequency, rate = 500) {
  // A narrow notch close to Nyquist can ring for many seconds.
  const n = rate * (kind === "notch" ? 120 : 20);
  const values = Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * frequency * i / rate));
  const result = Filters.apply(values, new Uint8Array(n), rate, settings(kind, cutoff));
  let input = 0, output = 0;
  for (let i = n / 2; i < n; ++i) { input += values[i] ** 2; output += result[i] ** 2; }
  return Math.sqrt(output / input);
}

test("LP/HP sind Butterworth 2. Ordnung mit −3 dB bei Grenzfrequenz und korrekten Durchlass-/Sperrbereichen", () => {
  for (const kind of ["lp", "hp"]) assert.ok(Math.abs(gain(kind, 20, 20) - Math.SQRT1_2) < 1e-6);
  assert.ok(gain("lp", 20, 2) > .99);
  assert.ok(gain("lp", 20, 100) < .04);
  assert.ok(gain("hp", 20, 2) < .011);
  assert.ok(gain("hp", 20, 100) > .99);
});

test("Notch unterdrückt 50/60-Hz-Störung und erhält benachbarte Nutzfrequenzen", () => {
  for (const rate of [125, 250, 500]) {
    for (const frequency of [50, 60]) assert.ok(gain("notch", frequency, frequency, rate) < 1e-6);
    assert.ok(gain("notch", 50, 10, rate) > .99);
  }
});

test("Rohdaten bleiben unverändert; Reset liefert exakte Werte; Lücken initialisieren jedes Segment separat", () => {
  const raw = Float64Array.from({ length: 1000 }, (_, i) => 100 + Math.sin(i));
  const original = raw.slice(), gaps = new Uint8Array(raw.length);
  gaps[400] = 1;
  const config = { ...settings("hp", .5), ...settings("lp", 40), ...settings("notch", 50) };
  const output = Filters.apply(raw, gaps, 250, config);
  assert.deepEqual(raw, original);
  assert.deepEqual(Filters.apply(raw, gaps, 250, {}), original);
  const segment = Filters.apply(raw.subarray(400), new Uint8Array(600), 250, config);
  assert.deepEqual(output.subarray(400), segment);
  const constant = new Float64Array(500).fill(123456);
  for (const kind of ["hp", "lp", "notch"]) {
    const filtered = Filters.apply(constant, new Uint8Array(500), 250, settings(kind, kind === "hp" ? .5 : 40));
    assert.ok(filtered.every((value) => Math.abs(value - (kind === "hp" ? 0 : 123456)) < 1e-5));
  }
});

test("Ungültige Parameter werden abgewiesen statt an Nyquist oder mit falschem Band zu filtern", () => {
  for (const frequency of [0, -1, 125, Infinity, NaN]) assert.throws(() => Filters.validate(250, settings("lp", frequency)), /Frequenz/);
  for (const q of [0, 101, NaN]) assert.throws(() => Filters.validate(250, settings("notch", 50, q)), /Güte/);
  assert.throws(() => Filters.validate(250, { ...settings("hp", 40), ...settings("lp", 20) }), /HP-Grenzfrequenz/);
  assert.throws(() => Filters.validate(null, {}), /Abtastrate/);
});

test("Filter-Worker liefert gefilterte Arrays und neuen exakten Index, Fehler werden gemeldet", () => {
  let response;
  const self = { postMessage(result) { response = result; } };
  const context = vm.createContext({ self, importScripts() {}, EkgCsv: Csv, EkgFilters: Filters });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../visualization-filter-worker.js"), "utf8"), context);
  const values = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 2000), gaps = new Uint8Array(1000);
  self.onmessage({ data: { values, gaps, rate: 250, settings: settings("lp", 40) } });
  assert.equal(response.values.length, 1000);
  assert.deepEqual(Csv.extrema({ values: response.values, ...response.index }, 0, 1000), {
    min: Math.min(...response.values), max: Math.max(...response.values),
  });
  self.onmessage({ data: { values, gaps, rate: 250, settings: settings("lp", 125) } });
  assert.match(response.error, /Nyquist/);
});

test("QRS: feste 5-Punkt-Ableitung, Quadrat und kausaler Mittelwert stimmen mit direkter Referenz überein", () => {
  for (const rate of [125, 250, 500]) {
    const values = Float64Array.from({ length: 400 }, (_, i) => i < 200 ? i : 400 - i);
    const gaps = new Uint8Array(values.length), windowMs = 150;
    const original = values.slice();
    const result = Filters.apply(values, gaps, rate, { qrs: { enabled: true, windowMs } });
    const length = Math.max(1, Math.round(windowMs * rate / 1000));
    const squared = Array.from(values, (_, i) => {
      const x = (offset) => values[Math.max(0, i - offset)];
      return ((x(0) + 2 * x(1) - 2 * x(3) - x(4)) * rate / 8) ** 2;
    });
    for (let i = 0; i < result.length; ++i) {
      const reference = squared.slice(Math.max(0, i - length + 1), i + 1).reduce((a, b) => a + b, 0) / length;
      assert.ok(Math.abs(result[i] - reference) < 1e-8);
      assert.ok(result[i] >= 0);
    }
    assert.deepEqual(values, original);
    assert.equal(result[100], rate ** 2); // A unit ramp has derivative fs, not an arbitrary gain.
  }
});

test("QRS kommt nach HP/LP/Notch; Datenlücken starten Ableitung und Integrator unabhängig neu", () => {
  const values = Float64Array.from({ length: 1000 }, (_, i) => 10000 + Math.round(200 * Math.sin(i / 4)));
  const gaps = new Uint8Array(1000); gaps[400] = 1; gaps[401] = 1;
  const band = { ...settings("hp", .5), ...settings("lp", 40), ...settings("notch", 50) };
  const qrs = { qrs: { enabled: true, windowMs: 150 } };
  const together = Filters.apply(values, gaps, 250, { ...band, ...qrs });
  assert.deepEqual(together, Filters.apply(Filters.apply(values, gaps, 250, band), gaps, 250, qrs));
  assert.equal(together[400], 0);
  assert.equal(together[401], 0);
  assert.deepEqual(together.subarray(401), Filters.apply(values.subarray(401), new Uint8Array(599), 250, { ...band, ...qrs }));
  assert.ok(Filters.apply(new Float64Array(100).fill(123456), new Uint8Array(100), 250, qrs).every((x) => x === 0));
  for (const windowMs of [0, -1, 1001, NaN, Infinity]) {
    assert.throws(() => Filters.validate(250, { qrs: { enabled: true, windowMs } }), /Integrationsfenster/);
  }
  const single = Filters.apply(Float64Array.of(100), Uint8Array.of(0), 125, { qrs: { enabled: true, windowMs: 1 } });
  assert.deepEqual([...single], [0]);
  assert.match(Filters.describe({ ...band, ...qrs }), /HP.*LP.*NOTCH.*QRS-Energie.*150 ms/);
});
