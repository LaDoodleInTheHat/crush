// End-to-end: start a fake website, start crush in front of it, and talk to
// the fake site *through* crush over real HTTP and WebSocket connections.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

let site; // the fake website
let sitePort;
const procs = [];

function startSite() {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'none'",
        'x-frame-options': 'DENY',
        'set-cookie': 'sid=abc; Path=/; HttpOnly; SameSite=None; Secure',
      });
      return res.end('<html><head><title>Fixture</title></head><body><a href="/next">next</a></body></html>');
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/landing' });
      return res.end();
    }
    if (req.url === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.headers));
    }
    if (req.url === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': 'gzip' });
      return res.end(gzipSync('body { background: url(/bg.png) }'));
    }
    if (req.url === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' });
      return res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in windows-1252
    }
    if (req.url === '/form' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => res.end(`got ${body}`));
    }
    res.writeHead(404);
    res.end('nope');
  });

  // Minimal WebSocket echo server: handshake, then bounce small text frames back.
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (frame) => {
      const len = frame[1] & 0x7f;
      if ((frame[0] & 0x0f) !== 1 || len > 125) return; // only short text frames
      const mask = frame.subarray(2, 6);
      const text = Buffer.from(frame.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString();
      const reply = Buffer.from(`echo: ${text} (origin ${req.headers.origin})`);
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  return server;
}

async function startCrush(env) {
  const proc = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(proc);
  // PORT=0 lets the OS pick a free port; the server prints the URL it got.
  const port = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      const m = /:(\d+)/.exec(String(d));
      if (m) resolve(Number(m[1]));
    });
    proc.on('exit', (code) => reject(new Error(`crush exited with ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

let crush; // crush allowed to reach localhost (where the fake site lives)
let strict; // crush with the normal SSRF guard
let locked; // crush with a password
let siteBase; // the fake site's proxy prefix, e.g. /p/http/127.0.0.1:1234

before(async () => {
  site = startSite();
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  sitePort = site.address().port;
  siteBase = `/p/http/127.0.0.1:${sitePort}`;
  [crush, strict, locked] = await Promise.all([
    startCrush({ CRUSH_UNSAFE_ALLOW_PRIVATE: '1', CRUSH_PASSWORD: '' }),
    startCrush({ CRUSH_PASSWORD: '' }),
    startCrush({ CRUSH_UNSAFE_ALLOW_PRIVATE: '1', CRUSH_PASSWORD: 'hunter2' }),
  ]);
});

after(() => {
  for (const p of procs) p.kill();
  site.close();
  site.closeAllConnections();
});

test('serves the browser UI', async () => {
  const res = await fetch(`${crush}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>crush<\/title>/);
});

test('proxies a page: rewritten, injected, security headers dropped, cookie scoped', async () => {
  const res = await fetch(`${crush}${siteBase}/`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /<head><script src="\/_\/inject.js"><\/script><title>Fixture/);
  assert.match(body, new RegExp(`href="${siteBase}/next"`));
  assert.equal(res.headers.get('content-security-policy'), null);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('set-cookie'), `sid=abc; Path=${siteBase}/; HttpOnly`);
});

test('redirects stay inside the proxy', async () => {
  const res = await fetch(`${crush}${siteBase}/redirect`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${siteBase}/landing`);
});

test('request headers are translated for the real site', async () => {
  const res = await fetch(`${crush}${siteBase}/headers`, {
    headers: {
      cookie: 'sid=abc; __crush_auth=secret',
      referer: `${crush}${siteBase}/some/page`,
      'x-forwarded-for': '203.0.113.9',
    },
  });
  const seen = await res.json();
  assert.equal(seen.host, `127.0.0.1:${sitePort}`);
  assert.equal(seen.cookie, 'sid=abc');
  assert.equal(seen.referer, `http://127.0.0.1:${sitePort}/some/page`);
  assert.equal(seen['x-forwarded-for'], undefined);
});

test('gzipped CSS is unpacked and rewritten', async () => {
  const res = await fetch(`${crush}${siteBase}/style.css`);
  assert.equal(await res.text(), `body { background: url(${siteBase}/bg.png) }`);
  assert.equal(res.headers.get('content-encoding'), null);
});

test('non-UTF-8 pages are decoded with their own charset', async () => {
  const res = await fetch(`${crush}${siteBase}/latin1`);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await res.text(), /café$/);
});

test('POST bodies are forwarded', async () => {
  const res = await fetch(`${crush}${siteBase}/form`, { method: 'POST', body: 'q=hello' });
  assert.equal(await res.text(), 'got q=hello');
});

test('stray root-relative requests are redirected using the Referer', async () => {
  const res = await fetch(`${crush}/api/thing?x=1`, {
    headers: { referer: `${crush}${siteBase}/page` },
    redirect: 'manual',
  });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), `${siteBase}/api/thing?x=1`);
});

test('WebSockets are tunneled', async () => {
  const ws = new WebSocket(`${crush.replace('http', 'ws')}${siteBase}/ws`);
  await once(ws, 'open');
  ws.send('hi');
  const [msg] = await once(ws, 'message');
  assert.equal(msg.data, `echo: hi (origin http://127.0.0.1:${sitePort})`);
  ws.close();
});

test('SSRF guard: private addresses and cloud metadata are refused', async () => {
  for (const path of [siteBase, '/p/http/169.254.169.254/latest/meta-data/', '/p/http/localhost:22/', '/p/http/[::1]/']) {
    const res = await fetch(`${strict}${path}`);
    assert.equal(res.status, 403, path);
  }
});

test('the proxy refuses to proxy itself', async () => {
  const self = new URL(crush).host;
  const res = await fetch(`${crush}/p/http/${self}/`);
  assert.equal(res.status, 400);
});

test('password: locked out until logged in', async () => {
  const page = await fetch(`${locked}/`, { redirect: 'manual', headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/_/login');

  const api = await fetch(`${locked}${siteBase}/headers`);
  assert.equal(api.status, 401);

  const wrong = await fetch(`${locked}/_/login`, { method: 'POST', body: 'password=nope', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(wrong.headers.get('location'), '/_/login?wrong');
  assert.equal(wrong.headers.get('set-cookie'), null);

  const right = await fetch(`${locked}/_/login`, { method: 'POST', body: 'password=hunter2', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = right.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^__crush_auth=/);

  const after = await fetch(`${locked}${siteBase}/headers`, { headers: { cookie } });
  assert.equal(after.status, 200);
  assert.equal((await after.json()).cookie, undefined, 'login cookie is not leaked to the site');
});

test('our own assets are served even when a proxied page asks for them', async () => {
  const res = await fetch(`${crush}/_/inject.js`, { headers: { referer: `${crush}${siteBase}/page` }, redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});
