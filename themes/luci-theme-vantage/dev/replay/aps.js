'use strict';
/* Paired access points (--aps): vantage.collector report answered as the
   collector service would with two access points reporting and a third
   offline, to develop the dashboard's branches for them (#127). Without
   --aps the replay answers that object as absent (server.js), as a
   device with none paired does: the collector service is not running.

   Replies are rewritten after the store (and the other modes) answered:
     vantage.collector report  SYNTHETIC: ap-hall (two SSIDs, seven
                               stations, three wired hosts and ap-den
                               in its lan1), ap-den (one SSID, three
                               stations, one wired host) and
                               ap-loft, offline: not reachable for six
                               minutes, so without a report
     luci-rpc getHostHints     SYNTHETIC names and addresses for most of
                               their stations and for the two access
                               points themselves, as a router's leases
                               give
     luci.vantage wired        SYNTHETIC: ap-hall's own MAC, and
                               ap-den's (plugged into ap-hall, so drawn
                               under it), beside this
                               device's first two wired hosts, which
                               ap-hall also lists: the first as its wired
                               host (the note "behind ap-hall"), the
                               second as its station (it moves to the
                               Wi-Fi list, as on a router with wired
                               access points)
   Station traffic moves a little on every call. pair-plugin.js starts
   with these three paired, from APS: the same names, addresses and MACs
   (a report's `mac` is the one recorded at pairing), and its ids, the
   first 16 hex digits of SHA-256 of "vantage-replay id <name>".
   Addresses and MACs are documentation values, names and SSIDs
   invented. */

const crypto = require('crypto');

const id = name => crypto.createHash('sha256').update('vantage-replay id ' + name).digest('hex').slice(0, 16);

/* [ mac, ifname, signal (dBm), link rx, tx (kbit/s), traffic rx, tx (bit/s), hint name, last octet ] */
const APS = [
	{
		name: 'ap-hall', addr: '192.0.2.10', mac: '02:00:5e:10:00:01', model: 'Example AX3000', host: 'OpenWrt',
		ssids: [
			{ ifname: 'phy0-ap0', bssid: '02:00:5e:10:01:10', ssid: 'Harbor', freq: 2437, channel: 6, band: '2g' },
			{ ifname: 'phy1-ap0', bssid: '02:00:5e:10:01:11', ssid: 'Harbor-5G', freq: 5180, channel: 36, band: '5g' }
		],
		stations: [
			[ '02:00:5e:20:00:01', 'phy1-ap0', -52, 1200950, 1080600, 2.4e6, 38e6, 'hall-laptop', 201 ],
			[ '02:00:5e:20:00:02', 'phy1-ap0', -61, 576500, 648500, 180e3, 6.2e6, 'living-tv', 202 ],
			[ '02:00:5e:20:00:03', 'phy1-ap0', -67, 286800, 360300, 48e3, 410e3, 'kitchen-tablet', 203 ],
			[ '02:00:5e:20:00:04', 'phy1-ap0', -73, 144400, 173300, 9e3, 22e3, null, 204 ],
			[ '02:00:5e:20:00:05', 'phy0-ap0', -58, 72200, 86700, 2e3, 6e3, 'hall-thermostat', 205 ],
			[ '02:00:5e:20:00:06', 'phy0-ap0', -79, 26000, 39000, 600, 1.4e3, 'garden-sensor', 206 ],
			/* this device's second wired host (shared()) */
			[ null, 'phy1-ap0', -63, 400000, 433300, 120e3, 2.4e6, null, null ]
		],
		/* [ mac, port, Mbit/s, rx, tx (bit/s, a port with one host only),
		   hint name, last octet ]; the first is the host this device hears
		   too (shared()) */
		wired: [
			[ null, 'lan2', 1000, null, null ],
			[ '02:00:5e:30:00:01', 'lan3', 1000, 85e3, 1.2e6, 'office-printer', 211 ],
			[ '02:00:5e:30:00:02', 'lan4', 100, 3e3, 12e3, null, 212 ],
			/* ap-den */
			[ '02:00:5e:10:00:02', 'lan1', 1000, null, null ]
		]
	},
	{
		name: 'ap-den', addr: '192.0.2.11', mac: '02:00:5e:10:00:02', model: 'Example AC1200', host: 'den',
		ssids: [ { ifname: 'phy1-ap0', bssid: '02:00:5e:10:02:11', ssid: 'Harbor-5G', freq: 5745, channel: 149, band: '5g' } ],
		stations: [
			[ '02:00:5e:20:00:11', 'phy1-ap0', -55, 866700, 866700, 12e6, 95e6, 'den-desktop', 221 ],
			[ '02:00:5e:20:00:12', 'phy1-ap0', -64, 390000, 433300, 60e3, 1.1e6, 'den-phone', 222 ],
			[ '02:00:5e:20:00:13', 'phy1-ap0', -70, 175500, 200000, 4e3, 9e3, null, 223 ]
		],
		wired: [ [ '02:00:5e:30:00:11', 'lan1', 1000, 640e3, 22e6, 'den-nas', 231 ] ]
	},
	/* its last report `offline` seconds ago: the collector has none to show */
	{ name: 'ap-loft', addr: '198.51.100.12', mac: '02:00:5e:10:00:03', offline: 360 }
];

