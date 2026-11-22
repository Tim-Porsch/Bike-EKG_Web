"use strict";

// SD-Client und BEKG-Decoder. Wire-Layout mit SdFileProtocol.h synchron halten.
// Alle Dateidaten bleiben lokal; CRC32 pro Paket und SHA-256 am Ende trennen
// Transportprüfung von der anschließenden Prüfung des Aufzeichnungsformats.

const SD_SERVICE = "7f530001-1212-efde-1523-785feabcd123";
const SD_CONTROL = "7f530002-1212-efde-1523-785feabcd123";
const SD_RESPONSE = "7f530003-1212-efde-1523-785feabcd123";
const SD_DATA = "7f530004-1212-efde-1523-785feabcd123";
const SD_OP = { list: 1, next: 2, open: 3, read: 4, close: 5,
  metadataBegin: 6, metadataChunk: 7, metadataSeal: 8, listInfo: 9, nextInfo: 10, listInfoNewest: 16,
  streamStart: 11, streamAck: 12, streamSeek: 13, streamFinish: 14, streamStartCompressed: 15 };
const SD_MAX_FILE_BYTES = 32 * 1024 * 1024;
const PARTICIPANT_MAX_BYTES = 80;
const COMMENT_MAX_BYTES = 376;

function encodeRecordingFields(participant, comment) {
  // Grenzen zählen UTF-8-Bytes. Niemals Texte still abschneiden oder NUL anhängen.
  participant = participant.trim();
  comment = comment.replace(/\r\n?/g, "\n");
  if (/[\u0000-\u001F\u007F\uD800-\uDFFF]/u.test(participant)
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u.test(comment)) {
    throw new Error("Versuchsperson oder Kommentar enthält ungültige Steuerzeichen.");
  }
  const encoder = new TextEncoder();
  const name = encoder.encode(participant), note = encoder.encode(comment);
  if (name.length > PARTICIPANT_MAX_BYTES || note.length > COMMENT_MAX_BYTES) {
    throw new Error(`Versuchsperson: maximal ${PARTICIPANT_MAX_BYTES} UTF-8-Bytes; Kommentar: maximal ${COMMENT_MAX_BYTES} UTF-8-Bytes. Es wird nichts abgeschnitten.`);
  }
  const bytes = new Uint8Array(12 + name.length + note.length);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("META"));
  view.setUint16(4, 1, true); view.setUint16(6, name.length, true); view.setUint16(8, note.length, true);
  bytes.set(name, 12); bytes.set(note, 12 + name.length);
  return bytes;
}

function decodeRecordingFields(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || bytes.length > 468 || String.fromCharCode(...bytes.subarray(0, 4)) !== "META"
    || view.getUint16(4, true) !== 1 || view.getUint16(10, true) !== 0) throw new Error("Unbekannte Aufzeichnungsmetadaten.");
  const nameLength = view.getUint16(6, true), commentLength = view.getUint16(8, true);
  if (nameLength > PARTICIPANT_MAX_BYTES || commentLength > COMMENT_MAX_BYTES || bytes.length !== 12 + nameLength + commentLength) {
    throw new Error("Ungültige Länge der Aufzeichnungsmetadaten.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const participant = decoder.decode(bytes.subarray(12, 12 + nameLength));
  const comment = decoder.decode(bytes.subarray(12 + nameLength));
  if (/[\u0000-\u001F\u007F]/u.test(participant) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(comment)) {
    throw new Error("Ungültige Steuerzeichen in gespeicherten Aufzeichnungsmetadaten.");
  }
  // Apply the same character restrictions without changing stored whitespace.
  encodeRecordingFields(participant, comment);
  return { participant, comment };
}

function checkCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error("Vorgang abgebrochen.");
    error.name = "AbortError";
    throw error;
  }
}

function fileCrc32Update(crc, bytes) {
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return crc >>> 0;
}
function fileCrc32(bytes) { return (~fileCrc32Update(0xFFFFFFFF, bytes)) >>> 0; }

