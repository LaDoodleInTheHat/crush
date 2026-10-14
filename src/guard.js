// SSRF guard: stop the proxy from being used to reach machines that are only
// reachable *from inside* your server.
//
// On AWS this is not optional. Every EC2 instance can read
// http://169.254.169.254/ -- the metadata service, which hands out the
// instance's IAM credentials. Without this file, anyone who can use the proxy
// could type that address and walk away with your AWS keys.
//
// Checking the hostname text isn't enough ("evil.example" can resolve to
// 127.0.0.1), so we check the IP addresses DNS returns, at the moment we
// connect. Node lets us swap in our own `lookup` function for exactly this.

import dns from 'node:dns';
import net from 'node:net';

const blocked = new net.BlockList();

for (const [address, bits] of [
  ['0.0.0.0', 8], //        "this network"
  ['10.0.0.0', 8], //       private (VPC)
  ['100.64.0.0', 10], //    carrier-grade NAT
  ['127.0.0.0', 8], //      loopback
  ['169.254.0.0', 16], //   link-local -- AWS metadata lives here
  ['172.16.0.0', 12], //    private (VPC)
  ['192.0.0.0', 24], //     IETF protocol assignments
  ['192.168.0.0', 16], //   private
  ['198.18.0.0', 15], //    benchmarking
  ['224.0.0.0', 4], //      multicast
  ['240.0.0.0', 4], //      reserved + broadcast
]) {
  blocked.addSubnet(address, bits, 'ipv4');
}

// No rule needed for IPv4-mapped addresses (::ffff:127.0.0.1): BlockList
// already checks those against the IPv4 rules above. (Adding ::ffff:0:0/96
// here would actually block *every* IPv4 address, for the same reason.)
for (const [address, bits] of [
  ['::', 127], //           unspecified + loopback (::1)
  ['64:ff9b::', 96], //     NAT64 (can embed any IPv4, including the ones above)
  ['100::', 64], //         discard
  ['fc00::', 7], //         unique local -- AWS IPv6 metadata is fd00:ec2::254
  ['fe80::', 10], //        link-local
  ['ff00::', 8], //         multicast
]) {
  blocked.addSubnet(address, bits, 'ipv6');
}

// Escape hatch for local testing only. Never set this on a public server.
const allowPrivate = () => process.env.CRUSH_UNSAFE_ALLOW_PRIVATE === '1';

export function isBlockedAddress(ip) {
  if (allowPrivate()) return false;
  const family = net.isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function blockedError(host, ip) {
  const err = new Error(`${host} points at a private address (${ip}), which this proxy refuses to visit.`);
  err.code = 'EBLOCKED';
  return err;
}

/**
 * Hostnames that are already IP literals skip DNS entirely (and so skip our
 * lookup hook), so they get checked up front.
 */
export function assertPublicHost(hostname) {
  const ip = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(ip) && isBlockedAddress(ip)) throw blockedError(hostname, ip);
}

/**
 * Drop-in replacement for dns.lookup. Node calls it right before opening a
 * socket, and connects to whatever address we hand back -- so the address we
 * checked is the address we use (no DNS-rebinding window).
 */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') [callback, options] = [options, {}];
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) return callback(blockedError(hostname, bad.address));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}