/* when the replay started, as the access points' uptime counts */
const T0 = Date.now() / 1000 - 5 * 86400;

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
/* a rate that moves around its mean, 70 to 130 % */
const near = (bps, seed, t) => bps == null ? null : Math.round(bps * (0.7 + 0.6 * smooth(seed, t, 15)));

/* the first two of this device's wired hosts on one port (the stand-in's
   synthetic bridge entries), the ones ap-hall lists too */
function shared(hosts) {
	const ok = Array.isArray(hosts) ? hosts.filter(x => x && typeof x.mac === 'string' && typeof x.port === 'string') : [];
	const on = ok.filter(x => ok[0] && x.port === ok[0].port).slice(0, 2);
	return on.length ? { macs: on.map(x => x.mac.toLowerCase()), port: on[0].port, bridge: on[0].bridge } : null;
}
let heard = null;

function report(t) {
	return { aps: APS.map((a, k) => {
		/* as the collector: offline is a fetch that could not reach it */
		if (a.offline) return { id: id(a.name), name: a.name, addr: a.addr, state: 'offline', error: 'unreachable', age: a.offline, report: null };
		const rep = {
			name: a.host, model: a.model, uptime: Math.floor(t - T0) + 3600 * (k + 1), mac: a.mac,
			ssids: a.ssids.map(s => Object.assign({}, s)),
			stations: a.stations.map((s, i) => ({ mac: s[0] || (heard && heard.macs[1]), ifname: s[1], signal: s[2] + Math.round(3 * smooth(100 + k * 10 + i, t, 20) - 1.5),
				rxRate: s[3], txRate: s[4], rx: near(s[5], 200 + k * 10 + i, t), tx: near(s[6], 300 + k * 10 + i, t), connected: Math.floor(t - T0) % (3600 * (i + 1)) }))
				.filter(x => typeof x.mac === 'string'),
			wired: a.wired.map((w, i) => ({ mac: w[0] || (heard && heard.macs[0]), port: w[1], speed: w[2], rx: near(w[3], 400 + k * 10 + i, t), tx: near(w[4], 500 + k * 10 + i, t) }))
				.filter(w => typeof w.mac === 'string')
		};
		/* a report every 10 s */
		return { id: id(a.name), name: a.name, addr: a.addr, state: 'ok', error: null, age: Math.floor(t) % 10, report: rep };
	}) };
}

function hints() {
	const out = {};
	for (const a of APS.filter(x => !x.offline)) {
		/* the access point itself: its lease */
		out[a.mac.toUpperCase()] = { name: a.name, ipaddrs: [ a.addr ], ip6addrs: [] };
		for (const x of a.stations.concat(a.wired))
			if (x[0] && x[x.length - 1]) out[x[0].toUpperCase()] = Object.assign({ ipaddrs: [ '192.0.2.' + x[x.length - 1] ], ip6addrs: [] }, x[x.length - 2] ? { name: x[x.length - 2] } : {});
	}
	return out;
}

/* reply: { result: [ status, data ] } from the store and the other modes;
   returns the reply to send */
function transform(object, method, args, reply) {
	if (object === 'vantage.collector')
		return method === 'report' ? { result: [ 0, report(Date.now() / 1000) ] } : { error: { code: -32601, message: 'Method not found' } };
	const res = reply && reply.result;
	if (!Array.isArray(res) || res[0] !== 0 || !res[1] || typeof res[1] !== 'object') return reply;
	if (object === 'luci-rpc' && method === 'getHostHints')
		return { result: [ 0, Object.assign({}, res[1], hints()) ] };
	if (object === 'luci.vantage' && method === 'wired' && Array.isArray(res[1].hosts)) {
		heard = shared(res[1].hosts);
		if (!heard) return reply;
		const own = APS.slice(0, 2).map(a => ({ mac: a.mac, port: heard.port, bridge: heard.bridge || null, vlan: null, seen: Math.floor(Date.now() / 1000) % 20 }));
		return { result: [ 0, Object.assign({}, res[1], { hosts: res[1].hosts.concat(own) }) ] };
	}
	return reply;
}

module.exports = { transform, APS, id };
