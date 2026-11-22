"use strict";
// Vertrags-/Fehlertests für SD-Requests, Metadaten, Kompression, CRC und Gesamtdateihash.
// Synthetische Dateien vermeiden Abhängigkeiten von privaten Versuchspersonendaten.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SD_SERVICE, SD_CONTROL, SD_RESPONSE, SD_DATA, SD_OP, SdFileClient, fileCrc32, fileRequest,
  decodeFileResponse, decodeStreamPacket, recordingMetadata, recordingCsv, encodeRecordingFields, decodeRecordingFields } = require("../files.js");
const { recording, response, fileService } = require("./file-fixtures.cjs");

function fixture(files) {
  const service = fileService(files);
  const monitor = {
    generation: 1,
    device: { gatt: { async getPrimaryService(uuid) {
      assert.equal(uuid, SD_SERVICE);
      return { async getCharacteristic(id) {
         assert.ok([SD_CONTROL, SD_RESPONSE, SD_DATA].includes(id));
         return id === SD_CONTROL ? service.control : id === SD_DATA ? service.stream : service.data;
      } };
    } } },
    queue: Promise.resolve(),
    runGatt(action) {
      const generation = this.generation;
      const op = this.queue.then(() => action(() => {
        if (this.generation !== generation) throw new Error("Geräteverbindung beendet.");
      }));
      this.queue = op.catch(() => {});
      return op;
    },
  };
  return { ...service, monitor, client: new SdFileClient(monitor) };
}

test("SD-Protokoll: CRC32-Referenzvektor, Requests, falsche IDs und beschädigte Antworten", () => {
  assert.equal(fileCrc32(new TextEncoder().encode("123456789")), 0xCBF43926);
  assert.equal(fileCrc32(new Uint8Array()), 0);
  assert.deepEqual([...fileRequest(0x1234, SD_OP.list)], [0xF1, 1, 0x34, 0x12, 1, 0]);
  const view = response(3, SD_OP.read, 496, new Uint8Array([1, 2]));
  assert.equal(decodeFileResponse(view, 2, SD_OP.read), null);
  assert.equal(decodeFileResponse(view, 3, SD_OP.read).value, 496);
  view.setUint8(16, 10);
  assert.throws(() => decodeFileResponse(view, 3, SD_OP.read), /Prüfsummenfehler/);
  assert.throws(() => decodeFileResponse(new DataView(new ArrayBuffer(5)), 0, 0));
  assert.throws(() => fileRequest(1, 1, new Uint8Array(15)));
});

test("Dateiliste wird vollständig gelesen und SD-Sitzung geschlossen, auch bei leerer Karte", async () => {
  for (const files of [{}, { "EKG00001.BIN": recording(), "EKG00002.BIN": recording([]) }]) {
    const f = fixture(files);
    const entries = [];
    const result = await f.client.list((file) => entries.push(file));
    assert.equal(result.length, Object.keys(files).length);
    assert.deepEqual(result, entries);
    assert.equal(f.operations.at(-1), SD_OP.close);
    assert.equal(f.state.closed, true);
  }
});

test("Neue Listoperation liefert neueste Dateien zuerst, alte Firmware bleibt kompatibel", async () => {
  const files = { "EKG00001.BIN": recording(), "EKG00099.BIN": recording(), "EKG00050.BIN": recording() };
  for (const legacy of [false, true]) {
    const f = fixture(files);
    f.state.legacyListing = legacy;
    const entries = [];
    await f.client.list((file) => entries.push(file.name));
    assert.equal(f.operations[0], SD_OP.listInfoNewest);
    assert.equal(f.operations.includes(SD_OP.listInfo), legacy);
    assert.deepEqual(entries, legacy ? Object.keys(files) : ["EKG00099.BIN", "EKG00050.BIN", "EKG00001.BIN"]);
    assert.equal(f.state.closed, true);
  }
});

test("Datei wird in bestätigten Blöcken exakt zusammengesetzt; alte Statuswerte werden ignoriert", async () => {
  const bytes = recording();
  const f = fixture({ "EKG00001.BIN": bytes });
  f.state.staleReads = 1;
  const progress = [];
  const received = await f.client.downloadBlocks("EKG00001.BIN", (count, total) => progress.push([count, total]));
  assert.deepEqual(received, bytes);
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
  assert.equal(f.operations.filter((op) => op === SD_OP.read).length, 3);
  assert.equal(f.state.closed, true);
});

