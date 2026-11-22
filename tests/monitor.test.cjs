"use strict";

// GATT-/DOM-Doubles prüfen Sitzungswechsel, Befehlsbestätigungen und UI-Sperren.
// Fake-Timer machen Reconnect/Timeout reproduzierbar, ersetzen aber keinen Browser-BLE-Test.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { BleMonitor, encodeCommand, FirmwareClient, parseConfiguration, configurationCommands, RecordingProgress, formatDuration } = require("../monitor.js");
const { PREVIEW_SERVICE, PREVIEW_DATA, PREVIEW_STATUS } = require("../preview.js");
const { SD_SERVICE, SD_CONTROL, SD_DATA, SD_OP } = require("../files.js");
const { fileService, recording, response } = require("./file-fixtures.cjs");
const BinaryStream = require("../visualization-stream.js");

function attachFileService(f, files) {
  const service = fileService(files);
  const original = f.device.gatt.getPrimaryService;
  f.device.gatt.getPrimaryService = async (uuid) => uuid === SD_SERVICE
    ? { async getCharacteristic(id) { return id === SD_CONTROL ? service.control : id === SD_DATA ? service.stream : service.data; } }
    : original(uuid);
  return service;
}

function fixture({ sync = false, reconnect = false } = {}) {
  const messages = [];
  const states = [];
  const received = [];
  const writes = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const device = new EventTarget();
  device.name = "Bike-EKG";
  const tx = new EventTarget();
  tx.startNotifications = async () => tx;
  tx.stopNotifications = async () => tx;
  const rx = {
    properties: { write: true },
    async writeValueWithResponse(bytes) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await Promise.resolve();
      writes.push(bytes);
      activeWrites -= 1;
    },
  };
  const uuids = [];
  const service = {
    async getCharacteristic(uuid) {
      uuids.push(uuid);
      return uuid.startsWith("6e400002") ? rx : tx;
    },
  };
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    async getPrimaryService(uuid) { uuids.push(uuid); return service; },
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      device.dispatchEvent(new Event("gattserverdisconnected"));
    },
  };
  let options;
  const monitor = new BleMonitor({
    bluetooth: { async requestDevice(value) { options = value; return device; } },
    onState: (state) => states.push(state),
    onText: (text) => received.push(text),
    onMessage: (text) => messages.push(text),
    shouldReconnect: () => reconnect,
    syncTime: () => sync,
  });
  function notify(bytes) {
    const event = new Event("characteristicvaluechanged");
    tx.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    tx.dispatchEvent(event);
  }
  return {
    monitor, device, tx, rx, messages, states, received, writes, uuids, notify,
    options: () => options,
    maxActiveWrites: () => maxActiveWrites,
  };
}

test("Befehle: Zeilenabschluss, Leerzeichen und Firmware-Bytegrenze", () => {
  assert.equal(encodeCommand("  display   start  ").command, "display start");
  assert.equal(new TextDecoder().decode(encodeCommand("help").bytes), "help\n");
  assert.equal(encodeCommand("a".repeat(63)).bytes.length, 64);
  for (const command of ["", "help\nstart", "help\0", "a".repeat(64), "ä".repeat(32)]) {
    assert.throws(() => encodeCommand(command));
  }
});

test("Gerätefilter, NUS-UUIDs und Zeitsynchronisierung", async (t) => {
  const f = fixture({ sync: true });
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  assert.deepEqual(f.options().filters, [{ name: "Bike-EKG" }, { name: "Bike_EKG_Debug" }]);
  assert.equal(f.uuids.length, 3);
  assert.equal(f.uuids[0], f.options().optionalServices[0]);
  assert.equal(f.monitor.state, "connected");
  assert.match(new TextDecoder().decode(Buffer.concat(f.writes)), /^time \d+\n$/);
});

test("Schreiben wird serialisiert und in maximal 20 Bytes zerlegt", async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  await Promise.all([f.monitor.send("a".repeat(63)), f.monitor.send("status")]);
  assert.deepEqual(f.writes.map((bytes) => bytes.length), [20, 20, 20, 4, 7]);
  assert.equal(f.maxActiveWrites(), 1);
  assert.equal(new TextDecoder().decode(Buffer.concat(f.writes)), "a".repeat(63) + "\nstatus\n");
});

test("Write-without-response wird bei entsprechender Characteristic unterstützt", async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  f.rx.properties = { writeWithoutResponse: true };
  f.rx.writeValueWithoutResponse = f.rx.writeValueWithResponse;
  await f.monitor.chooseDevice();
  await f.monitor.send("help");
  assert.equal(new TextDecoder().decode(f.writes[0]), "help\n");
});

test("UTF-8 bleibt über Notification-Grenzen erhalten; nach Trennen keine Listener", async () => {
  const f = fixture();
  await f.monitor.chooseDevice();
  const bytes = new TextEncoder().encode("Grüße\r\n");
  f.notify(bytes.slice(0, 3));
  f.notify(bytes.slice(3));
  assert.equal(f.received.join(""), "Grüße\r\n");
  f.monitor.disconnect();
  f.notify(new TextEncoder().encode("ignorieren"));
  assert.equal(f.received.join(""), "Grüße\r\n");
});

test("Manuelles Trennen startet keine Wiederverbindung und verwirft wartende Befehle", async () => {
  const f = fixture({ reconnect: true });
  await f.monitor.chooseDevice();
  const pending = f.monitor.send("start");
  f.monitor.disconnect();
  await assert.rejects(pending, /Keine Geräteverbindung/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.monitor.state, "disconnected");
  assert.equal(f.monitor.retryTimer, null);
});

test("Displaywechsel: fragmentierte Bestätigung, kein automatisches Reconnect", async (t) => {
  const f = fixture({ reconnect: true });
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  await f.monitor.send("display   start");
  f.notify(new TextEncoder().encode("display: star"));
  f.notify(new TextEncoder().encode("ted; NUS will disconnect\r\n"));
  f.device.gatt.disconnect();
  assert.equal(f.monitor.state, "display");
  assert.match(f.messages.at(-1), /vom Gerät bestätigt/);
  assert.equal(f.monitor.retryTimer, null);
});

test("Ein Abbruch allein bestätigt keinen Displaywechsel", async (t) => {
  const f = fixture({ reconnect: true });
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  await f.monitor.send("display start");
  f.device.gatt.disconnect();
  assert.match(f.messages.at(-1), /nicht bestätigt/);
  assert.equal(f.monitor.retryTimer, null);
});

test("Unerwarteter Abbruch plant Reconnect; Trennen stoppt den Timer", async () => {
  const f = fixture({ reconnect: true });
  await f.monitor.chooseDevice();
  f.device.gatt.disconnect();
  assert.equal(f.monitor.state, "reconnecting");
  assert.equal(f.monitor.retryAttempt, 1);
  f.monitor.disconnect();
  assert.equal(f.monitor.state, "disconnected");
  assert.equal(f.device.gatt.connected, false);
});

test("Abgebrochener Verbindungsversuch hinterlässt keine späte GATT-Verbindung", async () => {
  const f = fixture();
  let complete;
  f.device.gatt.connect = () => new Promise((resolve) => { complete = resolve; });
  const choosing = f.monitor.chooseDevice();
  await new Promise(setImmediate);
  f.monitor.disconnect();
  f.device.gatt.connected = true;
  complete(f.device.gatt);
  await choosing;
  assert.equal(f.device.gatt.connected, false);
  assert.equal(f.monitor.state, "disconnected");
});

test("Manuelles Trennen beendet Notifications vor GATT und erneutes Verbinden empfängt wieder", async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  let registered = false;
  let receiving = false;
  const operations = [];
  const connect = f.device.gatt.connect;
  const disconnect = f.device.gatt.disconnect;
  f.device.gatt.connect = async function () {
    operations.push("connect");
    receiving = false;
    return connect.call(this);
  };
  f.tx.startNotifications = async () => {
    // Simulate a browser retaining its subscription registration across links.
    operations.push("subscribe");
    if (!registered) receiving = true;
    registered = true;
    return f.tx;
  };
  f.tx.stopNotifications = async () => {
    assert.equal(f.device.gatt.connected, true);
    operations.push("unsubscribe");
    registered = receiving = false;
    return f.tx;
  };
  f.device.gatt.disconnect = function () {
    operations.push("disconnect");
    disconnect.call(this);
  };
  for (let attempt = 0; attempt < 3; ++attempt) {
    await f.monitor.chooseDevice();
    assert.equal(receiving, true);
    f.notify(new TextEncoder().encode("state: idle\r\n"));
    await f.monitor.disconnect();
    assert.equal(registered, false);
  }
  assert.equal(f.received.length, 3);
  assert.deepEqual(operations, Array(3).fill(["connect", "subscribe", "unsubscribe", "disconnect"]).flat());
});

