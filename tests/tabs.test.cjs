"use strict";

// Minimales DOM prüft Sichtbarkeit, Tastaturnavigation und Erhalt vorhandener Panels.
// Kein Pixel-/Layouttest und keine Neuanlage der Inhalte beim Reiterwechsel.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture() {
  const panels = [{ hidden: false }, { hidden: true }];
  const tabs = panels.map((panel, index) => ({
    attributes: { "aria-controls": String(index), "aria-selected": String(index === 0) },
    tabIndex: index === 0 ? 0 : -1,
    listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    focus() { this.focused = true; },
  }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../tabs.js"), "utf8"), {
    document: {
      querySelectorAll: () => tabs,
      getElementById: (id) => panels[Number(id)],
    },
  });
  return { tabs, panels };
}

test("Reiter wechseln nur die Sichtbarkeit und erhalten den Panelinhalt", () => {
  const { tabs, panels } = fixture();
  panels[0].input = "bestehende Eingabe";
  for (const index of [1, 0, 1, 0]) {
    tabs[index].listeners.click();
    panels.forEach((panel, i) => {
      assert.equal(panel.hidden, i !== index);
      assert.equal(tabs[i].attributes["aria-selected"], String(i === index));
      assert.equal(tabs[i].tabIndex, i === index ? 0 : -1);
    });
  }
  assert.equal(panels[0].input, "bestehende Eingabe");
});

test("Pfeiltasten und Pos1/Ende wählen und fokussieren den Reiter", () => {
  for (const [from, key, to] of [[0, "ArrowRight", 1], [0, "ArrowLeft", 1], [1, "ArrowRight", 0], [1, "ArrowLeft", 0], [1, "Home", 0], [0, "End", 1]]) {
    const { tabs, panels } = fixture();
    let prevented = false;
    tabs[from].listeners.keydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(tabs[to].focused, true);
    assert.equal(panels[to].hidden, false);
  }
});
