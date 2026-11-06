'use strict';
/* A second line to the internet (--multiwan): beside the recorded uplink
   (or --wired's wan), a backup WAN with a default route of a higher
   metric, as plain failover and mwan3 leave it, to develop the network
   path's other lines. Works on top of --wired and --big.

   Replies are rewritten after the store (and --wired / --big) answered:
     network.interface dump   SYNTHETIC 'wanb' (dhcp, eth9) with an IPv4
                              default route of metric 20, and 'wanb6'
                              (dhcpv6) on the same device: one line
     network.device status    SYNTHETIC eth9 with counters growing with
                              the clock (about 30 Mbit/s down, 4 up)
   Added addresses are documentation ranges only. */

const LINE = {
	iface: 'wanb', iface6: 'wanb6', dev: 'eth9', speed: '1000F', metric: 20,
	addr: '203.0.113.202', mask: 29, gateway: '203.0.113.201',
	addr6: '2001:db8:b::2', mask6: 64, dns: [ '203.0.113.53' ],
	down: 30e6, up: 4e6
};

/* the line came up an hour before the replay started (its uptime) */
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

function ifaces() {
	const base = { up: true, pending: false, available: true, autostart: true, dynamic: false, uptime: UP_S, device: LINE.dev, l3_device: LINE.dev, data: {} };
	return [
		Object.assign({}, base, {
			interface: LINE.iface, proto: 'dhcp', metric: LINE.metric,
			'ipv4-address': [ { address: LINE.addr, mask: LINE.mask } ], 'ipv6-address': [],
			route: [ { target: '0.0.0.0', mask: 0, nexthop: LINE.gateway, source: LINE.addr + '/32' } ], 'dns-server': LINE.dns
		}),
		Object.assign({}, base, {
			interface: LINE.iface6, proto: 'dhcpv6', metric: LINE.metric,
			'ipv4-address': [], 'ipv6-address': [ { address: LINE.addr6, mask: LINE.mask6 } ],
			route: [ { target: '::', mask: 0, nexthop: 'fe80::1', source: '::/0' } ], 'dns-server': []
		})
	];
}

function device(t) {
	const rx = bytes(LINE.down, 41, t), tx = bytes(LINE.up, 42, t);
	return {
		up: true, carrier: true, devtype: 'ethernet', type: 'Network device', speed: LINE.speed, macaddr: '00:00:5e:00:53:e1',
		statistics: { rx_bytes: rx, tx_bytes: tx, rx_packets: Math.round(rx / 900), tx_packets: Math.round(tx / 900), rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0 }
	};
}

/* reply: { result: [ status, data ] }; returns the reply to send */
function transform(object, method, args, reply) {
	const res = reply && reply.result;
	if (!Array.isArray(res) || res[0] !== 0 || !res[1] || typeof res[1] !== 'object') return reply;
	if (object === 'network.interface' && method === 'dump' && Array.isArray(res[1].interface)) {
		const kept = res[1].interface.filter(i => !(i && (i.interface === LINE.iface || i.interface === LINE.iface6)));
		return { result: [ 0, Object.assign({}, res[1], { interface: kept.concat(ifaces()) }) ] };
	}
	if (object === 'network.device' && method === 'status' && !(args && args.name))
		return { result: [ 0, Object.assign({}, res[1], { [LINE.dev]: device(Date.now() / 1000 - T0) }) ] };
	return reply;
}

module.exports = { transform, LINE };
