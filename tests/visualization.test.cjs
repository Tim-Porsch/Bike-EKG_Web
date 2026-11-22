"use strict";

// Parser, Suchindex und Berichtsgeometrie ohne Browserhardware prüfen.
// Canvas-Doubles kontrollieren Zeichenaufrufe, nicht das fertige Pixelbild.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Csv = require("../visualization-data.js");
const Report = require("../visualization-report.js");
const { recordingCsv } = require("../files.js");
const { recording } = require("./file-fixtures.cjs");

const csv = (rows, metadata = "") => `${metadata}sample_number,timestamp_us,timestamp_s,adc_counts\n${rows.join("\n")}\n`;

test("CSV-Betrachter liest tatsächlichen Download inkl. UTF-8-Metadaten und Timestampüberlauf", async () => {
  const bytes = recording([[0, 0xFFFFFF00, -8388608], [1, 1744, 8388607], [3, 5744, -42]],
    { participant: "Änne 🚲", comment: "Zeile 1\nZeile 2, Kommentar" });
  const blob = await recordingCsv(bytes, "EKG00001.BIN");
  const data = Csv.parse(await blob.text());
  assert.equal(data.metadata.participant, "Änne 🚲");
  assert.equal(data.metadata.comment, "Zeile 1\nZeile 2, Kommentar");
  assert.deepEqual([...data.values], [-8388608, 8388607, -42]);
  assert.ok(Math.abs(data.times[1] - .002) < 1e-9);
  assert.deepEqual([...data.gaps], [0, 0, 1]);
  assert.equal(data.gapCount, 1);
  assert.equal(data.rate, 500);
});

test("BOM, CRLF, zusätzliche Spalten und Abtastratenschätzung ohne Metadaten", () => {
  const data = Csv.parse('\uFEFFtimestamp_s,adc_counts,extra\r\n30,-5,a\r\n30.004,7,b\r\n30.008,1,c\r\n');
  assert.equal(data.origin, 30);
  assert.equal(data.times[0], 0);
  assert.ok(Math.abs(data.rate - 250) < 1e-6);
  assert.equal(data.gapCount, 0);
});

test("Probennummernüberlauf ist keine Lücke, Zeitlücken bleiben erkennbar", () => {
  const data = Csv.parse(csv(["4294967295,0,1,1", "0,0,1.002,2", "1,0,1.020,3"], '# sample_rate_sps: 500\n'));
  assert.deepEqual([...data.gaps], [0, 0, 1]);
});

test("Leere und beschädigte CSVs werden nicht stillschweigend dargestellt", () => {
  for (const text of ["", "time,value\n1,2", csv([]), csv(["0,0,1,NaN"]), csv(["0,0,1,"]),
    csv(["0,0,1,1.5"]), csv(["0,0,1,2147483648"]), csv(["-1,0,1,2"]),
    csv(["0,0,1,2", "1,0,1,3"]), csv(["0,0,1,2", "1,0,0.5,3"]),
    csv(["0,0,-1,2"]), csv(["0,0,Infinity,2"]), csv(["0,0,1,2,extra"]),
    csv(["0,0,1,2"], '# participant: kaputtes JSON\n'), csv(["0,0,1,2"], '# csv_format_version: 2\n'),
    "timestamp_s,adc_counts,adc_counts\n1,2,3"]) assert.throws(() => Csv.parse(text));
});

test("Eine einzelne Probe und konstantes Signal sind gültig", () => {
  const single = Csv.parse("timestamp_s,adc_counts\n5,42");
  assert.equal(single.rate, null);
  assert.deepEqual(Csv.extrema(single, 0, 1), { min: 42, max: 42 });
  assert.deepEqual(Csv.extrema(single, 0, 0), { min: Infinity, max: -Infinity });
});

test("Index liefert exakte sichtbare Minima/Maxima einschließlich Blockrändern und schmaler Spitzen", () => {
  const values = Float64Array.from({ length: 1027 }, (_, i) => (i * 117) % 719 - 350);
  values[511] = 8388607;
  const data = { values, ...Csv.buildIndex(values, new Uint8Array(values.length)) };
  for (let start = 0; start < values.length; start += 7) {
    for (const length of [0, 1, 2, 63, 64, 65, 127, 257, 10000]) {
      const end = Math.min(values.length, start + length);
      const direct = values.subarray(start, end);
      assert.deepEqual(Csv.extrema(data, start, end), { min: Math.min(...direct), max: Math.max(...direct) });
    }
  }
  assert.equal(Csv.extrema(data, 500, 520).max, 8388607);
  assert.notEqual(Csv.extrema(data, 512, 520).max, 8388607);
});

