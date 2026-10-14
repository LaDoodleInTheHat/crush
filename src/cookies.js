// Every proxied site lives on *our* origin, so the browser would happily mix
// all their cookies together. We keep them apart with the cookie Path:
//
//   example.com sets   sid=1; Path=/
//   we store it as     sid=1; Path=/p/https/example.com/
//
// The browser then only sends it back on requests under /p/https/example.com/.

export const AUTH_COOKIE = '__crush_auth';

// __Host- and __Secure- cookies come with rules (Path=/, Secure) that our
// rewritten cookie can't satisfy, so the browser would drop them. We rename
// them on the way in and restore the name on the way out.
const hidePrefix = (name) => name.replace(/^__(Host|Secure)-/, '__crush$1-');
const restorePrefix = (name) => name.replace(/^__crush(Host|Secure)-/, '__$1-');

/** Rewrite one upstream Set-Cookie header. Returns null to drop it. */
export function rewriteSetCookie(header, target, secure) {
  const [pair, ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  const name = pair.slice(0, eq).trim();
  if (name === AUTH_COOKIE) return null; // a site must never overwrite our login

  let path = '/';
  const kept = [];
  for (const raw of attributes) {
    const attr = raw.trim();
    const [key, value = ''] = attr.split(/=(.*)/s);
    switch (key.toLowerCase()) {
      case 'path':
        if (value.startsWith('/')) path = value;
        break;
      case 'domain': // scoped by path instead
        break;
      case 'secure':
      case 'partitioned': // both need https on our side
        if (secure) kept.push(attr);
        break;
      case 'samesite': // SameSite=None is rejected without Secure
        if (secure || value.toLowerCase() !== 'none') kept.push(attr);
        break;
      default:
        kept.push(attr);
    }
  }

  const scope = `/p/${target.protocol.slice(0, -1)}/${target.host}`;
  return [`${hidePrefix(name)}=${pair.slice(eq + 1)}`, `Path=${scope}${path}`, ...kept].join('; ');
}

/** The Cookie header the browser sent, minus our login, ready for the real site. */
export function cookiesForUpstream(header) {
  if (!header) return '';
  return header
    .split(/;\s*/)
    .filter((c) => c && !c.startsWith(`${AUTH_COOKIE}=`))
    .map(restorePrefix)
    .join('; ');
}

/** All values for one cookie name (a page could plant a decoy with the same name). */
export function readCookies(header, name) {
  return (header || '')
    .split(/;\s*/)
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
}
