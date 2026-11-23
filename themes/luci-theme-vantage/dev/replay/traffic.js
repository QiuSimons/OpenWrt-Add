'use strict';
/* Per-device traffic (--traffic): luci.vantage.traffic hosts answered as
   luci-app-vantage-traffic's rpcd plugin does on a router (#110), for
   the wired hosts the replay's own luci.vantage wired lists (after the
   other modes rewrote it), to develop the dashboard's side: the rate
   through this router for a host on a shared port. The session holds
   the package's ACL group. Without --traffic the object is absent and
   the group not held (server.js), as on a router without the package.

     luci.vantage.traffic hosts   SYNTHETIC, in the plugin's own form:
                                  one read every 5 s, shared by every
                                  call in between (at: ms since the
                                  replay started), counters that only
                                  grow, by MAC: a rate per host from a
                                  hash of its MAC, a fifth of them idle,
                                  about eight times as much to the host
                                  as from it

   No address of either end is in the answer, as in the plugin's. */

const fs = require('fs');
const path = require('path');

const ACL = path.join(__dirname, '../../luci-app-vantage-traffic/root/usr/share/rpcd/acl.d/luci-app-vantage-traffic.json');
const EVERY = 5000;
const T0 = Date.now();

/* the package's ACL file, for the session's groups */
function acl() {
	try { return JSON.parse(fs.readFileSync(ACL, 'utf8')); } catch (e) { return {}; }
}

/* deterministic noise in [0, 1) (as wired.js) */
function hash01(a, b) {
	let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
	return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
function smooth(seed, t, period) {
	const x = t / period, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
	return hash01(seed, i) * (1 - u) + hash01(seed, i + 1) * u;
}
/* bytes so far at a mean of `bps` bit/s, never falling */
function bytes(bps, seed, t) {
	const B = bps / 8, P = 20;
	return Math.round(B * t + 0.4 * B * P * smooth(seed, t, P));
}
function seedOf(mac) {
	let h = 0;
	for (const c of mac) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
	return h;
}

/* the answer for these wired hosts at ms since the start */
function answer(hosts, ms) {
	const at = Math.floor(ms / EVERY) * EVERY, t = at / 1000, seen = new Set(), out = [];
	for (const h of hosts) {
		const mac = h && typeof h.mac === 'string' ? h.mac.toLowerCase() : null;
		if (!mac || seen.has(mac)) continue;
		seen.add(mac);
		const seed = seedOf(mac), r = hash01(seed, 7);
		/* a fifth idle; the rest from 8 kbit/s to about 12 Mbit/s to the host */
		const down = r < 0.2 ? 0 : 8e3 * Math.pow(10, 3.2 * hash01(seed, 11));
		out.push({ mac, rx: 4e6 + bytes(down / 8, seed, t), tx: 3e7 + bytes(down, seed + 1, t) });
	}
	out.sort((a, b) => a.mac < b.mac ? -1 : 1);
	return { v: 1, at, took: 4, every: EVERY, slow: false, low: false, acct: true, entries: 24 * out.length + 40, partial: false,
		offloaded: 0, hw: 0, zeroed: 0, dropped: 0, hosts: out.slice(0, 512) };
}

/* wired: luci.vantage wired's reply as the replay sends it ({ result }).
   Returns the reply to send */
function transform(object, method, args, wired) {
	if (object !== 'luci.vantage.traffic' || method !== 'hosts') return { error: { code: -32601, message: 'Method not found' } };
	const w = wired && Array.isArray(wired.result) && wired.result[0] === 0 && wired.result[1] ? wired.result[1] : {};
	return { result: [ 0, answer(Array.isArray(w.hosts) ? w.hosts : [], Date.now() - T0) ] };
}

module.exports = { acl, answer, transform, EVERY };
