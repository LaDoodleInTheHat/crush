// The one idea the whole proxy is built on: every real URL gets an address
// on our own server, with the real path kept intact at the end.
//
//   https://example.com/docs/page?x=1
//            | toProxy()
//            v
//   /p/https/example.com/docs/page?x=1
//
// Because the real path survives untouched, relative links such as
// "img/cat.png" resolve to /p/https/example.com/docs/img/cat.png in the
// browser all by themselves. Only absolute and root-relative URLs need help.

export const PREFIX = '/p/';

const SCHEMES = new Set(['http', 'https']);
const PROXY_PATH = /^\/p\/(https?)\/([^/?#]+)(.*)$/;

// Schemes and fragments that never touch the network through us.
const LEAVE_ALONE = /^\s*(?:#|data:|blob:|javascript:|about:|mailto:|tel:|sms:)/i;

/** Real URL -> proxy path, or null for schemes we can't carry. */
export function toProxy(url) {
  const u = url instanceof URL ? url : new URL(url);
  const scheme = u.protocol.slice(0, -1);
  if (!SCHEMES.has(scheme)) return null;
  return `${PREFIX}${scheme}/${u.host}${u.pathname}${u.search}${u.hash}`;
}

/** Proxy path (with query string) -> real URL, or null if it isn't one. */
export function fromProxy(path) {
  const m = PROXY_PATH.exec(path);
  if (!m) return null;
  try {
    return new URL(`${m[1]}://${m[2]}${m[3] || '/'}`);
  } catch {
    return null;
  }
}

/**
 * Rewrite a URL found inside a page (an href, a src, a CSS url()) so it points
 * through the proxy. `base` is the real URL the page was loaded from, which is
 * what relative URLs resolve against.
 */
export function proxifyUrl(raw, base) {
  if (!raw || LEAVE_ALONE.test(raw)) return raw;
  try {
    return toProxy(new URL(raw.trim(), base)) ?? raw;
  } catch {
    return raw;
  }
}

/**
 * srcset="a.jpg 1x, b.jpg 2x" holds several URLs, each followed by a size hint.
 * URLs may contain commas themselves (a.jpg?w=1,2), so we can't just split on
 * "," -- the spec says a URL is a run of non-spaces, then descriptors run until
 * the next comma.
 */
export function proxifySrcset(value, base) {
  const out = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !/\s/.test(value[j])) j++;
    let url = value.slice(i, j);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const comma = value.indexOf(',', j);
      const end = comma === -1 ? value.length : comma;
      descriptor = value.slice(j, end).trim();
      j = end + 1;
    }
    out.push(descriptor ? `${proxifyUrl(url, base)} ${descriptor}` : proxifyUrl(url, base));
    i = j;
  }
  return out.join(', ');
}
