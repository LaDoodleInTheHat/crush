// crush browser UI.
//
// Every tab is an <iframe> pointed at a proxy address (/p/https/site/...).
// Those frames live on the same origin as this page, so we can look straight
// into them to read their real URL, title and favicon.

const $ = (id) => document.getElementById(id);
const ui = {
  tabs: $('tabs'),
  views: $('views'),
  newtab: $('newtab'),
  omnibox: $('omnibox'),
  address: $('address'),
  back: $('back'),
  forward: $('forward'),
  reload: $('reload'),
  popout: $('popout'),
  progress: $('progress'),
  search: $('search'),
  searchInput: $('search-input'),
  engine: $('engine'),
  shortcuts: $('shortcuts'),
};

// inject.js looks for this to know it's running inside our UI.
window.__crushBrowser = true;

const SHORTCUTS = [
  ['Wikipedia', 'https://en.wikipedia.org/'],
  ['Hacker News', 'https://news.ycombinator.com/'],
  ['Reddit', 'https://old.reddit.com/'],
  ['GitHub', 'https://github.com/'],
  ['MDN', 'https://developer.mozilla.org/'],
];

const FRAME_SANDBOX = [
  'allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-modals', 'allow-downloads',
  'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-pointer-lock', 'allow-presentation',
  // Deliberately missing: allow-top-navigation. Pages that try to "break out
  // of frames" (top.location = ...) can't replace this UI.
].join(' ');

// ------------------------------------------------------------ helpers

const toProxy = (url) => {
  const u = new URL(url);
  return `/p/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
};

function fromProxy(path) {
  const m = /^\/p\/(https?)\/([^/?#]+)(.*)$/.exec(path);
  if (!m) return null;
  try {
    return new URL(`${m[1]}://${m[2]}${m[3] || '/'}`);
  } catch {
    return null;
  }
}

/** What the user typed -> a URL to visit (an address, or a search). */
function parseInput(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#]|$)/i.test(t)) return `https://${t}`;
  return ui.engine.value.replace('%s', encodeURIComponent(t));
}

// localStorage can be missing or throw (private mode); the UI works without it.
const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

/** A site icon, falling back to its first letter if the image won't load. */
function siteIcon(src, label) {
  const letter = () => {
    const span = document.createElement('span');
    span.className = 'tab-icon fallback';
    span.textContent = (label || '?').trim().charAt(0) || '?';
    return span;
  };
  if (!src) return letter();
  const img = new Image();
  img.className = 'tab-icon';
  img.alt = '';
  img.onerror = () => img.replaceWith(letter());
  img.src = src;
  return img;
}

// ------------------------------------------------------------ tabs
//
// Why each tab keeps its own history list: all iframes on a page share ONE
// session history with the top window. Calling history.back() inside tab A
// can rewind tab B if B navigated more recently. So we track history per tab
// ourselves and use location.replace(), which adds no entries.

const tabs = [];
let current = null;
let nextId = 1;

function createTab(url, { focus = true, lazy = false, after = null } = {}) {
  const tab = {
    id: nextId++,
    url: '',
    title: 'New tab',
    icon: null,
    history: [],
    index: -1,
    frame: null,
    pending: false, // we started a navigation and are waiting for it to land
    lazyUrl: lazy ? url : null, // restored tabs don't load until you open them
  };
  tab.el = tabElement(tab);

  const at = after ? tabs.indexOf(after) + 1 : tabs.length;
  tabs.splice(at, 0, tab);
  ui.tabs.insertBefore(tab.el, tabs[at + 1]?.el ?? null);

  if (lazy) {
    tab.url = url;
    tab.title = new URL(url).host;
  }
  if (focus) selectTab(tab);
  if (url && !lazy) navigate(tab, url);
  render(tab);
  save();
  return tab;
}

function tabElement(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.innerHTML = `
    <span class="icon-slot" style="display:contents"></span>
    <span class="tab-title"></span>
    <button class="tab-close" title="Close tab (Alt+W)" aria-label="Close tab">
      <svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>
    </button>`;
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.tab-close')) selectTab(tab);
  });
  el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(tab));
  el.querySelector('.tab-close').addEventListener('click', () => closeTab(tab));
  return el;
}

function selectTab(tab) {
  current = tab;
  for (const t of tabs) {
    t.el.setAttribute('aria-selected', String(t === tab));
    if (t.frame) t.frame.hidden = t !== tab;
  }
  if (tab.lazyUrl) {
    const url = tab.lazyUrl;
    tab.lazyUrl = null;
    navigate(tab, url);
  }
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderToolbar();
  if (!tab.url) ui.searchInput.focus();
  save();
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  tabs.splice(i, 1);
  tab.el.remove();
  tab.frame?.remove();
  if (!tabs.length) createTab();
  else if (tab === current) selectTab(tabs[Math.min(i, tabs.length - 1)]);
  save();
}

// ------------------------------------------------------------ navigation

function makeFrame(tab) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', FRAME_SANDBOX);
  frame.allow = 'fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture';
  frame.hidden = tab !== current;
  frame.addEventListener('load', () => {
    setLoading(tab, false);
    sync(tab, { landed: true });
  });
  ui.views.append(frame);
  return frame;
}

/** Visit a new URL in a tab (adds a history entry). */
function navigate(tab, url) {
  tab.history = tab.history.slice(0, tab.index + 1);
  tab.history.push(url);
  tab.index++;
  show(tab, url);
}

/** Back/forward: move along this tab's own history list. */
function go(tab, step) {
  const i = tab.index + step;
  if (i < 0 || i >= tab.history.length) return;
  tab.index = i;
  show(tab, tab.history[i]);
}

