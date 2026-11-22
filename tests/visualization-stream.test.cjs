"use strict";

// Beliebige Chunkgrenzen mit Referenzdaten vergleichen, auch mitten im 12-Byte-Record.
// Index und Zeitachse müssen während des Wachstums ebenso stimmen wie am Dateiende.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Stream = require("../visualization-stream.js");
const Csv = require("../visualization-data.js");
const { recordingCsv, recordingMetadata } = require("../files.js");
const { recording } = require("./file-fixtures.cjs");

test("Live-Dekoder verarbeitet beliebige Chunkgrenzen, Timestamp-/Probennummernüberläufe und Lücken", async () => {
  const bytes = recording([[0xFFFFFFFF, 0xFFFFFF00, -1000], [0, 1744, 1200], [2, 5744, -42]],
    { participant: "Änne 🚲", comment: "Mehrzeilig\nKommentar" });
  const reference = Csv.parse(await (await recordingCsv(bytes, "EKG00001.BIN")).text());
  for (const chunkSize of [1, 7, 13, 232, 4096]) {
    const stream = new Stream("EKG00001.BIN");
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      stream.push(chunk, offset, bytes.length);
      const recordsEnd = Math.min(offset + chunk.length, bytes.length - 512);
      assert.equal(stream.count, Math.max(0, Math.floor((recordsEnd - 512) / 12)));
      if (stream.count) {
        const data = stream.snapshot();
        assert.deepEqual(Csv.extrema(data, 0, stream.count), {
          min: Math.min(...data.values), max: Math.max(...data.values),
        });
      }
    }
    const data = stream.finish(recordingMetadata(bytes, "EKG00001.BIN"));
    assert.deepEqual([...data.times], [...reference.times]);
    assert.deepEqual([...data.values], [...reference.values]);
    assert.deepEqual([...data.gaps], [...reference.gaps]);
    assert.equal(data.metadata.participant, "Änne 🚲");
    assert.equal(data.metadata.comment, "Mehrzeilig\nKommentar");
  }
});

test("Gesamtzeitachse ist schon beim ersten Datenblock vollständig und bleibt beim Empfang stabil", () => {
  const bytes = recording(Array.from({ length: 2000 }, (_, i) => [i, 1000 + i * 2000, i]));
  const stream = new Stream("EKG00001.BIN");
  stream.push(bytes.slice(0, 6512), 0, bytes.length);
  const duration = stream.estimatedDuration();
  assert.equal(duration, 3.998);
  assert.equal(stream.count, 500);
  stream.push(bytes.slice(6512), 6512, bytes.length);
  assert.equal(stream.estimatedDuration(), duration);
});

test("Inkrementeller Min-/Max-Index bleibt bei wachsender Aufnahme exakt", () => {
  const records = Array.from({ length: 12001 }, (_, i) => [i, 1000 + i * 2000, (i * 117) % 719 - 350]);
  records[511][2] = 8388607;
  const bytes = recording(records), stream = new Stream("EKG00001.BIN");
  for (let offset = 0; offset < bytes.length; offset += 1733) {
    stream.push(bytes.slice(offset, offset + 1733), offset, bytes.length);
    if (!stream.count) continue;
    const data = stream.snapshot();
    for (const from of [0, Math.max(0, stream.count - 153), Math.max(0, stream.count - 1)]) {
      const values = data.values.subarray(from);
      assert.deepEqual(Csv.extrema(data, from, stream.count), { min: Math.min(...values), max: Math.max(...values) });
    }
  }
  assert.equal(stream.finish(recordingMetadata(bytes, "EKG00001.BIN")).values.length, 12001);
});

test("Live-Dekoder lehnt falsche Offsets, ungültige Header, Zeitrücksprünge und unvollständige Abschlüsse ab", () => {
  const bytes = recording();
  assert.throws(() => new Stream("x").push(bytes, 0, bytes.length + 1), /Datenstrom/);
  assert.throws(() => new Stream("x").push(bytes, 1, bytes.length), /zusammenhängend/);
  const broken = bytes.slice(); broken[0] = 0;
  assert.throws(() => new Stream("x").push(broken, 0, broken.length), /Dateikopf/);
  const duplicateTime = recording([[0, 1000, 1], [1, 1000, 2]]);
  assert.throws(() => new Stream("x").push(duplicateTime, 0, duplicateTime.length), /Zeitstempel/);
  const partial = new Stream("x"); partial.push(bytes.slice(0, 520), 0, bytes.length);
  assert.throws(() => partial.finish(recordingMetadata(bytes, "x")), /unvollständig/);
  const complete = new Stream("x"); complete.push(bytes, 0, bytes.length);
  assert.throws(() => complete.finish({ footer_samples_written: 3 }), /unvollständig/);
});
