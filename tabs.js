"use strict";

// Reiter blenden Panels nur aus: Verbindungen, Worker und Eingaben bleiben erhalten.
// Roving tabindex: genau der aktive Reiter ist regulär per Tab erreichbar.

(() => {
  const tabs = Array.from(document.querySelectorAll('.app-tabs [role="tab"]'));

  function selectTab(selected) {
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      let index = tabs.indexOf(tab);
      switch (event.key) {
        case "ArrowRight": index = (index + 1) % tabs.length; break;
        case "ArrowLeft": index = (index + tabs.length - 1) % tabs.length; break;
        case "Home": index = 0; break;
        case "End": index = tabs.length - 1; break;
        default: return;
      }
      event.preventDefault();
      selectTab(tabs[index]);
      tabs[index].focus();
    });
  }
})();