test("Sofortiges Wiederverbinden wartet auf Abonnementsabbau und verspätetes Disconnect-Ereignis", async (t) => {
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  let finishUnsubscribe;
  let finishDisconnect;
  f.tx.stopNotifications = () => new Promise((resolve) => { finishUnsubscribe = resolve; });
  f.device.gatt.disconnect = () => {
    f.device.gatt.connected = false;
    finishDisconnect = () => f.device.dispatchEvent(new Event("gattserverdisconnected"));
  };
  let newConnections = 0;
  const connect = f.device.gatt.connect;
  f.device.gatt.connect = async function () { ++newConnections; return connect.call(this); };
  const closing = f.monitor.disconnect();
  const choosing = f.monitor.chooseDevice();
  await new Promise(setImmediate);
  assert.equal(newConnections, 0);
  finishUnsubscribe();
  await new Promise(setImmediate);
  assert.equal(newConnections, 0);
  finishDisconnect();
  await closing;
  await choosing;
  assert.equal(newConnections, 1);
  assert.equal(f.monitor.state, "connected");
  f.tx.stopNotifications = async () => f.tx;
  f.device.gatt.disconnect = () => {
    f.device.gatt.connected = false;
    f.device.dispatchEvent(new Event("gattserverdisconnected"));
  };
});

test("Fehler beim Abmelden der Notifications verhindert manuelles Trennen nicht", async () => {
  const f = fixture();
  await f.monitor.chooseDevice();
  f.tx.stopNotifications = async () => { throw new Error("GATT error"); };
  await f.monitor.disconnect();
  assert.equal(f.device.gatt.connected, false);
  assert.equal(f.monitor.state, "disconnected");
});

test("Hängende alte GATT-Queue blockiert Wiederverbinden nicht und meldet keine neue Session ab", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  let finishOldOperation;
  f.monitor.queue = new Promise((resolve) => { finishOldOperation = resolve; });
  let unsubscribed = 0;
  f.tx.stopNotifications = async () => { ++unsubscribed; return f.tx; };
  const closing = f.monitor.disconnect();
  t.mock.timers.tick(1500);
  await closing;
  assert.equal(f.device.gatt.connected, false);
  await f.monitor.chooseDevice();
  await f.monitor.send("state");
  assert.equal(f.monitor.state, "connected");
  finishOldOperation();
  await new Promise(setImmediate);
  assert.equal(unsubscribed, 0);
});

test("Abgelehnter Displaybefehl gibt nach Timeout die Konsole wieder frei", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  await f.monitor.send("display start");
  assert.equal(f.monitor.state, "switching");
  f.notify(new TextEncoder().encode("error: display requires rate 250\r\n"));
  t.mock.timers.tick(5000);
  assert.equal(f.monitor.state, "connected");
  assert.equal(f.monitor.displayPending, false);
  await f.monitor.send("rate 250");
});

test("Wiederverbindung endet nach fünf fehlgeschlagenen Versuchen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ reconnect: true });
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  let attempts = 0;
  f.device.gatt.connect = async () => { attempts += 1; throw new Error("Board aus"); };
  f.device.gatt.disconnect();
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(10000);
    await new Promise(setImmediate);
  }
  assert.equal(attempts, 5);
  assert.equal(f.monitor.state, "disconnected");
  assert.match(f.messages.at(-1), /Wiederverbindung beendet/);
});

