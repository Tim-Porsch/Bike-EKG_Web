"use strict";
// Synthetische BEKG-Dateien, Pakete und GATT-Doubles für reproduzierbare Hosttests.
// Fehler/Verzögerungen werden gezielt simuliert; kein Modell des realen Funk-Timings.
const { fileCrc32, fileCrc32Update, SD_OP, encodeRecordingFields, decodeRecordingFields } = require("../files.js");
const { createHash } = require("node:crypto");

function streamPacket(session, offset, payload) {
  const bytes = new Uint8Array(12 + payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0xF3, 1]); view.setUint16(2, session, true); view.setUint32(4, offset, true);
  bytes.set(payload, 12);
  view.setUint32(8, ~fileCrc32Update(fileCrc32Update(0xFFFFFFFF, bytes.subarray(0, 8)), payload) >>> 0, true);
  return view;
}

// Independent arithmetic reference encoder for codec/transport tests.
function compressedPacket(session, offset, raw, capacity = 244) {
  if (raw.length < 24 || capacity < 29) return null;
  const input = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const packed = [...raw.subarray(0, 12)];
  let consumed = 12;
  while (consumed + 12 <= raw.length) {
    const next = [];
    for (let field = 0; field < 12; field += 4) {
      const delta = (input.getUint32(consumed + field, true) - input.getUint32(consumed + field - 12, true)) | 0;
      let value = delta >= 0 ? delta * 2 : -delta * 2 - 1;
      do {
        next.push(value % 128 + (value >= 128 ? 128 : 0));
        value = Math.floor(value / 128);
      } while (value);
    }
    if (14 + packed.length + next.length > capacity) break;
    packed.push(...next); consumed += 12;
  }
  if (packed.length + 2 >= consumed) return null;
  const payload = new Uint8Array(2 + packed.length);
  new DataView(payload.buffer).setUint16(0, consumed, true); payload.set(packed, 2);
  const view = streamPacket(session, offset, payload);
  view.setUint8(1, 2);
  const bytes = new Uint8Array(view.buffer);
  view.setUint32(8, ~fileCrc32Update(fileCrc32Update(0xFFFFFFFF, bytes.subarray(0, 8)), bytes.subarray(12)) >>> 0, true);
  return { view, consumed };
}

function recording(records = [[0, 1000, -8388608], [1, 3000, 8388607]], fields = null) {
  const bytes = new Uint8Array(1024 + records.length * 12);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => bytes.set(new TextEncoder().encode(value), offset);
  text(0, "BEKG");
  view.setUint16(4, 1, true); view.setUint16(6, 512, true); view.setUint16(8, 12, true);
  view.setUint16(10, 500, true); view.setUint8(12, 8); view.setUint8(13, 0);
  view.setUint16(14, 3, true); view.setUint32(16, 1700000000, true);
  view.setUint32(20, 12345, true); view.setUint32(24, 30, true); text(28, "0.9.0");
  if (fields) {
    view.setUint16(14, 7, true);
    bytes.set(encodeRecordingFields(fields.participant, fields.comment), 44);
  }
  records.forEach((record, i) => {
    view.setUint32(512 + i * 12, record[0], true);
    view.setUint32(516 + i * 12, record[1], true);
    view.setInt32(520 + i * 12, record[2], true);
  });
  const footer = bytes.length - 512;
  text(footer, "END!"); view.setUint16(footer + 4, 1, true); view.setUint16(footer + 6, 512, true);
  view.setUint32(footer + 8, 30000000, true);
  view.setUint32(footer + 12, records.length, true);
  view.setUint32(footer + 16, records.length + 4, true);
  view.setUint32(footer + 20, records.length, true);
  view.setUint32(footer + 24, 1, true);
  view.setUint32(footer + 28, 1, true);
  view.setUint32(footer + 32, 0, true);
  view.setUint32(footer + 36, 3, true);
  view.setUint16(footer + 40, 17, true);
  text(footer + 44, "duration reached"); text(footer + 60, "none");
  return bytes;
}

