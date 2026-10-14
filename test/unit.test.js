import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromProxy, proxifySrcset, proxifyUrl, toProxy } from '../src/urls.js';
import { assertPublicHost, isBlockedAddress, safeLookup } from '../src/guard.js';
import { cookiesForUpstream, rewriteSetCookie } from '../src/cookies.js';
import { rewriteCss, rewriteHtml } from '../src/rewrite.js';

const page = new URL('https://example.com/docs/page.html');

test('urls: real URL <-> proxy path round trip', () => {
  assert.equal(toProxy('https://example.com/a/b?c=1#d'), '/p/https/example.com/a/b?c=1#d');
  assert.equal(toProxy('http://example.com:8080/'), '/p/http/example.com:8080/');
  assert.equal(toProxy('ftp://example.com/'), null);
  assert.equal(fromProxy('/p/https/example.com/a/b?c=1').href, 'https://example.com/a/b?c=1');
  assert.equal(fromProxy('/p/https/example.com?q=1').href, 'https://example.com/?q=1');
  assert.equal(fromProxy('/p/https/example.com').href, 'https://example.com/');
  assert.equal(fromProxy('/p/gopher/example.com/'), null);
  assert.equal(fromProxy('/elsewhere'), null);
});

test('urls: page URLs resolve against the real page, then get proxied', () => {
  assert.equal(proxifyUrl('img/cat.png', page), '/p/https/example.com/docs/img/cat.png');
  assert.equal(proxifyUrl('/root.css', page), '/p/https/example.com/root.css');
  assert.equal(proxifyUrl('//cdn.example.net/x.js', page), '/p/https/cdn.example.net/x.js');
  assert.equal(proxifyUrl('http://other.org/', page), '/p/http/other.org/');
  for (const untouched of ['#top', 'data:image/png;base64,AAAA', 'javascript:void(0)', 'mailto:a@b.c', '']) {
    assert.equal(proxifyUrl(untouched, page), untouched);
  }
});

test('urls: srcset keeps descriptors and commas inside URLs', () => {
  assert.equal(
    proxifySrcset('a.jpg 1x, /b.jpg?w=1,2 2x,https://c.net/c.jpg 640w', page),
    '/p/https/example.com/docs/a.jpg 1x, /p/https/example.com/b.jpg?w=1,2 2x, /p/https/c.net/c.jpg 640w',
  );
});

test('guard: private and metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
  assert.throws(() => assertPublicHost('169.254.169.254'), { code: 'EBLOCKED' });
  assert.throws(() => assertPublicHost('[::1]'), { code: 'EBLOCKED' });
  assert.doesNotThrow(() => assertPublicHost('example.com'));
});

test('guard: hostnames that resolve to private addresses are blocked at lookup', async () => {
  const err = await new Promise((resolve) => safeLookup('localhost', { all: true }, resolve));
  assert.equal(err?.code, 'EBLOCKED');
});

test('cookies: Set-Cookie gets scoped to the site path', () => {
  const target = new URL('https://shop.example.com/cart');
  assert.equal(
    rewriteSetCookie('sid=abc; Path=/; Domain=.example.com; Secure; HttpOnly; SameSite=None', target, false),
    'sid=abc; Path=/p/https/shop.example.com/; HttpOnly',
  );
  assert.equal(
    rewriteSetCookie('__Host-id=1; Path=/; Secure; SameSite=Lax', target, true),
    '__crushHost-id=1; Path=/p/https/shop.example.com/; Secure; SameSite=Lax',
  );
  assert.equal(rewriteSetCookie('k=v; path=/account', target, true), 'k=v; Path=/p/https/shop.example.com/account');
  assert.equal(rewriteSetCookie('__crush_auth=evil', target, true), null);
});

test('cookies: our login cookie never reaches the site, renamed ones get restored', () => {
  assert.equal(cookiesForUpstream('a=1; __crush_auth=secret; __crushHost-id=2'), 'a=1; __Host-id=2');
  assert.equal(cookiesForUpstream(undefined), '');
});

test('rewrite: HTML attributes, srcset, base, meta tags, inline styles', async () => {
  const html = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<meta http-equiv="refresh" content="5; url=/next">
<link rel="stylesheet" href="/s.css" integrity="sha384-x">
<style>body{background:url('/bg.png')}</style>
</head><body>
<a href="https://other.org/x" target="_top">x</a>
<img src="cat.png" srcset="cat.png 1x, /cat2.png 2x">
<form action="/search" target="_blank"></form>
<div style="background-image:url(//cdn.net/i.png)"></div>
<script>var s = '<a href="/not-touched">';</script>
</body></html>`;
  const out = await rewriteHtml(html, page);

  assert.match(out, /<head><script src="\/_\/inject.js"><\/script>/);
  assert.match(out, /http-equiv="x-crush-removed-csp"/);
  assert.match(out, /content="5; url=\/p\/https\/example.com\/next"/);
  assert.match(out, /<link rel="stylesheet" href="\/p\/https\/example.com\/s.css">/);
  assert.match(out, /background:url\('\/p\/https\/example.com\/bg.png'\)/);
  assert.match(out, /<a href="\/p\/https\/other.org\/x" target="_self">/);
  assert.match(out, /src="\/p\/https\/example.com\/docs\/cat.png"/);
  assert.match(out, /srcset="\/p\/https\/example.com\/docs\/cat.png 1x, \/p\/https\/example.com\/cat2.png 2x"/);
  assert.match(out, /<form action="\/p\/https\/example.com\/search" target="_self">/);
  assert.match(out, /url\(\/p\/https\/cdn.net\/i.png\)/);
  assert.match(out, /'<a href="\/not-touched">'/, 'script contents are left alone');
});

test('rewrite: <base href> changes how later URLs resolve', async () => {
  const out = await rewriteHtml('<head><base href="https://cdn.example.net/assets/"></head><img src="a.png">', page);
  assert.match(out, /<base href="\/p\/https\/cdn.example.net\/assets\/">/);
  assert.match(out, /<img src="\/p\/https\/cdn.example.net\/assets\/a.png">/);
});

test('rewrite: inject script lands first even without a <head>', async () => {
  assert.match(await rewriteHtml('<p>hi</p>', page), /^<script src="\/_\/inject.js"><\/script><p>hi<\/p>$/);
  assert.match(await rewriteHtml('just text', page), /^<script src="\/_\/inject.js"><\/script>just text$/);
});

test('rewrite: untouched tags are copied byte-for-byte', async () => {
  const html = '<DIV   class=x data-a=\'1\'>ok</DIV><svg viewBox="0 0 1 1"></svg>';
  assert.equal(await rewriteHtml(html, page), `<script src="/_/inject.js"></script>${html}`);
});

test('rewrite: CSS url() and @import', () => {
  const css = `@import "theme.css"; @import url(/print.css) print;
.a { background: url("../img/a.png") } .b { background: url(data:image/png;base64,AAA=) }`;
  assert.equal(
    rewriteCss(css, page),
    `@import "/p/https/example.com/docs/theme.css"; @import url(/p/https/example.com/print.css) print;
.a { background: url("/p/https/example.com/img/a.png") } .b { background: url(data:image/png;base64,AAA=) }`,
  );
});