function pageFixture(secure, bluetooth) {
  const directory = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
  const source = fs.readFileSync(path.join(directory, "monitor.js"), "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  function node() {
    const handlers = new Map();
    return {
      textContent: "", hidden: true, disabled: false, dataset: {}, checked: false, value: "",
      children: [],
      scrollHeight: 0, scrollTop: 0, clientHeight: 100,
      addEventListener(name, handler) { handlers.set(name, handler); },
      async emit(name) { return handlers.get(name)?.({ preventDefault() {} }); },
      append(...items) { this.children.push(...items); this.textContent += items.map((item) => typeof item === "string" ? item : item.textContent).join(""); },
      replaceChildren(...items) { this.children = []; this.textContent = ""; this.append(...items); },
      insertBefore(item, before) {
        const index = before ? this.children.indexOf(before) : this.children.length;
        assert.ok(index >= 0);
        this.children.splice(index, 0, item);
        this.textContent = this.children.map((child) => child.textContent).join("");
      },
      click() { handlers.get("click")?.({ preventDefault() {} }); },
      focus(options) { this.focused = true; this.focusOptions = options; }, select() { this.selected = true; },
      getContext() { return null; },
      open: false,
      showModal() { this.open = true; },
      setAttribute(name, value) { this[name] = value; },
    };
  }
  const nodes = new Map(ids.map((id) => [id, node()]));
  nodes.get("sync-time").checked = true;
  nodes.get("auto-reconnect").checked = true;
  nodes.get("flags-address").value = "chrome://flags/#enable-experimental-web-platform-features";
  const buttons = [...html.matchAll(/data-command="([^"]+)"/g)].map((match) => {
    const button = node();
    button.dataset.command = match[1];
    return button;
  });
  let copied = "";
  const context = {
    window: { isSecureContext: secure, addEventListener() {}, confirm: () => true },
    navigator: { bluetooth, clipboard: { async writeText(value) { copied = value; } } },
    document: {
      getElementById(id) {
        assert.ok(nodes.has(id), `HTML-Element ${id} fehlt`);
        return nodes.get(id);
      },
      createElement: node,
      querySelectorAll: () => buttons,
    },
    TextEncoder, TextDecoder, Date, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController, Blob, crypto: require("node:crypto").webcrypto,
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    performance: { now: () => performance.now() },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(directory, "preview.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(directory, "files.js"), "utf8"), context);
  vm.runInContext(source, context);
  return { nodes, buttons, context, copied: () => copied };
}

test("Webversion ist im Footer und in den geladenen Assets konsistent", () => {
  const page = pageFixture(true);
  const version = page.nodes.get("monitor-script-version").textContent;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.ok(html.includes(`Webanwendung ${version}`));
  assert.match(html, /id="monitor-script-version">nicht geladen<\/span>/);
  const assets = [...html.matchAll(/(?:src|href)="([^"?]+\.(?:js|css))\?v=([^"&]+)"/g)];
  assert.equal(assets.length, 10);
  for (const [, , assetVersion] of assets) assert.equal(assetVersion, version);
});

test("Seiteninitialisierung: DOM-Verknüpfung, ausgeblendete Bedienung und Browserhinweis", async () => {
  for (const [secure, bluetooth, expected] of [
    [true, undefined, /Web Bluetooth ist in diesem Browser nicht verfügbar/],
    [false, {}, /sicheren Kontext/],
    [true, {}, null],
  ]) {
    const { nodes, copied } = pageFixture(secure, bluetooth);
    assert.equal(nodes.get("connect").disabled, Boolean(expected));
    assert.equal(nodes.get("command").disabled, true);
    assert.equal(nodes.get("device-controls").hidden, true);
    assert.equal(nodes.get("console-panel").hidden, true);
    if (expected) {
      assert.equal(nodes.get("compatibility").hidden, false);
      assert.match(nodes.get("compatibility").textContent, expected);
      assert.equal(nodes.get("compatibility-dialog").open, true);
      assert.match(nodes.get("compatibility-dialog-message").textContent, expected);
    } else {
      assert.equal(nodes.get("compatibility").hidden, true);
      assert.equal(nodes.get("compatibility-dialog").open, false);
    }
    if (secure && !bluetooth) {
      assert.equal(nodes.get("browser-setup").hidden, false);
      await nodes.get("copy-flags").emit("click");
      assert.equal(copied(), "chrome://flags/#enable-experimental-web-platform-features");
    }
  }
});

const configText = "config:\r\n  rate: 250 SPS\r\n  gain: x6\r\n  input: normal\r\n"
  + "  rld: off\r\n  test_duration: 60 seconds\r\n  filter_band: 0.500-40.000 Hz\r\n"
  + "  stream_filter: off\r\n  preview_max_rate: 500 SPS\r\n  apply: at next start\r\n";
const configValue = { rate: 250, gain: 6, input: "normal", rld: "off", duration: 60, filter: "off", low: 0.5, high: 40 };

test("Konfigurationslayout trennt Filter ohne Hintergrund und ordnet Reset links, Übernehmen rechts an", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8");
  const fields = /<fieldset id="config-fields"[^>]*>([\s\S]*?)<\/fieldset>/.exec(html)[1];
  const filter = fields.slice(fields.indexOf('class="config-filter"'));
  for (const id of ["setting-filter", "setting-low", "setting-high"]) assert.ok(filter.includes(`id="${id}"`));
  assert.ok(!filter.includes('id="setting-rld"'));
  assert.match(filter, /Digitaler Filter für Vorschau/);
  assert.ok(!html.includes("Änderungen gelten ab dem nächsten Messstart. Das Filterband gilt auch für die Displayübertragung."));
  assert.ok(!html.includes("Digitaler Filter für USB-Streaming und BLE-Vorschau"));
  const footer = /<div class="config-footer">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.ok(footer.indexOf('id="reset-config"') < footer.indexOf('id="apply-config"'));
  assert.match(css, /\.config-footer #apply-config\s*\{\s*margin-left: auto;/);
  assert.match(css, /\.config-footer\s*\{[^}]*flex-wrap: wrap;/);
  assert.doesNotMatch(/\.config-filter\s*\{([^}]*)\}/.exec(css)[1], /background|border|padding/);
  assert.match(css, /input\.config-switch:checked\s*\{\s*background: #14685c; border-color: #14685c;/);
  for (const id of ["setting-rld", "setting-filter"]) {
    assert.match(html, new RegExp(`<input id="${id}"[^>]*type="checkbox"[^>]*role="switch"`));
  }
});

test("Resetbutton fragt nach, wartet auf Gerätebestätigung und lädt tatsächliche Standardwerte", async (t) => {
  const f = fixture();
  const commands = [];
  let current = configText;
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    if (command !== "config reset") f.notify(new TextEncoder().encode(command === "config" ? current : "time: set\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  const reset = page.buttons.find((button) => button.dataset.command === "config reset");
  assert.ok(reset);
  assert.equal(reset.disabled, true);
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.equal(reset.disabled, false);
  page.context.window.confirm = () => false;
  const before = commands.length;
  await reset.emit("click");
  assert.equal(commands.length, before);
  let confirmations = 0;
  page.context.window.confirm = (text) => {
    ++confirmations;
    assert.match(text, /Standardwerte/);
    return true;
  };
  const job = reset.emit("click");
  await new Promise(setImmediate);
  assert.equal(confirmations, 1);
  assert.equal(reset.disabled, true);
  assert.equal(page.nodes.get("config-fields").disabled, true);
  assert.equal(commands.at(-1), "config reset");
  assert.equal(commands.length, before + 1); // no config query before acknowledgement
  current = configText.replace("rate: 250", "rate: 500")
    .replace("test_duration: 60", "test_duration: 300").replace("rld: off", "rld: on");
  f.notify(new TextEncoder().encode("config: reset to defaults\r\n"));
  await job;
  assert.deepEqual(commands.slice(-2), ["config reset", "config"]);
  assert.equal(page.nodes.get("setting-gain").value, "6");
  assert.equal(page.nodes.get("setting-rate").value, "500");
  assert.equal(page.nodes.get("setting-duration").value, "300");
  assert.equal(page.nodes.get("setting-rld").checked, true);
  assert.equal(page.nodes.get("setting-filter").checked, false);
  assert.equal(reset.disabled, false);
  assert.equal(page.nodes.get("command").focused, undefined);
  await page.nodes.get("disconnect").emit("click");
  assert.equal(reset.disabled, true);
});

test("Resetbutton bleibt während Vorschau und Messung gesperrt", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = previewFixture();
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  const reset = page.buttons.find((button) => button.dataset.command === "config reset");
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.equal(reset.disabled, false);
  await page.nodes.get("preview-start").emit("click");
  assert.equal(reset.disabled, true);
  await page.nodes.get("preview-stop").emit("click");
  assert.equal(reset.disabled, false);
  await page.buttons.find((button) => button.dataset.command === "start").emit("click");
  assert.equal(reset.disabled, true);
});

test("Gerätezeile zeigt die echte, fragmentiert empfangene Firmwareversion und verwirft sie beim Trennen", async (t) => {
  const f = fixture();
  let version = "0.12.2";
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    const text = command === "config" ? configText.replace("config:\r\n", `config:\r\n${version ? `  firmware: ${version}\r\n` : ""}`) : "time: set\r\n";
    for (const character of text) f.notify(new TextEncoder().encode(character));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.match(page.nodes.get("device-info").textContent, /Gerät: .* · Firmware: 0\.12\.2 · Nordic UART Service/);
  assert.equal(page.nodes.get("config-fields").disabled, false);
  await page.nodes.get("disconnect").emit("click");
  assert.ok(!page.nodes.get("device-info").textContent.includes("0.12.2"));
  version = "";
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.match(page.nodes.get("device-info").textContent, /Firmware: nicht gemeldet/);
  assert.equal(page.nodes.get("config-fields").disabled, false);
});

test("Konfiguration wird aus echten Firmwarefeldern gelesen; unvollständige Antworten werden verworfen", () => {
  assert.deepEqual(parseConfiguration(configText.trim().split("\r\n").slice(1)), configValue);
  assert.throws(() => parseConfiguration(["rate: 250 SPS"]), /Unvollständige/);
  assert.throws(() => parseConfiguration(configText.replace("x6", "x9").trim().split("\r\n").slice(1)), /Ungültige/);
});

test("FirmwareClient wartet auf vollständige, beliebig fragmentierte Konfiguration", async () => {
  const commands = [];
  const client = new FirmwareClient(async (command) => commands.push(command));
  const result = client.request("config");
  for (const character of configText) client.feed(character);
  assert.deepEqual(await result, configValue);
  assert.deepEqual(commands, ["config"]);
});

test("Einstellungen werden bestätigt, Firmwarefehler und Abbrüche werden weitergereicht", async () => {
  const client = new FirmwareClient(async () => {});
  const saved = client.request("gain 8");
  client.feed("time: set\r\n");
  assert.ok(client.pending);
  client.feed("setting: updated and saved\r\n");
  await saved;
  const rejected = client.request("rate 125");
  client.feed("error: settings are available only in idle\r\n");
  await assert.rejects(rejected, /only in idle/);
  const interrupted = client.request("config");
  client.reset();
  await assert.rejects(interrupted, /Geräteverbindung beendet/);
});

test("Keine Geräteantwort: Timeout statt dauerhaft gesperrter Oberfläche", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new FirmwareClient(async () => {});
  const pending = client.request("config");
  t.mock.timers.tick(6000);
  assert.ok(client.pending);
  t.mock.timers.tick(6000);
  await assert.rejects(pending, /Keine Geräteantwort/);
  assert.equal(client.pending, null);
});

test("Konfiguration: Abbruch nach drei Paketen wird einmal lesend wiederholt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands = [];
  const client = new FirmwareClient((command) => commands.push(command));
  const pending = client.request("config");
  const response = configText.replace("config:\r\n", "config:\r\n  firmware: 0.12.2\r\n");
  client.feed(response.slice(0, 60));
  t.mock.timers.tick(6000);
  assert.deepEqual(commands, ["config", "config"]);
  // Old tail must not complete the new attempt without a fresh config marker.
  client.feed(response.slice(60));
  assert.ok(client.pending);
  for (let i = 0; i < response.length; i += 20) client.feed(response.slice(i, i + 20));
  assert.deepEqual(await pending, configValue);
  t.mock.timers.tick(12000);
  assert.equal(commands.length, 2);
});

test("Seite erholt sich automatisch vom Smartphone-Abbruch nach gain, ohne Zeitsync", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const commands = [];
  const response = configText.replace("config:\r\n", "config:\r\n  firmware: 0.12.2\r\n");
  f.rx.writeValueWithResponse = async (bytes) => {
    commands.push(new TextDecoder().decode(bytes).trim());
    const text = commands.length === 1 ? response.slice(0, 60) : response;
    f.notify(new TextEncoder().encode(text));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  page.nodes.get("sync-time").checked = false;
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.equal(page.nodes.get("config-fields").disabled, true);
  t.mock.timers.tick(6000);
  await new Promise(setImmediate);
  assert.deepEqual(commands, ["config", "config"]);
  assert.equal(page.nodes.get("config-fields").disabled, false);
  assert.equal(page.nodes.get("config-status").textContent, "");
  assert.equal(page.nodes.get("config-status").hidden, true);
});

test("Konfiguration: neuer Startmarker trennt alte unvollständige Zeilen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new FirmwareClient(() => {});
  const pending = client.request("config");
  client.feed("config:\r\n  rate: 125 SPS\r\n  gain: x");
  t.mock.timers.tick(6000);
  client.feed("6\r\n  input: nor");
  for (const char of configText) client.feed(char);
  assert.deepEqual(await pending, configValue);
});

