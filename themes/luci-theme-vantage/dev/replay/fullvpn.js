'use strict';
/* A full-tunnel VPN (--fullvpn): the 'vpn' WireGuard interface gets an
   IPv4 default route in the main table at the interface's metric (0), as
   route_allowed_ips with 0.0.0.0/0 leaves it: the uplink's metric, so of
   the two the kernel keeps the tunnel's, added later (the stand-in's
   luci.vantage routes says so), to develop the network path's tunnel
   over the line. --wired has a 'vpn' on wg0; without one (the access
   point, --big) a SYNTHETIC one is added. Works with --multiwan.

   Replies are rewritten after the store (and --wired / --big /
   --multiwan) answered:
     network.interface dump   'vpn' with the default route; SYNTHETIC
                              'vpn' (wireguard, wg0) where there is none
     network.device status    SYNTHETIC wg0 counters where there are none
                              (about 40 Mbit/s down, 3 up)
   Added addresses are documentation ranges only. */

const VPN = { iface: 'vpn', dev: 'wg0', addr: '203.0.113.1', mask: 24, down: 40e6, up: 3e6 };
const ROUTE = { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0', source: '0.0.0.0/0' };

/* the tunnel came up an hour before the replay started (its uptime) */
const UP_S = 3600, T0 = Date.now() / 1000 - UP_S;

/* deterministic noise in [0, 1), smooth over `period` seconds */
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

function iface() {
	return {
		interface: VPN.iface, up: true, pending: false, available: true, autostart: true, dynamic: false, uptime: UP_S,
		proto: 'wireguard', device: VPN.dev, l3_device: VPN.dev, metric: 0, data: {},
		'ipv4-address': [ { address: VPN.addr, mask: VPN.mask } ], 'ipv6-address': [], 'dns-server': [], route: [ ROUTE ]
	};
}

function device(t) {
	const rx = bytes(VPN.down, 51, t), tx = bytes(VPN.up, 52, t);
	return {
		up: true, carrier: true, devtype: 'wireguard', type: 'Network device',
		statistics: { rx_bytes: rx, tx_bytes: tx, rx_packets: Math.round(rx / 900), tx_packets: Math.round(tx / 900), rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0 }
	};
}

/* reply: { result: [ status, data ] }; returns the reply to send */
function transform(object, method, args, reply) {
	const res = reply && reply.result;
	if (!Array.isArray(res) || res[0] !== 0 || !res[1] || typeof res[1] !== 'object') return reply;
	if (object === 'network.interface' && method === 'dump' && Array.isArray(res[1].interface)) {
		const list = res[1].interface;
		const has = list.some(i => i && i.interface === VPN.iface);
		const out = has
			? list.map(i => i && i.interface === VPN.iface ? Object.assign({}, i, { route: (Array.isArray(i.route) ? i.route : []).concat([ ROUTE ]) }) : i)
			: list.concat([ iface() ]);
		return { result: [ 0, Object.assign({}, res[1], { interface: out }) ] };
	}
	if (object === 'network.device' && method === 'status' && !(args && args.name) && !res[1][VPN.dev])
		return { result: [ 0, Object.assign({}, res[1], { [VPN.dev]: device(Date.now() / 1000 - T0) }) ] };
	return reply;
}

module.exports = { transform, VPN };