test("Binäre Zeitsuche und begrenztes Zeitfenster funktionieren auch an den Grenzen", () => {
  const times = new Float64Array([0, .002, .004, .010]);
  assert.equal(Csv.lowerBound(times, -.001), 0);
  assert.equal(Csv.lowerBound(times, .004), 2);
  assert.equal(Csv.lowerBound(times, .005), 3);
  assert.equal(Csv.lowerBound(times, 1), 4);
  assert.deepEqual(Csv.clampWindow(-10, 5, 30, .004), { start: 0, end: 5 });
  assert.deepEqual(Csv.clampWindow(29, 5, 30, .004), { start: 25, end: 30 });
  assert.deepEqual(Csv.clampWindow(15, 50, 30, .004), { start: 0, end: 30 });
  assert.deepEqual(Csv.clampWindow(0, 0, 30, .004), { start: 0, end: .004 });
});

test("Worker übergibt alle großen Arrays als Transfer und meldet Parserfehler", async () => {
  const messages = [];
  const context = vm.createContext({
    EkgCsv: Csv, TextDecoder, importScripts() {},
    self: { postMessage(message, transfer) { messages.push({ message, transfer }); } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../visualization-worker.js"), "utf8"), context);
  const file = new Blob([csv(["0,0,1,-2", "1,0,1.002,3"])]);
  await context.self.onmessage({ data: file });
  assert.equal(messages[0].message.data.values.length, 2);
  assert.equal(messages[0].transfer.length, 6);
  await context.self.onmessage({ data: new Blob(["invalid"]) });
  assert.equal(typeof messages[1].message.error, "string");
  await context.self.onmessage({ data: { size: Csv.MAX_BYTES + 1 } });
  assert.match(messages[2].message.error, /256 MiB/);
});

test("Y-Auswahl begrenzt beide Griffe ohne Kreuzung und verschiebt das Band ohne Zoomänderung", () => {
  const range = { min: -20, max: 40 }, domain = { min: -100, max: 100 };
  assert.deepEqual(Csv.adjustValueRange(range, domain, "upper", -30), { min: -20, max: 10 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "lower", 20), { min: 0, max: 40 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "upper", 1000), { min: -20, max: 100 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "lower", -1000), { min: -100, max: 40 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "upper", -1000), { min: -20, max: -19.99 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "lower", 1000), { min: 39.99, max: 40 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "move", 10), { min: -10, max: 50 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "move", 1000), { min: 40, max: 100 });
  assert.deepEqual(Csv.adjustValueRange(range, domain, "move", -1000), { min: -100, max: -40 });
  assert.deepEqual(range, { min: -20, max: 40 });
});

test("Aufgeräumtes Viewer-Layout enthält alle JS-Verknüpfungen und keine alten Regler", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../visualization.js"), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const match of script.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.has(match[1]), `DOM-ID fehlt: ${match[1]}`);
  for (const removed of ["viewer-zoom-in", "viewer-zoom-out", "viewer-time-scroll", "viewer-y-zoom", "viewer-y-position", "viewer-y-manual"]) {
    assert.ok(!ids.has(removed));
    assert.ok(!script.includes(`"${removed}"`));
  }
  assert.ok(html.indexOf('id="viewer-cursor"') < html.indexOf('id="viewer-canvas"'));
  assert.ok(html.indexOf('id="viewer-help-bubble"') < html.indexOf('id="viewer-canvas"'));
  for (const mode of ["upper", "move", "lower"]) assert.ok(ids.has("viewer-y-" + mode));
  assert.ok(html.indexOf('id="viewer-y-auto"') > html.indexOf('class="viewer-y-column"'));
  assert.match(html, /id="viewer-y-auto"[^>]*aria-label="Y-Achse automatisch skalieren"[^>]*checked/);
  assert.match(html, /id="viewer-export-scale"/);
  assert.match(html, /<option value="4" selected>/);
});

test("Plotbericht enthält Messinformationen, aber verwechselt CSV-Exportzeit nicht mit Messbeginn", () => {
  const data = { rate: 250, gapCount: 0, metadata: {
    exported_utc: "2026-10-19T04:56:54.292Z", device_start_utc: null, device_unix_time: null,
    sample_rate_sps: 250, gain_multiplier: 12, rld_enabled: false, input_name: "normal",
    signal_format: "raw_adc_counts", firmware_version: "0.3.0", participant: "", comment: "",
  } };
  const rows = Report.summary(data, "EKG00002.csv");
  assert.ok(rows.includes("Datei: EKG00002.csv"));
  assert.ok(rows.includes("Datum/Uhrzeit (Messbeginn): nicht im Messsystem gespeichert"));
  assert.ok(rows.includes("Person: -"));
  assert.ok(rows.some((row) => row.includes("250 Samples/s") && row.includes("12×") && row.includes("RLD: Aus")));
  assert.ok(rows.some((row) => row.includes("Bike-EKG Firmware: 0.3.0")));
  assert.ok(!rows.some((row) => row.includes("Kommentar:") || row.includes("2026")));
  data.metadata.participant = "Änne 🚲";
  data.metadata.comment = "Erste Zeile\nZweite Zeile";
  data.metadata.device_start_utc = "2026-10-19T04:56:00Z";
  data.gapCount = 3;
  const complete = Report.summary(data, "zweite.csv");
  assert.ok(complete.includes("Person: Änne 🚲"));
  assert.ok(complete.includes("Kommentar: Erste Zeile\nZweite Zeile"));
  assert.ok(complete.some((row) => row.includes("19.10.2026") && row.includes("04:56:00 UTC")));
  assert.ok(complete.some((row) => row.includes("Datenlücken: 3")));
});

test("Bericht verwendet Unix-Gerätezeit oder weist fehlende Werte und geschätzte Rate aus", () => {
  const rows = Report.summary({ rate: 125, gapCount: 0, metadata: { device_start_utc: "kaputt", device_unix_time: 1700000000 } }, "test.csv");
  assert.ok(rows.some((row) => row.includes("14.11.2023") && row.includes("UTC")));
  assert.ok(rows.some((row) => row.includes("125 Samples/s (geschätzt)")));
});

test("Gemeinsames Bildschirm-/Exportlayout bricht lange Kommentare und Dateinamen um", () => {
  const ctx = { measureText: (text) => ({ width: [...text].length * 6 }) };
  const rows = ["Datei: " + "x".repeat(200) + ".csv", "Kommentar: Hallo\nMehrzeilig 🚲"];
  const report = Report.layout(ctx, 280, rows, "0 – 10 s · Y: -1.120 bis 1.120 Counts (automatisch)", 340);
  assert.ok(report.lines.length > rows.length);
  assert.ok(report.lines.every((line) => ctx.measureText(line).width <= 256));
  assert.ok(report.footer.every((line) => ctx.measureText(line).width <= 256));
  assert.ok(report.plot.top > report.lines.length * 18);
  assert.ok(report.height > report.plot.top + report.plot.height + 40);
  assert.ok(report.lines.includes("Mehrzeilig 🚲"));
  assert.equal(report.lines.filter((line) => line.startsWith("Kommentar:")).length, 1);
});

test("PNG-Export orientiert sich an Full-HD-Pixelanzahl und erhält das Seitenverhältnis ohne Zusatzränder", () => {
  for (const factor of [1, 2, 4]) {
    for (const report of [{ width: 910, height: 639 }, { width: 280, height: 1000 }, { width: 1500, height: 400 }]) {
      const target = Report.exportLayout(report, factor);
      assert.equal(target.x, 0);
      assert.equal(target.y, 0);
      assert.ok(Math.abs(target.width - report.width * target.scale) <= .5);
      assert.ok(Math.abs(target.height - report.height * target.scale) <= .5);
      assert.ok(Math.abs(target.width * target.height / (1920 * 1080 * factor ** 2) - 1) < .002);
    }
  }
  assert.throws(() => Report.exportLayout({ width: 910, height: 639 }, 3));
});

test("Dateiname, Datum und Person werden nur im Wert fett hervorgehoben, auch bei Zeilenumbrüchen", () => {
  const ctx = { measureText: (text) => ({ width: [...text].length * 6 }) };
  const rows = ["Datei: " + "x".repeat(100) + ".csv", "Datum/Uhrzeit (Messbeginn): 19.10.2026, 04:56 UTC", "Person: Änne", "Kommentar: normal"];
  const report = Report.layout(ctx, 280, rows, "0 – 10 s", 340);
  const runs = report.lineRuns.flat();
  assert.ok(runs.some((run) => run.text.trimEnd() === "Datei:" && !run.bold));
  assert.ok(runs.some((run) => run.text === "Person: " && !run.bold));
  assert.ok(runs.some((run) => run.text === "Änne" && run.bold));
  assert.ok(runs.some((run) => run.text === "Datum/Uhrzeit (Messbeginn): " && !run.bold));
  assert.ok(runs.some((run) => run.text.includes("19.10.2026") && run.bold));
  assert.ok(runs.filter((run) => run.text.includes("xxx")).every((run) => run.bold));
  assert.ok(runs.some((run) => run.text === "Kommentar: normal" && !run.bold));
});

test("Nur-Plot-Export entfernt Informationen und reservierte Flächen, ohne den Bildschirmbericht zu ändern", () => {
  const texts = [];
  const ctx = { measureText: (text) => ({ width: text.length * 6 }),
    fillRect() {}, strokeRect() {}, fillText(text) { texts.push(text); } };
  const report = Report.layout(ctx, 910, ["Datei: EKG00002.csv", "Person: Änne"], "0 – 10 s · Y: -100 bis 100", 420);
  const plotOnly = Report.withoutInfo(report);
  assert.equal(plotOnly.height, 420);
  assert.equal(plotOnly.headerHeight, 0);
  assert.equal(plotOnly.plot.top, 24);
  assert.equal(plotOnly.plot.width, report.plot.width);
  assert.equal(plotOnly.plot.height, report.plot.height);
  assert.ok(report.headerHeight > 0 && report.lines.length > 0 && report.footer.length > 0);
  Report.paint(ctx, plotOnly);
  assert.deepEqual(texts, []);
  Report.paint(ctx, report);
  assert.ok(texts.includes("Bike-EKG"));
});
