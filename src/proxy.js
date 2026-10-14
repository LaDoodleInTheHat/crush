// The actual proxy: take the browser's request, replay it against the real
// site, then send the answer back -- rewritten if it's HTML or CSS, streamed
// straight through if it's anything else (images, video, JS, downloads).

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { assertPublicHost, safeLookup } from './guard.js';
import { cookiesForUpstream, rewriteSetCookie } from './cookies.js';
import { fromProxy, proxifyUrl } from './urls.js';
import { rewriteCss, rewriteHtml } from './rewrite.js';

const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
};

const MAX_REWRITE_BYTES = 25 * 1024 * 1024; // HTML/CSS bigger than this is refused

// Request headers we never pass to the real site.
const DROP_REQUEST = new Set([
  // hop-by-hop: they describe the browser<->us connection, not the request
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'host',
  // added by a reverse proxy in front of us; would leak the visitor's real IP
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'via',
  // recomputed below
  'accept-encoding', 'cookie', 'referer', 'origin',
  // would always say "same-origin", which is a lie
  'sec-fetch-site',
]);

// Response headers we never pass back to the browser.
const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate',
  // security policies written for the real origin; on ours they block our own script or the iframe
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'origin-agent-cluster', 'strict-transport-security', 'service-worker-allowed',
  // "clear-site-data" would wipe *our* origin, i.e. every site's cookies at once
  'clear-site-data',
  // preload hints and reporting endpoints pointing at real URLs
  'link', 'alt-svc', 'report-to', 'reporting-endpoints', 'nel',
]);

/**
 * @param {URL} target  the real URL to fetch
 * @param {{secure: boolean}} ctx  is the browser talking to us over https?
 */
export function proxyRequest(req, res, target, ctx) {
  try {
    assertPublicHost(target.hostname);
  } catch (err) {
    return sendError(res, 403, 'Blocked', err.message);
  }

  const upstream = (target.protocol === 'https:' ? https : http).request(target, {
    method: req.method,
    headers: upstreamHeaders(req, target),
    agent: agents[target.protocol],
    lookup: safeLookup,
    timeout: 30_000,
  });

  upstream.on('response', (upRes) => {
    handleResponse(req, res, target, upRes, ctx).catch((err) => {
      if (!res.headersSent) sendError(res, 502, 'Could not read that page', err.message);
      else res.destroy(err);
    });
  });
  upstream.on('timeout', () => upstream.destroy(new Error('The site took longer than 30 seconds to answer.')));
  upstream.on('error', (err) => {
    if (!res.headersSent) sendError(res, err.code === 'EBLOCKED' ? 403 : 502, "Couldn't reach that site", err.message);
    else res.destroy();
  });

  // If the visitor gives up (closes the tab) mid-download, stop fetching for them.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });

  req.pipe(upstream); // forwards a POST body; for a GET this just ends the request
}

function upstreamHeaders(req, target) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST.has(name) && !name.startsWith('cf-')) headers[name] = value;
  }
  headers.host = target.host;
  headers['accept-encoding'] = 'gzip, deflate, br'; // only what we know how to decode

  const cookie = cookiesForUpstream(req.headers.cookie);
  if (cookie) headers.cookie = cookie;

  // The browser's Referer is a proxy URL (/p/https/site/page). Translate it
  // back, trimmed the way browsers trim it by default for cross-site requests.
  const from = req.headers.referer && realUrlOf(req.headers.referer);
  if (from) headers.referer = from.origin === target.origin ? from.href : `${from.origin}/`;
  if (req.headers.origin) headers.origin = req.headers.origin === 'null' ? 'null' : (from ?? target).origin;

  return headers;
}

/** "http://our-server/p/https/site/page" -> URL("https://site/page") */
export function realUrlOf(proxyHref) {
  try {
    const u = new URL(proxyHref);
    const real = fromProxy(u.pathname + u.search);
    if (real) real.hash = '';
    return real;
  } catch {
    return null;
  }
}

async function handleResponse(req, res, target, upRes, ctx) {
  const headers = {};
  for (const [name, value] of Object.entries(upRes.headers)) {
    if (!DROP_RESPONSE.has(name)) headers[name] = value;
  }

  // Redirects: "Location: https://site/next" must become "/p/https/site/next".
  if (headers.location) headers.location = proxifyUrl(headers.location, target);
  if (headers.refresh) headers.refresh = headers.refresh.replace(/(url=)(.+)$/i, (_, pre, url) => pre + proxifyUrl(url, target));
  if (headers['set-cookie']) {
    headers['set-cookie'] = headers['set-cookie'].map((c) => rewriteSetCookie(c, target, ctx.secure)).filter(Boolean);
  }
  headers['referrer-policy'] = 'same-origin';

  const type = (headers['content-type'] || '').toLowerCase();
  const kind = type.includes('html') ? 'html' : type.startsWith('text/css') ? 'css' : null;
  const hasBody = req.method !== 'HEAD' && upRes.statusCode !== 204 && upRes.statusCode !== 304;

  // Not something we rewrite: stream it through untouched (still compressed,
  // range requests and all). This is the path video and big downloads take.
  if (!kind || !hasBody) {
    res.writeHead(upRes.statusCode, headers);
    pipeline(upRes, res, () => {}); // like .pipe(), but tears both down if either side fails
    return;
  }

  // HTML/CSS: we need the whole text to rewrite it.
  const compressed = await readBody(upRes, MAX_REWRITE_BYTES);
  const bytes = await decompress(compressed, headers['content-encoding']);
  const text = decodeText(bytes, type);
  const body = Buffer.from(kind === 'html' ? await rewriteHtml(text, target) : rewriteCss(text, target));

  delete headers['content-encoding'];
  headers['content-type'] = `${type.split(';')[0]}; charset=utf-8`;
  headers['content-length'] = body.length;
  res.writeHead(upRes.statusCode, headers);
  res.end(body);
}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) stream.destroy(new Error('Page is too large to rewrite.'));
      else chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const decoders = {
  gzip: promisify(zlib.gunzip),
  'x-gzip': promisify(zlib.gunzip),
  deflate: (buf) => promisify(zlib.inflate)(buf).catch(() => promisify(zlib.inflateRaw)(buf)),
  br: promisify(zlib.brotliDecompress),
};

async function decompress(buf, encoding) {
  // "Content-Encoding: gzip, br" means gzip was applied first, so undo br first.
  const steps = (encoding || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'identity');
  for (const step of steps.reverse()) {
    if (!decoders[step]) throw new Error(`Unsupported encoding: ${step}`);
    buf = await decoders[step](buf);
  }
  return buf;
}

/**
 * Bytes -> text, using the page's declared character set. We always send
 * UTF-8 back (and say so in Content-Type, which outranks any <meta charset>).
 */
function decodeText(bytes, contentType) {
  const head = bytes.subarray(0, 2048).toString('latin1');
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /^@charset\s+"([\w-]+)"/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function sendError(res, status, title, detail = '') {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; margin: 0 16px;
         background: light-dark(#f6f6f8, #16161a); color: light-dark(#222, #ddd); }
  main { max-width: 34rem; }
  .face { font-size: 2.2rem; opacity: .7; }
  code { font-size: .9em; opacity: .8; word-break: break-word; }
</style>
<main><div class="face">(._.)</div><h1>${esc(title)}</h1><p><code>${esc(detail)}</code></p></main>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