test("Visualisierungs-Chunks sind zusammenhängende Kopien und erscheinen vor der abschließenden Verifikation", async () => {
  const bytes = recording(Array.from({ length: 2000 }, (_, i) => [i, 1000 + i * 2000, i - 1000]));
  const f = fixture({ "EKG00001.BIN": bytes });
  const chunks = [];
  let verified = false, end = 0;
  const received = await f.client.download("EKG00001.BIN", undefined, undefined, () => { verified = true; }, (chunk, offset, total) => {
    assert.equal(verified, false);
    assert.equal(offset, end);
    assert.equal(total, bytes.length);
    chunks.push(chunk.slice());
    end += chunk.length;
    chunk.fill(0); // Callback-owned bytes must never alter the SHA-256 input.
  });
  assert.equal(verified, true);
  assert.equal(end, bytes.length);
  assert.ok(chunks.length > 1);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  assert.deepEqual(received, bytes);
});

test("Ein Fehler im Live-Dekoder beendet die SD-Sitzung ohne bestätigten Abschluss", async () => {
  const f = fixture();
  let verified = false;
  await assert.rejects(f.client.download("EKG00001.BIN", undefined, undefined, () => { verified = true; }, () => {
    throw new Error("Defekter Header");
  }), /Defekter Header/);
  assert.equal(verified, false);
  assert.equal(f.state.closed, true);
  assert.equal(f.state.subscribed, false);
});

test("Download bricht bei CRC-Fehlern, falschem Offset und vorzeitigem Ende ab", async () => {
  for (const mutation of [
    (view) => { view.setUint8(16, view.getUint8(16) ^ 1); return view; },
    (view) => { view.setUint32(8, 99, true); return view; },
    (view) => { view.setUint8(5, 1); return view; },
  ]) {
    const f = fixture();
    f.state.mutate = (view, op) => op === SD_OP.read ? mutation(view) : view;
    await assert.rejects(f.client.downloadBlocks("EKG00001.BIN"));
    assert.equal(f.state.closed, true);
  }
});

test("Dateipfade und zu große Dateien werden abgewiesen", async () => {
  const f = fixture();
  await assert.rejects(f.client.download("../file.bin"), /Dateiname/);
  assert.equal(f.operations.length, 0);
  f.state.mutate = (view, op) => {
    if (op === SD_OP.open) view.setUint32(8, 33 * 1024 * 1024, true);
    return view;
  };
  await assert.rejects(f.client.download("EKG00001.BIN"), /Dateigröße/);
  assert.equal(f.state.closed, true);
});

test("Vorübergehender Prüfsummenfehler wird durch erneutes Lesen desselben Blocks behoben", async () => {
  const f = fixture();
  const read = f.data.readValue;
  let corrupt = true;
  f.data.readValue = async () => {
    const view = await read();
    if (corrupt && view.getUint8(4) === SD_OP.read) {
      corrupt = false;
      const copy = new DataView(view.buffer.slice(0));
      copy.setUint8(16, copy.getUint8(16) ^ 1);
      return copy;
    }
    return view;
  };
  assert.deepEqual(await f.client.downloadBlocks("EKG00001.BIN"), recording());
  assert.equal(f.operations.filter((op) => op === SD_OP.read).length, 3);
});

test("Abbrechen stoppt Liste und Download ohne Teil-CSV und schließt die Sitzung", async () => {
  let f = fixture();
  let controller = new AbortController();
  await assert.rejects(f.client.list(() => controller.abort(), controller.signal), { name: "AbortError" });
  assert.equal(f.state.closed, true);
  f = fixture(); controller = new AbortController();
  await assert.rejects(f.client.downloadBlocks("EKG00001.BIN", (received) => {
    if (received) controller.abort();
  }, controller.signal), { name: "AbortError" });
  assert.equal(f.operations.filter((op) => op === SD_OP.read).length, 1);
  assert.equal(f.state.closed, true);
});

test("Verbindungswechsel invalidiert alte Dateicharacteristics und bricht laufenden Empfang ab", async () => {
  const f = fixture();
  await assert.rejects(f.client.downloadBlocks("EKG00001.BIN", (received) => {
    if (received) ++f.monitor.generation;
  }), /Geräteverbindung beendet/);
  assert.notEqual(f.operations.at(-1), SD_OP.close); // Never close a new connection's session.
});

