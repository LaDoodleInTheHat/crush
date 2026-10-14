# crush

A small web proxy with a browser UI. You open one page on your server and get
tabs, an address bar and back/forward. Every site you visit is fetched by
the server, not by your computer.

```
 your browser                      your AWS instance                  the internet
+------------------+   /p/https/   +--------------------------+   GET  +-------------+
|  crush UI        | ------------> |  server.js               | -----> | example.com |
|  [tab][tab][+]   |  example.com/ |   1. fetch the real page | <----- |             |
|  [<][>][address] |               |   2. rewrite its URLs    |        +-------------+
|  +------------+  | <------------ |   3. send it back        |
|  |  <iframe>  |  |  rewritten    +--------------------------+
|  +------------+  |  page
+------------------+
```

## Run it locally

Needs Node.js 20.11 or newer.

```sh
npm install
CRUSH_PASSWORD=secret npm start
# open http://localhost:8080
```

`npm test` runs the unit tests and an end-to-end test that pushes real HTTP
and WebSocket traffic through the proxy.

## How it works

**1. Addresses.** Every real URL gets an address on your server, with the
real path kept as-is at the end:

```
https://example.com/docs/page?x=1   ->   /p/https/example.com/docs/page?x=1
```

Keeping the real path means relative links (`img/cat.png`) already resolve
to the right proxy address in the browser, with no help from us.

**2. Rewriting on the server** (`src/rewrite.js`). HTML goes through a
tokenizer, and every `href`, `src`, `srcset`, `action`, `<base>`, inline
style and `<meta refresh>` gets pointed back through the proxy. CSS gets its
`url()` and `@import` rewritten. Everything else (images, video, JS,
downloads) streams straight through untouched.

**3. Patching in the page** (`public/inject.js`). Pages also build URLs while
they run (`fetch('/api')`, `new WebSocket(...)`, `img.src = ...`,
`history.pushState`). The server puts one script at the top of every page,
and it wraps those browser APIs so their URLs get rewritten too.

**4. Safety net** (`server.js`). If a request still slips through, say
`/api/search` hitting your server directly, its `Referer` header names
the proxied page that sent it, so the server redirects it to the right site.

**Cookies** (`src/cookies.js`). Every site shares your server's origin, so
cookies are kept apart by path: `sid=1; Path=/` from example.com is stored
as `Path=/p/https/example.com/`.

**WebSockets** (`src/websocket.js`). After its handshake, a WebSocket is just
a raw two-way pipe. The server replays the handshake to the real site and
then joins the two sockets together.

## Deploy on AWS (EC2)

**1. Open the ports.** In the instance's security group, allow inbound TCP
**8080** (or **80 + 443** if you use Caddy for HTTPS, step 5). Keep SSH (22)
limited to your own IP.

**2. Install Node 22** (over SSH):

```sh
# Amazon Linux 2023
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs git
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
```

**3. Get the code:**

```sh
sudo git clone https://github.com/LaDoodleInTheHat/crush.git /opt/crush
sudo chown -R $USER /opt/crush
cd /opt/crush && npm ci --omit=dev
```

**4. Run it as a service** (it starts on boot and restarts after a crash):

```sh
sudo cp deploy/crush.env.example /etc/crush.env
sudo nano /etc/crush.env            # set CRUSH_PASSWORD
sudo chmod 600 /etc/crush.env
sudo cp deploy/crush.service /etc/systemd/system/
sudo nano /etc/systemd/system/crush.service   # set User= to ec2-user or ubuntu
sudo systemctl daemon-reload && sudo systemctl enable --now crush
```

Now open `http://<your-instance-public-ip>:8080`.

**5. HTTPS (recommended).** Without it, your password and everything you
browse travel across the network unencrypted. Point a domain at the instance,
[install Caddy](https://caddyserver.com/docs/install), and use
`deploy/Caddyfile`. Then set `HOST=127.0.0.1` in `/etc/crush.env` and close
port 8080 again.

**Updating later:** `cd /opt/crush && git pull && npm ci --omit=dev && sudo systemctl restart crush`

## Settings (environment variables)

| Variable         | Default   | What it does |
|------------------|-----------|--------------|
| `CRUSH_PASSWORD` | *(none)*  | Login password. **Set this on a public server**, or anyone who finds it gets a free open proxy on your AWS bill and IP address. |
| `PORT`           | `8080`    | Port to listen on. |
| `HOST`           | `0.0.0.0` | `0.0.0.0` = everyone, `127.0.0.1` = only this machine (use with Caddy). |
| `CRUSH_UNSAFE_ALLOW_PRIVATE` | *(off)* | Lets the proxy reach private and local addresses. For local testing only. **Never on AWS** (see below). |

## Security notes

- **The metadata service.** Every EC2 instance can reach
  `http://169.254.169.254/`, which hands out the instance's AWS credentials. A
  proxy that will fetch any URL would hand those to whoever asks.
  `src/guard.js` blocks all private, loopback and link-local addresses. It
  checks the IPs that DNS actually returns, at the moment of connecting, so
  a domain that points at `127.0.0.1` gets blocked too.
- **All sites share one origin.** A page you open through the proxy could, in
  theory, read another proxied site's cookies and pages. That's how every
  proxy of this kind works. Don't log into anything important through it.

## Limitations

This is a simple proxy, so heavy web apps will break. Works well on most
content sites, docs, news, Wikipedia, Hacker News and search engines. Expect
trouble with:

- Sites that check `location.hostname` in their JavaScript, or send you to
  another domain with `location.href = "https://..."` (the `location` object
  can't be patched, so that click leaves the proxy).
- Logins and CAPTCHAs (Google, Discord, YouTube) and sites that block
  datacenter IPs (Google Search often shows an "unusual traffic" page from
  AWS addresses).
- Service workers (turned off on purpose) and anything that needs HTTP/2.

Bigger projects like Ultraviolet and Scramjet get further by running a
service worker in your browser that intercepts every request. That's a good
next step if you outgrow this one.

## Layout

```
server.js            routing, login, static files, stray-request redirect
src/urls.js          real URL <-> /p/... address
src/rewrite.js       HTML + CSS rewriting
src/proxy.js         forwarding requests, cleaning up responses
src/cookies.js       per-site cookie scoping
src/guard.js         SSRF protection (blocks private/metadata IPs)
src/websocket.js     WebSocket tunnel
public/              the browser UI + inject.js (runs inside proxied pages)
deploy/              systemd unit, Caddyfile, env example
test/                node:test unit + end-to-end tests
```
