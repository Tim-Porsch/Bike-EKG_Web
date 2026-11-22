"use strict";

// Rechenintensive Filterung und neuer Min-/Max-Index außerhalb des UI-Threads.
// Nur Ergebnisarrays übertragen; die Originalarrays im Hauptthread bleiben erhalten.

importScripts("visualization-data.js", "visualization-filters.js");
self.onmessage = ({ data: { values, gaps, rate, settings } }) => {
  try {
    const filtered = EkgFilters.apply(values, gaps, rate, settings);
    const index = EkgCsv.buildIndex(filtered, gaps);
    self.postMessage({ values: filtered, index },
      [filtered.buffer, index.minima.buffer, index.maxima.buffer, index.gapPrefix.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