function response(id, operation, value = 0, payload = new Uint8Array(), status = 0) {
  const bytes = new Uint8Array(16 + payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set([0xF2, 1]);
  view.setUint16(2, id, true); view.setUint8(4, operation); view.setUint8(5, status);
  view.setUint16(6, payload.length, true); view.setUint32(8, value, true);
  view.setUint32(12, fileCrc32(payload), true); bytes.set(payload, 16);
  return view;
}

function fileService(files = { "EKG00001.BIN": recording() }) {
  let answer = response(0, 0, 0, undefined, 1);
  let index = 0, opened = null, previous = null;
  let listedNames = [];
  const operations = [];
  const state = { closed: true, mutate: null, staleReads: 0, token: 0, sealed: false, fields: null, uploaded: null, received: 0 };
  let sent = 0, acked = 0, streamSession = 0, compression = false;
  const listeners = new Set();
  const stream = {
    addEventListener(name, listener) { listeners.add(listener); },
    removeEventListener(name, listener) { listeners.delete(listener); },
    async startNotifications() { state.subscribed = true; },
    async stopNotifications() { state.subscribed = false; },
  };
  function pump() {
    while (state.subscribed && !state.closed && sent < opened.length && sent - acked < 4096) {
      const offset = sent;
      let count = Math.min(state.packetBytes || 232, opened.length - sent, 4096 - (sent - acked));
      let packet = streamPacket(streamSession, offset, opened.subarray(offset, offset + count));
      if (compression && !state.packetBytes && offset >= 512 && offset < opened.length - 512 && (offset - 512) % 12 === 0) {
        const limit = Math.floor(Math.min(384, opened.length - 512 - offset, 4096 - (sent - acked)) / 12) * 12;
        const encoded = compressedPacket(streamSession, offset, opened.subarray(offset, offset + limit));
        if (encoded) { packet = encoded.view; count = encoded.consumed; }
      } else if (compression && offset < 512) {
        count = Math.min(count, 512 - offset);
        packet = streamPacket(streamSession, offset, opened.subarray(offset, offset + count));
      }
      sent += count;
      if (state.packetMutation) packet = state.packetMutation(packet, offset);
      if (packet) {
        stream.value = packet;
        for (const listener of listeners) listener({ target: stream });
      }
    }
  }
  const control = { async writeValueWithResponse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getUint16(2, true), op = bytes[4];
    operations.push(op);
    const key = Buffer.from(bytes).toString("hex");
    if (key === previous) return;
    previous = key;
    if (op === SD_OP.close) { state.closed = true; state.sealed = false; opened = null; answer = response(id, op); }
    else if (op === SD_OP.listInfoNewest && state.legacyListing) {
      state.closed = true;
      answer = response(id, op, 0, new TextEncoder().encode("Invalid SD operation or session"), 2);
    } else if ([SD_OP.list, SD_OP.next, SD_OP.listInfo, SD_OP.nextInfo, SD_OP.listInfoNewest].includes(op)) {
      if ([SD_OP.list, SD_OP.listInfo, SD_OP.listInfoNewest].includes(op)) {
        index = 0; state.closed = false;
        listedNames = Object.keys(files);
        if (op === SD_OP.listInfoNewest) listedNames.sort().reverse();
      }
      const name = listedNames[index++];
      if (!name) answer = response(id, op, 0, undefined, 1);
      else {
        let payload = new TextEncoder().encode(name);
        if ([SD_OP.listInfo, SD_OP.nextInfo, SD_OP.listInfoNewest].includes(op)) {
          const file = files[name];
          const data = new DataView(file.buffer, file.byteOffset, file.byteLength);
          const hasMetadata = data.getUint16(14, true) & 4;
          const extension = hasMetadata ? file.subarray(44, 56 + data.getUint16(50, true) + data.getUint16(52, true)) : new Uint8Array();
          const entry = new Uint8Array(13 + extension.length);
          entry.set(payload); entry[12] = hasMetadata ? 1 : 0; entry.set(extension, 13);
          payload = entry;
        }
        answer = response(id, op, files[name].length, payload);
      }
    } else if (op === SD_OP.open) {
      const name = new TextDecoder().decode(bytes.subarray(6));
      opened = files[name]; state.closed = false;
      answer = opened ? response(id, op, opened.length)
        : response(id, op, 0, new TextEncoder().encode("File not found"), 2);
    } else if (op === SD_OP.read) {
      const offset = view.getUint32(6, true);
      answer = response(id, op, offset, opened.subarray(offset, offset + 496));
    } else if (op === SD_OP.streamStartCompressed && state.legacyStream) {
      state.closed = true; opened = null;
      answer = response(id, op, 0, new TextEncoder().encode("Invalid SD operation or session"), 2);
    } else if (op === SD_OP.streamStart || op === SD_OP.streamStartCompressed) {
      compression = op === SD_OP.streamStartCompressed;
      sent = acked = 0; ++streamSession;
      const info = new Uint8Array(8), data = new DataView(info.buffer);
      data.setUint32(0, opened.length, true); data.setUint16(4, 4096, true); data.setUint16(6, 247, true);
      answer = response(id, op, streamSession, info);
      pump(); // Deliberately before the start response is read.
    } else if (op === SD_OP.streamAck || op === SD_OP.streamSeek) {
      if (view.getUint16(6, true) !== streamSession) throw new Error("Invalid session");
      acked = view.getUint32(8, true);
      if (op === SD_OP.streamSeek) sent = acked;
      answer = response(id, op, acked);
      pump();
    } else if (op === SD_OP.streamFinish) {
      answer = response(id, op, opened.length, new Uint8Array(createHash("sha256").update(opened).digest()));
    } else if (op === SD_OP.metadataBegin) {
      state.closed = false; state.sealed = false;
      state.uploaded = new Uint8Array(view.getUint16(6, true)); state.received = 0;
      answer = response(id, op, ++state.token);
    } else if (op === SD_OP.metadataChunk) {
      const offset = view.getUint16(6, true);
      if (offset !== state.received) throw new Error("Invalid metadata offset");
      state.uploaded.set(bytes.subarray(8), offset);
      state.received += bytes.length - 8;
      answer = response(id, op, state.received);
    } else if (op === SD_OP.metadataSeal) {
      if (state.received !== state.uploaded.length || view.getUint32(6, true) !== fileCrc32(state.uploaded)) throw new Error("Invalid metadata checksum");
      state.fields = decodeRecordingFields(state.uploaded); state.sealed = true;
      answer = response(id, op, state.token);
    }
    if (state.mutate) answer = state.mutate(answer, op);
  } };
  const data = { async readValue() {
    if (state.staleReads > 0) { --state.staleReads; return response(0, 0); }
    return answer;
  } };
  function consume(token) {
    if (!state.sealed || token !== state.token) throw new Error("Invalid metadata token");
    state.sealed = false; state.closed = true;
    return state.fields;
  }
  return { state, operations, control, data, stream, consume };
}

module.exports = { recording, response, fileService, streamPacket, compressedPacket };