function decodeStreamPacket(view) {
  // Erst CRC prüfen, dann optionale Delta-/ZigZag-/LEB128-Daten rekonstruieren.
  // offset bezeichnet auch bei Kompression die Position in der Originaldatei.
  if (view.byteLength <= 12 || view.byteLength > 244 || view.getUint8(0) !== 0xF3 || ![1, 2].includes(view.getUint8(1))) return null;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let payload = bytes.subarray(12);
  const crc = ~fileCrc32Update(fileCrc32Update(0xFFFFFFFF, bytes.subarray(0, 8)), payload) >>> 0;
  if (crc !== view.getUint32(8, true)) return null;
  const compressed = view.getUint8(1) === 2;
  if (compressed) {
    if (view.byteLength < 26) return null;
    const length = view.getUint16(12, true);
    if (length < 24 || length > 384 || length % 12 || length <= payload.length) return null;
    const raw = new Uint8Array(length);
    const output = new DataView(raw.buffer);
    raw.set(bytes.subarray(14, 26));
    let position = 26;
    for (let offset = 12; offset < length; offset += 4) {
      let value = 0, complete = false;
      for (let i = 0; i < 5 && position < bytes.length; ++i) {
        const byte = bytes[position++];
        if (i === 4 && byte > 15) return null;
        value = (value | ((byte & 127) << (7 * i))) >>> 0;
        if (!(byte & 128)) {
          if (i && byte === 0) return null; // Reject noncanonical LEB128.
          complete = true; break;
        }
      }
      if (!complete) return null;
      const delta = ((value >>> 1) ^ -(value & 1)) >>> 0;
      output.setUint32(offset, output.getUint32(offset - 12, true) + delta, true);
    }
    if (position !== bytes.length) return null;
    payload = raw;
  }
  return { session: view.getUint16(2, true), offset: view.getUint32(4, true), payload, compressed, wireBytes: view.byteLength };
}

function fileRequest(id, operation, payload = new Uint8Array()) {
  if (payload.length > 14) throw new Error("SD-Anfrage zu lang.");
  const bytes = new Uint8Array(6 + payload.length);
  bytes.set([0xF1, 1, id & 255, id >>> 8, operation, 0]);
  bytes.set(payload, 6);
  return bytes;
}

function decodeFileResponse(view, id, operation) {
  if (view.byteLength < 16 || view.byteLength > 512 || view.getUint8(0) !== 0xF2 || view.getUint8(1) !== 1) {
    throw new Error("Unbekanntes SD-Übertragungsformat.");
  }
  if (view.getUint16(2, true) !== id || view.getUint8(4) !== operation) return null;
  const length = view.getUint16(6, true);
  if (view.byteLength !== 16 + length || view.getUint8(5) > 2) throw new Error("Ungültige SD-Antwort.");
  const payload = new Uint8Array(view.buffer, view.byteOffset + 16, length).slice();
  if (fileCrc32(payload) !== view.getUint32(12, true)) {
    const error = new Error("Prüfsummenfehler bei der SD-Übertragung.");
    error.checksumError = true;
    throw error;
  }
  if (view.getUint8(5) === 2) throw new Error(`SD: ${new TextDecoder().decode(payload)}`);
  return { done: view.getUint8(5) === 1, value: view.getUint32(8, true), payload };
}

function boundedGatt(operation) {
  // Timeout beendet das Warten, nicht zwingend den Browser-/OS-Bluetoothaufruf.
  // Deshalb schützen zusätzlich die Verbindungs-Generationen vor späten Ergebnissen.
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Bluetooth antwortet nicht. Verbindung bitte erneut herstellen.");
        error.transportFailure = true;
        reject(error);
      }, 5000);
    }),
  ]).catch((error) => {
    if (["NetworkError", "InvalidStateError"].includes(error.name)) error.transportFailure = true;
    throw error;
  }).finally(() => clearTimeout(timer));
}

class SdFileClient {
  constructor(monitor) {
    this.monitor = monitor;
    this.id = 0;
    this.generation = null;
    this.control = this.response = null;
  }

