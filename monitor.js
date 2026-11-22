"use strict";

// Independent of the connected device's firmware version; bump with web releases.
const WEB_APP_VERSION = "0.1.8";

// Drei Ebenen: BleMonitor verwaltet GATT, FirmwareClient bestätigt Textbefehle,
// initializePage verbindet Gerätezustand und Oberfläche. Binärdaten laufen separat.

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const DEVICE_NAME = "Bike-EKG";
const LEGACY_DEVICE_NAME = "Bike_EKG_Debug";
const previewApi = typeof module !== "undefined" && module.exports
  ? require("./preview.js")
  : { PREVIEW_SERVICE, PREVIEW_DATA, PREVIEW_STATUS, PreviewModel, PreviewPlot };
const fileApi = typeof module !== "undefined" && module.exports
  ? require("./files.js")
  : { SD_SERVICE, SdFileClient, recordingMetadata, recordingCsv, formatFileSize, encodeRecordingFields, PARTICIPANT_MAX_BYTES, COMMENT_MAX_BYTES };

function encodeCommand(text) {
  const command = text.trim().replace(/ +/g, " ");
  if (!command || /[\r\n\0]/.test(command)) {
    throw new Error("Bitte genau einen Befehl ohne Zeilenumbruch eingeben.");
  }
  const bytes = new TextEncoder().encode(command + "\n");
  // Firmware: 64-Byte-Zeilenpuffer, einschließlich abschließendem Nullbyte.
  if (bytes.length > 64) throw new Error("Befehl zu lang (maximal 63 UTF-8-Bytes).");
  return { command, bytes };
}