test("CSV enthält gespeicherte Header-/Footerinformationen und unveränderte vorzeichenbehaftete Rohwerte", async () => {
  const bytes = recording();
  const metadata = recordingMetadata(bytes, "EKG00001.BIN");
  assert.equal(metadata.gain_multiplier, 8);
  assert.equal(metadata.rld_enabled, true);
  assert.equal(metadata.device_unix_time, 1700000000);
  assert.equal(metadata.firmware_version, "0.9.0");
  assert.equal(metadata.footer_samples_written, 2);
  assert.equal(metadata.footer_samples_dropped, 1);
  assert.equal(metadata.footer_reason, "duration reached");
  assert.equal(metadata.footer_error, "none");
  const csv = await (await recordingCsv(bytes, "EKG00001.BIN")).text();
  assert.match(csv, /# source_file: "EKG00001.BIN"/);
  assert.match(csv, /# signal_format: "raw_adc_counts"/);
  assert.match(csv, /sample_number,timestamp_us,timestamp_s,adc_counts\r\n0,1000,0.001000,-8388608\r\n1,3000,0.003000,8388607/);
});

test("CSV berücksichtigt Timestampüberlauf und erfindet keine fehlende Gerätezeit", async () => {
  const bytes = recording([[0, 0xFFFFFFF0, -1], [1, 5, 2]]);
  new DataView(bytes.buffer).setUint16(14, 0, true);
  assert.equal(recordingMetadata(bytes, "x").device_start_utc, null);
  const csv = await (await recordingCsv(bytes, "x")).text();
  assert.match(csv, /1,5,4294.967301,2/);
});

test("Unvollständige und inkonsistente Aufzeichnungen werden nicht als gültige CSV ausgegeben", async () => {
  for (const change of [
    (bytes) => bytes[0] = 0,
    (bytes) => bytes[bytes.length - 512] = 0,
    (bytes) => new DataView(bytes.buffer).setUint32(bytes.length - 500, 999, true),
  ]) {
    const bytes = recording(); change(bytes);
    await assert.rejects(recordingCsv(bytes, "x"));
  }
});

test("Große CSV-Konvertierung bleibt abbrechbar", async () => {
  const bytes = recording(Array.from({ length: 5000 }, (_, i) => [i, i * 2000, i - 2500]));
  const controller = new AbortController();
  await assert.rejects(recordingCsv(bytes, "x", { signal: controller.signal, onProgress() { controller.abort(); } }), { name: "AbortError" });
});

test("Aufzeichnungsmetadaten: UTF-8-Bytes, Umlaute, Emoji, Zeilenumbrüche und Grenzen", () => {
  const bytes = encodeRecordingFields(" P-Ä🫀 ", "Ruhig\r\nGriffe drücken\t✓");
  assert.deepEqual(decodeRecordingFields(bytes), { participant: "P-Ä🫀", comment: "Ruhig\nGriffe drücken\t✓" });
  assert.equal(encodeRecordingFields("A".repeat(80), "B".repeat(376)).length, 468);
  assert.throws(() => encodeRecordingFields("Ä".repeat(41), ""), /maximal/);
  assert.throws(() => encodeRecordingFields("", "🫀".repeat(95)), /maximal/);
  assert.throws(() => encodeRecordingFields("P\n01", ""), /Steuerzeichen/);
  assert.throws(() => encodeRecordingFields("P01", "\0"), /Steuerzeichen/);
  assert.throws(() => encodeRecordingFields("P01", "\uD800"), /Steuerzeichen/);
});

test("Metadaten werden blockweise bestätigt und erst danach ein tokengebundener Start ausgelöst", async () => {
  const f = fixture();
  const starts = [];
  await f.client.startRecording("P-Ä🫀", "Mehrzeilig\nBewegung", async (command) => {
    assert.equal(f.state.sealed, true);
    assert.deepEqual(f.consume(Number(command.split(" ")[1])), { participant: "P-Ä🫀", comment: "Mehrzeilig\nBewegung" });
    starts.push(command);
  });
  assert.deepEqual(starts, ["record 1"]);
  assert.deepEqual(f.operations.slice(0, 1), [SD_OP.metadataBegin]);
  assert.equal(f.operations.at(-1), SD_OP.metadataSeal);
  assert.equal(f.state.closed, true);
});

test("Fehlende Metadatenbestätigung verhindert Messstart statt stillschweigend Roh-start auszuführen", async () => {
  const f = fixture();
  f.state.mutate = (view, op) => {
    if (op === SD_OP.metadataSeal) view.setUint32(8, 999, true);
    return view;
  };
  let starts = 0;
  await assert.rejects(f.client.startRecording("P01", "Kommentar", () => ++starts), /Metadatenbestätigung/);
  assert.equal(starts, 0);
  assert.equal(f.state.closed, true);
  assert.equal(f.operations.at(-1), SD_OP.close);
});

test("Zu lange Metadaten werden vor jedem BLE-Zugriff abgelehnt", async () => {
  const f = fixture();
  await assert.rejects(f.client.startRecording("Ä".repeat(41), "", () => {}), /maximal/);
  assert.equal(f.operations.length, 0);
});

test("Dateiliste und CSV lesen Versuchsperson/Kommentar aus dem gespeicherten Header", async () => {
  const fields = { participant: "P-Ä🫀", comment: "Sitzend\nGriffe drücken" };
  const bytes = recording(undefined, fields);
  const f = fixture({ "EKG00001.BIN": bytes, "EKG00002.BIN": recording() });
  const files = await f.client.list();
  assert.equal(files[1].metadataStatus, 1);
  assert.equal(files[1].participant, fields.participant);
  assert.equal(files[1].comment, fields.comment);
  assert.equal(files[0].metadataStatus, 0);
  const stored = recordingMetadata(bytes, "EKG00001.BIN");
  assert.equal(stored.participant, fields.participant);
  assert.equal(stored.comment, fields.comment);
  const csv = await (await recordingCsv(bytes, "EKG00001.BIN")).text();
  assert.ok(csv.includes(`# participant: ${JSON.stringify(fields.participant)}`));
  assert.ok(csv.includes(`# comment: ${JSON.stringify(fields.comment)}`));
  assert.equal(recordingMetadata(recording(), "old").participant, "");
});

test("Beschädigte oder unbekannte META-Erweiterung wird nicht als gültige CSV exportiert", async () => {
  const bytes = recording(undefined, { participant: "P01", comment: "Text" });
  bytes[48] = 2;
  await assert.rejects(recordingCsv(bytes, "x"), /Aufzeichnungsmetadaten/);
});

test("Notification-Download: mehrere Fenster, frühe Pakete und ganzer SHA-256 stimmen überein", async () => {
  const bytes = recording(Array.from({ length: 3000 }, (_, i) => [i, i * 2000, i - 1000]));
  const f = fixture({ "EKG00001.BIN": bytes });
  let verified;
  const received = await f.client.download("EKG00001.BIN", undefined, undefined, (result) => { verified = result; });
  assert.deepEqual(received, bytes);
  assert.equal(verified.sha256, require("node:crypto").createHash("sha256").update(bytes).digest("hex"));
  assert.equal(verified.bytes, bytes.length);
  assert.equal(verified.mtu, 247);
  assert.equal(f.operations.includes(SD_OP.read), false);
  assert.ok(f.operations.filter((op) => op === SD_OP.streamAck).length < bytes.length / 1000);
  assert.equal(f.state.subscribed, false);
  assert.equal(f.state.closed, true);
});

test("MTU-23-Paketgröße wird einschließlich voller früher Fenster unterstützt", async () => {
  const f = fixture();
  f.state.packetBytes = 8;
  assert.deepEqual(await f.client.download("EKG00001.BIN"), recording());
});

test("Fehlende und CRC-beschädigte Notifications werden ab bestätigter Position wiederholt", async () => {
  for (const corrupt of [false, true]) {
    const f = fixture();
    let once = true;
    f.state.packetMutation = (view, offset) => {
      if (offset === 232 && once) {
        once = false;
        if (!corrupt) return null;
        view.setUint8(12, view.getUint8(12) ^ 1);
      }
      return view;
    };
    assert.deepEqual(await f.client.download("EKG00001.BIN"), recording());
    assert.ok(f.operations.includes(SD_OP.streamSeek));
  }
});

test("Gesamtdatei-SHA-256 verhindert Export auch bei transportgültigen falschen Bytes", async () => {
  const f = fixture();
  const { streamPacket } = require("./file-fixtures.cjs");
  f.state.packetMutation = (view, offset) => {
    if (offset !== 0) return view;
    const bytes = new Uint8Array(view.buffer).slice(12);
    bytes[20] ^= 1;
    return streamPacket(view.getUint16(2, true), offset, bytes); // Valid per-packet CRC!
  };
  let verified = false;
  await assert.rejects(f.client.download("EKG00001.BIN", undefined, undefined, () => { verified = true; }), /SHA-256/);
  assert.equal(verified, false);
  assert.equal(f.state.closed, true);
  assert.equal(f.state.subscribed, false);
});

test("Fehlende oder falsche MCU-Dateiprüfsumme wird abgewiesen", async () => {
  const f = fixture();
  f.state.mutate = (view, op) => {
    if (op !== SD_OP.streamFinish) return view;
    const hash = new Uint8Array(32); // CRC is valid but file hash is wrong.
    return response(view.getUint16(2, true), op, recording().length, hash);
  };
  await assert.rejects(f.client.download("EKG00001.BIN"), /SHA-256/);
  assert.equal(f.state.closed, true);
});

test("Abbruch während Notification-Wartezeit schließt Sitzung und entfernt Subscriber", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.state.packetMutation = () => null;
  const pending = f.client.download("EKG00001.BIN", () => queueMicrotask(() => controller.abort()), controller.signal);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.state.closed, true);
  assert.equal(f.state.subscribed, false);
});