  async prepare() {
    const monitor = this.monitor;
    await monitor.runGatt(async (guard) => {
      if (this.generation === monitor.generation && this.control && this.response) return;
      const service = await boundedGatt(monitor.device.gatt.getPrimaryService(SD_SERVICE));
      guard();
      const control = await boundedGatt(service.getCharacteristic(SD_CONTROL));
      guard();
      const response = await boundedGatt(service.getCharacteristic(SD_RESPONSE));
      guard();
      this.control = control;
      this.response = response;
      this.generation = monitor.generation;
    });
  }

  async request(operation, payload, signal) {
    const id = this.id = (this.id + 1) & 0xFFFF;
    const bytes = fileRequest(id, operation, payload);
    return this.monitor.runGatt(async (guard) => {
      guard();
      if (this.generation !== this.monitor.generation) throw new Error("Geräteverbindung beendet.");
      // Retried requests retain their ID: the MCU returns its cached response
      // instead of accidentally advancing the directory a second time.
      for (let attempt = 0; attempt < 3; ++attempt) {
        let checksumRetries = 0;
        checkCancelled(signal);
        await boundedGatt(this.control.writeValueWithResponse(bytes));
        guard();
        checkCancelled(signal);
        const deadline = performance.now() + 3000;
        do {
          checkCancelled(signal);
          const view = await boundedGatt(this.response.readValue());
          guard();
          checkCancelled(signal);
          let result;
          try { result = decodeFileResponse(view, id, operation); }
          catch (error) {
            if (!error.checksumError || ++checksumRetries >= 3) throw error;
            continue; // Re-read the same stable block, never advance the file.
          }
          if (result) return result;
          await new Promise((resolve) => setTimeout(resolve, 15));
        } while (performance.now() < deadline);
      }
      throw new Error("Keine SD-Antwort vom Gerät. Dateiliste erneut laden.");
    });
  }

  async session(action) {
    // SD-Zugriff auch bei Fehlern aufräumen, aber nie in einer neuen Verbindung.
    const generation = this.monitor.generation;
    await this.prepare();
    try {
      const result = await action();
      await this.request(SD_OP.close);
      return result;
    } catch (error) {
      if (generation === this.monitor.generation && !error.transportFailure) {
        try { await this.request(SD_OP.close); } catch { /* Original error is more useful. */ }
      }
      throw error;
    }
  }

  async startRecording(participant, comment, sendStart) {
    const bytes = encodeRecordingFields(participant, comment);
    const generation = this.monitor.generation;
    await this.prepare();
    try {
      const size = new Uint8Array(2);
      new DataView(size.buffer).setUint16(0, bytes.length, true);
      const begun = await this.request(SD_OP.metadataBegin, size);
      if (!begun.value) throw new Error("Gerät hat die Aufzeichnungsmetadaten nicht angenommen.");
      for (let offset = 0; offset < bytes.length; offset += 12) {
        const chunk = bytes.subarray(offset, offset + 12);
        const payload = new Uint8Array(2 + chunk.length);
        new DataView(payload.buffer).setUint16(0, offset, true);
        payload.set(chunk, 2);
        const received = await this.request(SD_OP.metadataChunk, payload);
        if (received.value !== offset + chunk.length) throw new Error("Metadatenübertragung unvollständig.");
      }
      const checksum = new Uint8Array(4);
      new DataView(checksum.buffer).setUint32(0, fileCrc32(bytes), true);
      const sealed = await this.request(SD_OP.metadataSeal, checksum);
      if (sealed.value !== begun.value) throw new Error("Metadatenbestätigung passt nicht zum Aufzeichnungsstart.");
      // The MCU consumes this single-use token and writes these exact values
      // before acquisition starts. Never fall back to a plain start on failure.
      await sendStart(`record ${sealed.value}`);
    } catch (error) {
      if (generation === this.monitor.generation && !error.transportFailure) {
        try { await this.request(SD_OP.close); } catch { /* Preserve original error. */ }
      }
      throw error;
    }
  }