/** Point the tab's frame at a URL without touching its history list. */
function show(tab, url) {
  tab.frame ??= makeFrame(tab);
  tab.url = url;
  tab.pending = true;
  setLoading(tab, true);
  const dest = toProxy(url);
  try {
    tab.frame.contentWindow.location.replace(dest);
  } catch {
    tab.frame.src = dest;
  }
  render(tab);
}

/**
 * Look inside a tab's frame and update our idea of where it is. Runs when the
 * frame finishes loading and whenever inject.js reports a change (SPA routing,
 * new title...).
 */
function sync(tab, { landed = false } = {}) {
  const ours = tab.pending && landed; // the navigation we started just finished
  if (landed) tab.pending = false;

  let loc, doc;
  try {
    loc = tab.frame.contentWindow.location;
    doc = tab.frame.contentDocument;
    void loc.href; // throws if the frame went to a real, non-proxied site
  } catch {
    tab.title = 'Outside the proxy';
    tab.icon = null;
    return render(tab);
  }
  const real = fromProxy(loc.pathname + loc.search + loc.hash);
  if (!real) return; // about:blank, or one of our own pages (login, errors)

  const url = real.href;
  if (url !== tab.history[tab.index]) {
    if (ours) tab.history[tab.index] = url; // ours, after any redirects
    else if (url === tab.history[tab.index - 1]) tab.index--; // the browser's own back button
    else if (url === tab.history[tab.index + 1]) tab.index++; // ...or forward
    else {
      // the page navigated itself: link click, form, pushState
      tab.history = tab.history.slice(0, tab.index + 1);
      tab.history.push(url);
      tab.index++;
    }
  }
  tab.url = url;
  tab.title = doc?.title?.trim() || real.host;
  const iconLink = doc?.querySelector('link[rel~="icon" i]');
  tab.icon = iconLink?.href || `/p/${real.protocol.slice(0, -1)}/${real.host}/favicon.ico`;
  render(tab);
  save();
}

// Messages from inject.js inside the frames.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data?.crush) return;
  const tab = tabs.find((t) => t.frame && isInside(e.source, t.frame.contentWindow));
  if (!tab) return;

  if (e.data.crush === 'open') createTab(e.data.url, { after: tab });
  // Ignore chatter from the old page while our own navigation is still in flight.
  if (e.data.crush === 'changed' && e.source === tab.frame.contentWindow && !tab.pending) sync(tab);
  if (e.data.crush === 'leaving' && e.source === tab.frame.contentWindow) setLoading(tab, true);
});

/** Is `win` this frame's window, or a frame nested anywhere inside it? */
function isInside(win, frameWindow) {
  for (let w = win; w; w = w.parent === w ? null : w.parent) {
    if (w === frameWindow) return true;
  }
  return false;
}

// ------------------------------------------------------------ rendering

function render(tab) {
  tab.el.querySelector('.tab-title').textContent = tab.title;
  tab.el.title = tab.url ? `${tab.title}\n${tab.url}` : tab.title;
  const slot = tab.el.querySelector('.icon-slot');
  if (slot.dataset.src !== (tab.icon ?? '')) {
    slot.dataset.src = tab.icon ?? '';
    slot.replaceChildren(siteIcon(tab.icon, tab.title));
  }
  if (tab === current) renderToolbar();
}

function renderToolbar() {
  const tab = current;
  ui.back.disabled = tab.index <= 0;
  ui.forward.disabled = tab.index >= tab.history.length - 1;
  ui.popout.disabled = !tab.url;
  ui.newtab.hidden = Boolean(tab.url);
  if (document.activeElement !== ui.address) ui.address.value = tab.url;
  ui.progress.className = `progress ${tab.loading ? 'loading' : 'done'}`;
  document.title = tab.url ? `${tab.title} - crush` : 'crush';
}

function setLoading(tab, loading) {
  tab.loading = loading;
  clearTimeout(tab.loadingTimer);
  // Downloads never fire "load"; don't spin forever.
  if (loading) tab.loadingTimer = setTimeout(() => setLoading(tab, false), 20_000);
  if (tab === current) renderToolbar();
}

function save() {
  store.set('crush:tabs', {
    urls: tabs.map((t) => t.url),
    active: tabs.indexOf(current),
  });
}

// ------------------------------------------------------------ controls

ui.omnibox.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = parseInput(ui.address.value);
  if (!url) return;
  ui.address.blur();
  navigate(current, url);
});
ui.address.addEventListener('focus', () => ui.address.select());
ui.address.addEventListener('blur', () => (ui.address.value = current.url));

ui.search.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = parseInput(ui.searchInput.value);
  if (!url) return;
  ui.searchInput.value = '';
  navigate(current, url);
});

ui.engine.value = store.get('crush:engine', ui.engine.value);
ui.engine.addEventListener('change', () => store.set('crush:engine', ui.engine.value));

ui.back.addEventListener('click', () => go(current, -1));
ui.forward.addEventListener('click', () => go(current, 1));
ui.reload.addEventListener('click', () => current.url && show(current, current.url));
ui.popout.addEventListener('click', () => current.url && window.open(toProxy(current.url), '_blank', 'noopener'));
$('new-tab').addEventListener('click', () => createTab());

document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 't') createTab();
  else if (key === 'w') closeTab(current);
  else return;
  e.preventDefault();
});

for (const [name, url] of SHORTCUTS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'shortcut';
  button.append(siteIcon(toProxy(new URL('/favicon.ico', url)), name), name);
  button.addEventListener('click', () => navigate(current, url));
  ui.shortcuts.append(button);
}

// ------------------------------------------------------------ start up

const saved = store.get('crush:tabs', null);
if (saved?.urls?.length) {
  for (const url of saved.urls) createTab(url || '', { focus: false, lazy: Boolean(url) });
  selectTab(tabs[saved.active] ?? tabs[0]);
} else {
  createTab();
}
