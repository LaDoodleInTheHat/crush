// crush page hook -- the server inserts this as the first script of every
// proxied HTML page.
//
// The server already rewrote every URL it could *see* in the HTML and CSS.
// But pages also invent URLs while running: fetch('/api'), new Image().src = ...,
// history.pushState(...). This script wraps those browser APIs so URLs made at
// runtime get routed through the proxy too.
(() => {
  'use strict';
  if (window.__crush) return;

  const PREFIX = '/p/';
  const LEAVE_ALONE = /^\s*(?:#|data:|blob:|javascript:|about:|mailto:|tel:|sms:)/i;

  // ------------------------------------------------------------ URL helpers
  // Same scheme as src/urls.js on the server:
  //   https://site.com/a?b  <->  /p/https/site.com/a?b

  const encode = (u) => `${PREFIX}${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;

  function decode(path) {
    const m = /^\/p\/(https?)\/([^/?#]+)(.*)$/.exec(path);
    if (!m) return null;
    try {
      return new URL(`${m[1]}://${m[2]}${m[3] || '/'}`);
    } catch {
      return null;
    }
  }

  // Where this page *really* is (location.href is the proxy address).
  const realPage = () => decode(location.pathname + location.search + location.hash);

  /** Any URL a page might use -> the real URL it means, or null. */
  function toReal(input) {
    let u;
    try {
      u = new URL(String(input), document.baseURI);
    } catch {
      return null;
    }
    if (u.origin !== location.origin) return u; // absolute URL to another site
    // Points at our server: either already a proxy address (relative links
    // resolve to those naturally), or a root-relative "/x" meant for the real site.
    const page = realPage();
    return decode(u.pathname + u.search + u.hash) || (page && new URL(u.pathname + u.search + u.hash, page.origin));
  }

  function proxify(input) {
    if (input == null || input === '' || LEAVE_ALONE.test(String(input))) return input;
    const real = toReal(input);
    return real && /^https?:$/.test(real.protocol) ? encode(real) : input;
  }

  function proxifySrcset(value) {
    // Mirrors proxifySrcset in src/urls.js.
    const out = [];
    const s = String(value);
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      let url = s.slice(i, j);
      let descriptor = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        const comma = s.indexOf(',', j);
        const end = comma === -1 ? s.length : comma;
        descriptor = s.slice(j, end).trim();
        j = end + 1;
      }
      out.push(descriptor ? `${proxify(url)} ${descriptor}` : proxify(url));
      i = j;
    }
    return out.join(', ');
  }

  // wss://site/chat -> ws(s)://our-server/p/https/site/chat
  function proxifyWebSocket(input) {
    const real = toReal(input);
    if (!real) return input;
    const scheme = { 'ws:': 'http', 'http:': 'http', 'wss:': 'https', 'https:': 'https' }[real.protocol];
    if (!scheme) return input;
    const self = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${self}://${location.host}${PREFIX}${scheme}/${real.host}${real.pathname}${real.search}`;
  }

  // ------------------------------------------------------------ network APIs

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    input = input instanceof Request ? new Request(proxify(input.url), input) : proxify(input);
    return nativeFetch(input, init);
  };

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return nativeXhrOpen.call(this, method, proxify(url), ...rest);
  };

  if (Navigator.prototype.sendBeacon) {
    const nativeBeacon = Navigator.prototype.sendBeacon;
    Navigator.prototype.sendBeacon = function (url, data) {
      return nativeBeacon.call(this, proxify(url), data);
    };
  }

  // `new WebSocket(url)` etc: a Proxy lets us edit the arguments while keeping
  // everything else (WebSocket.OPEN, instanceof checks) exactly as it was.
  function wrapConstructor(name, map) {
    const Native = window[name];
    if (!Native) return;
    window[name] = new Proxy(Native, {
      construct(target, args, newTarget) {
        if (args.length) args[0] = map(args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
  wrapConstructor('WebSocket', proxifyWebSocket);
  wrapConstructor('EventSource', proxify);
  wrapConstructor('Worker', proxify);
  wrapConstructor('SharedWorker', proxify);

  // ------------------------------------------------------------ DOM URLs
  // img.src = "...", link.href = "...", el.setAttribute('src', ...)

  function hookSetter(Ctor, prop, map) {
    const desc = Ctor && Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!desc?.set) return;
    Object.defineProperty(Ctor.prototype, prop, {
      ...desc,
      set(value) {
        desc.set.call(this, map(value));
      },
    });
  }

  for (const [Ctor, prop] of [
    [window.HTMLAnchorElement, 'href'],
    [window.HTMLAreaElement, 'href'],
    [window.HTMLLinkElement, 'href'],
    [window.HTMLBaseElement, 'href'],
    [window.HTMLImageElement, 'src'],
    [window.HTMLScriptElement, 'src'],
    [window.HTMLIFrameElement, 'src'],
    [window.HTMLEmbedElement, 'src'],
    [window.HTMLMediaElement, 'src'],
    [window.HTMLSourceElement, 'src'],
    [window.HTMLTrackElement, 'src'],
    [window.HTMLInputElement, 'src'],
    [window.HTMLFormElement, 'action'],
    [window.HTMLButtonElement, 'formAction'],
    [window.HTMLInputElement, 'formAction'],
    [window.HTMLObjectElement, 'data'],
    [window.HTMLVideoElement, 'poster'],
  ]) {
    hookSetter(Ctor, prop, proxify);
  }
  hookSetter(window.HTMLImageElement, 'srcset', proxifySrcset);
  hookSetter(window.HTMLSourceElement, 'srcset', proxifySrcset);

  const URL_ATTRS = new Set(['src', 'href', 'action', 'formaction', 'poster']);
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if (URL_ATTRS.has(n) || (n === 'data' && this instanceof HTMLObjectElement)) value = proxify(value);
    else if (n === 'srcset' || n === 'imagesrcset') value = proxifySrcset(value);
    else if (n === 'integrity') return; // the hash can't match a rewritten file
    return nativeSetAttribute.call(this, name, value);
  };

  // Markup inserted as a string (el.innerHTML = '<img src=...>') skips all of
  // the above, and the browser starts downloading the moment it parses it.
  // So we parse the string ourselves first, inside a <template> (whose
  // contents are inert: nothing loads), fix the URLs there, and hand the
  // cleaned-up string to the real setter.
  const needsFix = (v) => /^\s*(https?:)?\/\//i.test(v) || (/^\s*\//.test(v) && !v.trim().startsWith(PREFIX));
  const MAYBE_URL = /\b(?:src|href|srcset|action|poster)\s*=\s*["']?\s*(?:https?:|\/)/i;
  const templateHtml = Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype, 'innerHTML')
    ?? Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  function cleanHtml(html) {
    if (typeof html !== 'string' || !MAYBE_URL.test(html)) return html;
    const t = document.createElement('template');
    templateHtml.set.call(t, html);
    t.content.querySelectorAll('[src],[href],[action],[poster],[srcset]').forEach((n) => sweepOne(n));
    return templateHtml.get.call(t);
  }
  for (const prop of ['innerHTML', 'outerHTML']) {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    Object.defineProperty(Element.prototype, prop, {
      ...desc,
      set(value) {
        desc.set.call(this, cleanHtml(value));
      },
    });
  }
  const nativeInsertHtml = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (position, html) {
    return nativeInsertHtml.call(this, position, cleanHtml(html));
  };
  function sweepOne(node) {
    for (const attr of URL_ATTRS) {
      const v = node.getAttribute(attr);
      if (v && needsFix(v)) nativeSetAttribute.call(node, attr, proxify(v));
    }
    const set = node.getAttribute('srcset');
    if (set && set.split(',').some(needsFix)) nativeSetAttribute.call(node, 'srcset', proxifySrcset(set));
  }

  // Safety net for anything that still slipped in: check new elements as
  // they're added to the page.
  const swept = new WeakSet();
  function sweep(el) {
    if (el.nodeType !== 1 || swept.has(el)) return;
    for (const node of [el, ...el.querySelectorAll('[src],[href],[action],[poster],[srcset]')]) {
      if (swept.has(node)) continue;
      swept.add(node);
      sweepOne(node);
    }
  }

  // ------------------------------------------------------------ navigation

  for (const method of ['pushState', 'replaceState']) {
    const native = History.prototype[method];
    History.prototype[method] = function (state, title, url) {
      const result = native.call(this, state, title, url == null ? url : proxify(url));
      tellBrowser();
      return result;
    };
  }

  // A site's service worker would take over our whole origin. No thanks.
  if (window.ServiceWorkerContainer) {
    ServiceWorkerContainer.prototype.register = () =>
      Promise.reject(new DOMException('Service workers are disabled by the proxy.', 'SecurityError'));
  }

  // ------------------------------------------------------------ cookies
  // Same path-scoping the server does for Set-Cookie (see src/cookies.js).

  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    enumerable: true,
    get() {
      return cookieDesc.get.call(this).replace(/(^|;\s*)__crush(Host|Secure)-/g, '$1__$2-');
    },
    set(value) {
      const page = realPage();
      if (!page) return cookieDesc.set.call(this, value);
      const [pair, ...attrs] = String(value).split(';');
      const name = pair.split('=')[0].trim();
      if (name === '__crush_auth') return;
      let path = '/';
      const kept = attrs
        .map((a) => a.trim())
        .filter((a) => {
          const [key, val = ''] = a.split(/=(.*)/s);
          const k = key.toLowerCase();
          if (k === 'path') path = val.startsWith('/') ? val : '/';
          if (location.protocol !== 'https:' && (k === 'secure' || k === 'partitioned' || (k === 'samesite' && /none/i.test(val)))) {
            return false;
          }
          return k !== 'path' && k !== 'domain';
        });
      const renamed = pair.trim().replace(/^__(Host|Secure)-/, '__crush$1-');
      const scope = `${PREFIX}${page.protocol.slice(0, -1)}/${page.host}`;
      cookieDesc.set.call(this, [renamed, `path=${scope}${path}`, ...kept].join('; '));
    },
  });

  // ------------------------------------------------------------ talking to the browser UI
  // The UI (public/browser.js) is the window above us, on the same origin.

  const ui = (() => {
    try {
      return window.top !== window && window.top.__crushBrowser ? window.top : null;
    } catch {
      return null;
    }
  })();

  let lastTitle = null;
  function tellBrowser() {
    lastTitle = document.title;
    ui?.postMessage({ crush: 'changed' }, location.origin);
  }

  function openTab(url) {
    const real = toReal(url);
    if (!real || !ui) return false;
    ui.postMessage({ crush: 'open', url: real.href }, location.origin);
    return true;
  }

  // window.open(url) -> a new tab inside the UI instead of a real popup.
  const nativeOpen = window.open;
  window.open = function (url, target, features) {
    if (url && (!target || target === '_blank') && openTab(url)) return null;
    return nativeOpen.call(this, url == null ? url : proxify(url), target, features);
  };

  // <a target="_blank"> and ctrl/middle-click -> a new UI tab. Listening on
  // window (the last stop of a bubbling click) lets the page's own handlers
  // go first and cancel it if they want to.
  function onLinkClick(e) {
    if (e.defaultPrevented || !ui) return;
    const link = e.composedPath().find((n) => n instanceof HTMLAnchorElement || n instanceof HTMLAreaElement);
    if (!link?.href || LEAVE_ALONE.test(link.getAttribute('href') ?? '')) return;
    const wantsNewTab = link.target === '_blank' || e.ctrlKey || e.metaKey || e.button === 1;
    if (wantsNewTab && openTab(link.href)) e.preventDefault();
  }
  window.addEventListener('click', onLinkClick);
  window.addEventListener('auxclick', onLinkClick);

  // Lets the UI start its loading bar the moment a link is followed.
  addEventListener('beforeunload', () => ui?.postMessage({ crush: 'leaving' }, location.origin));
  addEventListener('DOMContentLoaded', tellBrowser);
  addEventListener('load', tellBrowser);
  addEventListener('popstate', tellBrowser);
  addEventListener('hashchange', tellBrowser);

  new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach(sweep);
    if (document.title !== lastTitle) tellBrowser();
  }).observe(document, { childList: true, subtree: true, characterData: true });

  window.__crush = { proxify, toReal };
})();
