"use strict";

// Gemeinsamer Berichtrenderer für Bildschirm und PNG, ohne DOM- oder BLE-Zugriff.

// One layout for the on-screen report and its high-resolution PNG export.
const EkgReport = (() => {
  const format = (value) => Number(value).toLocaleString("de-DE", { maximumFractionDigits: 3 });
  const present = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

  function summary(data, filename) {
    // Messbeginn ausschließlich aus Gerätezeit, nicht aus dem CSV-Exportdatum ableiten.
    const meta = data.metadata;
    let date = null;
    if (present(meta.device_start_utc)) {
      const parsed = new Date(meta.device_start_utc);
      if (Number.isFinite(parsed.getTime())) date = parsed;
    }
    if (!date && typeof meta.device_unix_time === "number" && meta.device_unix_time > 0) {
      const parsed = new Date(meta.device_unix_time * 1000);
      if (Number.isFinite(parsed.getTime())) date = parsed;
    }
    const started = date ? new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium", timeStyle: "medium", timeZone: "UTC",
    }).format(date) + " UTC" : "nicht im Messsystem gespeichert";
    const rate = typeof meta.sample_rate_sps === "number" && Number.isFinite(meta.sample_rate_sps) && meta.sample_rate_sps > 0
      ? `${format(meta.sample_rate_sps)} Samples/s`
      : data.rate ? `${format(data.rate)} Samples/s (geschätzt)` : "unbekannt";
    const settings = [`Abtastrate: ${rate}`];
    if (typeof meta.gain_multiplier === "number" && meta.gain_multiplier > 0) settings.push(`Verstärkung: ${format(meta.gain_multiplier)}×`);
    const inputs = { normal: "Messeingang", short: "kurzgeschlossen", test: "Testsignal" };
    const input = Object.hasOwn(inputs, meta.input_name) ? inputs[meta.input_name] : null;
    if (input) settings.push(`Eingang: ${input}`);
    if (typeof meta.rld_enabled === "boolean") settings.push(`RLD: ${meta.rld_enabled ? "Ein" : "Aus"}`);
    const result = [
      `Datei: ${filename}`,
      `Datum/Uhrzeit (Messbeginn): ${started}`,
      `Person: ${present(meta.participant) || "-"}`,
      settings.join(" · "),
      `Signal: ${meta.signal_format === "viewer_qrs_energy" ? "QRS-Energiekurve, (Counts/s)²" : `${meta.signal_format === "raw_adc_counts" ? "ungefilterte Rohdaten, " : ""}ADC-Counts`}`
        + (present(meta.firmware_version) ? ` · Bike-EKG Firmware: ${meta.firmware_version}` : ""),
    ];
    if (present(meta.comment)) result.push(`Kommentar: ${meta.comment.trim()}`);
    const warnings = [];
    if (data.gapCount) warnings.push(`Erkannte Datenlücken: ${format(data.gapCount)}`);
    if (meta.footer_samples_dropped > 0) warnings.push(`Verworfene Samples: ${format(meta.footer_samples_dropped)}`);
    if (meta.footer_sample_read_errors > 0) warnings.push(`Lesefehler: ${format(meta.footer_sample_read_errors)}`);
    if (present(meta.footer_error) && meta.footer_error !== "none") warnings.push(`Aufzeichnungsfehler: ${meta.footer_error}`);
    if (warnings.length) result.push(warnings.join(" · "));
    return result;
  }

  function wrap(text, width, measure) {
    const lines = [];
    for (const paragraph of text.split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && measure(`${line} ${word}`) > width) { lines.push(line); line = ""; }
        // File names and comments may contain words longer than the whole plot.
        for (const character of (line ? " " : "") + word) {
          if (line && measure(line + character) > width) { lines.push(line); line = ""; }
          line += character;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function layout(ctx, width, rows, rangeText, plotHeight) {
    const lines = [], lineRuns = [];
    rows.forEach((row, index) => {
      const label = index < 3 ? /^(Datei: |Datum\/Uhrzeit \(Messbeginn\): |Person: )/.exec(row)?.[0] : null;
      // Measuring highlighted rows in bold also leaves enough room for the normal-weight label.
      ctx.font = label ? "700 12px system-ui, sans-serif" : "12px system-ui, sans-serif";
      let remainingLabel = label || "";
      for (const line of wrap(row, width - 24, (text) => ctx.measureText(text).width)) {
        lines.push(line);
        let normalLength = 0;
        while (normalLength < line.length && normalLength < remainingLabel.length
          && line[normalLength] === remainingLabel[normalLength]) ++normalLength;
        remainingLabel = remainingLabel.slice(normalLength).trimStart();
        lineRuns.push(label ? [
          { text: line.slice(0, normalLength), bold: false },
          { text: line.slice(normalLength), bold: true },
        ] : [{ text: line, bold: false }]);
      }
    });
    const headerHeight = 60 + lines.length * 18;
    ctx.font = "11px system-ui, sans-serif";
    const footer = wrap(rangeText, width - 24, (text) => ctx.measureText(text).width);
    const left = width < 500 ? 70 : 84;
    return {
      width, height: headerHeight + plotHeight + 16 + footer.length * 17,
      lines, lineRuns, footer, headerHeight, plotHeight,
      plot: { left, top: headerHeight + 24, width: Math.max(1, width - left - 20), height: plotHeight - 64 },
    };
  }

  function paint(ctx, report) {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, report.width, report.height);
    ctx.textAlign = "left"; ctx.fillStyle = "#192c3c"; ctx.font = "600 22px system-ui, sans-serif";
    if (report.showInfo !== false) ctx.fillText("Bike-EKG", 12, 28);
    ctx.font = "12px system-ui, sans-serif"; ctx.fillStyle = "#536675";
    report.lineRuns.forEach((runs, index) => {
      let x = 12;
      for (const run of runs) {
        ctx.font = run.bold ? "700 12px system-ui, sans-serif" : "12px system-ui, sans-serif";
        ctx.fillText(run.text, x, 54 + index * 18);
        x += ctx.measureText(run.text).width;
      }
    });
    ctx.fillStyle = "#f8fafb"; ctx.fillRect(0, report.headerHeight, report.width, report.plotHeight);
    ctx.strokeStyle = "#dfe6ec"; ctx.lineWidth = 1;
    ctx.strokeRect(.5, report.headerHeight + .5, report.width - 1, report.plotHeight - 1);
    ctx.textAlign = "right"; ctx.fillStyle = "#536675"; ctx.font = "11px system-ui, sans-serif";
    report.footer.forEach((line, index) => ctx.fillText(line, report.width - 12, report.headerHeight + report.plotHeight + 18 + index * 17));
  }

  function exportLayout(report, factor) {
    // Faktor skaliert beide Kanten; vierfache Kantenlänge bedeutet 16-fache Pixelzahl.
    if (![1, 2, 4].includes(factor)) throw new Error("Bitte eine gültige Export-Auflösung wählen.");
    // Use Full-HD's pixel count as the baseline, retaining the report's aspect ratio.
    const scale = Math.sqrt((1920 * 1080) / (report.width * report.height)) * factor;
    const width = Math.round(report.width * scale), height = Math.round(report.height * scale);
    return { width, height, scale, x: 0, y: 0 };
  }

  function withoutInfo(report) {
    return {
      ...report, showInfo: false, headerHeight: 0, height: report.plotHeight,
      lines: [], lineRuns: [], footer: [],
      plot: { ...report.plot, top: report.plot.top - report.headerHeight },
    };
  }

  return { summary, wrap, layout, paint, exportLayout, withoutInfo };
})();

if (typeof module !== "undefined" && module.exports) module.exports = EkgReport;
