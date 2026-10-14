// WebSockets through the proxy.
//
// A WebSocket starts life as an ordinary HTTP request ("GET /chat, Upgrade:
// websocket"). Once the server answers "101 Switching Protocols", the
// connection stops being HTTP and becomes a raw two-way pipe of frames.
//
// So we don't need to understand WebSocket frames at all: open a socket to the
// real server, replay the upgrade request, then glue the two sockets together.
//
//   browser <==socket==> crush <==socket==> real server
//                (bytes copied both ways, untouched)
//
// Sockets use the same addresses as pages: wss://site/chat is reached at
// /p/https/site/chat (the Upgrade header is what tells us it's a socket).
// That way the site's cookies, stored under /p/https/site/, ride along.

import net from 'node:net';
import tls from 'node:tls';
import { assertPublicHost, safeLookup } from './guard.js';
import { cookiesForUpstream } from './cookies.js';

const FORWARD = [
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions',
  'user-agent', 'accept-language', 'cache-control', 'pragma',
];

/** @param {URL} target  the real URL, http(s) standing in for ws(s) */
export function tunnelWebSocket(req, socket, head, target) {
  try {
    assertPublicHost(target.hostname);
  } catch {
    return socket.destroy();
  }

  const secure = target.protocol === 'https:';
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port) || (secure ? 443 : 80);
  const upstream = secure
    ? tls.connect({ host, port, lookup: safeLookup, servername: net.isIP(host) ? undefined : host })
    : net.connect({ host, port, lookup: safeLookup });

  upstream.once(secure ? 'secureConnect' : 'connect', () => {
    const lines = [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      // We can't know which page opened the socket, so assume it's the same site.
      `Origin: ${secure ? 'https' : 'http'}://${target.host}`,
    ];
    for (const name of FORWARD) {
      if (req.headers[name]) lines.push(`${name}: ${req.headers[name]}`);
    }
    const cookie = cookiesForUpstream(req.headers.cookie);
    if (cookie) lines.push(`cookie: ${cookie}`);

    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);

    // From here on it's just bytes. The real server's "101" reply flows back
    // to the browser too, which completes the handshake on its side.
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', close);
  socket.on('error', close);
  upstream.on('close', close);
  socket.on('close', close);
}