test("Fehlende Streaming-Characteristic verlangt Firmwareupdate statt ungeprüftem Fallback", async () => {
  const f = fixture();
  f.monitor.device.gatt.getPrimaryService = async () => ({ async getCharacteristic(id) {
    if (id === SD_DATA) throw new Error("Not found");
    return id === SD_CONTROL ? f.control : f.data;
  } });
  await assert.rejects(f.client.download("EKG00001.BIN"), /Firmware ab 0.11.0/);
  assert.equal(f.operations.includes(SD_OP.read), false);
});

test("Doppelte Notifications werden nicht doppelt angehängt und die Lücke wird wiederholt", async () => {
  const f = fixture();
  let saved, once = true;
  f.state.packetMutation = (view, offset) => {
    if (offset === 0) { saved = view; return view; }
    if (offset === 232 && once) { once = false; return saved; }
    return view;
  };
  assert.deepEqual(await f.client.download("EKG00001.BIN"), recording());
  assert.ok(f.operations.includes(SD_OP.streamSeek));
});

test("Disconnect während Stream verhindert Ergebnis und schreibt nicht in neue Verbindung", async () => {
  const f = fixture();
  f.state.packetMutation = () => null;
  await assert.rejects(f.client.download("EKG00001.BIN", () => { ++f.monitor.generation; }), /Geräteverbindung beendet/);
  assert.equal(f.operations.includes(SD_OP.streamFinish), false);
  assert.equal(f.operations.includes(SD_OP.close), false);
});

