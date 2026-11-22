"use strict";

// UI-Transfervertrag im simulierten DOM: vorläufige Daten, Abschluss und Rücknahme
// bei Fehler/Abbruch. Rohdaten-Export muss unabhängig von Darstellungsfiltern bleiben.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function viewer() {
  const nodes = new Map();
  const workers = [];
  const downloads = [];
  function node(id) {
    if (!nodes.has(id)) {
      const element = {
        dataset: {}, style: {}, hidden: false, disabled: false, textContent: "", listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
        setAttribute() {}, removeAttribute() {}, click() {}, focus() {}, scrollIntoView() {},
        replaceChildren() {}, append() {},
      };
      element.parentElement = element;
      nodes.set(id, element);
    }
    return nodes.get(id);
  }
  const window = { addEventListener() {} };
  const context = vm.createContext({
    window, document: { getElementById: node, createElement: () => node("temporary"), querySelectorAll: () => [], addEventListener() {} },
    EkgBinaryStream: require("../visualization-stream.js"),
    EkgCsv: require("../visualization-data.js"),
    EkgReport: require("../visualization-report.js"),
    EkgFilters: require("../visualization-filters.js"),
    recordingCsv: require("../files.js").recordingCsv,
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    Worker: class {
      constructor(url) { this.url = url; workers.push(this); }
      postMessage(message) { this.message = message; }
      terminate() { this.terminated = true; }
    },
    requestAnimationFrame: () => 1, clearTimeout, setTimeout: () => 1,
    ResizeObserver: class { observe() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../visualization.js"), "utf8"), context);
  return { node, workers, downloads, api: window.EkgViewer };
}

test("Lokale BIN bietet CSV-Download ohne erneuten BLE-Zugriff oder SHA-256-Erfolgsbehauptung", async () => {
  const { node, workers, downloads } = viewer();
  const bytes = require("./file-fixtures.cjs").recording([[0, 1000, -100], [1, 3000, 200]]);
  const stream = new (require("../visualization-stream.js"))("lokal.bin");
  stream.push(bytes, 0, bytes.length);
  const data = stream.finish({ ...require("../files.js").recordingMetadata(bytes, "lokal.bin"), transfer_verification: "not_verified_local_file" });
  node("csv-file").listeners.change({ target: { files: [{ size: bytes.length, name: "lokal.bin" }] } });
  workers[0].onmessage({ data: { data, binary: bytes } });
  assert.equal(node("viewer-transfer").hidden, false);
  assert.equal(node("viewer-transfer-progress").hidden, true);
  assert.equal(node("viewer-transfer-cancel").hidden, true);
  assert.equal(node("viewer-transfer-csv").hidden, false);
  assert.equal(node("viewer-transfer-csv").disabled, false);
  assert.match(node("viewer-transfer-status").textContent, /Kein SHA-256-Abgleich/);
  await node("viewer-transfer-csv").listeners.click();
  const exported = require("../visualization-data.js").parse(await downloads[0].text());
  assert.deepEqual([...exported.values], [-100, 200]);
  assert.equal(exported.metadata.transfer_verification, "not_verified_local_file");
  assert.equal(node("temporary").download, "lokal.csv");

  // A failed replacement must leave the previously loaded recording usable.
  node("csv-file").listeners.change({ target: { files: [{ size: 100, name: "kaputt.bin" }] } });
  workers[1].onmessage({ data: { error: "Abschlussblock fehlt" } });
  assert.match(node("csv-status").textContent, /bisherige Ansicht bleibt erhalten/);
  await node("viewer-transfer-csv").listeners.click();
  assert.equal(downloads.length, 2);
  assert.equal(node("temporary").download, "lokal.csv");
});

test("Darstellungsfilter verwenden immer Originaldaten, markieren den Bericht und lassen sich exakt zurücksetzen", () => {
  const { node, workers, api } = viewer();
  node("csv-file").listeners.change({ target: { files: [{ size: 100, name: "test.csv" }] } });
  const model = require("../visualization-data.js");
  const raw = model.parse("# sample_rate_sps: 250\n# signal_format: \"raw_adc_counts\"\ntimestamp_s,adc_counts\n0,100\n0.004,200\n0.008,50\n");
  workers[0].onmessage({ data: { data: raw } });
  assert.equal(node("viewer-filters").disabled, false);
  node("viewer-filter-lp").checked = true;
  node("viewer-filter-lp-hz").value = "40";
  node("viewer-filter-qrs").checked = true;
  node("viewer-filter-qrs-ms").value = "150";
  node("viewer-filter-apply").listeners.click();
  const worker = workers[1];
  assert.equal(worker.message.values, raw.values);
  assert.equal(node("viewer-export").disabled, true);
  const values = require("../visualization-filters.js").apply(raw.values, raw.gaps, raw.rate, worker.message.settings);
  worker.onmessage({ data: { values, index: model.buildIndex(values, raw.gaps) } });
  assert.match(node("viewer-description").textContent, /Darstellungsfilter: LP 40 Hz/);
  assert.match(node("viewer-description").textContent, /QRS-Energiekurve, \(Counts\/s\)²/);
  assert.ok(!node("viewer-description").textContent.includes("ungefilterte Rohdaten"));
  assert.equal(node("viewer-export").disabled, false);
  node("viewer-filter-reset").listeners.click();
  assert.match(node("viewer-description").textContent, /ungefilterte Rohdaten/);
  assert.equal(node("viewer-filter-lp").checked, true);
  assert.equal(node("viewer-filter-lp-hz").value, "40");
  assert.equal(node("viewer-filter-qrs").checked, true);
  assert.equal(node("viewer-filter-qrs-ms").value, "150");
  assert.deepEqual([...raw.values], [100, 200, 50]);

  node("viewer-filter-apply").listeners.click();
  assert.equal(workers[2].message.values, raw.values);
  const transfer = api.begin("EKG00008.BIN", () => {});
  assert.equal(workers[2].terminated, true);
  assert.equal(node("viewer-filters").disabled, true);
  workers[2].onmessage({ data: { values, index: model.buildIndex(values, raw.gaps) } });
  assert.equal(node("viewer-filters").disabled, true); // Ignore a late filter result during BLE transfer.
  transfer.fail(Object.assign(new Error("cancel"), { name: "AbortError" }));
  assert.equal(node("viewer-filters").disabled, false);
  assert.match(node("viewer-description").textContent, /ungefilterte Rohdaten/);
});

for (const aborted of [true, false]) test(`Übertragungsende räumt Balken und Aktionen auf (${aborted ? "Abbruch" : "Fehler"}); Neustart setzt Ansicht zurück`, () => {
  const { node, api } = viewer();
  const handle = api.begin("EKG00008.BIN", () => {});
  assert.equal(node("viewer-transfer-progress").hidden, false);
  assert.equal(node("viewer-transfer-cancel").hidden, false);
  node("viewer-transfer-progress").value = 42;
  handle.fail(Object.assign(new Error("Testfehler"), { name: aborted ? "AbortError" : "Error" }));
  assert.equal(node("viewer-transfer-progress").hidden, true);
  assert.equal(node("viewer-transfer-progress").value, 0);
  assert.equal(node("viewer-transfer-cancel").hidden, true);
  assert.equal(node("viewer-transfer-csv").hidden, true);
  assert.equal(node("viewer-transfer-status").dataset.state, aborted ? "cancelled" : "error");
  assert.match(node("viewer-transfer-status").textContent, /Vorläufige Daten verworfen/);
  api.begin("EKG00009.BIN", () => {});
  assert.equal(node("viewer-transfer-progress").hidden, false);
  assert.equal(node("viewer-transfer-cancel").hidden, false);
  assert.equal(node("viewer-transfer-cancel").disabled, false);
  assert.equal(node("viewer-transfer-status").dataset.error, "false");
  assert.equal(node("viewer-transfer-status").dataset.state, "loading");
});
