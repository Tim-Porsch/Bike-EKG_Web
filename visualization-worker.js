"use strict";

// Lokale Datei im Worker prüfen/dekodieren; Dateiendung oder BEKG-Magic erkennt BIN.
// Transferlisten übergeben große ArrayBuffer ohne zusätzliche Ergebnis-Kopie.
// Lokale Formatprüfung behauptet bewusst keinen SHA-256-Abgleich mit dem Gerät.

importScripts("visualization-data.js", "files.js", "visualization-stream.js");

self.onmessage = async ({ data: file }) => {
  try {
    if (!file.size || file.size > EkgCsv.MAX_BYTES) throw new Error("Die Datei ist leer oder größer als 256 MiB.");
    const binaryName = /\.bin$/i.test(file.name || "");
    if (binaryName && file.size > 32 * 1024 * 1024) throw new Error("BIN-Dateien dürfen maximal 32 MiB groß sein.");
    const bytes = await file.arrayBuffer();
    const binary = new Uint8Array(bytes);
    const binaryMagic = binary[0] === 0x42 && binary[1] === 0x45 && binary[2] === 0x4b && binary[3] === 0x47;
    if (binaryName || binaryMagic) {
      const metadata = recordingMetadata(binary, file.name || "Aufzeichnung.bin");
      metadata.transfer_verification = "not_verified_local_file";
      const stream = new EkgBinaryStream(file.name || "Aufzeichnung.bin");
      stream.push(binary, 0, binary.length);
      const data = stream.finish(metadata);
      self.postMessage({ data, binary }, [data.times.buffer, data.values.buffer, data.gaps.buffer,
        data.minima.buffer, data.maxima.buffer, data.gapPrefix.buffer, binary.buffer]);
      return;
    }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Die CSV muss als UTF-8 gespeichert sein."); }
    const data = EkgCsv.parse(text);
    self.postMessage({ data }, [data.times.buffer, data.values.buffer, data.gaps.buffer,
      data.minima.buffer, data.maxima.buffer, data.gapPrefix.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || "Die CSV-/BIN-Datei konnte nicht eingelesen werden." });
  }
};