test("Ungültige Abschlusslänge wird trotz vollständigem Empfang nicht akzeptiert", async () => {
  const f = fixture();
  f.state.mutate = (view, op) => {
    if (op === SD_OP.streamFinish) view.setUint32(8, recording().length + 1, true);
    return view;
  };
  await assert.rejects(f.client.download("EKG00001.BIN"), /Dateiprüfsumme fehlt/);
  assert.equal(f.state.closed, true);
});

test("Kompressionscodec: feste Referenzbytes, uint32-Überläufe, Lücken und ADC-Grenzwerte", () => {
  const { compressedPacket } = require("./file-fixtures.cjs");
  const raw = recording([[0, 0, 0], [1, 2000, -1]]).subarray(512, 536);
  const packet = compressedPacket(1, 512, raw);
  assert.deepEqual([...new Uint8Array(packet.view.buffer).subarray(14)], [0,0,0,0,0,0,0,0,0,0,0,0,2,0xA0,0x1F,1]);
  assert.deepEqual(decodeStreamPacket(packet.view).payload, raw);
  const records = Array.from({ length: 32 }, (_, i) => [
    (0xFFFFFFF0 + i + (i > 7 ? 50 : 0)) >>> 0, (0xFFFFF000 + i * 2000) >>> 0,
    [0, -2147483648, 2147483647, -8388608, 8388607, -1][i % 6],
  ]);
  const source = recording(records).subarray(512, 512 + records.length * 12);
  let offset = 0;
  while (offset < source.length) {
    const encoded = compressedPacket(99, offset, source.subarray(offset));
    if (!encoded) break;
    assert.deepEqual(decodeStreamPacket(encoded.view).payload, source.subarray(offset, offset + encoded.consumed));
    offset += encoded.consumed;
  }
  assert.ok(offset >= 24);
});

