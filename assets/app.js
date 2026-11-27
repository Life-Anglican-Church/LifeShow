const service = [
  { title: "Welcome", slides: [["Welcome", "We're glad you're here."], ["Call to Worship", "Let us worship together."]] },
  { title: "Worship Set", slides: [["Verse 1", "Morning breaks across the sky"], ["Chorus", "We lift our voices as one"], ["Verse 2", "Through every season you remain"], ["Closing Chorus", "We lift our voices as one"]] },
  { title: "Announcements", slides: [["This Week", "Community dinner · Wednesday"], ["Giving", "Thank you for your generosity"]] },
  { title: "Sermon", slides: [["A Shared Table", "Luke 14"], ["Closing Prayer", "Go in peace."]] }
];
const cues = service.flatMap((item, itemIndex) =>
  item.slides.map(([title, preview], slideIndex) => ({ itemIndex, slideIndex, title, preview })));
const tabs = {
  Playlist: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="18" r=".8"/>',
  Macros: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  Props: '<rect x="6" y="4" width="14" height="14" rx="2"/><path d="M16 21H6a3 3 0 0 1-3-3V8m7 3h6m-3-3v6"/>',
  Looks: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  Stage: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4M7 9h10m-10 4h6"/>'
};
const props = ["Welcome banner", "Lower third", "Offering QR", "Service countdown"];
const looks = ["Full Screen", "Lower Thirds", "Sermon"];
const stageLayouts = ["Lyrics + Clock", "Current + Next", "Notes + Timer"];
const state = {
  tab: "Playlist",
  logo: false,
  position: 3,
  browsing: 1,
  props: new Set(),
  look: "Full Screen",
  screens: { "Worship Stage": "Lyrics + Clock", "Lectern": "Notes + Timer" },
  screenPicker: null
};

const panel = document.querySelector("#panel");
const nav = document.querySelector("#nav");
const back = document.querySelector("#back");
const next = document.querySelector("#next");
const feedback = document.querySelector("#feedback");
let feedbackTimer;

function announce(message) {
  clearTimeout(feedbackTimer);
  feedback.textContent = message;
  feedbackTimer = setTimeout(() => { feedback.textContent = ""; }, 2200);
}

function openSlide(position) {
  state.logo = false;
  state.position = position;
  state.browsing = cues[position].itemIndex;
  render();
}

function playlist() {
  const live = cues[state.position];
  const item = service[state.browsing];
  const slides = `<section class="slide-block" aria-label="Slides for ${item.title}">
    <h3>${item.title} · tap a slide to go live</h3>
    <div class="slide-grid">${cues.map((cue, index) => {
      if (cue.itemIndex !== state.browsing) return "";
      const isLive = !state.logo && index === state.position;
      const badge = isLive ? "LIVE" : index === state.position + 1 ? "UP NEXT" : "";
      return `<button class="card row ${isLive ? "live-slide" : ""}" data-action="slide" data-value="${index}" ${isLive ? 'aria-current="true"' : ""}>
        <span>${cue.title}<small>${cue.preview}</small></span>
        <span class="badge ${isLive ? "live-badge" : ""}">${badge}</span>
      </button>`;
    }).join("")}</div>
  </section>`;
  return `<div class="rundown inline-rundown"><div class="stack">${service.map((entry, index) => {
    const selected = state.browsing === index;
    return `<button class="card row ${selected ? "selected" : ""}" data-action="browse" data-value="${index}" aria-expanded="${selected}">
      <span>${entry.title}<small>${entry.slides.length} slides</small></span>
      <span class="badge ${!state.logo && index === live.itemIndex ? "live-badge" : ""}">${!state.logo && index === live.itemIndex ? "LIVE" : selected ? "OPEN" : ""}</span>
    </button>${selected ? slides : ""}`;
  }).join("")}</div></div>`;
}

function tile(label, action, value, detail = "", pressed = null) {
  return `<button class="card" data-action="${action}" data-value="${value}" ${pressed === null ? "" : `aria-pressed="${pressed}"`}>
    ${label}${detail ? `<small>${detail}</small>` : ""}
  </button>`;
}

const macros = [
  { name: "Start Service", detail: "Welcome slide · Full Screen", run() {
    state.logo = false;
    state.position = 0;
    state.browsing = 0;
    state.look = "Full Screen";
    state.props.clear();
  } },
  { name: "Sermon Mode", detail: "Sermon look · Stage notes", run() {
    state.look = "Sermon";
    state.screens["Worship Stage"] = "Notes + Timer";
  } },
  { name: "Clear Props", detail: "Clear every active prop", run() {
    state.props.clear();
  } }
];

