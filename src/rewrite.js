// Rewrites HTML and CSS so every URL in them points back through the proxy.
//
// HTML goes through a tokenizer (parse5) instead of regexes: it walks the page
// tag by tag, hands us each tag's attributes as a clean list, and copies every
// tag we don't touch to the output byte-for-byte.

import { RewritingStream } from 'parse5-html-rewriting-stream';
import { proxifySrcset, proxifyUrl } from './urls.js';

// The script that patches fetch/XHR/etc. inside the page (public/inject.js).
// It has to be the very first script on the page so it runs before the site's own.
const INJECT = '<script src="/_/inject.js"></script>';

// Which attribute holds a URL, per tag.
const URL_ATTRS = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  img: ['src'],
  script: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  audio: ['src'],
  video: ['src', 'poster'],
  source: ['src'],
  track: ['src'],
  input: ['src', 'formaction'],
  button: ['formaction'],
  form: ['action'],
  object: ['data'],
  body: ['background'],
  table: ['background'],
  td: ['background'],
  th: ['background'],
};
const SRCSET_ATTRS = { img: 'srcset', source: 'srcset', link: 'imagesrcset' };

// Attributes we delete outright:
//  integrity      - the page's own hash check fails once we rewrite a file
//  ping           - tracking beacons on links
//  referrerpolicy - we need the Referer header to route stray requests
const DROP_ATTRS = new Set(['integrity', 'ping', 'referrerpolicy']);

/**
 * @param {string} html  the page, already decoded to text
 * @param {URL} pageUrl  the real URL it came from
 */
export function rewriteHtml(html, pageUrl) {
  return new Promise((resolve, reject) => {
    const rw = new RewritingStream();
    const out = [];
    let base = pageUrl; // changes if the page has a <base href>
    let injected = false;
    let style = null; // text collected inside a <style> element

    const inject = () => {
      if (!injected) rw.emitRaw(INJECT);
      injected = true;
    };

    rw.on('startTag', (tag, raw) => {
      // No <head>? Then inject right before the first real tag.
      if (tag.tagName !== 'html' && tag.tagName !== 'head') inject();

      if (tag.tagName === 'base') {
        const href = tag.attrs.find((a) => a.name === 'href');
        if (href) base = safeUrl(href.value, pageUrl) ?? base;
      }

      if (rewriteTag(tag, base)) rw.emitStartTag(tag);
      else rw.emitRaw(raw);

      if (tag.tagName === 'head') inject();
      if (tag.tagName === 'style') style = [];
    });

    rw.on('text', (_, raw) => {
      if (style) style.push(raw);
      else rw.emitRaw(raw);
    });

    rw.on('endTag', (_, raw) => {
      if (style) rw.emitRaw(rewriteCss(style.join(''), base));
      style = null;
      rw.emitRaw(raw);
    });

    rw.on('data', (chunk) => out.push(chunk));
    rw.on('end', () => resolve(injected ? out.join('') : INJECT + out.join('')));
    rw.on('error', reject);
    rw.end(html);
  });
}

/** Rewrites one tag's attributes in place. Returns true if anything changed. */
function rewriteTag(tag, base) {
  const name = tag.tagName;
  const urlAttrs = URL_ATTRS[name] ?? [];
  const before = JSON.stringify(tag.attrs);

  tag.attrs = tag.attrs.filter((a) => !DROP_ATTRS.has(a.name));

  for (const attr of tag.attrs) {
    if (urlAttrs.includes(attr.name) || (name === 'base' && attr.name === 'href')) {
      attr.value = proxifyUrl(attr.value, base);
    } else if (SRCSET_ATTRS[name] === attr.name) {
      attr.value = proxifySrcset(attr.value, base);
    } else if (attr.name === 'style') {
      attr.value = rewriteCss(attr.value, base);
    } else if (attr.name === 'target' && /^_(top|parent)$/i.test(attr.value)) {
      // Our browser UI owns the top window; keep the page inside its tab.
      attr.value = '_self';
    } else if (attr.name === 'target' && name === 'form' && attr.value === '_blank') {
      attr.value = '_self';
    }
  }

  if (name === 'meta') rewriteMeta(tag, base);

  return JSON.stringify(tag.attrs) !== before;
}

function rewriteMeta(tag, base) {
  const get = (n) => tag.attrs.find((a) => a.name === n);
  const equiv = get('http-equiv');
  const content = get('content');
  const kind = (equiv?.value ?? get('name')?.value ?? '').toLowerCase();

  if (kind === 'refresh' && content) {
    // <meta http-equiv="refresh" content="5; url=/next">
    content.value = content.value.replace(/(url\s*=\s*['"]?)([^'";]+)/i, (_, pre, url) => pre + proxifyUrl(url, base));
  } else if (kind === 'content-security-policy' && equiv) {
    // A page-level CSP would block our injected script. Neutralize it.
    equiv.value = 'x-crush-removed-csp';
  } else if (kind === 'referrer' && content) {
    content.value = 'same-origin';
  }
}

/** url(...) and @import "..." are the only places CSS references other files. */
export function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (_, q, url) => `url(${q}${proxifyUrl(url, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, q, url) => `@import ${q}${proxifyUrl(url, base)}${q}`);
}

function safeUrl(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}