test("Unvollständige Antwort bleibt nach zwei Versuchen als solche erkennbar", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const client = new FirmwareClient(() => { ++attempts; client.feed("config:\r\n  gain: x6\r\n"); });
  const pending = client.request("config");
  t.mock.timers.tick(6000);
  t.mock.timers.tick(6000);
  await assert.rejects(pending, /Unvollständige Konfigurationsantwort/);
  assert.equal(attempts, 2);
});

test("Kein Retry nach Disconnect, Firmwarefehler, Transportfehler oder bei Schreibbefehlen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["disconnect", "firmware", "transport", "write"]) {
    let sends = 0;
    const client = new FirmwareClient(() => {
      ++sends;
      if (mode === "transport") throw new Error("GATT error");
    });
    const pending = client.request(mode === "write" ? "gain 8" : "config");
    if (mode === "disconnect") client.reset();
    if (mode === "firmware") client.feed("error: settings are available only in idle\r\n");
    if (mode === "write") t.mock.timers.tick(6000);
    await assert.rejects(pending);
    t.mock.timers.tick(12000);
    assert.equal(sends, 1, mode);
  }
});

test("Konfigurationsänderungen werden validiert und in sicherer Reihenfolge gesendet", () => {
  assert.deepEqual(configurationCommands(configValue, configValue), []);
  assert.deepEqual(configurationCommands(configValue, { ...configValue, gain: 8, duration: 120 }), ["gain 8", "test_duration 120"]);
  assert.deepEqual(configurationCommands({ ...configValue, high: 65 }, { ...configValue, rate: 125 }), ["filter band 0.5 40", "rate 125"]);
  assert.deepEqual(configurationCommands({ ...configValue, rate: 125 }, { ...configValue, high: 65 }), ["rate 250", "filter band 0.5 65"]);
  for (const changes of [{ low: 40 }, { high: 66 }, { duration: 0 }, { duration: 4201 }, { rate: 125, high: 63 }, { low: 0.0001 }]) {
    assert.throws(() => configurationCommands(configValue, { ...configValue, ...changes }));
  }
});

test("Seite lädt initial Konfiguration, übernimmt Dropdownänderung und blendet beim Trennen aus", async (t) => {
  const f = fixture();
  const commands = [];
  let current = configText;
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    const response = command === "config" ? current : command.startsWith("time ") ? "time: set\r\n" : "setting: updated and saved\r\n";
    if (command === "gain 8") current = current.replace("gain: x6", "gain: x8");
    f.notify(new TextEncoder().encode(response));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.equal(page.nodes.get("device-controls").hidden, false);
  assert.equal(page.nodes.get("console-panel").hidden, false);
  assert.equal(page.nodes.get("setting-gain").value, "6");
  assert.equal(page.nodes.get("config-fields").disabled, false);
  assert.equal(commands.filter((command) => command === "config").length, 1);
  assert.ok(page.buttons.every((button) => !["help", "state", "status"].includes(button.dataset.command)));
  page.nodes.get("setting-gain").value = "8";
  await page.nodes.get("config-form").emit("input");
  assert.equal(page.nodes.get("apply-config").disabled, false);
  await page.nodes.get("config-form").emit("submit");
  assert.deepEqual(commands.slice(-2), ["gain 8", "config"]);
  assert.equal(page.nodes.get("setting-gain").value, "8");
  assert.equal(page.nodes.get("apply-config").disabled, true);
  await page.nodes.get("disconnect").emit("click");
  assert.equal(page.nodes.get("device-controls").hidden, true);
  assert.equal(page.nodes.get("console-panel").hidden, true);
});