test("Komprimierter Transfer spart Notifications und rekonstruiert exakt dieselbe SHA-256-Datei", async () => {
  const original = recording(Array.from({ length: 3000 }, (_, i) => [i, 0xFFFF0000 + i * 2000, Math.round(100000 * Math.sin(i / 10))]));
  const f = fixture({ "EKG00001.BIN": original });
  let verification;
  assert.deepEqual(await f.client.download("EKG00001.BIN", undefined, undefined, (v) => { verification = v; }), original);
  assert.equal(verification.compression, "record_delta_v1");
  assert.ok(verification.compressedPackets > 0);
  assert.ok(verification.notificationBytes < original.length * 0.8);
  assert.equal(verification.sha256, require("node:crypto").createHash("sha256").update(original).digest("hex"));
});

test("Komprimierter Stream auf Firmware 0.11 fällt auf SHA-256-geprüften Rohtransfer zurück", async () => {
  const f = fixture();
  f.state.legacyStream = true;
  let verification;
  assert.deepEqual(await f.client.download("EKG00001.BIN", undefined, undefined, (v) => { verification = v; }), recording());
  assert.equal(verification.compression, "none");
  assert.equal(f.operations.filter((op) => op === SD_OP.open).length, 2);
  assert.ok(f.operations.includes(SD_OP.streamStart));
  assert.ok(f.operations.includes(SD_OP.streamFinish));
});

test("Verlorener komprimierter Block wird ohne veränderte Originalbytes erneut übertragen", async () => {
  const original = recording(Array.from({ length: 500 }, (_, i) => [i, i * 2000, i - 1000]));
  const f = fixture({ "EKG00001.BIN": original });
  let dropped = false;
  f.state.packetMutation = (view) => {
    if (view.getUint8(1) === 2 && !dropped) { dropped = true; return null; }
    return view;
  };
  assert.deepEqual(await f.client.download("EKG00001.BIN"), original);
  assert.ok(dropped && f.operations.includes(SD_OP.streamSeek));
});

test("Defekte komprimierte Rahmen werden trotz gültiger CRC strikt abgewiesen", () => {
  const { compressedPacket, streamPacket } = require("./file-fixtures.cjs");
  const raw = recording([[0, 0, 0], [1, 2000, -1]]).subarray(512, 536);
  const valid = compressedPacket(1, 512, raw).view;
  const { fileCrc32Update } = require("../files.js");
  const refresh = (view) => {
    const bytes = new Uint8Array(view.buffer);
    view.setUint32(8, ~fileCrc32Update(fileCrc32Update(0xFFFFFFFF, bytes.subarray(0, 8)), bytes.subarray(12)) >>> 0, true);
    return view;
  };
  for (const size of [0, 12, 25, 396, 65535]) {
    const view = new DataView(valid.buffer.slice(0));
    view.setUint16(12, size, true);
    assert.equal(decodeStreamPacket(refresh(view)), null);
  }
  const bytes = new Uint8Array(valid.buffer);
  assert.equal(decodeStreamPacket(refresh(new DataView(bytes.slice(0, -1).buffer))), null);
  const extra = new Uint8Array(bytes.length + 1); extra.set(bytes);
  assert.equal(decodeStreamPacket(refresh(new DataView(extra.buffer))), null);
  // Five-byte overflowing uint32 varint; decoded length exceeds encoded length.
  const payload = new Uint8Array(20); new DataView(payload.buffer).setUint16(0, 36, true);
  payload.set([255,255,255,255,16,0], 14);
  const overflow = streamPacket(1, 512, payload); overflow.setUint8(1, 2);
  assert.equal(decodeStreamPacket(refresh(overflow)), null);
});
