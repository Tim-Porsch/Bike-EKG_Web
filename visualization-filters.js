"use strict";

// Lokale Darstellungsfilter: Originalwerte werden kopiert, nie überschrieben.
// Kausaler Vorwärtslauf HP → LP → Notch → optionale QRS-Energie; keine filtfilt-
// Phasenkorrektur und keine vollständige R-Zacken-/Herzfrequenzdetektion.

// Second-order digital biquads (bilinear-transform/RBJ coefficients).
const EkgFilters = (() => {
  function validate(rate, settings) {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("Filter benötigen eine gültige Abtastrate.");
    for (const kind of ["hp", "lp", "notch"]) {
      const filter = settings[kind];
      if (!filter?.enabled) continue;
      if (!Number.isFinite(filter.frequency) || filter.frequency <= 0 || filter.frequency >= rate / 2) {
        throw new Error(`${kind.toUpperCase()}: Frequenz muss größer als 0 und kleiner als ${rate / 2} Hz (Nyquist) sein.`);
      }
      if (kind === "notch" && (!Number.isFinite(filter.q) || filter.q < 1 || filter.q > 100)) {
        throw new Error("Notch: Güte Q muss zwischen 1 und 100 liegen.");
      }
    }
    if (settings.hp?.enabled && settings.lp?.enabled && settings.hp.frequency >= settings.lp.frequency) {
      throw new Error("Die HP-Grenzfrequenz muss unter der LP-Grenzfrequenz liegen.");
    }
    if (settings.qrs?.enabled && (!Number.isFinite(settings.qrs.windowMs)
      || settings.qrs.windowMs < 1 || settings.qrs.windowMs > 1000)) {
      throw new Error("QRS: Integrationsfenster muss zwischen 1 und 1000 ms liegen.");
    }
  }

  function coefficients(kind, frequency, rate, q = Math.SQRT1_2) {
    // Auf a0 normierte Biquad-Koeffizienten; HP/LP mit Q=1/sqrt(2) (Butterworth).
    const omega = 2 * Math.PI * frequency / rate;
    const cosine = Math.cos(omega), alpha = Math.sin(omega) / (2 * q), a0 = 1 + alpha;
    let b0, b1, b2;
    if (kind === "lp") { b0 = b2 = (1 - cosine) / 2; b1 = 1 - cosine; }
    else if (kind === "hp") { b0 = b2 = (1 + cosine) / 2; b1 = -(1 + cosine); }
    else { b0 = b2 = 1; b1 = -2 * cosine; }
    return [b0 / a0, b1 / a0, b2 / a0, -2 * cosine / a0, (1 - alpha) / a0];
  }

  function apply(values, gaps, rate, settings) {
    validate(rate, settings);
    let output = values.slice();
    for (const kind of ["hp", "lp", "notch"]) {
      const filter = settings[kind];
      if (!filter?.enabled) continue;
      const [b0, b1, b2, a1, a2] = coefficients(kind, filter.frequency, rate,
        kind === "notch" ? filter.q : Math.SQRT1_2);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < output.length; ++i) {
        const x = output[i];
        // Constant prehistory avoids a spurious step from zero at each segment.
        if (!i || gaps[i]) { x1 = x2 = x; y1 = y2 = kind === "hp" ? 0 : x; }
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        if (!Number.isFinite(y)) throw new Error("Filterberechnung ist numerisch instabil. Bitte andere Frequenzen wählen.");
        output[i] = y;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
      }
    }
    return settings.qrs?.enabled ? qrsEnergy(output, gaps, rate, settings.qrs.windowMs) : output;
  }

  function qrsEnergy(values, gaps, rate, windowMs) {
    // Ergebnis in (Counts/s)²: Ableitung, Quadrat, gleitender Mittelwert.
    // Ringpuffer erlaubt O(1) Integrationsarbeit je Sample unabhängig vom Fenster.
    const length = Math.max(1, Math.round(windowMs * rate / 1000));
    const ring = new Float64Array(length), output = new Float64Array(values.length);
    let x1 = 0, x2 = 0, x3 = 0, x4 = 0, sum = 0, head = 0, count = 0;
    for (let i = 0; i < values.length; ++i) {
      const x = values[i];
      if (!i || gaps[i]) { x1 = x2 = x3 = x4 = x; sum = 0; head = 0; count = 0; }
      // Causal five-point Pan–Tompkins-like derivative, delay two samples.
      const derivative = ((x - x4) + 2 * (x1 - x3)) * rate / 8;
      const energy = derivative * derivative;
      sum += energy - (count === length ? ring[head] : 0);
      ring[head] = energy;
      head = (head + 1) % length;
      count = Math.min(length, count + 1);
      // Fixed window with zero prehistory, including at every recording gap.
      output[i] = Math.max(0, sum / length);
      if (!Number.isFinite(output[i])) throw new Error("QRS-Berechnung enthält nicht endliche Werte.");
      x4 = x3; x3 = x2; x2 = x1; x1 = x;
    }
    return output;
  }

  function describe(settings) {
    const stages = ["hp", "lp", "notch"].filter((kind) => settings[kind]?.enabled)
      .map((kind) => `${kind.toUpperCase()} ${settings[kind].frequency} Hz${kind === "notch" ? ` (Q ${settings[kind].q})` : ""}`);
    if (settings.qrs?.enabled) stages.push(`QRS-Energie (Ableitung → Quadrat → Mittelwert ${settings.qrs.windowMs} ms)`);
    return stages.join(" → ") || "Aus · Rohdaten";
  }
  return { validate, coefficients, apply, describe };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EkgFilters;
