// crush -- a tiny web proxy with a browser UI.
//
// Routes:
//   /                 the browser UI (public/index.html)
//   /_/<file>         UI assets and the injected page script
//   /_/login          password page (only when CRUSH_PASSWORD is set)
//   /p/<scheme>/<host>/<path>   a proxied page, e.g. /p/https/example.com/
//   anything else     a URL a proxied page built by hand and we missed;
//                     we work out which site it belongs to and redirect.

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { AUTH_COOKIE, readCookies } from './src/cookies.js';
import { proxyRequest, realUrlOf, sendError } from './src/proxy.js';
import { fromProxy, toProxy } from './src/urls.js';
import { tunnelWebSocket } from './src/websocket.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.CRUSH_PASSWORD || '';

// ---------------------------------------------------------------- static files
// Loaded once at startup into memory. Only files that exist in public/ can be
// served, so there's no way to ask for "../../etc/passwd".

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const files = new Map();
const publicDir = join(import.meta.dirname, 'public');
for (const name of readdirSync(publicDir)) {
  const body = readFileSync(join(publicDir, name));
  files.set(name, {
    body,
    type: `${TYPES[extname(name)] ?? 'application/octet-stream'}; charset=utf-8`,
    etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
  });
}

function serveFile(req, res, name) {
  const file = files.get(name);
  if (!file) return sendError(res, 404, 'Not found');
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, { etag: file.etag });
    return res.end();
  }
  res.writeHead(200, { 'content-type': file.type, etag: file.etag, 'cache-control': 'no-cache' });
  res.end(file.body);
}

// ---------------------------------------------------------------- login
// The login cookie holds a hash of the password, so it changes (and old
// sessions die) whenever you change CRUSH_PASSWORD.

const sha256 = (s) => createHash('sha256').update(s).digest();
const TOKEN = PASSWORD && createHash('sha256').update(`crush-login:${PASSWORD}`).digest('base64url');

function isLoggedIn(req) {
  if (!PASSWORD) return true;
  return readCookies(req.headers.cookie, AUTH_COOKIE).some((value) => sameText(value, TOKEN));
}

// Compare in constant time, so response timing can't leak how much matched.
function sameText(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

async function login(req, res, secure) {
  if (req.method !== 'POST') return serveFile(req, res, 'login.html');

  const form = new URLSearchParams(await readSmallBody(req));
  if (PASSWORD && sameText(form.get('password') ?? '', PASSWORD)) {
    const cookie = [`${AUTH_COOKIE}=${TOKEN}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=2592000'];
    if (secure) cookie.push('Secure');
    res.writeHead(303, { location: '/', 'set-cookie': cookie.join('; ') });
    return res.end();
  }
  await new Promise((r) => setTimeout(r, 800)); // slow down password guessing
  res.writeHead(303, { location: '/_/login?wrong' });
  res.end();
}

function readSmallBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy(new Error('Body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- routing

/**
 * A proxied page sometimes builds a root-relative URL ("/api/search") in a way
 * our rewriting didn't catch. The browser then asks *us* for /api/search. The
 * Referer header still says which proxied page asked, so we can send the
 * request where it was meant to go.
 */
function strayTarget(req) {
  const page = req.headers.referer && realUrlOf(req.headers.referer);
  return page ? new URL(req.url, page.origin) : null;
}

async function handle(req, res) {
  const path = req.url.split('?')[0];
  // Behind Caddy/nginx with TLS, the original scheme arrives in this header.
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';

  if (path === '/_/health') return res.end('ok');
  if (path === '/_/login') return login(req, res, secure);

  if (!isLoggedIn(req)) {
    const wantsPage = /\b(document|iframe)\b/.test(req.headers['sec-fetch-dest'] ?? '') || req.headers.accept?.includes('text/html');
    if (!wantsPage) return sendError(res, 401, 'Log in first');
    res.writeHead(302, { location: '/_/login' });
    return res.end();
  }

  if (req.url.startsWith('/p/')) {
    const target = fromProxy(req.url);
    if (!target) return sendError(res, 400, "That isn't a valid address", req.url);
    if (target.host === req.headers.host) return sendError(res, 400, "The proxy can't open itself");
    return proxyRequest(req, res, target, { secure });
  }

  // Our own files win (inject.js is requested *by* proxied pages, so it
  // carries their Referer and would otherwise be mistaken for a stray).
  if (path.startsWith('/_/') && files.has(path.slice(3))) return serveFile(req, res, path.slice(3));

  const stray = strayTarget(req);
  if (stray) {
    res.writeHead(307, { location: toProxy(stray) }); // 307 keeps the method and body (POSTs survive)
    return res.end();
  }

  if (path === '/') return serveFile(req, res, 'index.html');
  if (path === '/favicon.ico') return serveFile(req, res, 'icon.svg');
  sendError(res, 404, 'Not found', req.url);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendError(res, 500, 'Something broke', err.message);
    else res.destroy();
  });
});

// WebSocket connections arrive as "upgrade" events instead of normal requests.
server.on('upgrade', (req, socket, head) => {
  const target = req.url.startsWith('/p/') ? fromProxy(req.url) : strayTarget(req);
  if (!isLoggedIn(req) || !target) return socket.destroy();
  tunnelWebSocket(req, socket, head, target);
});

server.listen(PORT, HOST, () => {
  const { port } = server.address(); // the real port, even if PORT=0 asked the OS to pick one
  console.log(`crush is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
  if (!PASSWORD) {
    console.warn('WARNING: no CRUSH_PASSWORD set -- anyone who finds this server can use it as an open proxy.');
  }
});