  list(onEntry, signal) {
    return this.session(async () => {
      const files = [];
      const names = new Set();
      let response;
      try {
        try { response = await this.request(SD_OP.listInfoNewest, undefined, signal); }
        catch (error) {
          if (!error.message.includes("Invalid SD operation")) throw error;
          // Older firmware still streams entries; the UI keeps received entries sorted.
          response = await this.request(SD_OP.listInfo, undefined, signal);
        }
      }
      catch (error) {
        if (error.message.includes("Invalid SD operation")) {
          throw new Error("Dateiliste mit Versuchsperson und Kommentar benötigt Firmware ab 0.10.0.");
        }
        throw error;
      }
      while (!response.done) {
        if (response.payload.length < 13) throw new Error("Unvollständiger SD-Dateieintrag.");
        const name = new TextDecoder().decode(response.payload.subarray(0, 12));
        if (!/^EKG\d{5}\.BIN$/.test(name) || names.has(name) || files.length >= 100000) {
          throw new Error("Ungültiger SD-Dateieintrag.");
        }
        const metadataStatus = response.payload[12];
        if (metadataStatus > 2 || (metadataStatus !== 1 && response.payload.length !== 13)) throw new Error("Ungültige Dateimetadaten.");
        const fields = metadataStatus === 1 ? decodeRecordingFields(response.payload.subarray(13)) : { participant: "", comment: "" };
        const file = { name, size: response.value, metadataStatus, ...fields };
        names.add(name);
        files.push(file);
        onEntry?.(file);
        response = await this.request(SD_OP.nextInfo, undefined, signal);
      }
      return files;
    });
  }

