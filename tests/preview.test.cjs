"use strict";

// Binärpakete künstlich erzeugen: Sessions, Überläufe und Verlustzähler unabhängig
// vom Canvas prüfen; aus dem Zeitfenster entfernte Werte sind keine Empfangsverluste.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decodePreviewData, decodePreviewStatus, PreviewModel } = require("../preview.js");

function status({ session = 1, rate = 250, active = true, end = 0, acquisition = 0, tx = 0 } = {}) {
  const view = new DataView(new ArrayBuffer(20));
  view.setUint8(0, 0xC1); view.setUint8(1, 1);
  view.setUint16(2, session, true); view.setUint16(4, rate, true);
  view.setUint8(6, active ? 1 : 0); view.setUint8(7, 1);
  view.setUint32(8, end, true); view.setUint32(12, acquisition, true); view.setUint32(16, tx, true);
  return view;
}

function data(first, values, sequence = 0, session = 1) {
  const view = new DataView(new ArrayBuffer(12 + 4 * values.length));
  view.setUint8(0, 0xD1); view.setUint8(1, 1);
  view.setUint16(2, session, true); view.setUint16(4, sequence, true);
  view.setUint32(6, first, true); view.setUint8(10, values.length);
  values.forEach((value, index) => view.setInt32(12 + 4 * index, value, true));
  return view;
}

test("Binärdecoder liest vorzeichenbehaftete Rohwerte und verwirft falsche Pakete", () => {
  assert.deepEqual(decodePreviewData(data(3, [-8388608, 8388607])).values, [-8388608, 8388607]);
  assert.equal(decodePreviewStatus(status()).rate, 250);
  assert.throws(() => decodePreviewData(new DataView(new ArrayBuffer(10))));
  assert.throws(() => decodePreviewData(data(0, [])));
  const wrong = data(0, [1]); wrong.setUint8(10, 2);
  assert.throws(() => decodePreviewData(wrong));
  assert.throws(() => decodePreviewStatus(status({ rate: 999 })));
  assert.equal(decodePreviewStatus(status({ rate: 0, active: false })).rate, 0);
});

test("Sample- und Paketlücken werden gezählt und als Kurvenunterbrechung markiert", () => {
  const model = new PreviewModel(() => 0);
  model.status(status());
  model.data(data(0, [1, 2, 3]));
  model.data(data(5, [4, 5], 2));
  assert.equal(model.received, 5);
  assert.equal(model.missing, 2);
  assert.equal(model.packetGaps, 1);
  assert.equal(model.points[3].gap, true);
  assert.equal(model.points[3].position, 5);
  assert.equal(model.points[4].gap, false);
  assert.equal(model.data(data(5, [4, 5], 2)), false);
  assert.equal(model.received, 5);
});

test("MCU-Filtermodus wird aus Status gelesen und bei neuer Session zurückgesetzt", () => {
  const model = new PreviewModel(() => 0);
  const filtered = status();
  filtered.setUint8(7, 2);
  assert.equal(decodePreviewStatus(filtered).filtered, true);
  model.status(filtered);
  assert.equal(model.filtered, true);
  model.data(data(0, [-120, 300]));
  assert.deepEqual(model.points.map((point) => point.value), [-120, 300]);
  model.status(status({ session: 2 }));
  assert.equal(model.filtered, false);
  filtered.setUint8(7, 3);
  assert.throws(() => decodePreviewStatus(filtered));
});

test("MCU- und Queueverluste werden nicht nochmals zu erkannten Lücken addiert", () => {
  const model = new PreviewModel(() => 0);
  model.status(status({ acquisition: 2, tx: 3 }));
  model.data(data(5, [10]));
  assert.equal(model.missing, 5);
  model.status(status({ acquisition: 2, tx: 3, end: 10, active: false }));
  assert.equal(model.missing, 9); // Includes an undelivered final tail.
  model.data(data(6, [11], 1)); // A late queued notification corrects the final count.
  assert.equal(model.missing, 8);
});

test("Vorschau hält höchstens zehn Sekunden und verwechselt Fensterablauf nicht mit Verlusten", () => {
  let now = 0;
  const model = new PreviewModel(() => now);
  model.status(status({ rate: 500 }));
  for (let i = 0; i < 200; ++i) model.data(data(i * 50, Array(50).fill(i), i));
  assert.equal(model.points.length, 5000);
  assert.equal(model.received, 10000);
  assert.equal(model.missing, 0);
  assert.equal(model.points[0].position, 5000);
  now = 2000;
  assert.equal(model.rightEdge(), 11000); // Stalled input leaves visible blank time.
});

test("Neue Sessions setzen Statistiken zurück; veraltete Sessions werden ignoriert", () => {
  const model = new PreviewModel(() => 0);
  model.status(status({ session: 65535 }));
  model.data(data(2, [1], 0, 65535));
  assert.equal(model.missing, 2);
  model.status(status({ session: 0 }));
  assert.equal(model.received, 0);
  assert.equal(model.missing, 0);
  assert.equal(model.data(data(3, [10], 1, 65535)), false);
  model.status(status({ session: 65535 }));
  assert.equal(model.session, 0);
  model.reset();
  assert.equal(model.session, null);
});

test("Keep data time ändert Pufferdauer sofort und bleibt über Sessions erhalten", () => {
  const model = new PreviewModel(() => 0);
  model.setKeepSeconds(60);
  model.status(status({ rate: 500 }));
  for (let i = 0; i < 700; ++i) model.data(data(i * 50, Array(50).fill(i), i));
  assert.equal(model.points.length, 30000);
  model.setKeepSeconds(5);
  assert.equal(model.points.length, 2500);
  assert.equal(model.received, 35000);
  assert.equal(model.missing, 0);
  model.setKeepSeconds(20);
  assert.equal(model.points.length, 2500); // Discarded history cannot be restored.
  for (let i = 700; i < 900; ++i) model.data(data(i * 50, Array(50).fill(i), i));
  assert.equal(model.points.length, 10000);
  model.status(status({ session: 2 }));
  assert.equal(model.keepSeconds, 20);
  assert.equal(model.points.length, 0);
  assert.throws(() => model.setKeepSeconds(0));
  assert.throws(() => model.setKeepSeconds(Infinity));
  assert.equal(model.keepSeconds, 20);
});

test("Natürlicher Sample- und Paketnummernüberlauf erzeugt keine falschen Lücken", () => {
  const model = new PreviewModel(() => 0);
  model.status(status());
  model.expectedSample = 0xFFFFFFFF;
  model.expectedSequence = 0xFFFF;
  model.data(data(0xFFFFFFFF, [1], 0xFFFF));
  model.data(data(0, [2], 0));
  assert.equal(model.received, 2);
  assert.equal(model.missing, 0);
  assert.equal(model.packetGaps, 0);
});

test("Nach längerem Browserstillstand bleiben Sample-Lücken auch bei großer Paketnummerndifferenz erkennbar", () => {
  const model = new PreviewModel(() => 0);
  model.status(status());
  model.data(data(0, [1, 2]));
  assert.equal(model.data(data(80000, [3, 4], 40000)), true);
  assert.equal(model.received, 4);
  assert.equal(model.missing, 79998);
  assert.equal(model.points.length, 2);
});
