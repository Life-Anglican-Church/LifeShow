(() => {
  const settings = document.querySelector("#settings");
  const control = document.querySelector("#control");
  const status = document.querySelector("#connection-status");
  const logo = document.querySelector("#logo-action");
  const pending = new Map();
  const freshFor = 4500;
  const liveGrace = 8000;
  let requestId = 0;
  let session = null;
  let settingsOpen = false;
  let lastAddress = "";
  let lastRemotePort = "";
  try {
    lastAddress = localStorage.getItem("address") || "";
    lastRemotePort = localStorage.getItem("remotePort") || "";
  } catch (_) { /* Settings can still be entered for this session. */ }

  const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const id = value => value?.id ?? value;
  const uuid = value => typeof id(value)?.uuid === "string" ? id(value).uuid : "";
  const name = value => typeof id(value)?.name === "string" ? id(value).name : "";
  const part = value => encodeURIComponent(value);
  const list = value => Array.isArray(value) ? value : [];
  const playlistLeaves = (entries, folder = "") => list(entries).flatMap(entry => {
    const title = name(entry);
    const label = [folder, title].filter(Boolean).join(" / ");
    if (Array.isArray(entry?.playlists)) return playlistLeaves(entry.playlists, label);
    return entry?.type === "playlist" && uuid(entry) && title ? [{ key: uuid(entry), label }] : [];
  });
  const named = value => list(value).filter(entry => uuid(entry) && name(entry));
  const equalId = (a, b) => Boolean(uuid(a)) && uuid(a).toLowerCase() === uuid(b).toLowerCase();
  const currentSession = s => session === s;
  const isFresh = s => Boolean(s.data) && performance.now() - s.verified < freshFor;
  const canSend = s => s.live && !s.busy && !s.awaitingSync && !document.hidden && !settingsOpen && !s.error && isFresh(s);
  const itemKey = item => uuid(item) || String(id(item)?.index ?? "");
  const explicitTarget = item => item?.presentation_info?.presentation_uuid || item?.target_uuid;
  const itemTarget = item => explicitTarget(item) || uuid(item);
  const sameUuid = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

  function activeRow(s) {
    const active = s.data?.active;
    if (!s.playlistId || !sameUuid(s.playlistId, uuid(active?.playlist))) return null;
    const reported = active.playlist_item?.id || active.item;
    const activeUuid = uuid(s.data?.cursor?.presentation_id);
    const candidates = s.items.filter(item => item.type !== "presentation" || !activeUuid
      || !explicitTarget(item) || sameUuid(explicitTarget(item), activeUuid));
    const byId = candidates.find(item => sameUuid(uuid(item), uuid(reported)));
    if (byId) return byId;
    const byIndex = candidates.find(item => Number.isInteger(id(reported)?.index)
      && id(item)?.index === id(reported).index && name(item) && name(item) === name(reported));
    if (byIndex) return byIndex;
    const byTarget = candidates.filter(item => item.type === "presentation"
      && sameUuid(itemTarget(item), activeUuid) && (!name(reported) || name(item) === name(reported)));
    if (byTarget.length === 1) return byTarget[0];
    const activeName = name(reported) || name(s.data?.cursor?.presentation_id);
    if (!activeUuid || !activeName) return null;
    const byName = candidates.filter(item => item.type === "presentation" && name(item) === activeName);
    return byName.length === 1 ? byName[0] : null;
  }

  function activeSlideSet(s, item) {
    if (!item || activeRow(s) !== item) return null;
    const activeId = uuid(s.data?.cursor?.presentation_id);
    const cached = s.slides.get("active:" + itemKey(item));
    if (!cached || !sameUuid(cached.presentationId, activeId)) return null;
    const info = s.data.active.playlist_item?.presentation_info || item.presentation_info;
    if (cached.arrangementId !== info?.arrangement_uuid || cached.arrangementName !== info?.arrangement_name) return null;
    return cached;
  }

  const showTitle = text => String(text || "").split(/\r?\n/).find(line => line.trim())?.trim() || "";

  window.receiveLifeShow = (number, code, body) => {
    const callback = pending.get(number);
    if (callback) callback(code, body);
  };

  function request(s, path, parse = true, allowEmpty = false, remoteLogo = false) {
    return new Promise((resolve, reject) => {
      if (!window.LifeShowNative) {
        reject(new Error("Connection mode is available in the Android app."));
        return;
      }
      const number = ++requestId;
      const timeout = setTimeout(() => {
        pending.delete(number);
        reject(new Error("Request timed out."));
      }, 4200);
      pending.set(number, (code, body) => {
        pending.delete(number);
        clearTimeout(timeout);
        if (code === 404 && allowEmpty) { resolve({}); return; }
        if (code < 200 || code >= 300) {
          const error = new Error(remoteLogo ? body || "PP7 Remote connection failed."
            : code ? "ProPresenter returned HTTP " + code + "." : body || "Connection failed.");
          error.beforeSend = remoteLogo && code === 422;
          reject(error);
          return;
        }
        try { resolve(parse ? JSON.parse(body) : undefined); }
        catch (_) { reject(new Error("ProPresenter returned an unexpected response.")); }
      });
      try {
        if (remoteLogo) window.LifeShowNative.clearToLogo(number, s.address, s.remotePort, s.remotePassword);
        else window.LifeShowNative.get(number, s.address, path);
      }
      catch (error) {
        clearTimeout(timeout);
        pending.delete(number);
        reject(error);
      }
    });
  }

  async function core(s) {
    const [playlists, position, slide] = await Promise.all([
      request(s, "/v1/playlist/active", true, true),
      request(s, "/v1/presentation/slide_index", true, true),
      request(s, "/v1/status/slide", true, true)
    ]);
    if ([playlists, position, slide].some(value => !value || Array.isArray(value) || typeof value !== "object")) {
      throw new Error("ProPresenter returned an unexpected show state.");
    }
    const active = playlists.presentation || {};
    const cursor = position.presentation_index || null;
    return { active, cursor, slide };
  }

  function presentationFingerprint(data) {
    const item = data.active.playlist_item || data.active.item;
    return JSON.stringify([
      uuid(data.active.playlist), itemKey(item), uuid(data.cursor?.presentation_id),
      item?.presentation_info?.arrangement_uuid, item?.presentation_info?.arrangement_name
    ]);
  }

  function fingerprint(data) {
    return JSON.stringify([
      uuid(data.active.playlist), itemKey(data.active.playlist_item || data.active.item),
      data.active.playlist_item?.presentation_info?.arrangement_uuid, uuid(data.cursor?.presentation_id),
      data.cursor?.index ?? null, data.slide?.current?.uuid ?? null, data.slide?.current?.text ?? null,
      data.slide?.next?.uuid ?? null, data.slide?.next?.text ?? null
    ]);
  }

  async function optional(s, path) {
    try { return await request(s, path); }
    catch (_) { return null; }
  }

  async function tick(s) {
    if (!currentSession(s) || s.polling || s.busy || document.hidden) return;
    s.polling = true;
    try {
      if (!s.host) {
        const host = await request(s, "/version");
        if (!currentSession(s)) return;
        if (!host || host.api_version == null) throw new Error("This host did not identify itself as a ProPresenter API.");
        s.host = host;
      }
      const data = await core(s);
      if (!currentSession(s) || s.busy) return;
      s.data = data;
      s.verified = performance.now();
      s.awaitingSync = false;
      s.error = "";
      if (s.notice === "Command accepted.") s.notice = "";
      repaint();
      await refreshPlaylist(s);
      if (!currentSession(s) || s.busy) return;
      await Promise.all([refreshTab(s), refreshSlides(s), refreshCatalog(s)]);
    } catch (error) {
      if (currentSession(s)) {
        s.error = "Status check failed · " + error.message;
      }
    } finally {
      s.polling = false;
      if (currentSession(s)) {
        repaint();
        schedule(s);
      }
    }
  }

  async function refreshCatalog(s) {
    if (state.tab !== "Playlist" || performance.now() - (s.catalogAt ?? -Infinity) < 5500) return;
    s.catalogAt = performance.now();
    const entries = await optional(s, "/v1/playlists");
    if (currentSession(s) && Array.isArray(entries)) s.catalog = playlistLeaves(entries);
  }

  async function refreshPlaylist(s) {
    const playlistId = s.selectedPlaylist || uuid(s.data?.active.playlist);
    if (playlistId !== s.playlistId) {
      s.playlistId = playlistId;
      s.items = [];
      s.browsing = null;
      s.slides.clear();
      s.slideStatus.clear();
      s.playlistAt = 0;
    }
    if (!playlistId || (s.playlistAt && performance.now() - s.playlistAt < 5500)) return;
    const detail = await optional(s, "/v1/playlist/" + part(playlistId));
    if (!currentSession(s) || s.busy || s.playlistId !== playlistId) return;
    s.items = list(detail?.items).filter(item => !item.is_hidden && item.id);
    s.playlistAt = detail ? performance.now() : 0;
    if (!s.items.some(item => itemKey(item) === s.browsing)) {
      const preferred = activeRow(s) || s.items.find(item => item.type === "presentation");
      s.browsing = preferred ? itemKey(preferred) : null;
    }
  }

  function schedule(s) {
    clearTimeout(s.timer);
    if (!document.hidden) s.timer = setTimeout(() => tick(s), 1050);
  }

  async function refreshSlides(s) {
    if (state.tab !== "Playlist") return;
    const item = s.items.find(entry => itemKey(entry) === s.browsing);
    if (item?.type !== "presentation") return;
    const playlistId = s.playlistId;
    const active = activeRow(s) === item;
    const cursorId = uuid(s.data?.cursor?.presentation_id);
    const target = active && cursorId ? cursorId : itemTarget(item);
    if (!target) return;

    const info = (active ? s.data.active.playlist_item?.presentation_info : null) || item.presentation_info;
    const arrangementId = info?.arrangement_uuid;
    const arrangementName = info?.arrangement_name;
    const key = (active ? "active:" : "browse:") + itemKey(item);
    const cached = s.slides.get(key);
    if (cached && sameUuid(cached.presentationId, target) && cached.arrangementId === arrangementId
        && cached.arrangementName === arrangementName && performance.now() - cached.at < 5000) return;

    let response = active ? await optional(s, "/v1/presentation/active") : null;
    let presentation = response?.presentation ?? response;
    let fromActive = active;
    if (!Array.isArray(presentation?.groups) || (uuid(presentation) && !sameUuid(uuid(presentation), target))) {
      fromActive = false;
      response = await optional(s, "/v1/presentation/" + part(target));
      presentation = response?.presentation ?? response;
    }
    if (!currentSession(s) || s.busy || s.playlistId !== playlistId
        || (active && (!sameUuid(cursorId, uuid(s.data?.cursor?.presentation_id))
          || itemKey(activeRow(s)) !== itemKey(item)))) return;
    if (!Array.isArray(presentation?.groups) || (uuid(presentation) && !sameUuid(uuid(presentation), target))) {
      s.slides.delete(key);
      s.slideStatus.set(itemKey(item), "ProPresenter did not return slides for this item.");
      return;
    }
    const groups = presentation.groups;
    const arrangement = list(presentation.arrangements).find(entry =>
      sameUuid(uuid(entry), arrangementId) || (!arrangementId && arrangementName && name(entry) === arrangementName));
    const ordered = list(arrangement?.groups).map(groupId => groups.find(group => sameUuid(uuid(group), groupId)));
    const useArrangement = ordered.length > 0 && ordered.every(Boolean);
    const master = (!arrangementId && !arrangementName) || String(arrangementName || "").trim().toLowerCase() === "master";
    const nativeOrder = fromActive && !list(presentation.arrangements).length
      && !list(groups).some(group => list(group.slides).length === 0);
    const slides = (useArrangement ? ordered : groups).flatMap(group => list(group.slides).filter(Boolean).map(slide => ({
      enabled: slide.enabled !== false, title: slide.label || group.name || showTitle(slide.text) || "Slide",
      preview: showTitle(slide.text)
    }))).map((slide, index) => ({ ...slide, index }));
    s.slideStatus.set(itemKey(item), slides.length ? "" : "No slides were returned for this item.");
    s.slides.set(key, { at: performance.now(), presentationId: uuid(presentation) || target,
      arrangementId, arrangementName, slides, safeOrder: useArrangement || master || nativeOrder });
  }

  async function refreshTab(s) {
    const now = performance.now();
    const tab = state.tab;
    const paths = {
      macros: "/v1/macros", props: "/v1/props", looks: "/v1/looks", look: "/v1/look/current",
      screens: "/v1/stage/screens", layouts: "/v1/stage/layouts", layoutMap: "/v1/stage/layout_map"
    };
    const forTab = { Playlist: [], Macros: [], Props: ["props"], Looks: ["looks", "look"], Stage: ["screens", "layouts", "layoutMap"] };
    const keys = ["macros", ...forTab[tab]].filter(key => now - (s.infoAt[key] ?? -Infinity) > (key === "macros" ? 5000 : 1700));
    // Fetch one option view at a time to keep show-state reads ahead of ancillary data.
    if (keys.length > 2 && keys[0] === "macros" && s.infoAt.macros !== undefined) keys.shift();
    await Promise.all(keys.map(async key => {
      const value = await optional(s, paths[key]);
      if (currentSession(s) && !s.busy) {
        s.info[key] = value;
        s.infoAt[key] = now;
      }
    }));
  }

  function repaint() {
    if (!settingsOpen) render();
    else renderChrome();
  }

  function disarm(s) {
    s.live = false;
    s.awaitingSync = false;
    s.armGeneration++;
    if (s.logoPending) window.LifeShowNative?.cancelLogo?.();
  }

  async function send(s, path, verify = false, playlistItem = null, remoteLogo = false) {
    if (!canSend(s)) return;
    s.busy = true;
    s.logoPending = remoteLogo;
    s.notice = "";
    const compare = verify === "presentation" ? presentationFingerprint : fingerprint;
    const expected = compare(s.data);
    const targetPlaylist = s.playlistId;
    const arm = s.armGeneration;
    let dispatched = false;
    repaint();
    try {
      if (verify) {
        const latest = await core(s);
        if (!currentSession(s) || arm !== s.armGeneration || !s.live || document.hidden) return;
        let sameItem = true;
        if (playlistItem) {
          const detail = await request(s, "/v1/playlist/" + part(targetPlaylist));
          const item = list(detail.items).find(entry => id(entry)?.index === id(playlistItem).index);
          sameItem = Boolean(item) && itemKey(item) === itemKey(playlistItem) && !item.is_hidden;
        }
        if (!currentSession(s) || arm !== s.armGeneration || !s.live || document.hidden) return;
        if (compare(latest) !== expected || !sameItem) {
          s.awaitingSync = true;
          s.notice = "Cue or playlist changed · review it and tap again.";
          return;
        }
      }
      if (!currentSession(s) || arm !== s.armGeneration || !s.live || document.hidden) return;
      dispatched = true;
      await request(s, path, false, false, remoteLogo);
      if (currentSession(s)) {
        s.notice = remoteLogo ? "Clear to Logo sent · confirm the output at the booth." : "Command accepted.";
        s.awaitingSync = true;
      }
    } catch (error) {
      if (currentSession(s)) {
        if (dispatched) {
          disarm(s);
          s.verified = -Infinity;
          s.notice = error.beforeSend ? error.message : "Command outcome uncertain · check the booth before trying again.";
        } else {
          s.error = "Cue check failed · refreshing from ProPresenter.";
        }
      }
    } finally {
      if (currentSession(s)) {
        s.busy = false;
        s.logoPending = false;
        s.infoAt = {};
        s.playlistAt = 0;
        repaint();
        tick(s);
      }
    }
  }

  function renderChrome() {
    const s = session;
    settings.textContent = settingsOpen ? "Close" : s ? "Connection" : "Connect";
    settings.setAttribute("aria-expanded", String(settingsOpen));
    control.hidden = !s || settingsOpen;
    status.hidden = !s;
    if (!s) return;
    const fresh = isFresh(s);
    if (s.live && !s.busy && performance.now() - s.verified >= liveGrace) {
      disarm(s);
      s.notice ||= "Live disarmed after losing show state.";
    }
    control.textContent = s.live ? "Switch to Monitor" : "Enable Live";
    control.classList.toggle("is-live", s.live);
    control.disabled = !s.live && (!fresh || Boolean(s.error) || s.busy);
    const connectionLabel = !s.data ? "Connecting" : s.live ? (!fresh || s.error ? "Live paused" : "Live control") : !fresh || s.error ? "Reconnecting" : "Monitor";
    const detail = s.busy ? "Sending command…" : s.awaitingSync && fresh ? "Refreshing show state…" : [s.error, s.notice].filter(Boolean).join(" · ");
    const message = connectionLabel + (detail ? " · " + detail : "");
    if (status.textContent !== message) status.textContent = message;
  }

  function row(label, action, value, detail = "", badge = "", cls = "", disabled = false) {
    return `<button type="button" class="card row ${cls}" data-action="${action}" data-value="${escape(value)}" ${disabled ? "disabled" : ""}>
      <span>${escape(label)}${detail ? `<small>${escape(detail)}</small>` : ""}</span>${badge ? `<span class="badge">${escape(badge)}</span>` : ""}</button>`;
  }

  function playlist(s) {
    const selected = s.items.find(item => itemKey(item) === s.browsing);
    const liveItem = activeRow(s);
    const activeKey = itemKey(liveItem);
    const isSelectedLive = Boolean(selected && selected === liveItem);
    const canTriggerItem = selected && Number.isInteger(id(selected)?.index) && ["presentation", "audio", "media", "livevideo"].includes(selected.type);
    const activeSlides = isSelectedLive && s.slides.get("active:" + s.browsing);
    const canTriggerSlide = Boolean(activeSlideSet(s, selected)?.safeOrder);
    const slides = activeSlides?.slides || s.slides.get("browse:" + s.browsing)?.slides || [];
    const currentIndex = s.data?.cursor?.index;
    const selectedPanel = !selected ? "" : `<section class="slide-block stack"><h3>${escape(name(selected))}</h3>
      ${canTriggerItem ? row("Start playlist item", "item", itemKey(selected), "", "", "", !canSend(s)) : ""}
      <div class="slide-grid">${slides.map(slide => {
        const current = activeSlides && slide.index === currentIndex;
        return row(slide.title, "slide", slide.index, slide.preview === slide.title ? "" : slide.preview,
          current ? "LIVE" : "", current ? "live-slide" : "", !canSend(s) || !canTriggerSlide || !slide.enabled);
      }).join("")}</div>
      ${selected.type === "presentation" && !slides.length ? `<p class="muted">${escape(s.slideStatus.get(s.browsing) || "Loading slides…")}</p>` : ""}
      ${slides.length && isSelectedLive && !canTriggerSlide ? '<p class="muted">Slide order could not be verified for live selection.</p>' : ""}
      ${slides.length && !isSelectedLive ? '<p class="muted">Start this item to take its individual slides live.</p>' : ""}
      </section>`;
    const picker = `<label class="playlist-picker">Browse playlist<select id="playlist-picker">
      <option value="">Follow active playlist</option>
      ${s.catalog.map(entry => `<option value="${escape(entry.key)}" ${entry.key === s.selectedPlaylist ? "selected" : ""}>${escape(entry.label)}</option>`).join("")}
      ${s.selectedPlaylist && !s.catalog.some(entry => entry.key === s.selectedPlaylist)
        ? `<option value="${escape(s.selectedPlaylist)}" selected>Selected playlist · unavailable</option>` : ""}
      </select></label>`;
    const title = s.selectedPlaylist ? s.catalog.find(entry => entry.key === s.selectedPlaylist)?.label || "Selected playlist"
      : name(s.data?.active.playlist) || "Active playlist";
    return `${picker}<div class="rundown inline-rundown"><section class="stack"><h3>${escape(title)}</h3>
      ${s.items.length ? s.items.map(item => {
        const key = itemKey(item);
        if (item.type === "header") return `<h3>${escape(name(item))}</h3>`;
        return row(name(item) || item.type, "browse", key, "", key === activeKey ? "LIVE" : "", key === s.browsing ? "selected" : "")
          + (key === s.browsing ? selectedPanel : "");
      }).join("") : s.selectedPlaylist ? '<p class="muted">No playable items loaded for this playlist.</p>' : '<p class="muted">Select a playlist to browse, or trigger a cue at the booth to follow it.</p>'}
      </section></div>`;
  }

  function options(s) {
    const info = s.info;
    const result = (key, listHtml) => listHtml || (info[key] === null
      ? '<p class="muted">This view is unavailable on the connected host.</p>'
      : '<p class="muted">No items available.</p>');
    const grid = html => `<div class="grid">${html}</div>`;
    const locked = !canSend(s);
    if (state.tab === "Macros") return grid(result("macros", named(info.macros).map(entry =>
      row(name(entry), "macro", uuid(entry), "", "", "", locked)).join("")));
    if (state.tab === "Props") return grid(result("props", named(info.props).map(entry =>
      row(name(entry), entry.is_active ? "clear-prop" : "show-prop", uuid(entry), entry.is_active ? "Tap to clear" : "Tap to show",
        entry.is_active ? "ACTIVE" : "", entry.is_active ? "selected" : "", locked || performance.now() - (s.infoAt.props ?? -Infinity) > freshFor || typeof entry.is_active !== "boolean")).join("")));
    if (state.tab === "Looks") return grid(result("looks", named(info.looks).map(entry => {
      const active = equalId(entry, info.look) || (name(info.look) && name(entry) === name(info.look));
      return row(name(entry), "look", uuid(entry), "", active ? "ACTIVE" : "", active ? "selected" : "", locked);
    }).join("")));
    const mapping = screen => list(info.layoutMap).find(entry => equalId(entry.screen, screen))?.layout;
    const selected = named(info.screens).find(screen => uuid(screen) === s.screen);
    return grid(result("screens", named(info.screens).map(screen =>
      row(name(screen), "screen", uuid(screen), name(mapping(screen)) || "Layout unavailable", "", uuid(screen) === s.screen ? "selected" : "")).join("")))
      + (selected ? `<h3>Layout for ${escape(name(selected))}</h3>` + grid(result("layouts", named(info.layouts).map(layout =>
        row(name(layout), "layout", uuid(layout), "", equalId(layout, mapping(selected)) ? "CURRENT" : "", "", locked)).join(""))) : "");
  }

  function renderConnected(s) {
    const data = s.data;
    const activeCue = data?.slide?.current;
    document.querySelector("#cue-label").textContent = isFresh(s) ? "Current cue" : data ? "Last known cue" : "Current cue";
    document.querySelector("#cue-title").textContent = showTitle(activeCue?.text) || (activeCue?.uuid ? "Slide on air" : "No slide reported");
    document.querySelector("#live").textContent = name(data?.active.item) || name(data?.cursor?.presentation_id) || s.address;
    const hasCue = Boolean(data?.cursor && Number.isInteger(data.cursor.index) && uuid(data.cursor.presentation_id));
    back.disabled = next.disabled = !canSend(s) || !hasCue;
    const following = showTitle(data?.slide?.next?.text);
    next.textContent = following ? "Next · " + (following.length > 38 ? following.slice(0, 37) + "…" : following) + " ›" : "Next ›";
    logo.disabled = !canSend(s) || !s.remotePassword;
    logo.title = s.remotePassword ? "Show the logo configured in ProPresenter 7."
      : "Enter the PP7 Remote Controller password in Connection.";
    const target = panel.contains(document.activeElement) ? document.activeElement.dataset : null;
    const html = `<h2 id="heading">${state.tab}</h2>` + (state.tab === "Playlist" ? playlist(s) : options(s));
    if (s.panelMarkup !== html || panel.querySelector("#heading")?.textContent !== state.tab) {
      s.panelMarkup = html;
      panel.innerHTML = html;
      if (target) [...panel.querySelectorAll("button")].find(button => !button.disabled
        && button.dataset.action === target.action && button.dataset.value === target.value)?.focus({preventScroll:true});
    }
  }

  function showSettings() {
    settingsOpen = true;
    if (session) {
      disarm(session);
      session.panelMarkup = null;
    }
    renderChrome();
    back.disabled = next.disabled = logo.disabled = true;
    panel.innerHTML = `<h2 id="heading">ProPresenter connection</h2>
      <form class="settings-form">
        <label>Host and API port<input name="address" type="text" required autocapitalize="off" spellcheck="false" placeholder="192.168.1.20:50001" value="${escape(lastAddress)}"></label>
        <div class="muted">Use the address and port shown in ProPresenter’s Network settings. Connect on the same local network.</div>
        <label>PP7 Remote port<input name="remotePort" type="number" inputmode="numeric" min="1" max="65535" placeholder="Same as API port" value="${escape(lastRemotePort)}"></label>
        <label>PP7 Remote Controller password<input name="remotePassword" type="password" autocomplete="off"></label>
        <div class="muted">Clear to Logo uses ProPresenter Remote. Enable its Controller option in ProPresenter’s Network settings. The password is kept only for this session.</div>
        <div class="settings-error muted" role="alert"></div>
        <button class="card" type="submit">Connect in Monitor</button>
        <button class="card" id="demo" type="button">Use offline Demo</button>
      </form>`;
    panel.querySelector("[name=remotePassword]").value = session?.remotePassword || "";
    panel.querySelector("form").addEventListener("submit", event => {
      event.preventDefault();
      const form = event.currentTarget;
      let apiPort;
      try {
        const input = form.elements.address.value.trim();
        const url = new URL(input.includes("://") ? input : "http://" + input);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        lastAddress = url.origin;
        apiPort = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      } catch (_) {
        panel.querySelector(".settings-error").textContent = "Enter a host and API port, such as 192.168.1.20:50001.";
        return;
      }
      lastRemotePort = form.elements.remotePort.value;
      const remotePort = Number(lastRemotePort) || apiPort;
      const remotePassword = form.elements.remotePassword.value;
      try { localStorage.setItem("address", lastAddress); localStorage.setItem("remotePort", lastRemotePort); } catch (_) {}
      stop();
      session = {
        address: lastAddress, remotePort, remotePassword, items: [], browsing: null, slides: new Map(), slideStatus: new Map(),
        catalog: [], selectedPlaylist: "",
        info: {}, infoAt: {}, verified: -Infinity, playlistAt: 0, live: false, busy: false,
        armGeneration: 0, notice: "", polling: false, awaitingSync: false
      };
      settingsOpen = false;
      state.tab = "Playlist";
      render();
      tick(session);
    });
    panel.querySelector("#demo").onclick = () => {
      stop();
      settingsOpen = false;
      state.tab = "Playlist";
      render();
    };
  }

  function stop() {
    if (!session) return;
    disarm(session);
    clearTimeout(session.timer);
    session = null;
  }

  settings.addEventListener("click", () => {
    if (settingsOpen) {
      settingsOpen = false;
      render();
    } else showSettings();
  });
  control.addEventListener("click", () => {
    if (!session || settingsOpen) return;
    if (session.live) disarm(session);
    else if (isFresh(session) && !session.error && !session.busy && !document.hidden) {
      session.live = true;
      session.notice = "";
    }
    repaint();
  });
  window.pauseLifeShow = () => {
    if (!session) return;
    disarm(session);
    session.verified = -Infinity;
    repaint();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) window.pauseLifeShow();
    else if (session) tick(session);
  });
  setInterval(() => {
    if (session?.live && !session.busy && !isFresh(session)) {
      repaint();
    }
  }, 500);

  panel.addEventListener("change", async event => {
    const s = session;
    if (!s || event.target.id !== "playlist-picker") return;
    s.selectedPlaylist = event.target.value;
    const loading = refreshPlaylist(s);
    repaint();
    await loading;
    if (!currentSession(s)) return;
    await refreshSlides(s);
    if (currentSession(s)) repaint();
  });

  window.connection = {
    render() {
      renderChrome();
      if (settingsOpen) return true;
      if (!session) return false;
      renderConnected(session);
      return true;
    },
    closeSettings() {
      settingsOpen = false;
      if (session) session.panelMarkup = null;
    },
    transport(direction) {
      if (!session) return settingsOpen;
      if (canSend(session) && session.data?.cursor && !next.disabled) {
        send(session, "/v1/trigger/" + (direction > 0 ? "next" : "previous"), true);
      }
      return true;
    },
    logo() {
      if (!session) return settingsOpen;
      if (session.remotePassword) send(session, null, false, null, true);
      return true;
    },
    actionContext() {
      return session ? [session, session.armGeneration] : null;
    },
    panelAction(action, value) {
      const s = session;
      if (!s) return settingsOpen;
      if (action === "browse" || action === "screen") {
        if (action === "browse") s.browsing = value;
        else s.screen = value;
        render();
        if (action === "browse") refreshSlides(s).then(() => { if (currentSession(s)) repaint(); });
        return true;
      }
      if (!canSend(s)) return true;
      const endpoints = {
        macro: "/v1/macro/" + part(value) + "/trigger",
        "clear-prop": "/v1/prop/" + part(value) + "/clear",
        "show-prop": "/v1/prop/" + part(value) + "/trigger",
        look: "/v1/look/" + part(value) + "/trigger",
        layout: "/v1/stage/screen/" + part(s.screen) + "/layout/" + part(value)
      };
      if (action === "item") {
        const item = s.items.find(entry => itemKey(entry) === value);
        if (item && Number.isInteger(id(item).index) && s.playlistId) {
          send(s, "/v1/playlist/" + part(s.playlistId) + "/" + id(item).index + "/trigger", true, item);
        }
      } else if (action === "slide") {
        const index = Number(value);
        const active = activeRow(s);
        const cached = activeSlideSet(s, active);
        if (active && s.browsing === itemKey(active) && cached?.safeOrder && cached.slides[index]?.enabled) {
          send(s, "/v1/presentation/active/" + index + "/trigger", "presentation");
        }
      } else if (Object.prototype.hasOwnProperty.call(endpoints, action)) {
        if (action === "show-prop" || action === "clear-prop") {
          const prop = named(s.info.props).find(entry => uuid(entry) === value);
          if (!prop || prop.is_active !== (action === "clear-prop")) {
            announce("Prop state changed. Review it and tap again.");
            return true;
          }
        }
        send(s, endpoints[action]);
      }
      return true;
    }
  };
  render();
})();