test("Metadatenfelder stehen vor Aufzeichnungsstart und sind während Messung gesperrt", async (t) => {
  const f = fixture();
  const commands = [];
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    f.notify(new TextEncoder().encode(command === "config" ? configText : "time: set\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  assert.equal(page.nodes.get("recording-metadata").disabled, true);
  assert.equal(page.nodes.get("recording-panel").hidden, true);
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.equal(page.nodes.get("recording-metadata").disabled, false);
  assert.equal(page.nodes.get("recording-panel").hidden, false);
  page.nodes.get("recording-participant").value = "P01";
  page.nodes.get("recording-comment").value = "Sitzend\nRuhemessung";
  f.notify(new TextEncoder().encode("logging: started\r\n"));
  assert.equal(page.nodes.get("recording-metadata").disabled, true);
  assert.equal(page.nodes.get("recording-participant").value, "P01");
  f.notify(new TextEncoder().encode("state: idle\r\n"));
  await new Promise(setImmediate);
  assert.equal(page.nodes.get("recording-metadata").disabled, false);
  assert.equal(page.nodes.get("recording-comment").value, "Sitzend\nRuhemessung");
  assert.ok(commands.every((command) => command === "config" || command.startsWith("time ")));
});

test("Konfigurationsfelder bleiben beim Neuladen und Übernehmen sichtbar und gesperrt", async (t) => {
  const f = fixture();
  let delayConfig = false;
  let current = configText;
  let configWaiting = false;
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    if (command === "config" && delayConfig) {
      configWaiting = true;
      return;
    }
    if (command === "gain 8") current = current.replace("gain: x6", "gain: x8");
    f.notify(new TextEncoder().encode(command === "config" ? current
      : command.startsWith("time ") ? "time: set\r\n" : "setting: updated and saved\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  delayConfig = true;
  for (const action of ["refresh", "apply", "failed-refresh"]) {
    configWaiting = false;
    if (action === "apply") {
      page.nodes.get("setting-gain").value = "8";
      await page.nodes.get("config-form").emit("input");
    }
    const pending = action === "apply" ? page.nodes.get("config-form").emit("submit")
      : page.nodes.get("refresh-config").emit("click");
    await new Promise(setImmediate);
    assert.equal(configWaiting, true);
    assert.equal(page.nodes.get("device-controls").hidden, false);
    assert.equal(page.nodes.get("config-fields").hidden, false);
    assert.equal(page.nodes.get("config-fields").disabled, true);
    f.notify(new TextEncoder().encode(action === "failed-refresh" ? "error: cannot read settings\r\n" : current));
    await pending;
    assert.equal(page.nodes.get("config-fields").hidden, false);
    assert.equal(page.nodes.get("config-fields").disabled, action === "failed-refresh");
  }
  assert.equal(page.nodes.get("apply-config").disabled, true);
  await page.nodes.get("disconnect").emit("click");
  assert.equal(page.nodes.get("config-fields").hidden, true);
});

test("Bei laufender Messung bleibt die Konfiguration gesperrt, Stoppen aber verfügbar", async (t) => {
  const f = fixture();
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    f.notify(new TextEncoder().encode(command === "config"
      ? "error: settings are available only in idle\r\n" : "time: set\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.equal(page.nodes.get("config-fields").disabled, true);
  assert.equal(page.nodes.get("config-fields").hidden, true);
  assert.match(page.nodes.get("config-status").textContent, /only in idle/);
  assert.equal(page.buttons.find((button) => button.dataset.command === "start").disabled, true);
  assert.equal(page.buttons.find((button) => button.dataset.command === "stop").disabled, false);
  assert.equal(page.nodes.get("command").disabled, false);
});

test("Teilweise abgelehnte Änderungen zeigen nach erneutem Lesen den tatsächlichen Gerätestand", async (t) => {
  const f = fixture();
  const commands = [];
  let current = configText;
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    if (command === "rate 500") current = current.replace("rate: 250", "rate: 500");
    const response = command === "config" ? current : command === "gain 8"
      ? "error: setting was not saved\r\n" : command.startsWith("time ")
        ? "time: set\r\n" : "setting: updated and saved\r\n";
    f.notify(new TextEncoder().encode(response));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  page.nodes.get("setting-rate").value = "500";
  page.nodes.get("setting-gain").value = "8";
  page.nodes.get("setting-duration").value = "120";
  await page.nodes.get("config-form").emit("submit");
  assert.deepEqual(commands.slice(-3), ["rate 500", "gain 8", "config"]);
  assert.equal(page.nodes.get("setting-rate").value, "500");
  assert.equal(page.nodes.get("setting-gain").value, "6");
  assert.equal(page.nodes.get("setting-duration").value, "60");
  assert.equal(page.nodes.get("config-status").dataset.error, "true");
  assert.match(page.nodes.get("config-status").textContent, /Nicht alle Änderungen/);
});

test("RLD-Aktivierung kann vor jeder Änderung abgebrochen werden", async (t) => {
  const f = fixture();
  const commands = [];
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    f.notify(new TextEncoder().encode(command === "config" ? configText : "time: set\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  const before = commands.length;
  page.context.window.confirm = () => false;
  page.nodes.get("setting-rld").checked = true;
  page.nodes.get("setting-gain").value = "8";
  await page.nodes.get("config-form").emit("submit");
  assert.equal(commands.length, before);
});

test("RLD- und Filterschalter lesen Gerätewerte und senden on/off erst beim Übernehmen", async (t) => {
  const f = fixture();
  const commands = [];
  let rld = false;
  let filter = false;
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    if (command.startsWith("rld ")) rld = command === "rld on";
    if (command.startsWith("filter ")) filter = command === "filter on";
    const config = configText.replace("rld: off", `rld: ${rld ? "on" : "off"}`)
      .replace("stream_filter: off", `stream_filter: ${filter ? "0.500-40.000 Hz" : "off"}`);
    f.notify(new TextEncoder().encode(command === "config" ? config
      : command.startsWith("time ") ? "time: set\r\n" : "setting: updated and saved\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  let confirmations = 0;
  page.context.window.confirm = () => { ++confirmations; return true; };
  for (const enabled of [true, false]) {
    assert.equal(page.nodes.get("setting-rld").checked, !enabled);
    assert.equal(page.nodes.get("setting-filter").checked, !enabled);
    const before = commands.length;
    page.nodes.get("setting-rld").checked = enabled;
    page.nodes.get("setting-filter").checked = enabled;
    await page.nodes.get("config-form").emit("change");
    assert.equal(commands.length, before);
    assert.equal(page.nodes.get("apply-config").disabled, false);
    await page.nodes.get("config-form").emit("submit");
    assert.deepEqual(commands.slice(-3), [`rld ${enabled ? "on" : "off"}`, `filter ${enabled ? "on" : "off"}`, "config"]);
    assert.equal(page.nodes.get("setting-rld").checked, enabled);
    assert.equal(page.nodes.get("setting-filter").checked, enabled);
    assert.equal(page.nodes.get("apply-config").disabled, true);
    assert.equal(page.nodes.get("config-status").textContent, "");
    assert.equal(page.nodes.get("config-status").hidden, true);
  }
  assert.equal(confirmations, 1);
});

test("Aufzeichnungsfortschritt berechnet Zeit, Prozent und Restzeit ohne Timerdrift", () => {
  let now = 1000;
  const progress = new RecordingProgress(() => now);
  assert.equal(progress.snapshot(), null);
  progress.start(60);
  now += 15000;
  assert.deepEqual(progress.snapshot(), { elapsed: 15, remaining: 45, percent: 25, finished: false, reason: "" });
  now += 60000;
  assert.deepEqual(progress.snapshot(), { elapsed: 60, remaining: 0, percent: 100, finished: false, reason: "" });
  // Even at 100%, only a firmware completion may mark the recording finished.
  progress.finish("timeout");
  assert.equal(progress.snapshot().finished, true);
  progress.reset();
  assert.equal(progress.snapshot(), null);
});

test("Vorzeitiger Stopp friert den Fortschritt ein; neuer Start setzt ihn zurück", () => {
  let now = 0;
  const progress = new RecordingProgress(() => now);
  progress.start(120);
  now = 30000;
  progress.finish("user_stop");
  now = 60000;
  assert.deepEqual(progress.snapshot(), { elapsed: 30, remaining: 90, percent: 25, finished: true, reason: "user_stop" });
  progress.start(10);
  assert.equal(progress.snapshot().percent, 0);
  progress.start(undefined);
  assert.equal(progress.snapshot(), null);
  assert.equal(formatDuration(125), "02:05");
  assert.equal(formatDuration(4200), "70:00");
});

test("Fortschrittsanzeige startet erst nach Firmwarebestätigung und bleibt bei Stopp stehen", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  const files = attachFileService(f);
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    if (/^record \d+$/.test(command)) files.consume(Number(command.split(" ")[1]));
    const response = command === "config" ? configText : /^record \d+$/.test(command)
      ? "logging: started\r\nfile: test.csv\r\n" : command === "stop"
        ? "logging complete:\r\nreason: user_stop\r\nduration_ms: 15000\r\nstate: idle\r\n"
        : "time: set\r\n";
    f.notify(new TextEncoder().encode(response));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  let now = 0;
  page.context.performance.now = () => now;
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  assert.equal(page.nodes.get("recording-progress").hidden, true);
  await page.buttons.find((button) => button.dataset.command === "start").emit("click");
  assert.equal(page.nodes.get("recording-progress").hidden, false);
  assert.equal(page.nodes.get("recording-bar").value, 0);
  now = 15000;
  t.mock.timers.tick(500);
  assert.equal(page.nodes.get("recording-bar").value, 25);
  assert.equal(page.nodes.get("recording-remaining").textContent, "ca. 00:45 verbleibend");
  await page.buttons.find((button) => button.dataset.command === "stop").emit("click");
  assert.equal(page.nodes.get("recording-label").textContent, "Vorzeitig beendet");
  now = 100000;
  t.mock.timers.tick(500);
  assert.equal(page.nodes.get("recording-bar").value, 25);
  await page.nodes.get("disconnect").emit("click");
  assert.equal(page.nodes.get("recording-progress").hidden, true);
});

for (const outcome of ["duration", "user_stop", "sd_error", "missing_file"]) test(`Abgeschlossene Messung lässt sich direkt ohne Dateiliste visualisieren (${outcome})`, async (t) => {
  const f = fixture();
  const bytes = recording();
  const files = attachFileService(f, { "EKG00008.BIN": bytes });
  f.rx.writeValueWithResponse = async (chunk) => f.notify(new TextEncoder().encode(
    new TextDecoder().decode(chunk).trim() === "config" ? configText : "time: set\r\n"));
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  let opened = null;
  page.context.window.EkgViewer = { begin(name) {
    opened = name;
    return { append() {}, complete(metadata, verification, received) {
      assert.equal(verification.algorithm, "SHA-256");
      assert.deepEqual(Buffer.from(received), Buffer.from(bytes));
    }, fail(error) { throw error; } };
  } };
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  const send = (text) => f.notify(new TextEncoder().encode(text));
  send("logging: started\r\nfile: EKG00008.BIN\r\n");
  assert.equal(page.nodes.get("recording-result").hidden, true);
  assert.equal(page.nodes.get("recording-visualize").disabled, true);
  const summary = `logging complete:\r\nreason: ${outcome}\r\n${outcome === "missing_file" ? "" : "file: EKG00008.BIN\r\n"}sd: ${outcome === "sd_error" ? "error" : "complete"}\r\n`;
  for (const character of summary) send(character);
  assert.equal(page.nodes.get("recording-result").hidden, true); // Await final idle confirmation.
  send("state: idle\r\n");
  await new Promise(setImmediate);
  const success = ["duration", "user_stop"].includes(outcome);
  assert.equal(page.nodes.get("recording-result").hidden, !success);
  assert.equal(page.nodes.get("recording-visualize").disabled, !success);
  if (success) {
    assert.match(page.nodes.get("recording-result-info").textContent, /EKG00008\.BIN/);
    await page.nodes.get("recording-visualize").emit("click");
    assert.equal(opened, "EKG00008.BIN");
    assert.equal(files.operations.includes(SD_OP.listInfoNewest), false);
    assert.equal(files.operations.includes(SD_OP.listInfo), false);
    assert.equal(files.operations.includes(SD_OP.list), false);
    send("logging: started\r\n");
    assert.equal(page.nodes.get("recording-result").hidden, true);
  }
  await page.nodes.get("disconnect").emit("click");
  assert.equal(page.nodes.get("recording-result").hidden, true);
});

function previewFixture() {
  const f = fixture();
  const files = attachFileService(f);
  const raw = new EventTarget();
  const metadata = new EventTarget();
  const commands = [];
  const state = { session: 0, active: false, end: 0, acquisition: 0, tx: 0, filtered: false };
  function statusValue() {
    const view = new DataView(new ArrayBuffer(20));
    view.setUint8(0, 0xC1); view.setUint8(1, 1);
    view.setUint16(2, state.session, true); view.setUint16(4, state.session ? 250 : 0, true);
    view.setUint8(6, state.active ? 1 : 0); view.setUint8(7, state.filtered ? 2 : 1);
    view.setUint32(8, state.end, true); view.setUint32(12, state.acquisition, true); view.setUint32(16, state.tx, true);
    return view;
  }
  raw.startNotifications = async () => raw;
  raw.stopNotifications = async () => raw;
  metadata.startNotifications = async () => metadata;
  metadata.stopNotifications = async () => metadata;
  metadata.readValue = async () => statusValue();
  const originalService = f.device.gatt.getPrimaryService;
  f.device.gatt.getPrimaryService = async (uuid) => uuid === PREVIEW_SERVICE
    ? { async getCharacteristic(id) {
      assert.ok([PREVIEW_DATA, PREVIEW_STATUS].includes(id));
      return id === PREVIEW_DATA ? raw : metadata;
    } } : originalService(uuid);
  function emitStatus() {
    metadata.value = statusValue();
    metadata.dispatchEvent(new Event("characteristicvaluechanged"));
  }
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    let response = "time: set\r\n";
    if (command === "config") response = configText;
    if (command === "preview start") {
      ++state.session; state.active = true;
      emitStatus();
      response = "preview: started\r\n";
    }
    if (command === "preview stop") {
      state.active = false;
      emitStatus();
      response = "preview: stopped\r\nstate: idle\r\n";
    }
    if (/^record \d+$/.test(command)) {
      files.consume(Number(command.split(" ")[1]));
      response = "logging: started\r\nfile: test.csv\r\n";
    }
    f.notify(new TextEncoder().encode(response));
  };
  function emitData(first, values, sequence) {
    const view = new DataView(new ArrayBuffer(12 + 4 * values.length));
    view.setUint8(0, 0xD1); view.setUint8(1, 1);
    view.setUint16(2, state.session, true); view.setUint16(4, sequence, true);
    view.setUint32(6, first, true); view.setUint8(10, values.length);
    values.forEach((value, i) => view.setInt32(12 + 4 * i, value, true));
    raw.value = view;
    raw.dispatchEvent(new Event("characteristicvaluechanged"));
  }
  return { ...f, state, commands, raw, metadata, emitData, emitStatus, files };
}

test("Vorschau empfängt binär im Hintergrund, zeigt Verluste und stoppt vor SD-Aufzeichnung", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = previewFixture();
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  await page.nodes.get("preview-start").emit("click");
  assert.equal(page.nodes.get("preview-stop").disabled, false);
  assert.equal(page.nodes.get("command").focused, undefined);
  assert.equal(page.nodes.get("config-fields").disabled, true);
  page.nodes.get("preview-keep-seconds").value = "30";
  await page.nodes.get("preview-keep-seconds").emit("change");
  assert.match(page.nodes.get("preview-state").textContent, /Letzte 30 Sekunden/);
  assert.match(page.nodes.get("preview-canvas")["aria-label"], /30 Sekunden/);
  const consoleBefore = page.nodes.get("console").textContent;
  f.emitData(0, [-8388608, 11, 22], 0);
  f.emitData(5, [1234567], 2);
  f.state.end = 6;
  f.state.acquisition = 1;
  f.state.tx = 1;
  f.emitStatus();
  t.mock.timers.tick(40);
  assert.equal(page.nodes.get("preview-received").textContent, "4");
  assert.equal(page.nodes.get("preview-missing").textContent, "2");
  assert.equal(page.nodes.get("preview-packet-gaps").textContent, "1");
  assert.equal(page.nodes.get("console").textContent, consoleBefore);
  await page.buttons.find((button) => button.dataset.command === "start").emit("click");
  assert.equal(page.nodes.get("command").focused, undefined);
  assert.deepEqual(f.commands.slice(-2), ["preview stop", "record 1"]);
  assert.equal(page.nodes.get("preview-start").disabled, true);
  assert.equal(page.nodes.get("preview-stop").disabled, true);
  assert.match(page.nodes.get("preview-state").textContent, /SD-Aufzeichnung deaktiviert/);
  await page.nodes.get("disconnect").emit("click");
  assert.equal(page.nodes.get("preview-panel").hidden, true);
});

test("Vorschau kennzeichnet MCU-gefilterte Werte anhand der Firmware statt der Formulareinstellung", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = previewFixture();
  f.state.filtered = true;
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  await page.nodes.get("preview-start").emit("click");
  assert.match(page.nodes.get("preview-state").textContent, /MCU-gefilterte ADC-Werte/);
  assert.match(page.nodes.get("preview-canvas")["aria-label"], /MCU-gefilterte ADC-Werte/);
});

test("Vorschau-Buttons öffnen kein Texteingabefeld und damit keine Android-Tastatur", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = previewFixture();
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  await page.nodes.get("preview-start").emit("click");
  assert.equal(page.nodes.get("command").focused, undefined);
  await page.nodes.get("preview-stop").emit("click");
  assert.equal(page.nodes.get("command").focused, undefined);
  assert.equal(page.nodes.get("preview-start").disabled, false);
});

test("Gerätebuttons fokussieren nach Fehlern nicht die Konsole; Displaystart bleibt als Konsolenbefehl verfügbar", async (t) => {
  const f = fixture();
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    f.notify(new TextEncoder().encode(command === "config" ? configText
      : command.startsWith("time ") ? "time: set\r\n" : "error: unavailable\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  await page.nodes.get("preview-start").emit("click");
  assert.equal(page.nodes.get("command").focused, undefined);
  await page.buttons.find((button) => button.dataset.command === "stop").emit("click");
  assert.equal(page.nodes.get("command").focused, undefined);
  assert.ok(!page.buttons.some((button) => button.dataset.command === "display start"));
  page.nodes.get("command").value = "display start";
  await page.nodes.get("command-form").emit("submit");
  assert.equal(page.nodes.get("command").focused, undefined);
});

test("Expliziter Konsolenbefehl behält Texteingabefokus ohne Scrollen", async (t) => {
  const f = fixture();
  f.rx.writeValueWithResponse = async (bytes) => {
    f.notify(new TextEncoder().encode(new TextDecoder().decode(bytes).trim() === "config"
      ? configText : "time: set\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  page.nodes.get("command").value = "help";
  await page.nodes.get("command-form").emit("submit");
  assert.equal(page.nodes.get("command").focused, true);
  assert.equal(page.nodes.get("command").focusOptions.preventScroll, true);
});

test("Alte Firmware ohne Vorschaudienst bleibt als Konsole nutzbar", async (t) => {
  const f = fixture();
  const originalService = f.device.gatt.getPrimaryService;
  f.device.gatt.getPrimaryService = async (uuid) => {
    if (uuid === PREVIEW_SERVICE) throw new Error("GATT service not found");
    return originalService(uuid);
  };
  f.rx.writeValueWithResponse = async (bytes) => {
    f.notify(new TextEncoder().encode(new TextDecoder().decode(bytes).trim() === "config" ? configText : "time: set\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  await page.nodes.get("preview-start").emit("click");
  assert.equal(page.nodes.get("command").disabled, false);
  assert.equal(page.nodes.get("command").focused, undefined);
  assert.match(page.nodes.get("preview-state").textContent, /neue Firmware/);
});

test("Manuelles Trennen meldet SD-, Vorschau- und NUS-Notifications noch auf der bestehenden Verbindung ab", async () => {
  const f = previewFixture();
  const stopped = [];
  for (const [name, characteristic] of [["sd", f.files.stream], ["data", f.raw], ["status", f.metadata], ["nus", f.tx]]) {
    characteristic.stopNotifications = async () => {
      assert.equal(f.device.gatt.connected, true);
      stopped.push(name);
      return characteristic;
    };
  }
  await f.monitor.chooseDevice();
  await f.monitor.preparePreview(() => {}, () => {});
  f.monitor.sdData = f.files.stream;
  f.monitor.sdDataListener = () => {};
  await f.monitor.disconnect();
  assert.deepEqual(stopped, ["sd", "data", "status", "nus"]);
  assert.equal(f.device.gatt.connected, false);
});

test("SD-Bereich liegt zwischen Vorschau und Konsole; Liste und CSV-Download laufen ohne Konsolendaten", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  const files = fileService({ "EKG00001.BIN": recording(), "EKG00002.BIN": recording([]) });
  const originalService = f.device.gatt.getPrimaryService;
  f.device.gatt.getPrimaryService = async (id) => id === SD_SERVICE
    ? { async getCharacteristic(uuid) { return uuid === SD_CONTROL ? files.control : uuid === SD_DATA ? files.stream : files.data; } }
    : originalService(id);
  f.rx.writeValueWithResponse = async (bytes) => {
    f.notify(new TextEncoder().encode(new TextDecoder().decode(bytes).trim() === "config" ? configText : "time: set\r\n"));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.ok(html.indexOf('id="preview-panel"') < html.indexOf('id="sd-panel"'));
  assert.ok(html.indexOf('id="device-controls"') < html.indexOf('id="preview-panel"'));
  assert.ok(html.indexOf('id="preview-panel"') < html.indexOf('id="recording-panel"'));
  assert.ok(html.indexOf('id="recording-panel"') < html.indexOf('id="sd-panel"'));
  assert.ok(html.indexOf('id="sd-panel"') < html.indexOf('id="console-panel"'));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  const consoleBefore = page.nodes.get("console").textContent;
  await page.nodes.get("sd-refresh").emit("click");
  assert.equal(page.nodes.get("sd-files").children.length, 2);
  const firstRow = page.nodes.get("sd-files").children[0];
  assert.match(firstRow.children[0].textContent, /EKG00002.BIN/);
  let csv;
  page.context.URL.createObjectURL = (blob) => { csv = blob; return "blob:test"; };
  await firstRow.children[1].emit("click");
  assert.match(await csv.text(), /# source_file: "EKG00002.BIN"/);
  assert.match(page.nodes.get("sd-status").textContent, /Download an den Browser übergeben/);
  assert.equal(page.nodes.get("console").textContent, consoleBefore);
  assert.equal(files.state.closed, true);
  await page.nodes.get("disconnect").emit("click");
  assert.equal(page.nodes.get("sd-panel").hidden, true);
  assert.equal(page.nodes.get("sd-files").children.length, 0);
});

for (const outcome of ["success", "checksum", "abort"]) test(`SD-Visualisieren öffnet inkrementelle Ansicht ohne automatischen CSV-Download (${outcome})`, async (t) => {
  const f = fixture();
  const bytes = recording(Array.from({ length: 2000 }, (_, i) => [i, 1000 + i * 2000, i - 1000]),
    { participant: "P-Ä", comment: "Direktansicht" });
  const files = attachFileService(f, { "EKG00001.BIN": bytes });
  if (outcome === "checksum") files.state.mutate = (view, op) => op === SD_OP.streamFinish
    ? response(view.getUint16(2, true), op, bytes.length, new Uint8Array(32)) : view;
  f.rx.writeValueWithResponse = async (chunk) => f.notify(new TextEncoder().encode(
    new TextDecoder().decode(chunk).trim() === "config" ? configText : "time: set\r\n"));
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  const counts = [];
  let completed = false, failure = null, downloads = 0;
  page.context.URL.createObjectURL = () => { ++downloads; return "blob:test"; };
  page.context.window.EkgViewer = { begin(name, cancel) {
    assert.equal(name, "EKG00001.BIN");
    const stream = new BinaryStream(name);
    return {
      append(chunk, offset, total) {
        stream.push(chunk, offset, total);
        counts.push(stream.count);
        if (outcome === "abort") cancel();
      },
      complete(metadata, verification, receivedBytes) {
        assert.deepEqual(Buffer.from(receivedBytes), Buffer.from(bytes));
        assert.equal(verification.algorithm, "SHA-256");
        assert.equal(stream.finish(metadata).values.length, 2000);
        assert.equal(metadata.participant, "P-Ä");
        completed = true;
      },
      fail(error) { failure = error; },
    };
  } };
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  await page.nodes.get("sd-refresh").emit("click");
  const row = page.nodes.get("sd-files").children[0];
  assert.equal(row.children[2].textContent, "Visualisieren");
  assert.equal(row.children[2].disabled, false);
  await row.children[2].emit("click");
  assert.ok(counts.some((count) => count > 0 && count < 2000));
  assert.equal(downloads, 0);
  assert.equal(completed, outcome === "success");
  if (outcome === "success") {
    assert.equal(failure, null);
    assert.match(page.nodes.get("sd-status").textContent, /Daten Visualisieren/);
  } else if (outcome === "checksum") assert.match(failure.message, /SHA-256/);
  else assert.equal(failure.name, "AbortError");
  assert.equal(files.state.closed, true);
  assert.equal(files.state.subscribed, false);
  assert.equal(row.children[2].disabled, false);
});

for (const legacy of [false, true]) test(`Dateiliste baut sich sofort sortiert auf, ohne vorhandene Zeilen neu zu erstellen (${legacy ? "alte" : "neue"} Firmware)`, async (t) => {
  const f = fixture();
  const files = attachFileService(f, { "EKG00001.BIN": recording(), "EKG00099.BIN": recording(), "EKG00050.BIN": recording() });
  files.state.legacyListing = legacy;
  f.rx.writeValueWithResponse = async (bytes) => f.notify(new TextEncoder().encode(
    new TextDecoder().decode(bytes).trim() === "config" ? configText : "time: set\r\n"));
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  const write = files.control.writeValueWithResponse;
  const release = [];
  files.control.writeValueWithResponse = async (bytes) => {
    if (bytes[4] === SD_OP.nextInfo) await new Promise((resolve) => release.push(resolve));
    return write(bytes);
  };
  const listing = page.nodes.get("sd-refresh").emit("click");
  await new Promise(setImmediate);
  const list = page.nodes.get("sd-files");
  assert.equal(list.children.length, 1);
  const first = list.children[0];
  assert.match(first.children[0].textContent, legacy ? /EKG00001/ : /EKG00099/);
  assert.equal(first.children[1].disabled, true);
  assert.equal(list["aria-busy"], "true");
  list.scrollTop = 42;
  release.shift()();
  await new Promise(setImmediate);
  assert.equal(list.children.length, 2);
  assert.ok(list.children.includes(first));
  assert.match(list.children[0].children[0].textContent, /EKG00099/);
  assert.equal(list.scrollTop, 42);
  release.shift()();
  await new Promise(setImmediate);
  assert.equal(list.children.length, 3);
  release.shift()();
  await listing;
  assert.deepEqual(list.children.map((row) => row.children[0].children[0].textContent), ["EKG00099.BIN", "EKG00050.BIN", "EKG00001.BIN"]);
  assert.ok(list.children.includes(first));
  assert.ok(list.children.every((row) => !row.children[1].disabled));
  assert.equal(list["aria-busy"], "false");
  assert.equal(files.state.closed, true);
});

test("Abbruch einer Teilliste erhält sichtbare Einträge und gibt deren Download frei", async (t) => {
  const f = fixture();
  const files = attachFileService(f, { "EKG00001.BIN": recording(), "EKG00099.BIN": recording() });
  f.rx.writeValueWithResponse = async (bytes) => f.notify(new TextEncoder().encode(
    new TextDecoder().decode(bytes).trim() === "config" ? configText : "time: set\r\n"));
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  const write = files.control.writeValueWithResponse;
  let resume;
  files.control.writeValueWithResponse = async (bytes) => {
    if (bytes[4] === SD_OP.nextInfo) await new Promise((resolve) => { resume = resolve; });
    return write(bytes);
  };
  const listing = page.nodes.get("sd-refresh").emit("click");
  await new Promise(setImmediate);
  const list = page.nodes.get("sd-files");
  assert.equal(list.children.length, 1);
  const row = list.children[0];
  await page.nodes.get("sd-cancel").emit("click");
  resume();
  await listing;
  assert.equal(files.state.closed, true);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0], row);
  assert.equal(row.children[1].disabled, false);
  assert.equal(list["aria-busy"], "false");
  assert.match(page.nodes.get("sd-status").textContent, /Dateiliste unvollständig/);
  assert.equal(page.nodes.get("sd-refresh").disabled, false);
});

test("Alter Firmware fehlt der SD-Dienst: verständlicher Hinweis, Konsole bleibt nutzbar", async (t) => {
  const f = fixture();
  const originalService = f.device.gatt.getPrimaryService;
  f.device.gatt.getPrimaryService = async (id) => {
    if (id === SD_SERVICE) throw new Error("SD service not found");
    return originalService(id);
  };
  f.rx.writeValueWithResponse = async (bytes) => f.notify(new TextEncoder().encode(
    new TextDecoder().decode(bytes).trim() === "config" ? configText : "time: set\r\n"));
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  await page.nodes.get("sd-refresh").emit("click");
  assert.match(page.nodes.get("sd-status").textContent, /Firmware ab 0.10.0/);
  assert.equal(page.nodes.get("command").disabled, false);
});

test("SD-Abbruch sperrt während des Zugriffs Messung/Vorschau und gibt danach die Bedienung frei", async (t) => {
  const f = fixture();
  const files = fileService();
  const originalService = f.device.gatt.getPrimaryService;
  f.device.gatt.getPrimaryService = async (id) => id === SD_SERVICE
    ? { async getCharacteristic(uuid) { return uuid === SD_CONTROL ? files.control : uuid === SD_DATA ? files.stream : files.data; } }
    : originalService(id);
  f.rx.writeValueWithResponse = async (bytes) => f.notify(new TextEncoder().encode(
    new TextDecoder().decode(bytes).trim() === "config" ? configText : "time: set\r\n"));
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  const read = files.data.readValue;
  let finishRead;
  let first = true;
  files.data.readValue = async () => {
    if (first) {
      first = false;
      await new Promise((resolve) => { finishRead = resolve; });
    }
    return read();
  };
  const listing = page.nodes.get("sd-refresh").emit("click");
  await new Promise(setImmediate);
  assert.equal(page.nodes.get("preview-start").disabled, true);
  assert.equal(page.nodes.get("config-fields").disabled, true);
  assert.equal(page.nodes.get("sd-cancel").hidden, false);
  assert.equal(page.buttons.find((button) => button.dataset.command === "start").disabled, true);
  await page.nodes.get("sd-cancel").emit("click");
  finishRead();
  await listing;
  assert.equal(files.state.closed, true);
  assert.match(page.nodes.get("sd-status").textContent, /abgebrochen/);
  assert.equal(page.nodes.get("sd-files").children.length, 0);
  assert.equal(page.nodes.get("sd-cancel").hidden, true);
  assert.equal(page.nodes.get("preview-start").disabled, false);
});

test("Versuchsperson und Kommentar werden beim Start übertragen und später neben Datei sowie in CSV angezeigt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  const storedFiles = {};
  const files = attachFileService(f, storedFiles);
  const commands = [];
  f.rx.writeValueWithResponse = async (bytes) => {
    const command = new TextDecoder().decode(bytes).trim();
    commands.push(command);
    let answer = command === "config" ? configText : "time: set\r\n";
    if (/^record \d+$/.test(command)) {
      const fields = files.consume(Number(command.split(" ")[1]));
      storedFiles["EKG00000.BIN"] = recording(undefined, fields);
      answer = "logging: started\r\nfile: EKG00000.BIN\r\n";
    }
    if (command === "stop") answer = "state: idle\r\n";
    f.notify(new TextEncoder().encode(answer));
  };
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  page.nodes.get("recording-participant").value = "P-Ä🫀";
  page.nodes.get("recording-comment").value = "Sitzend\nGriffe drücken";
  await page.nodes.get("recording-metadata").emit("input");
  await page.buttons.find((button) => button.dataset.command === "start").emit("click");
  assert.match(page.nodes.get("recording-metadata-note").textContent, /im Dateiheader gespeichert/);
  assert.equal(page.nodes.get("recording-metadata").disabled, true);
  assert.ok(commands.includes("record 1"));
  assert.ok(!commands.includes("start"));
  await page.buttons.find((button) => button.dataset.command === "stop").emit("click");
  await page.nodes.get("sd-refresh").emit("click");
  const row = page.nodes.get("sd-files").children[0];
  assert.match(row.children[0].textContent, /P-Ä🫀/);
  assert.match(row.children[0].textContent, /Sitzend\nGriffe drücken/);
  let csv;
  page.context.URL.createObjectURL = (blob) => { csv = blob; return "blob:test"; };
  await row.children[1].emit("click");
  assert.match(await csv.text(), /# participant: "P-Ä🫀"/);
  assert.ok((await csv.text()).includes('# comment: "Sitzend\\nGriffe drücken"'));
});

test("Überlange UTF-8-Metadaten zeigen Fehler und verhindern Aufzeichnungsstart", async (t) => {
  const f = previewFixture();
  const page = pageFixture(true, { async requestDevice() { return f.device; } });
  t.after(() => page.nodes.get("disconnect").emit("click"));
  await page.nodes.get("connect").emit("click");
  await new Promise(setImmediate);
  page.nodes.get("recording-participant").value = "Ä".repeat(41);
  await page.nodes.get("recording-metadata").emit("input");
  assert.equal(page.nodes.get("recording-metadata-note").dataset.error, "true");
  assert.match(page.nodes.get("recording-participant-count").textContent, /82 \/ 80/);
  await page.buttons.find((button) => button.dataset.command === "start").emit("click");
  assert.equal(f.files.operations.length, 0);
  assert.ok(!f.commands.some((command) => /^(record|start)/.test(command)));
});

test("Fehlgeschlagenes Abonnieren kann wiederholt werden; Trennen entfernt Binärlistener", async (t) => {
  const f = previewFixture();
  t.after(() => f.monitor.disconnect());
  await f.monitor.chooseDevice();
  f.raw.startNotifications = async () => { throw new Error("subscription failed"); };
  await assert.rejects(f.monitor.preparePreview(() => {}, () => {}), /subscription failed/);
  assert.equal(f.monitor.previewReady, false);
  f.raw.startNotifications = async () => f.raw;
  let received = 0;
  await f.monitor.preparePreview(() => ++received, () => {});
  f.emitData(0, [1], 0);
  assert.equal(received, 1);
  f.monitor.disconnect();
  f.emitData(1, [2], 1);
  assert.equal(received, 1);
});