class BleMonitor {
  constructor({ bluetooth, onState, onText, onMessage, shouldReconnect, syncTime }) {
    Object.assign(this, { bluetooth, onState, onText, onMessage, shouldReconnect, syncTime });
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.previewData = null;
    this.previewStatus = null;
    this.previewReady = false;
    this.sdData = this.sdDataListener = null;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.teardown = Promise.resolve();
    this.retryTimer = null;
    this.displayTimer = null;
    this.displayPending = false;
    this.displayConfirmed = false;
    this.manualDisconnect = true;
    this.decoder = new TextDecoder();
    this.responseTail = "";
    this.retryAttempt = 0;
    this.state = "disconnected";
    this.handleDisconnect = () => this.disconnected();
    this.handleNotification = (event) => {
      const text = this.decoder.decode(event.target.value, { stream: true });
      this.responseTail = (this.responseTail + text).slice(-512);
      if (this.displayPending && this.responseTail.includes("display: started; NUS will disconnect")) {
        this.displayConfirmed = true;
      }
      this.onText(text);
    };
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  detachNotifications() {
    this.sdData?.removeEventListener("characteristicvaluechanged", this.sdDataListener);
    this.sdData = this.sdDataListener = null;
    this.tx?.removeEventListener("characteristicvaluechanged", this.handleNotification);
    this.tx = null;
    this.rx = null;
    this.detachPreviewNotifications();
  }

  detachPreviewNotifications() {
    this.previewData?.removeEventListener("characteristicvaluechanged", this.previewDataListener);
    this.previewStatus?.removeEventListener("characteristicvaluechanged", this.previewStatusListener);
    this.previewData = this.previewStatus = null;
    this.previewReady = false;
  }

  clearDisplay() {
    clearTimeout(this.displayTimer);
    this.displayPending = false;
    this.displayConfirmed = false;
  }

  async chooseDevice() {
    this.disconnect();
    const generation = this.generation;
    this.setState("selecting");
    try {
      // Must be called directly from a click; no await before requestDevice.
      const device = await this.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }, { name: LEGACY_DEVICE_NAME }],
        optionalServices: [NUS_SERVICE, previewApi.PREVIEW_SERVICE, fileApi.SD_SERVICE],
      });
      // Keep requestDevice directly in the click handler (user activation), but
      // never open GATT until the previous subscriptions/connection are closed.
      await this.teardown;
      if (generation !== this.generation) return;
      this.device = device;
      this.retryAttempt = 0;
      device.addEventListener("gattserverdisconnected", this.handleDisconnect);
      this.manualDisconnect = false;
      await this.open(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.disconnect();
      if (error.name === "NotFoundError") this.onMessage("Geräteauswahl abgebrochen oder kein passendes Gerät gefunden.");
      else this.onMessage(`Verbindung fehlgeschlagen: ${error.message}`);
    }
  }

  async open(generation) {
    this.setState("connecting");
    const device = this.device;
    const server = await device.gatt.connect();
    if (generation !== this.generation || this.manualDisconnect) {
      // connect() selbst ist nicht abbrechbar. Eine spät fertiggestellte,
      // inzwischen verworfene Verbindung darf nicht unbemerkt offen bleiben.
      if (this.device !== device || this.manualDisconnect) server.disconnect();
      throw new Error("Verbindungsversuch beendet.");
    }
    const assertCurrent = () => {
      if (generation !== this.generation || this.manualDisconnect) throw new Error("Verbindungsversuch beendet.");
    };
    assertCurrent();
    const service = await server.getPrimaryService(NUS_SERVICE);
    assertCurrent();
    const rx = await service.getCharacteristic(NUS_RX);
    assertCurrent();
    const tx = await service.getCharacteristic(NUS_TX);
    assertCurrent();
    this.tx = tx;
    this.decoder = new TextDecoder();
    this.responseTail = "";
    tx.addEventListener("characteristicvaluechanged", this.handleNotification);
    await tx.startNotifications();
    assertCurrent();
    this.rx = rx;
    // Synchronisierung vor Freigabe der Eingabe verhindert parallele GATT-Schreibvorgänge.
    if (this.syncTime()) {
      const { bytes, command } = encodeCommand(`time ${Math.floor(Date.now() / 1000)}`);
      await this.write(bytes, generation, rx);
      assertCurrent();
      this.onMessage(`Gesendet: ${command} (Zeitsynchronisierung)`);
    }
    this.retryAttempt = 0;
    this.setState("connected");
    this.onMessage(`Verbunden mit ${this.device.name || DEVICE_NAME}.`);
  }

  runGatt(action) {
    // Alle GATT-Zugriffe serialisieren. guard nach await verhindert, dass späte
    // Ergebnisse einer alten Verbindung in den Zustand der neuen Sitzung gelangen.
    const generation = this.generation;
    const assertCurrent = () => {
      if (generation !== this.generation || this.state !== "connected") throw new Error("Keine Geräteverbindung.");
    };
    const operation = this.queue.then(async () => {
      assertCurrent();
      return action(assertCurrent);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  preparePreview(onData, onStatus) {
    return this.runGatt(async (assertCurrent) => {
      try {
        if (!this.previewReady) {
          this.detachPreviewNotifications();
          const service = await this.device.gatt.getPrimaryService(previewApi.PREVIEW_SERVICE);
          assertCurrent();
          const data = await service.getCharacteristic(previewApi.PREVIEW_DATA);
          assertCurrent();
          const status = await service.getCharacteristic(previewApi.PREVIEW_STATUS);
          assertCurrent();
          this.previewData = data;
          this.previewStatus = status;
          this.previewDataListener = (event) => onData(event.target.value);
          this.previewStatusListener = (event) => onStatus(event.target.value);
          data.addEventListener("characteristicvaluechanged", this.previewDataListener);
          status.addEventListener("characteristicvaluechanged", this.previewStatusListener);
          await status.startNotifications();
          assertCurrent();
          await data.startNotifications();
          assertCurrent();
          this.previewReady = true;
        }
        const value = await this.previewStatus.readValue();
        assertCurrent();
        onStatus(value);
      } catch (error) {
        this.detachPreviewNotifications();
        throw error;
      }
    });
  }

  readPreviewStatus(onStatus) {
    return this.runGatt(async (assertCurrent) => {
      if (!this.previewStatus) return;
      const value = await this.previewStatus.readValue();
      assertCurrent();
      onStatus(value);
    });
  }

  async write(bytes, generation, rx) {
    // 20-Byte-Pakete funktionieren auch mit der kleinsten BLE-ATT-MTU.
    for (let offset = 0; offset < bytes.length; offset += 20) {
      if (generation !== this.generation || !this.device?.gatt.connected) {
        throw new Error("Verbindung während des Sendens getrennt.");
      }
      const chunk = bytes.slice(offset, offset + 20);
      if (rx.properties.write) await rx.writeValueWithResponse(chunk);
      else if (rx.properties.writeWithoutResponse) await rx.writeValueWithoutResponse(chunk);
      else throw new Error("Keine beschreibbare UART-Characteristic verfügbar.");
    }
  }

  send(text) {
    // Ein erfolgreicher BLE-Write bestätigt nur Transport, nicht Befehlsausführung.
    // Befehle mit Seiteneffekten werden bei Reconnect niemals erneut gesendet.
    const { command, bytes } = encodeCommand(text);
    const generation = this.generation;
    const operation = this.queue.then(async () => {
      if (generation !== this.generation || this.state !== "connected" || !this.rx) {
        throw new Error("Keine Geräteverbindung.");
      }
      const display = command === "display start";
      if (display) {
        this.displayPending = true;
        this.displayConfirmed = false;
        this.responseTail = "";
        this.setState("switching");
        this.displayTimer = setTimeout(() => {
          this.clearDisplay();
          if (this.device?.gatt.connected) {
            this.setState("connected");
            this.onMessage("Displaymodus nicht bestätigt. Konsolenverbindung besteht weiterhin; Geräteantwort prüfen.");
          }
        }, 5000);
      }
      try {
        await this.write(bytes, generation, this.rx);
        this.onMessage(`Gesendet: ${command}`);
      } catch (error) {
        // Beim Moduswechsel kann das Board direkt nach Empfang des Befehls trennen.
        if (display && generation !== this.generation) return;
        if (display) {
          this.clearDisplay();
          if (this.device?.gatt.connected) this.setState("connected");
        }
        error.transportFailure = true;
        throw error;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  disconnected() {
    const wasDisplay = this.displayPending;
    const confirmed = this.displayConfirmed;
    this.generation += 1;
    this.detachNotifications();
    this.clearDisplay();
    if (this.manualDisconnect) return;
    if (wasDisplay) {
      this.manualDisconnect = true;
      this.setState("display");
      this.onMessage(confirmed
        ? "Displaymodus vom Gerät bestätigt. Konsolenverbindung beendet; Rückkehr durch Geräteneustart."
        : "Verbindung nach Displaybefehl getrennt; Moduswechsel nicht bestätigt. Automatische Wiederverbindung ausgesetzt. Gerätezustand prüfen.");
      return;
    }
    this.onMessage("BLE-Verbindung unterbrochen.");
    this.setState("disconnected");
    if (this.shouldReconnect()) this.scheduleReconnect(this.retryAttempt + 1, this.generation);
  }

  scheduleReconnect(attempt, generation) {
    clearTimeout(this.retryTimer);
    if (attempt > 5 || !this.shouldReconnect()) {
      this.setState("disconnected");
      this.onMessage("Automatische Wiederverbindung beendet. Bei Bedarf erneut „Verbinden“ wählen.");
      return;
    }
    this.retryAttempt = attempt;
    this.setState("reconnecting");
    this.onMessage(`Wiederverbindung ${attempt}/5 wird versucht …`);
    this.retryTimer = setTimeout(async () => {
      if (generation !== this.generation || this.manualDisconnect) return;
      if (!this.shouldReconnect()) {
        this.setState("disconnected");
        return;
      }
      try {
        await this.open(generation);
      } catch (error) {
        if (generation !== this.generation) return;
        this.detachNotifications();
        this.onMessage(`Wiederverbindung fehlgeschlagen: ${error.message}`);
        this.scheduleReconnect(attempt + 1, generation);
      }
    }, Math.min(1000 * 2 ** (attempt - 1), 10000));
  }

  disconnect() {
    const device = this.device;
    const characteristics = [this.sdData, this.previewData, this.previewStatus, this.tx].filter(Boolean);
    const pendingWrites = this.queue;
    this.manualDisconnect = true;
    this.generation += 1;
    clearTimeout(this.retryTimer);
    this.clearDisplay();
    this.detachNotifications();
    if (device) device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
    this.device = null;
    this.setState("disconnected");
    if (device) {
      this.teardown = this.closeGatt(device, characteristics, pendingWrites);
      // A hung operation from an old session must not block future commands.
      this.queue = Promise.resolve();
    }
    return this.teardown;
  }

  async closeGatt(device, characteristics, pendingWrites) {
    // Removing JS listeners is not the same as stopping Web Bluetooth
    // notifications. Explicitly unsubscribe while GATT is still connected so
    // Chromium does not retain an active notification registration on reconnect.
    let timer;
    let cleaning = true;
    try {
      await Promise.race([
        (async () => {
          await pendingWrites;
          for (const characteristic of characteristics) {
            if (!cleaning || !device.gatt.connected) break;
            try { await characteristic.stopNotifications(); }
            catch { /* Disconnect must still work if an unsubscribe fails. */ }
          }
        })(),
        new Promise((resolve) => { timer = setTimeout(resolve, 1500); }),
      ]);
    } finally {
      cleaning = false;
      clearTimeout(timer);
      if (device.gatt.connected) {
        // disconnect() returns before the browser's disconnect event. Do not let
        // that late event tear down the next connection to the same device.
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            device.removeEventListener("gattserverdisconnected", done);
            resolve();
          };
          device.addEventListener("gattserverdisconnected", done);
          timer = setTimeout(done, 1500);
          try { device.gatt.disconnect(); }
          catch { done(); }
        });
      }
    }
  }
}

// The firmware emits config as a multi-line response, split over BLE notifications.
function parseConfiguration(lines) {
  const fields = Object.fromEntries(lines.map((line) => {
    const separator = line.indexOf(":");
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  const band = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?) Hz$/.exec(fields.filter_band || "");
  if (!band || !/^\d+ SPS$/.test(fields.rate) || !/^x\d+$/.test(fields.gain)
    || !/^\d+ seconds$/.test(fields.test_duration)
    || !/^(on|off)(?: |$)/.test(fields.rld || "")
    || !(fields.stream_filter === "off" || fields.stream_filter === fields.filter_band)) {
    throw new Error("Unvollständige oder unbekannte Konfigurationsantwort.");
  }
  const configuration = {
    rate: Number(fields.rate.split(" ")[0]), gain: Number(fields.gain.slice(1)),
    input: fields.input, rld: fields.rld.startsWith("on") ? "on" : "off",
    duration: Number(fields.test_duration.split(" ")[0]),
    filter: fields.stream_filter === "off" ? "off" : "on",
    low: Number(band[1]), high: Number(band[2]),
  };
  validateConfiguration(configuration);
  return configuration;
}

function validateConfiguration(value) {
  if (![125, 250, 500].includes(value.rate) || ![1, 2, 3, 4, 6, 8, 12].includes(value.gain)
    || !["normal", "short", "test"].includes(value.input)
    || !["on", "off"].includes(value.rld) || !["on", "off"].includes(value.filter)) {
    throw new Error("Ungültige Auswahl in der Konfiguration.");
  }
  if (!Number.isInteger(value.duration) || value.duration < 1 || value.duration > 4200) {
    throw new Error("Die Aufzeichnungsdauer muss zwischen 1 und 4200 Sekunden liegen.");
  }
  if (!Number.isFinite(value.low) || !Number.isFinite(value.high)
    || value.low < 0.001 || value.low >= value.high || value.high > 65.535 || value.high >= value.rate / 2
    || [value.low, value.high].some((hz) => Math.abs(hz * 1000 - Math.round(hz * 1000)) > 0.000001)) {
    throw new Error("Filtergrenzen prüfen: 0 < unten < oben ≤ 65,535 Hz; oben < halbe Abtastrate. Maximal drei Nachkommastellen.");
  }
}

function configurationCommands(current, next) {
  validateConfiguration(next);
  const commands = [];
  const rate = current.rate !== next.rate ? `rate ${next.rate}` : null;
  const band = current.low !== next.low || current.high !== next.high
    ? `filter band ${next.low} ${next.high}` : null;
  // Lower the band first if the existing band would make a lower sample rate invalid.
  if (rate && current.high >= next.rate / 2) {
    if (band) commands.push(band);
    commands.push(rate);
  } else {
    if (rate) commands.push(rate);
    if (band) commands.push(band);
  }
  for (const [key, command] of [["gain", "gain"], ["input", "input"], ["duration", "test_duration"], ["rld", "rld"], ["filter", "filter"]]) {
    if (current[key] !== next[key]) commands.push(`${command} ${next[key]}`);
  }
  return commands;
}

class FirmwareClient {
  // Notifications können mitten in UTF-8-Textzeilen enden. BleMonitor dekodiert
  // die Bytes zustandsbehaftet; hier werden vollständige Antwortzeilen gesammelt.
  constructor(send, onLine = () => {}) {
    this.send = send;
    this.onLine = onLine;
    this.buffer = "";
    this.pending = null;
  }

  reset() {
    this.pending?.finish(new Error("Geräteverbindung beendet."));
    this.buffer = "";
  }

  feed(text) {
    this.buffer += text;
    let end;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(end + 1);
      const pending = this.pending;
      if (pending) {
        if (line.startsWith("error:")) pending.finish(new Error(line.slice(6).trim()));
        else if (pending.command === "config") {
          // An older, truncated reply may leave a partial line before this marker.
          if (line.endsWith("config:")) pending.lines = [];
          else if (pending.lines) {
            pending.lines.push(line);
            if (line.startsWith("apply:")) {
              try { pending.finish(null, parseConfiguration(pending.lines)); }
              catch (error) { pending.finish(error); }
            }
          }
        } else if ((/^(start|stream start|record \d+)$/.test(pending.command) && /^(logging|streaming): started$/.test(line))
          || (pending.command === "preview start" && line === "preview: started")
          || (pending.command === "preview stop" && line === "preview: stopped")
          || (/^(stop|stream stop)$/.test(pending.command) && line === "state: idle")
          || (pending.command === "config reset" && line === "config: reset to defaults")
          || (/^(gain|rate|input|rld|test_duration|filter) /.test(pending.command) && line.startsWith("setting:"))) {
          pending.finish(null);
        }
      }
      this.onLine(line);
    }
    // A malformed device response must not grow the parser buffer indefinitely.
    this.buffer = this.buffer.slice(-4096);
  }

  request(command) {
    if (this.pending) return Promise.reject(new Error("Eine Geräteantwort steht noch aus."));
    return new Promise((resolve, reject) => {
      const pending = {
        command, lines: null, attempt: 0,
        finish: (error, value) => {
          if (this.pending !== pending) return;
          clearTimeout(pending.timer);
          this.pending = null;
          if (error) reject(error); else resolve(value);
        },
      };
      this.pending = pending;
      const transportError = (error) => {
        error.transportFailure = true;
        pending.finish(error);
      };
      const sendAttempt = () => {
        if (command === "config") {
          this.buffer = "";
          pending.lines = null;
        }
        pending.timer = setTimeout(() => {
          // Only the read-only query is safe to repeat. Never retry writes,
          // explicit firmware errors, or across reset()/a disconnected session.
          if (command === "config" && pending.attempt++ === 0) {
            sendAttempt();
            return;
          }
          pending.finish(new Error(pending.lines
            ? "Unvollständige Konfigurationsantwort. Konfiguration erneut laden."
            : "Keine Geräteantwort. Konfiguration erneut laden."));
        }, 6000);
        try { Promise.resolve(this.send(command)).catch(transportError); }
        catch (error) { transportError(error); }
      };
      sendAttempt();
    });
  }
}

class RecordingProgress {
  // Monotone Hostzeit statt hochgezählter Timer-Ticks: reine Laufzeitschätzung,
  // ausdrücklich kein Beleg für erfolgreich auf SD gespeicherte Samples.
  constructor(now = () => performance.now()) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.duration = 0;
    this.startedAt = null;
    this.stoppedElapsed = null;
    this.reason = "";
  }

  start(duration) {
    this.reset();
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.duration = duration;
    this.startedAt = this.now();
  }

  finish(reason = "") {
    if (this.startedAt === null) return;
    if (this.stoppedElapsed === null) this.stoppedElapsed = this.snapshot().elapsed;
    this.reason = reason;
    if (reason === "timeout") this.stoppedElapsed = this.duration;
  }

  snapshot() {
    if (this.startedAt === null) return null;
    const elapsed = Math.min(this.duration, Math.max(0,
      this.stoppedElapsed ?? (this.now() - this.startedAt) / 1000));
    return {
      elapsed, remaining: Math.max(0, this.duration - elapsed),
      percent: elapsed / this.duration * 100,
      finished: this.stoppedElapsed !== null, reason: this.reason,
    };
  }
}

function formatDuration(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

function initializePage() {
  const element = (id) => document.getElementById(id);
  element("monitor-script-version").textContent = WEB_APP_VERSION;
  const output = element("console");
  const input = element("command");
  const history = [];
  let historyPosition = 0;
  let draft = "";
  let busy = false;
  let configuration = null;
  let firmwareVersion = null;
  let hasDisplayedConfiguration = false;
  let loadedGeneration = null;
  let operationState = "unknown";
  let fileJob = null;
  let sdFiles = [];
  let sdDownloadButtons = [];
  let completedRecording = null;
  let recordingSummary = null;
  const recording = new RecordingProgress();
  let recordingTimer = null;
  const preview = new previewApi.PreviewModel();
  const previewPlot = new previewApi.PreviewPlot(element("preview-canvas"), preview);
  let previewTimer = null;
  const settingKeys = ["rate", "gain", "input", "duration", "rld", "filter", "low", "high"];
  const supported = window.isSecureContext && Boolean(navigator.bluetooth);
  const labels = {
    disconnected: "Nicht verbunden", selecting: "Geräteauswahl …", connecting: "Verbindungsaufbau …",
    connected: "Verbunden", reconnecting: "Wiederverbindung …", switching: "Displaymodus angefordert …",
    display: "Konsolenverbindung beendet",
  };
  const descriptions = {
    disconnected: "Messsystem einschalten und über „Verbinden“ das Gerät Bike-EKG auswählen.",
    selecting: "Bike-EKG im Auswahldialog des Browsers auswählen.",
    connecting: "Verbindung und UART-Dienst werden eingerichtet.",
    reconnecting: "Die Verbindung wird automatisch wiederhergestellt. „Trennen“ beendet den Vorgang.",
    switching: "Displaymodus angefordert. Geräteantwort und Verbindungsabbau werden abgewartet.",
    display: "Für den erneuten Konsolenbetrieb das Gerät neu starten und anschließend verbinden.",
  };

  function append(text) {
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    output.textContent = (output.textContent + text).slice(-100000);
    if (atBottom) output.scrollTop = output.scrollHeight;
  }
  function message(text) {
    append(`\n[${new Date().toLocaleTimeString("de-DE")}] ${text}\n`);
    element("announcement").textContent = text;
    // Connection errors must remain visible when the console is hidden.
    if (!["connected", "switching"].includes(monitor.state)) element("device-info").textContent = text;
  }
  function configStatus(text, error = false) {
    element("config-status").textContent = text;
    element("config-status").hidden = !text;
    element("config-status").dataset.error = String(error);
  }
  function updateDeviceInfo() {
    if (monitor.state !== "connected") return;
    element("device-info").textContent = `Gerät: ${monitor.device.name || DEVICE_NAME} · Firmware: ${firmwareVersion || "nicht gemeldet"} · Nordic UART Service`;
  }
  function renderRecording() {
    const progress = recording.snapshot();
    element("recording-progress").hidden = !progress;
    if (!progress) return;
    element("recording-bar").value = progress.percent;
    element("recording-percent").textContent = `${Math.floor(progress.percent)} %`;
    element("recording-elapsed").textContent = `${formatDuration(progress.elapsed)} verstrichen`;
    element("recording-remaining").textContent = progress.finished
      ? "" : `ca. ${formatDuration(Math.ceil(progress.remaining))} verbleibend`;
    element("recording-label").textContent = progress.finished
      ? (progress.reason === "user_stop" ? "Vorzeitig beendet" : "Aufzeichnung beendet")
      : (progress.percent >= 100 ? "Warte auf Abschlussbestätigung …" : "Aufzeichnung läuft");
  }
  function stopRecordingTimer() {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
  function renderPreview() {
    const signalLabel = preview.filtered ? "MCU-gefilterte ADC-Werte" : "ADC-Rohwerte";
    element("preview-canvas").setAttribute("aria-label", `Signalverlauf der letzten ${preview.keepSeconds} Sekunden, ${signalLabel}`);
    element("preview-received").textContent = preview.received.toLocaleString("de-DE");
    element("preview-missing").textContent = preview.missing.toLocaleString("de-DE");
    element("preview-loss").dataset.loss = String(preview.missing > 0 || preview.invalid > 0);
    for (const [id, count] of [["acquisition", preview.acquisitionDropped], ["tx-dropped", preview.txDropped],
      ["packet-gaps", preview.packetGaps], ["invalid", preview.invalid]]) {
      element(`preview-${id}`).textContent = count.toLocaleString("de-DE");
    }
    if (preview.active && preview.lastArrival !== null && performance.now() - preview.lastArrival > 1500) {
      element("preview-state").textContent = "Keine neuen Messwerte empfangen. Verbindung oder Erfassung prüfen.";
    } else if (preview.active) {
      element("preview-state").textContent = `${preview.rate || configuration?.rate || "–"} Samples/s · ${signalLabel} · Letzte ${preview.keepSeconds} Sekunden`;
    }
    if (!element("preview-panel").hidden) previewPlot.draw();
  }
  function stopPreviewTimer() {
    clearInterval(previewTimer);
    previewTimer = null;
  }
  function startPreviewTimer() {
    if (previewTimer === null) previewTimer = setInterval(renderPreview, 40);
  }
  function receivePreviewStatus(value) {
    try {
      preview.status(value);
      if (preview.active && !["logging", "streaming"].includes(operationState)) {
        if (operationState !== "preview") {
          operationState = "preview";
          configStatus("Vorschau läuft. Zum Konfigurieren die Vorschau stoppen.");
          updateControls();
        }
        startPreviewTimer();
      } else {
        preview.active = false;
        stopPreviewTimer();
        if (operationState === "preview") {
          operationState = "idle";
          configStatus("Vorschau beendet. Konfiguration kann bearbeitet werden.");
          element("preview-state").textContent = "Vorschau gestoppt · Letzter Signalverlauf";
          updateControls();
        }
      }
      renderPreview();
    } catch (error) {
      ++preview.invalid;
      element("preview-state").textContent = error.message;
    }
  }
  function receivePreviewData(value) {
    try {
      const accepted = preview.data(value);
      // A notification already queued by the radio may arrive after the final
      // status. Reconcile its counters even though the drawing timer has stopped.
      if (accepted && !preview.active) renderPreview();
    }
    catch { ++preview.invalid; }
    // Never append binary samples to the text console; draw at a separate rate.
  }
  function editorValues() {
    return Object.fromEntries(settingKeys.map((key) => {
      const field = element(`setting-${key}`);
      const value = ["rld", "filter"].includes(key) ? (field.checked ? "on" : "off") : field.value;
      return [key, ["rate", "gain", "duration", "low", "high"].includes(key) ? Number(value) : value];
    }));
  }
  function showConfiguration(value) {
    configuration = value;
    hasDisplayedConfiguration = true;
    operationState = "idle";
    for (const key of settingKeys) {
      const field = element(`setting-${key}`);
      if (["rld", "filter"].includes(key)) field.checked = value[key] === "on";
      else field.value = String(value[key]);
    }
    configStatus("");
    updateControls();
  }
  async function readConfiguration() {
    const generation = monitor.generation;
    configuration = null;
    configStatus("Konfiguration wird vom Gerät geladen …");
    updateControls();
    const value = await client.request("config");
    if (generation !== monitor.generation || monitor.state !== "connected") throw new Error("Geräteverbindung beendet.");
    showConfiguration(value);
    return value;
  }
  async function refreshConfiguration() {
    if (busy || monitor.state !== "connected") return;
    busy = true;
    updateControls();
    try { await readConfiguration(); }
    catch (error) { configStatus(`Konfiguration nicht verfügbar: ${error.message}`, true); }
    finally { busy = false; updateControls(); }
  }
  function updateControls() {
    // UI-Sperren aus bestätigtem Geräte-/Jobzustand ableiten, nicht aus Formularwerten.
    const ready = monitor.state === "connected" && !busy;
    const visible = ["connected", "switching"].includes(monitor.state);
    element("device-controls").hidden = !visible;
    element("recording-panel").hidden = !visible;
    element("console-panel").hidden = !visible;
    element("preview-panel").hidden = !visible;
    element("sd-panel").hidden = !visible;
    const filesReady = ready && Boolean(configuration) && operationState === "idle";
    element("recording-result").hidden = !completedRecording;
    element("recording-result-info").textContent = completedRecording ? `${completedRecording.name} · Aufzeichnung auf SD-Karte abgeschlossen.` : "";
    element("recording-visualize").disabled = !filesReady || !completedRecording;
    element("sd-refresh").disabled = !filesReady;
    element("sd-cancel").hidden = !fileJob;
    for (const button of sdDownloadButtons) button.disabled = !filesReady;
    input.disabled = !ready;
    element("send").disabled = !ready;
    document.querySelectorAll("[data-command]").forEach((button) => {
      button.disabled = !ready || (button.dataset.command === "stop"
        ? ["idle", "preview"].includes(operationState)
        : !configuration || !(operationState === "idle" || (button.dataset.command === "start" && operationState === "preview")));
    });
    // Keep the last fields visible while revalidating; configuration remains null
    // until confirmed so stale values cannot be applied after a failed request.
    element("config-fields").hidden = !hasDisplayedConfiguration;
    element("config-fields").disabled = !ready || !configuration || operationState !== "idle";
    element("recording-metadata").disabled = !ready || !configuration || !["idle", "preview"].includes(operationState);
    element("refresh-config").disabled = !ready || operationState === "preview";
    element("preview-start").disabled = !ready || !configuration || operationState !== "idle";
    element("preview-stop").disabled = !ready || operationState !== "preview";
    let changed = false;
    if (configuration) {
      const next = editorValues();
      changed = settingKeys.some((key) => next[key] !== configuration[key]);
    }
    element("apply-config").disabled = !ready || !configuration || !changed || operationState !== "idle";
    element("connect").disabled = !supported || ["selecting", "connecting", "connected", "switching", "reconnecting"].includes(monitor.state);
    element("disconnect").disabled = monitor.state === "disconnected" || monitor.state === "display";
  }
  const client = new FirmwareClient((command) => monitor.send(command), (line) => {
    const version = /^firmware:\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(line);
    if (version && client.pending?.command === "config") {
      firmwareVersion = version[1];
      updateDeviceInfo();
    }
    if (line === "logging: started") {
      completedRecording = null;
      recordingSummary = null;
      preview.active = false;
      stopPreviewTimer();
      element("preview-state").textContent = "Während der SD-Aufzeichnung deaktiviert.";
      stopRecordingTimer();
      recording.start(configuration?.duration);
      renderRecording();
      if (recording.snapshot()) recordingTimer = setInterval(renderRecording, 500);
    } else if (line === "logging complete:") {
      completedRecording = null;
      recordingSummary = { name: null, complete: false };
      recording.finish();
      stopRecordingTimer();
      renderRecording();
    } else if (line.startsWith("reason:") && recording.snapshot()?.finished) {
      recording.finish(line.slice(7).trim());
      renderRecording();
    }
    if (recordingSummary) {
      const file = /^file: (EKG\d{5}\.BIN)$/.exec(line);
      if (file) recordingSummary.name = file[1];
      if (line.startsWith("sd:")) recordingSummary.complete = line === "sd: complete";
      if (line === "state: idle") {
        completedRecording = recordingSummary.complete && recordingSummary.name
          ? { name: recordingSummary.name } : null;
        recordingSummary = null;
      }
    }
    if (line === "preview: started") {
      operationState = "preview";
      preview.active = true;
      configStatus("Vorschau läuft. Zum Konfigurieren die Vorschau stoppen.");
      startPreviewTimer();
      renderPreview();
      updateControls();
    } else if (line === "preview: stopped") {
      preview.active = false;
      stopPreviewTimer();
      operationState = "idle";
      configStatus("Vorschau beendet. Konfiguration kann bearbeitet werden.");
      element("preview-state").textContent = "Vorschau gestoppt · Letzter Signalverlauf";
      renderPreview();
      updateControls();
    } else if (line === "logging: started" || line === "streaming: started" || /^state: (logging|streaming)$/.test(line)) {
      operationState = line.includes("streaming") ? "streaming" : "logging";
      configStatus("Messung läuft. Die Konfiguration ist bis zum Ende der Messung gesperrt.");
      updateControls();
    } else if (line === "state: idle") {
      const wasMeasuring = ["logging", "streaming"].includes(operationState);
      operationState = "idle";
      updateControls();
      if (wasMeasuring && !busy) queueMicrotask(refreshConfiguration);
    }
  });
  const monitor = new BleMonitor({
    bluetooth: navigator.bluetooth,
    onState(state) {
      element("connection-state").textContent = labels[state];
      element("connection-state").dataset.state = state;
      if (state === "connected") updateDeviceInfo();
      else element("device-info").textContent = descriptions[state];
      if (!["connected", "switching"].includes(state)) {
        firmwareVersion = null;
        completedRecording = null;
        recordingSummary = null;
        if (fileJob) {
          fileJob.controller.abort();
          fileJob.view?.fail(new Error("Geräteverbindung beendet"));
          fileJob = null;
          busy = false;
        }
        sdFiles = [];
        sdDownloadButtons = [];
        element("sd-files").replaceChildren();
        element("sd-files").setAttribute("aria-busy", "false");
        element("sd-progress").hidden = true;
        element("sd-status").textContent = "Dateiliste im Leerlauf laden und Aufzeichnungen als CSV herunterladen.";
        element("sd-status").dataset.error = "false";
        stopPreviewTimer();
        preview.reset();
        element("preview-state").textContent = "Signalvorschau · Während der SD-Aufzeichnung deaktiviert.";
        stopRecordingTimer();
        recording.reset();
        renderRecording();
        client.reset();
        configuration = null;
        hasDisplayedConfiguration = false;
        loadedGeneration = null;
        operationState = "unknown";
      }
      updateControls();
      if (state === "connected" && loadedGeneration !== monitor.generation) {
        loadedGeneration = monitor.generation;
        queueMicrotask(refreshConfiguration);
        renderPreview();
      }
    },
    onText(text) { append(text); client.feed(text); },
    onMessage: message,
    shouldReconnect: () => element("auto-reconnect").checked,
    syncTime: () => element("sync-time").checked,
  });

  const sdClient = new fileApi.SdFileClient(monitor);

  function sdStatus(text, error = false) {
    element("sd-status").textContent = text;
    element("sd-status").dataset.error = String(error);
  }

  function insertSdFile(file) {
    // Insert only the new row. Never rebuild the existing (possibly scrolled) list.
    let left = 0, right = sdFiles.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (sdFiles[middle].name > file.name) left = middle + 1;
      else right = middle;
    }
    const row = document.createElement("li");
    const info = document.createElement("span");
    info.className = "sd-file-info";
    const name = document.createElement("span");
    name.className = "sd-file-name";
    name.textContent = file.name;
    const size = document.createElement("span");
    size.className = "hint";
    size.textContent = fileApi.formatFileSize(file.size);
    info.append(name, size);
    const details = document.createElement("span");
    details.className = "sd-file-metadata";
    if (file.metadataStatus === 2) details.textContent = "Metadaten nicht lesbar";
    else if (file.metadataStatus === 0) details.textContent = "Keine Versuchsperson und kein Kommentar gespeichert";
    else {
      const participant = document.createElement("span");
      participant.textContent = `Versuchsperson: ${file.participant || "–"}`;
      const comment = document.createElement("span");
      comment.textContent = `Kommentar: ${file.comment || "–"}`;
      details.append(participant, comment);
    }
    info.append(details);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "CSV herunterladen";
    button.disabled = true; // The SD listing owns the connection until completion/cancel.
    button.setAttribute("aria-label", `${file.name} als CSV herunterladen`);
    button.addEventListener("click", () => runSdJob(file));
    const visualize = document.createElement("button");
    visualize.type = "button";
    visualize.textContent = "Visualisieren";
    visualize.disabled = true;
    visualize.setAttribute("aria-label", `${file.name} im Browser visualisieren`);
    visualize.addEventListener("click", () => runSdJob(file, true));
    row.append(info, button, visualize);
    const list = element("sd-files");
    list.insertBefore(row, list.children[left] || null);
    sdFiles.splice(left, 0, file);
    sdDownloadButtons.splice(left * 2, 0, button, visualize);
  }

  async function runSdJob(file = null, visualize = false) {
    // Ein Job besitzt SD-Sitzung und Abbruchsignal. Identitätsprüfungen verhindern,
    // dass verspätete Callbacks einen neu gestarteten Job oder dessen Ansicht ändern.
    if (busy || monitor.state !== "connected" || operationState !== "idle" || !configuration) return;
    const job = { controller: new AbortController(), generation: monitor.generation };
    fileJob = job;
    busy = true;
    const signal = job.controller.signal;
    element("sd-progress").hidden = !file;
    element("sd-progress-bar").value = 0;
    element("sd-progress-text").textContent = "";
    updateControls();
    try {
      if (!file) {
        sdFiles = [];
        sdDownloadButtons = [];
        element("sd-files").replaceChildren();
        element("sd-files").scrollTop = 0;
        element("sd-files").setAttribute("aria-busy", "true");
        sdStatus("SD-Karte wird gelesen …");
        await sdClient.list((entry) => {
          if (fileJob !== job || signal.aborted) return;
          insertSdFile(entry);
          sdStatus(`Dateiliste wird geladen … ${sdFiles.length} Aufzeichnung(en) · Neueste oben. Für einen vorzeitigen Download das Laden abbrechen.`);
        }, signal);
        if (fileJob !== job) return;
        sdStatus(sdFiles.length ? `${sdFiles.length} Aufzeichnung(en) · CSV herunterladen oder visualisieren.` : "Keine Aufzeichnungen auf der SD-Karte gefunden.");
      } else {
        if (visualize) {
          if (!window.EkgViewer) throw new Error("Visualisierer nicht geladen. Bitte die Seite neu laden.");
          job.view = window.EkgViewer.begin(file.name, () => job.controller.abort());
        }
        sdStatus(`${file.name} wird übertragen …`);
        const started = performance.now();
        let verification;
        const bytes = await sdClient.download(file.name, (received, total) => {
          if (fileJob !== job) return;
          const seconds = Math.max(0.1, (performance.now() - started) / 1000);
          element("sd-progress-bar").value = received / total * 100;
          element("sd-progress-text").textContent = `${Math.floor(received / total * 100)} % · ${fileApi.formatFileSize(received)} / ${fileApi.formatFileSize(total)} · ${fileApi.formatFileSize(received / seconds)}/s`;
        }, signal, (result) => { verification = result; }, job.view ? (chunk, offset, total) => {
          if (fileJob === job && !signal.aborted) job.view.append(chunk, offset, total);
        } : undefined);
        if (fileJob !== job) return;
        if (signal.aborted) {
          const error = new Error("Vorgang abgebrochen"); error.name = "AbortError"; throw error;
        }
        if (job.view) {
          job.view.complete(fileApi.recordingMetadata(bytes, file.name), verification, bytes);
          sdStatus(`${file.name} vollständig geladen · SHA-256 mit SD-Datei identisch · In „Daten Visualisieren“ geöffnet.`);
          return;
        }
        sdStatus("SD-Datei vollständig empfangen und mit SHA-256 geprüft. CSV wird erstellt …");
        const blob = await fileApi.recordingCsv(bytes, file.name, { signal, verification });
        if (fileJob !== job || signal.aborted) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name.replace(/\.BIN$/, ".csv");
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        sdStatus(`${link.download} erstellt · SHA-256 mit SD-Datei identisch · MTU ${verification.mtu} · ${verification.compressedPackets ? "verlustfrei komprimiert" : "unkomprimiert"} · Download an den Browser übergeben.`);
      }
    } catch (error) {
      job.view?.fail(error);
      if (fileJob !== job) return;
      const partial = !file && sdFiles.length ? ` Dateiliste unvollständig (${sdFiles.length} Einträge); bereits geladene Aufzeichnungen bleiben verfügbar.` : "";
      sdStatus((error.name === "AbortError" ? "Vorgang abgebrochen. SD-Dateien bleiben unverändert."
        : `${error.message}${sdClient.generation !== job.generation ? " SD-Zugriff benötigt Firmware ab 0.10.0." : ""}`) + partial, error.name !== "AbortError");
      element("sd-progress").hidden = true;
      if (error.transportFailure) monitor.disconnect();
    } finally {
      if (fileJob === job) {
        element("sd-files").setAttribute("aria-busy", "false");
        fileJob = null;
        busy = false;
        updateControls();
      }
    }
  }

  element("recording-visualize").addEventListener("click", () => {
    if (completedRecording) return runSdJob(completedRecording, true);
  });

  if (!supported) {
    const warning = element("compatibility");
    warning.hidden = false;
    if (!window.isSecureContext) {
      warning.textContent = "Web Bluetooth benötigt einen sicheren Kontext. Die Seite über HTTPS oder http://localhost öffnen. Einrichtung: siehe README.";
    } else {
      warning.textContent = "Web Bluetooth ist in diesem Browser nicht verfügbar. Chrome oder Edge verwenden. Unter Linux gegebenenfalls die Option „Experimental Web Platform features“ aktivieren: ";
      const flagsLink = document.createElement("a");
      flagsLink.href = "chrome://flags/#enable-experimental-web-platform-features";
      flagsLink.textContent = "chrome://flags/#enable-experimental-web-platform-features";
      flagsLink.addEventListener("click", (event) => {
        event.preventDefault();
        element("flags-address").focus();
        element("flags-address").select();
        element("copy-result").textContent = "Chromium blockiert das direkte Öffnen dieser internen Seite. Adresse kopieren und in einem neuen Tab öffnen.";
      });
      warning.append(flagsLink, ". Option auf „Enabled“ setzen und den Browser neu starten. Firefox und Safari werden nicht unterstützt.");
      element("browser-setup").hidden = false;
    }
    element("compatibility-dialog-title").textContent = window.isSecureContext
      ? "Browser unterstützt keine Bluetooth-Verbindung" : "Unsichere Verbindung: Bluetooth gesperrt";
    const explanation = window.isSecureContext
      ? "Web Bluetooth ist in diesem Browser nicht verfügbar. Bitte öffnen Sie die Anwendung in einem unterstützten Chrome- oder Edge-Browser auf einem Gerät mit Bluetooth-Unterstützung. Firefox und Safari unterstützen diese Geräteverbindung nicht. Hinweise zur Einrichtung stehen im Bereich unter diesem Fenster."
      : "Web Bluetooth benötigt einen sicheren Kontext. Öffnen Sie die Anwendung über HTTPS oder lokal über http://localhost statt über eine unverschlüsselte HTTP-Adresse.";
    element("compatibility-dialog-message").textContent = explanation;
    const dialog = element("compatibility-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else window.alert?.(`${element("compatibility-dialog-title").textContent}\n\n${explanation}\n\n${element("compatibility-dialog-local").textContent}`);
  }
  updateControls();
  message(supported ? descriptions.disconnected : "Keine Geräteverbindung: Web Bluetooth nicht verfügbar.");

  element("connect").addEventListener("click", () => monitor.chooseDevice());
  element("disconnect").addEventListener("click", () => {
    monitor.disconnect();
    message("Verbindung manuell beendet.");
  });
  element("copy-flags").addEventListener("click", async () => {
    const field = element("flags-address");
    try {
      await navigator.clipboard.writeText(field.value);
      element("copy-result").textContent = "Adresse kopiert. In einem neuen Tab in die Adresszeile einfügen.";
    } catch {
      field.focus();
      field.select();
      element("copy-result").textContent = "Adresse markiert. Mit Strg+C (macOS: ⌘C) kopieren und in einem neuen Tab öffnen.";
    }
  });
  element("refresh-config").addEventListener("click", refreshConfiguration);
  element("sd-refresh").addEventListener("click", () => runSdJob());
  element("sd-cancel").addEventListener("click", () => {
    fileJob?.controller.abort();
    sdStatus("Vorgang wird abgebrochen …");
  });
  element("preview-start").addEventListener("click", () => submit("preview start"));
  element("preview-keep-seconds").addEventListener("change", () => {
    preview.setKeepSeconds(Number(element("preview-keep-seconds").value));
    renderPreview();
  });
  element("preview-stop").addEventListener("click", () => submit("preview stop"));
  element("config-form").addEventListener("input", updateControls);
  element("config-form").addEventListener("change", updateControls);
  function renderRecordingFields() {
    const participant = element("recording-participant").value.trim();
    const comment = element("recording-comment").value.replace(/\r\n?/g, "\n");
    const encoder = new TextEncoder();
    element("recording-participant-count").textContent = `${encoder.encode(participant).length} / ${fileApi.PARTICIPANT_MAX_BYTES} UTF-8-Bytes`;
    element("recording-comment-count").textContent = `${encoder.encode(comment).length} / ${fileApi.COMMENT_MAX_BYTES} UTF-8-Bytes`;
    try {
      fileApi.encodeRecordingFields(participant, comment);
      element("recording-metadata-note").textContent = "Angaben werden beim Start auf dem Gerät im Dateiheader gespeichert. Beide Felder sind optional.";
      element("recording-metadata-note").dataset.error = "false";
    } catch (error) {
      element("recording-metadata-note").textContent = error.message;
      element("recording-metadata-note").dataset.error = "true";
    }
  }
  element("recording-metadata").addEventListener("input", renderRecordingFields);
  renderRecordingFields();
  element("config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !configuration || monitor.state !== "connected") return;
    let commands;
    try { commands = configurationCommands(configuration, editorValues()); }
    catch (error) { configStatus(error.message, true); return; }
    if (!commands.length) return;
    if (commands.includes("rld on") && !window.confirm("RLD ist nur für elektrisch isolierte Prüfaufbauten vorgesehen. Ab Firmware 0.12.4 bleibt diese Einstellung auch nach einem Neustart aktiv. Fortfahren?")) return;
    busy = true;
    configStatus("Änderungen werden übertragen …");
    updateControls();
    let failure = null;
    const generation = monitor.generation;
    try {
      // Wait for each firmware acknowledgement, not just the BLE write.
      for (const command of commands) {
        if (generation !== monitor.generation) throw new Error("Geräteverbindung beendet.");
        await client.request(command);
      }
    } catch (error) {
      failure = error;
      if (error.transportFailure) {
        monitor.disconnect();
        message("Übertragung unterbrochen. Bei Teilübertragung das Gerät vor weiteren Befehlen neu starten.");
      }
    }
    try {
      if (monitor.state === "connected" && generation === monitor.generation) {
        await readConfiguration();
        configStatus(failure
          ? `Nicht alle Änderungen übernommen: ${failure.message} Angezeigt ist die aktuelle Gerätekonfiguration.`
          : "", Boolean(failure));
      }
    } catch (error) { configStatus(`Konfiguration bitte erneut laden: ${error.message}`, true); }
    finally { busy = false; updateControls(); }
  });

  async function submit(text, { focusInput = false } = {}) {
    if (busy) return;
    let command;
    try { ({ command } = encodeCommand(text)); }
    catch (error) { message(error.message); return; }
    if (command === "start") {
      try { fileApi.encodeRecordingFields(element("recording-participant").value, element("recording-comment").value); }
      catch (error) { renderRecordingFields(); message(error.message); return; }
    }
    if (command === "display start" && !window.confirm(
      "Displaymodus starten?\n\nVoraussetzung: rate 250. Die Konsolenverbindung wird getrennt. Für die Rückkehr ist ein Geräteneustart erforderlich."
    )) return;
    if (command === "rld on" && !window.confirm(
      "RLD ist nur für elektrisch isolierte Prüfaufbauten vorgesehen. Ab Firmware 0.12.4 bleibt diese Einstellung auch nach einem Neustart aktiv. Fortfahren?"
    )) return;
    if (command === "config reset" && !window.confirm("Gespeicherte Messeinstellungen auf Standardwerte zurücksetzen? Ab Firmware 0.12.4 wird dabei RLD eingeschaltet und dauerhaft gespeichert. Ausschließlich in elektrisch isolierten Prüfaufbauten verwenden.")) return;
    busy = true;
    updateControls();
    try {
      if (command === "preview start") {
        await monitor.preparePreview(receivePreviewData, receivePreviewStatus);
        preview.reset();
        await client.request(command);
        await monitor.readPreviewStatus(receivePreviewStatus);
      } else if (command === "preview stop") {
        await client.request(command);
        await monitor.readPreviewStatus(receivePreviewStatus);
        await readConfiguration();
      } else if (command === "config") await readConfiguration();
      else if (/^(gain|rate|input|rld|test_duration|filter) /.test(command) || command === "config reset") {
        await client.request(command);
        await readConfiguration();
      } else if (["start", "stop", "stream start", "stream stop"].includes(command)) {
        if (command === "start" && operationState === "preview") {
          await client.request("preview stop");
          await monitor.readPreviewStatus(receivePreviewStatus);
        }
        if (command === "start") {
          element("recording-metadata-note").textContent = "Angaben werden an das Gerät übertragen und bestätigt …";
          await sdClient.startRecording(element("recording-participant").value, element("recording-comment").value,
            (start) => client.request(start));
          element("recording-metadata-note").textContent = "Versuchsperson und Kommentar wurden im Dateiheader gespeichert.";
          element("recording-metadata-note").dataset.error = "false";
        } else await client.request(command);
        if (command === "stop" || command === "stream stop") await readConfiguration();
      } else await monitor.send(command);
      if (history.at(-1) !== command) history.push(command);
      if (history.length > 100) history.shift();
      historyPosition = history.length;
      input.value = "";
      draft = "";
    } catch (error) {
      if (command === "start") {
        element("recording-metadata-note").textContent = `Aufzeichnungsstart nicht bestätigt: ${error.message} Metadaten benötigen Firmware ab 0.10.0.`;
        element("recording-metadata-note").dataset.error = "true";
      }
      if (command.startsWith("preview ")) {
        element("preview-state").textContent = operationState === "preview"
          ? `Vorschau aktiv, Befehlsbestätigung fehlt: ${error.message}`
          : `Vorschau nicht verfügbar: ${error.message} Gegebenenfalls die neue Firmware flashen.`;
      }
      message(`Befehl nicht bestätigt: ${error.message}`);
      // Never automatically repeat a command with side effects.
      if (error.transportFailure || !monitor.device?.gatt.connected) monitor.disconnect();
    } finally {
      busy = false;
      updateControls();
      // Device buttons must not summon Android's keyboard or jump to the console.
      // Restore text entry only after an explicitly submitted console command.
      if (focusInput && !input.disabled) input.focus({ preventScroll: true });
    }
  }
  element("command-form").addEventListener("submit", (event) => {
    event.preventDefault();
    return submit(input.value, { focusInput: true });
  });
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => submit(button.dataset.command));
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (historyPosition === history.length) draft = input.value;
    historyPosition = Math.max(0, Math.min(history.length, historyPosition + (event.key === "ArrowUp" ? -1 : 1)));
    input.value = historyPosition === history.length ? draft : history[historyPosition];
  });
  element("clear-log").addEventListener("click", () => { output.textContent = ""; });
  element("save-log").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([output.textContent], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `bike-ekg-ble-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener("pagehide", () => monitor.disconnect());
}

if (typeof document !== "undefined") initializePage();
if (typeof module !== "undefined" && module.exports) {
  module.exports = { BleMonitor, encodeCommand, FirmwareClient, parseConfiguration, configurationCommands, RecordingProgress, formatDuration };
}