const views = {
  Playlist: playlist,
  Macros: () => `<div class="grid">${macros.map((macro, index) => tile(macro.name, "macro", index, macro.detail)).join("")}</div>`,
  Props: () => {
    const available = props.filter(name => !state.props.has(name));
    return `<h3>Active</h3><div class="grid">${state.props.size
      ? [...state.props].map(name => tile(name, "prop", name, "Tap to clear", true)).join("")
      : '<div class="muted">No active props</div>'}</div>
      <h3>Available</h3><div class="grid">${available.length
        ? available.map(name => tile(name, "prop", name, "Tap to show", false)).join("")
        : '<div class="muted">All props are active</div>'}</div>`;
  },
  Looks: () => `<div class="grid">${looks.map(name => tile(name, "look", name, state.look === name ? "✓ Active audience look" : "", state.look === name)).join("")}</div>`,
  Stage: () => `<div class="grid">${Object.entries(state.screens).map(([screen, layout]) => tile(screen, "screen", screen, layout, state.screenPicker === screen)).join("")}</div>
    ${state.screenPicker ? `<h3>Layout for ${state.screenPicker}</h3><div class="grid">${stageLayouts.map(layout => {
      const active = state.screens[state.screenPicker] === layout;
      return tile(layout, "layout", layout, active ? "✓ Current layout" : "", active);
    }).join("")}</div>` : ""}`
};

function render() {
  nav.querySelectorAll("button").forEach(button => {
    if (button.dataset.tab === state.tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (window.connection?.render()) return;
  const focused = panel.contains(document.activeElement) ? document.activeElement.dataset : null;
  const current = cues[state.position];
  const upcoming = cues[state.position + 1];
  panel.innerHTML = `<h2 id="heading">${state.tab}</h2>${views[state.tab]()}`;
  if (focused) {
    const replacement = [...panel.querySelectorAll("button")].find(button =>
      button.dataset.action === focused.action && button.dataset.value === focused.value);
    replacement?.focus({ preventScroll: true });
  }
  document.querySelector("#cue-label").textContent = "Current cue · Demo";
  document.querySelector("#cue-title").textContent = state.logo ? "Logo" : current.title;
  document.querySelector("#live").textContent = state.logo ? "Audience output cleared" : service[current.itemIndex].title;
  document.querySelector("#logo-action").disabled = state.logo;
  back.disabled = state.position === 0;
  next.disabled = !upcoming && !state.logo;
  const destination = upcoming && (upcoming.itemIndex === current.itemIndex
    ? upcoming.title : service[upcoming.itemIndex].title);
  next.textContent = state.logo ? "Resume current cue ›" : destination ? `Next: ${destination} ›` : "End of playlist";
}

nav.innerHTML = Object.entries(tabs).map(([tab, icon]) => `
  <button data-tab="${tab}">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon}</svg>
    <span>${tab}</span>
  </button>`).join("");
nav.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (window.connection) window.connection.closeSettings();
  state.tab = button.dataset.tab;
  panel.scrollTop = 0;
  render();
});
back.addEventListener("click", () => { if (!window.connection?.transport(-1)) openSlide(state.position - 1); });
next.addEventListener("click", () => { if (!window.connection?.transport(1)) openSlide(state.logo ? state.position : state.position + 1); });
document.querySelector("#logo-action").addEventListener("click", () => {
  if (window.connection?.logo()) return;
  state.props.clear();
  state.logo = true;
  render();
});
panel.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, value } = button.dataset;
  if (window.connection?.panelAction(action, value)) return;
  switch (action) {
    case "browse": state.browsing = Number(value); break;
    case "slide": openSlide(Number(value)); return;
    case "macro": macros[value].run(); announce(`${macros[value].name} fired`); break;
    case "prop":
      if (state.props.delete(value)) announce(`${value} cleared`);
      else { state.props.add(value); announce(`${value} shown`); }
      break;
    case "look": state.look = value; announce(`${value} applied`); break;
    case "screen": state.screenPicker = state.screenPicker === value ? null : value; break;
    case "layout": state.screens[state.screenPicker] = value; announce(`${state.screenPicker} updated`); break;
  }
  render();
});
render();
