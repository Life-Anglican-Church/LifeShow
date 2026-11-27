(() => {
  const banner = document.querySelector("#update-banner");
  const text = document.querySelector("#update-text");
  let latest;
  let dismissed;

  function version(value) {
    const match = /^(?:lifeshow-|v)?(\d+)\.(\d+)(?:\.(\d+))?(?:-beta(?:[.-]?(\d+))?)?(?:\.apk)?$/i.exec(value || "");
    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0),
      /-beta/i.test(value) ? -1 : 0, Number(match[4] || 0)] : null;
  }

  function compare(a, b) {
    const index = a.findIndex((number, i) => number !== b[i]);
    return index < 0 ? 0 : a[index] - b[index];
  }

  window.receiveLifeShowUpdates = (installed, kind, payload) => {
    const current = version(installed);
    if (!current) return;
    let entries;
    try { entries = JSON.parse(payload); } catch (_) { return; }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (kind === "release" && (entry.draft || !entry.assets?.some(asset => /^lifeshow-.*\.apk$/i.test(asset.name)))) continue;
      if (kind === "build" && (entry.type !== "file" || !/^lifeshow-.*\.apk$/i.test(entry.name))) continue;
      const name = kind === "release" ? entry.tag_name : entry.name;
      const candidate = version(name);
      if (!candidate || compare(candidate, current) <= 0) continue;
      const difference = latest ? compare(candidate, latest.version) : 1;
      if (difference > 0 || (difference === 0 && kind === "release")) latest = { name, version: candidate, kind };
    }
    if (!latest || (dismissed && compare(latest.version, dismissed) <= 0)) return;
    const display = latest.name.replace(/^(lifeshow-|v)/i, "").replace(/\.apk$/i, "");
    text.textContent = "LifeSHOW " + display + " is available.";
    banner.hidden = false;
  };

  document.querySelector("#view-update").addEventListener("click", () => {
    if (latest) window.LifeShowNative?.openUpdate(latest.kind, latest.name);
  });
  document.querySelector("#dismiss-update").addEventListener("click", () => {
    dismissed = latest?.version;
    banner.hidden = true;
  });
  window.LifeShowNative?.checkUpdates?.();
})();
