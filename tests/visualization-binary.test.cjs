"use strict";

// Lokalen Datei-Worker in Node-VM ausführen: BIN/CSV-Gleichheit und ungültige Abschlüsse.
// Lokales Öffnen darf niemals eine nicht erfolgte SD-SHA-256-Verifikation behaupten.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Csv = require("../visualization-data.js");
const { recordingMetadata, recordingCsv } = require("../files.js");
const { recording } = require("./file-fixtures.cjs");

async function load(bytes, name) {
  let response;
  const context = vm.createContext({
    EkgCsv: Csv, EkgBinaryStream: require("../visualization-stream.js"), recordingMetadata,
    TextDecoder, importScripts() {},
    self: { postMessage(message, transfer) { response = { message, transfer }; } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../visualization-worker.js"), "utf8"), context);
  const file = new Blob([bytes]);
  Object.defineProperty(file, "name", { value: name });
  await context.self.onmessage({ data: file });
  return response;
}

test("Lokale BIN wird exakt wie CSV dargestellt, einschließlich Überläufen, Lücken und Metadaten", async () => {
  const binary = recording([[0xFFFFFFFF, 0xFFFFFF00, -123], [0, 1744, 8388607], [2, 5744, -8388608]],
    { participant: "Änne 🫀", comment: "Lokal\nKommentar" });
  for (const name of ["EKG00008.BIN", "aufnahme.bin", "kopierte-datei"]) {
    const { message, transfer } = await load(binary, name);
    assert.equal(message.error, undefined);
    assert.deepEqual(Buffer.from(message.binary), Buffer.from(binary));
    assert.equal(transfer.length, 7);
    const reference = Csv.parse(await (await recordingCsv(binary, name)).text());
    assert.deepEqual([...message.data.values], [...reference.values]);
    assert.deepEqual([...message.data.times], [...reference.times]);
    assert.deepEqual([...message.data.gaps], [...reference.gaps]);
    assert.equal(message.data.metadata.participant, "Änne 🫀");
    assert.equal(message.data.metadata.comment, "Lokal\nKommentar");
    assert.equal(message.data.metadata.transfer_verification, "not_verified_local_file");
    assert.equal(message.data.metadata.source_binary_sha256, undefined);
  }
});

test("Lokaler BIN-zu-CSV-Export enthält Rohdaten und keine erfundene SD-Prüfsumme", async () => {
  const binary = recording([[0, 1000, -42], [1, 3000, 123]]);
  const blob = await recordingCsv(binary, "EKG00008.BIN", { localFile: true });
  const text = await blob.text(), data = Csv.parse(text);
  assert.deepEqual([...data.values], [-42, 123]);
  assert.equal(data.metadata.transfer_verification, "not_verified_local_file");
  assert.ok(!text.includes("source_binary_sha256"));
  assert.ok(!text.includes("# source_binary_bytes:"));
});

test("Unvollständige, ungültige und leere BIN-Aufnahmen werden vor Anzeige/Export zurückgewiesen", async () => {
  const binary = recording();
  const brokenHeader = binary.slice(); brokenHeader[0] = 0;
  const brokenFooter = binary.slice(); brokenFooter[brokenFooter.length - 512] = 0;
  const wrongCount = binary.slice(); new DataView(wrongCount.buffer).setUint32(wrongCount.length - 512 + 12, 123, true);
  for (const bytes of [brokenHeader, brokenFooter, wrongCount, binary.slice(0, -1), recording([])]) {
    const { message } = await load(bytes, "test.bin");
    assert.equal(message.data, undefined);
    assert.equal(message.binary, undefined);
    assert.equal(typeof message.error, "string");
  }
});

test("BIN-Dateigrößenlimit wird schon vor dem Einlesen geprüft", async () => {
  let message;
  const context = vm.createContext({ EkgCsv: Csv, importScripts() {}, self: { postMessage(result) { message = result; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../visualization-worker.js"), "utf8"), context);
  await context.self.onmessage({ data: { name: "test.BIN", size: 32 * 1024 * 1024 + 1,
    arrayBuffer() { throw new Error("Datei darf nicht gelesen werden"); } } });
  assert.match(message.error, /32 MiB/);
});