  download(name, onProgress, signal, onVerified, onChunk) {
    // Chunks dienen nur einer vorläufigen Anzeige. Erst onVerified bestätigt
    // vollständigen Empfang und Hashgleichheit, nicht die medizinische Datenqualität.
    if (!/^EKG\d{5}\.BIN$/.test(name)) return Promise.reject(new Error("Ungültiger Dateiname."));
    return this.session(async () => {
      if (!globalThis.crypto?.subtle) throw new Error("SHA-256 benötigt einen sicheren Browserkontext (HTTPS/localhost).");
      const generation = this.monitor.generation;
      let data;
      await this.monitor.runGatt(async (guard) => {
        try {
          const service = await boundedGatt(this.monitor.device.gatt.getPrimaryService(SD_SERVICE));
          guard();
          data = await boundedGatt(service.getCharacteristic(SD_DATA));
          guard();
        } catch (error) {
          if (error.transportFailure) throw error;
          throw new Error("Schneller, SHA-256-geprüfter Download benötigt Firmware ab 0.11.0.");
        }
      });
      const opened = await this.request(SD_OP.open, new TextEncoder().encode(name), signal);
      const size = opened.value;
      if (size < 1024 || size > SD_MAX_FILE_BYTES) throw new Error("Dateigröße nicht unterstützt (1 KiB bis 32 MiB).");
      const bytes = new Uint8Array(size);
      let session = 0, offset = 0, acknowledged = 0, wake = null;
      let compressedPackets = 0, notificationBytes = 0;
      const early = []; // Notifications may precede the StreamStart response.
      const accept = (packet) => {
        if (!packet || packet.session !== session || packet.offset !== offset || packet.payload.length > size - offset) return;
        bytes.set(packet.payload, offset);
        notificationBytes += packet.wireBytes;
        if (packet.compressed) ++compressedPackets;
        offset += packet.payload.length;
        wake?.();
      };
      const receive = (event) => {
        if (generation !== this.monitor.generation) { wake?.(); return; }
        const packet = decodeStreamPacket(event.target.value);
        if (!session) {
          if (packet && early.length < 512) early.push({ ...packet, payload: packet.payload.slice() });
        } else accept(packet);
      };
      data.addEventListener("characteristicvaluechanged", receive);
      this.monitor.sdData = data;
      this.monitor.sdDataListener = receive;
      try {
        await this.monitor.runGatt(async (guard) => { await boundedGatt(data.startNotifications()); guard(); });
        let start;
        try { start = await this.request(SD_OP.streamStartCompressed, undefined, signal); }
        catch (error) {
          if (!error.message.includes("Invalid SD operation or session")) throw error;
          // Firmware 0.11.0 still supports the same whole-file SHA-256 check.
          // Its unknown-operation error closes the file: reopen before fallback.
          early.length = 0;
          const reopened = await this.request(SD_OP.open, new TextEncoder().encode(name), signal);
          if (reopened.value !== size) throw new Error("SD-Dateigröße hat sich geändert.");
          start = await this.request(SD_OP.streamStart, undefined, signal);
        }
        const info = new DataView(start.payload.buffer, start.payload.byteOffset, start.payload.byteLength);
        if (start.done || start.payload.length !== 8 || !start.value || start.value > 65535 || info.getUint32(0, true) !== size
          || info.getUint16(4, true) !== 4096 || info.getUint16(6, true) < 23) throw new Error("Ungültiger SD-Datenstrom.");
        session = start.value;
        for (const packet of early) accept(packet);
        early.length = 0;
        const position = (count) => {
          const payload = new Uint8Array(6);
          const view = new DataView(payload.buffer);
          view.setUint16(0, session, true); view.setUint32(2, count, true);
          return payload;
        };
        let stalled = 0, lastOffset = offset;
        let published = 0;
        const reportProgress = () => {
          checkCancelled(signal);
          if (onChunk && offset > published) {
            const from = published;
            published = offset;
            onChunk(bytes.slice(from, offset), from, size);
          }
          onProgress?.(offset, size);
        };
        reportProgress();
        while (offset < size) {
          checkCancelled(signal);
          if (generation !== this.monitor.generation) throw new Error("Geräteverbindung beendet.");
          if (offset - acknowledged >= 2048) {
            const count = offset;
            const ack = await this.request(SD_OP.streamAck, position(count), signal);
            if (ack.done || ack.value !== count) throw new Error("Ungültige SD-Empfangsbestätigung.");
            acknowledged = count;
            reportProgress();
          } else {
            // Wake at half a window, EOF, abort, or timeout. No per-packet GATT requests.
            await new Promise((resolve) => {
              const timer = setTimeout(finish, 1000);
              function finish() { clearTimeout(timer); signal?.removeEventListener("abort", finish); wake = null; resolve(); }
              wake = () => { if (offset - acknowledged >= 2048 || offset === size || generation !== this.monitor.generation) finish(); };
              signal?.addEventListener("abort", finish, { once: true });
              wake();
            });
            checkCancelled(signal);
            if (offset === lastOffset && offset < size) {
              if (++stalled > 5) throw new Error("SD-Datenstrom bleibt unvollständig. Download erneut starten.");
              const count = offset;
              const seek = await this.request(SD_OP.streamSeek, position(count), signal);
              if (seek.done || seek.value !== count) throw new Error("SD-Wiederholung fehlgeschlagen.");
              acknowledged = count;
            } else stalled = 0;
            lastOffset = offset;
            reportProgress();
          }
        }
        reportProgress(); // Publish the final prefix before the whole-file verification.
        const ack = await this.request(SD_OP.streamAck, position(size), signal);
        if (ack.done || ack.value !== size) throw new Error("SD-Dateiende nicht bestätigt.");
        const finish = await this.request(SD_OP.streamFinish, position(size).subarray(0, 2), signal);
        if (finish.done || finish.value !== size || finish.payload.length !== 32) throw new Error("SD-Dateiprüfsumme fehlt.");
        const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
        checkCancelled(signal);
        if (generation !== this.monitor.generation) throw new Error("Geräteverbindung beendet.");
        if (hash.some((value, index) => value !== finish.payload[index])) {
          throw new Error("SHA-256 stimmt nicht mit der SD-Datei überein. Kein CSV exportiert.");
        }
        onProgress?.(size, size);
        onVerified?.({ algorithm: "SHA-256", bytes: size, sha256: Array.from(hash, (v) => v.toString(16).padStart(2, "0")).join(""),
          mtu: info.getUint16(6, true), compression: compressedPackets ? "record_delta_v1" : "none", compressedPackets, notificationBytes });
        return bytes;
      } finally {
        data.removeEventListener("characteristicvaluechanged", receive);
        if (generation === this.monitor.generation) {
          await this.monitor.runGatt(async (guard) => {
            await boundedGatt(data.stopNotifications()); guard();
            if (this.monitor.sdData === data && this.monitor.sdDataListener === receive) {
              this.monitor.sdData = this.monitor.sdDataListener = null;
            }
          }).catch(() => {});
        }
      }
    });
  }

