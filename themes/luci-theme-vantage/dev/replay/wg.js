'use strict';
/* WireGuard tunnels (--wg): luci.wireguard getWgInstances answered as
   luci-proto-wireguard's rpcd plugin does on a router with two tunnels,
   to develop the dashboard's WireGuard tile (#129). Without --wg the
   replay answers that object as absent and its group as not held
   (server.js), as a device without the package does, unless the
   recording or a --fixtures plugin has the object.

     luci.wireguard getWgInstances   SYNTHETIC, in the plugin's own form
                                     (`wg show all dump` split by tabs:
                                     numbers as text, "(none)" and "off"
                                     for nothing, allowed IPs only beside
                                     an endpoint):
         wg0 (UDP 51820)   seven road-warrior peers: two with a session
                           and traffic, one with a session and none, two
                           whose last handshake is hours and days old,
                           two that never made one, one of them without
                           a description (it shows by its key)
         wg1 (UDP 51821)   one site-to-site peer with keepalive and
                           steady traffic, its endpoint an IPv6 address

   Counters grow with the clock; a peer with a session makes a handshake
   every two minutes, as WireGuard does while traffic flows. Keys are
   SHA-256 of a label (the form of a key, never one in use); addresses
   are documentation values, names invented. */

const crypto = require('crypto');

/* 32 bytes in base64, as a WireGuard public key */
const key = label => crypto.createHash('sha256').update('vantage-replay wg ' + label).digest('base64');

/* [ description, endpoint, allowed IPs, last handshake, down, up (bit/s,
   as the router receives and sends), keepalive ]. Last handshake: 'live'
   (a session: every 120 s), seconds ago when the replay started, or 0
   for never */
const TUNNELS = [
	{
		name: 'wg0', port: 51820,
		peers: [
			[ 'Mira phone', '198.51.100.20:40321', [ '192.0.2.200/32', '2001:db8:2::200/128' ], 'live', 180e3, 2.6e6, 0 ],
			[ 'workshop laptop', '203.0.113.77:51820', [ '192.0.2.201/32' ], 'live', 1.4e6, 14e6, 0 ],
			[ 'kitchen tablet', '198.51.100.141:3907', [ '192.0.2.202/32' ], 'live', 0, 0, 25 ],
			[ 'Jonas phone', '198.51.100.8:61002', [ '192.0.2.203/32' ], 3 * 3600 + 240, 0, 0, 0 ],
			[ 'backup NAS at the cabin', '203.0.113.130:51820', [ '192.0.2.204/32', '198.51.100.192/28' ], 2 * 86400 + 5 * 3600, 0, 0, 0 ],
			[ 'guest laptop', null, [ '192.0.2.205/32' ], 0, 0, 0, 0 ],
			[ null, null, [ '192.0.2.206/32' ], 0, 0, 0, 0 ]
		]
	},
	{
		name: 'wg1', port: 51821,
		peers: [ [ 'office site', '[2001:db8:51::1]:51820', [ '198.51.100.0/25', '2001:db8:51::/48' ], 'live', 6.2e6, 1.1e6, 25 ] ]
	}
];

/* the tunnels came up a day before the replay started */
const UP_S = 86400, T0 = Date.now() / 1000 - UP_S;

/* deterministic noise in [0, 1), smooth over `period` seconds (as multiwan.js) */
function hash01(a, b) {
	let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
	return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
function smooth(seed, t, period) {
	const x = t / period, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
	return hash01(seed, i) * (1 - u) + hash01(seed, i + 1) * u;
}
/* bytes so far at a mean of `bps` bit/s, never dropping (see wired.js) */
function bytes(bps, seed, t) {
	const B = bps / 8, P = 20;
	return Math.round(B * t + 0.4 * B * P * smooth(seed, t, P));
}

/* now: epoch seconds */
function instances(now) {
	const out = {}, t = now - T0;
	TUNNELS.forEach((tun, k) => {
		out[tun.name] = {
			name: tun.name, public_key: key(tun.name), listen_port: String(tun.port), fwmark: 'off',
			peers: tun.peers.map((p, i) => {
				const seed = 600 + k * 20 + i * 2, label = tun.name + ' peer ' + i;
				/* each peer's two minutes start at another second */
				const hs = p[3] === 'live' ? Math.floor(now) - Math.floor(t + 17 * (i + 1) + 40 * k) % 120 : p[3] ? Math.floor(T0 + UP_S - p[3]) : 0;
				return {
					/* its description in the configuration, if it has one */
					name: p[0], public_key: key(label), endpoint: p[1] || '(none)',
					allowed_ips: p[1] ? p[2].slice() : [],
					latest_handshake: String(hs),
					/* a peer that was here once has counted something */
					transfer_rx: String(p[3] ? 48e6 * (i + 1) + bytes(p[4], seed, t) : 0), transfer_tx: String(p[3] ? 310e6 * (i + 1) + bytes(p[5], seed + 1, t) : 0),
					persistent_keepalive: p[6] ? String(p[6]) : 'off'
				};
			})
		};
	});
	return out;
}

/* reply: { result: [ status, data ] } or null; returns the reply to send:
   the status call's is made here, any other is left as it is */
function transform(object, method, args, reply) {
	return object === 'luci.wireguard' && method === 'getWgInstances' ? { result: [ 0, instances(Date.now() / 1000) ] } : reply;
}

module.exports = { transform, instances, TUNNELS, key };