  // Legacy pull transport retained for protocol regression tests, not used by
  // the UI: it lacks the mandatory whole-file SHA-256 verification.
  downloadBlocks(name, onProgress, signal) {
    if (!/^EKG\d{5}\.BIN$/.test(name)) return Promise.reject(new Error("Ungültiger Dateiname."));
    return this.session(async () => {
      const opened = await this.request(SD_OP.open, new TextEncoder().encode(name), signal);
      const size = opened.value;
      if (size < 1024 || size > SD_MAX_FILE_BYTES) throw new Error("Dateigröße nicht unterstützt (1 KiB bis 32 MiB).");
      const bytes = new Uint8Array(size);
      let offset = 0;
      onProgress?.(0, size);
      while (offset < size) {
        const position = new Uint8Array(4);
        new DataView(position.buffer).setUint32(0, offset, true);
        const block = await this.request(SD_OP.read, position, signal);
        if (block.done || block.value !== offset || !block.payload.length || block.payload.length > size - offset) {
          throw new Error("Unvollständige oder falsch positionierte Dateidaten.");
        }
        bytes.set(block.payload, offset);
        offset += block.payload.length;
        onProgress?.(offset, size);
      }
      return bytes;
    });
  }
}

function recordingHeader(bytes, sourceName) {
  if (bytes.length < 512) throw new Error("Aufzeichnungsheader ist unvollständig.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => new TextDecoder().decode(bytes.subarray(offset, offset + length)).split("\0")[0];
  if (text(0, 4) !== "BEKG" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 512
    || view.getUint16(8, true) !== 12) throw new Error("Kein unterstützter Bike-EKG-Dateikopf.");
  const flags = view.getUint16(14, true);
  const unixTime = flags & 2 ? view.getUint32(16, true) : null;
  const input = view.getUint8(13);
  let fields = { participant: "", comment: "" };
  if (flags & 4) {
    const length = 12 + view.getUint16(50, true) + view.getUint16(52, true);
    if (length > 468) throw new Error("Ungültige Aufzeichnungsmetadaten im Header.");
    fields = decodeRecordingFields(bytes.subarray(44, 44 + length));
  }
  return {
    csv_format_version: 1,
    source_file: sourceName,
    exported_utc: new Date().toISOString(),
    binary_format_version: 1,
    header_bytes: 512,
    record_bytes: 12,
    firmware_version: text(28, 16),
    ...fields,
    sample_rate_sps: view.getUint16(10, true),
    gain_multiplier: view.getUint8(12),
    input_mux: input,
    input_name: ({ 0: "normal", 1: "short", 5: "test" })[input] || "unknown",
    header_flags: flags,
    rld_enabled: Boolean(flags & 1),
    device_unix_time: unixTime,
    device_start_utc: unixTime === null ? null : new Date(unixTime * 1000).toISOString(),
    header_boot_time_us: view.getUint32(20, true),
    header_expected_duration_seconds: view.getUint32(24, true),
    signal_format: "raw_adc_counts",
  };
}

function recordingMetadata(bytes, sourceName) {
  // Footer und Dateilänge müssen zusammenpassen; Vorallokation allein ist kein Abschluss.
  if (bytes.length < 1024) throw new Error("Aufzeichnung ist unvollständig.");
  const header = recordingHeader(bytes, sourceName);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => new TextDecoder().decode(bytes.subarray(offset, offset + length)).split("\0")[0];
  const footer = bytes.length - 512;
  if (text(footer, 4) !== "END!" || view.getUint16(footer + 4, true) !== 1 || view.getUint16(footer + 6, true) !== 512) {
    throw new Error("Aufzeichnung nicht vollständig abgeschlossen (Abschlussblock fehlt). Kein CSV exportiert.");
  }
  const count = view.getUint32(footer + 12, true);
  if (bytes.length !== 1024 + count * 12 || view.getUint16(footer + 40, true) > 1023) {
    throw new Error("Dateigröße oder Abschlussstatistik passt nicht zur Aufzeichnung.");
  }
  return {
    ...header,
    footer_format_version: 1,
    footer_bytes: 512,
    footer_duration_us: view.getUint32(footer + 8, true),
    footer_samples_written: count,
    footer_samples_received: view.getUint32(footer + 16, true),
    footer_samples_processed: view.getUint32(footer + 20, true),
    footer_samples_dropped: view.getUint32(footer + 24, true),
    footer_sample_read_errors: view.getUint32(footer + 28, true),
    footer_inferred_missed_drdy: view.getUint32(footer + 32, true),
    footer_settling_samples_discarded: view.getUint32(footer + 36, true),
    footer_ring_max_fill: view.getUint16(footer + 40, true),
    footer_reason: text(footer + 44, 16),
    footer_error: text(footer + 60, 64),
  };
}

async function recordingCsv(bytes, sourceName, { signal, onProgress, verification, localFile = false } = {}) {
  // Export immer aus unveränderten BIN-Bytes, niemals aus Darstellungsfiltern.
  // JSON-escaped Metadaten halten mehrzeilige Kommentare aus den CSV-Datenzeilen heraus.
  const metadata = recordingMetadata(bytes, sourceName);
  if (localFile) metadata.transfer_verification = "not_verified_local_file";
  if (verification) {
    metadata.transfer_verification = verification.algorithm;
    metadata.source_binary_sha256 = verification.sha256;
    metadata.source_binary_bytes = verification.bytes;
    metadata.transfer_compression = verification.compression;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [Object.entries(metadata).map(([key, value]) => `# ${key}: ${JSON.stringify(value)}\n`).join("")
    + "sample_number,timestamp_us,timestamp_s,adc_counts\r\n"];
  let previous = null, wrap = 0, chunk = "";
  for (let i = 0; i < metadata.footer_samples_written; ++i) {
    const offset = 512 + i * 12;
    const timestamp = view.getUint32(offset + 4, true);
    if (previous !== null && previous - timestamp > 0x80000000) wrap += 0x100000000;
    previous = timestamp;
    chunk += `${view.getUint32(offset, true)},${timestamp},${((timestamp + wrap) / 1000000).toFixed(6)},${view.getInt32(offset + 8, true)}\r\n`;
    if ((i + 1) % 2048 === 0) {
      parts.push(chunk); chunk = "";
      checkCancelled(signal);
      onProgress?.(i + 1, metadata.footer_samples_written);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  checkCancelled(signal);
  parts.push(chunk);
  onProgress?.(metadata.footer_samples_written, metadata.footer_samples_written);
  return new Blob(parts, { type: "text/csv;charset=utf-8" });
}

function formatFileSize(size) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 2 })} MiB`
    : `${(size / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} KiB`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SD_SERVICE, SD_CONTROL, SD_RESPONSE, SD_DATA, SD_OP, SdFileClient, fileCrc32, fileCrc32Update, decodeStreamPacket, fileRequest,
    decodeFileResponse, recordingHeader, recordingMetadata, recordingCsv, formatFileSize, encodeRecordingFields, decodeRecordingFields,
    PARTICIPANT_MAX_BYTES, COMMENT_MAX_BYTES };
}
