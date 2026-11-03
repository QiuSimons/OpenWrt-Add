'use strict';
/* A bigger access point (--big): the recorded device served as a
   quad-radio Wi-Fi 7 access point with ten networks, 74 stations and six
   wired ports, one with a switch and one with a second access point
   behind it, and eth1.1, VLAN 1 of a swconfig switch (switch0, three of
   its four ports with a link), to see the dashboard with a deep path and
   long lists.

   Replies are rewritten after the store answers (whatever it answered):
     luci.vantage wireless,   SYNTHETIC radios: 2.4 GHz (Wi-Fi 6), 5 GHz
     network.wireless status  low and high, 6 GHz (320 MHz), ten networks
     iwinfo info/assoclist,   per network: channel, power, its stations
     hostapd.<if> get_clients/get_status   with counters growing with
                              the clock; airtime per radio
     network.device status    the networks' and ports' counters (sums of
                              their stations' and hosts'); eth0 carries
                              most of it to the gateway; lan1..lan5 and
                              eth1.1 are bridge members of br-lan
     luci.vantage wired       SYNTHETIC hosts on lan1..lan5 and eth1.1,
                              the gateway on eth0, and switch0's ports
                              behind eth1.1 (switches)
     luci getSwconfigPortState  switch0's link state
     luci-rpc getHostHints    names and addresses of all of them
   The recorded LAN (the interface with the default route) gives the
   addresses their first three octets and the gateway's; documentation
   values otherwise. Added MACs and addresses are documentation ranges. */

const RADIOS = [
	{ id: 'radio0', band: '2g', channel: 1, htmode: 'HE20', freq: 2412, centre: 1, txpower: 20, noise: -92, phy: 'phy0', util: 150 },
	{ id: 'radio1', band: '5g', channel: 36, htmode: 'EHT160', freq: 5180, centre: 50, txpower: 23, noise: -95, phy: 'phy1', util: 95 },
	{ id: 'radio2', band: '6g', channel: 37, htmode: 'EHT320', freq: 6135, centre: 31, txpower: 23, noise: -97, phy: 'phy2', util: 45 },
	{ id: 'radio3', band: '5g', channel: 149, htmode: 'EHT80', freq: 5745, centre: 155, txpower: 26, noise: -94, phy: 'phy3', util: 70 }
];

/* [ ifname, radio, section, SSID, encryption, ieee80211w, hidden ] */
const NETS = [
	[ 'phy0-ap0', 'radio0', 'home2g', 'Harbor', 'sae-mixed', 1 ],
	[ 'phy0-ap1', 'radio0', 'guest2g', 'Harbor-Guest', 'psk2', 0 ],
	[ 'phy0-ap2', 'radio0', 'iot2g', 'Harbor-IoT', 'psk2', 0 ],
	[ 'phy1-ap0', 'radio1', 'home5g', 'Harbor', 'sae-mixed', 1 ],
	[ 'phy1-ap1', 'radio1', 'guest5g', 'Harbor-Guest', 'psk2', 0 ],
	[ 'phy1-ap2', 'radio1', 'media5g', 'Harbor-Media', 'sae-mixed', 1 ],
	[ 'phy2-ap0', 'radio2', 'home6g', 'Harbor-6E', 'sae', 2 ],
	[ 'phy2-ap1', 'radio2', 'mlo6g', 'Harbor-MLO', 'sae', 2 ],
	[ 'phy3-ap0', 'radio3', 'backhaul', 'Harbor-Backhaul', 'sae', 2, true ],
	[ 'phy3-ap1', 'radio3', 'office5g', 'Harbor-Office', 'sae-mixed', 1 ]
];

/* per network: [ name (null: none, a private MAC), standard, bit/s to it,
   bit/s from it, signal ] */
const STATIONS = {
	'phy0-ap0': [
		[ 'kitchen-tablet', 'he', 1.2e6, 1e5, -58 ], [ 'phone-pixel', 'he', 8e5, 6e4, -64 ], [ null, 'he', 3e5, 2e4, -70 ],
		[ 'thinkpad-x1', 'he', 2.5e6, 4e5, -61 ], [ 'kitchen-speaker', 'ht', 1.5e5, 1e4, -55 ], [ 'tablet-galaxy', 'he', 6e5, 5e4, -67 ],
		[ 'old-laptop', 'ht', 4e5, 6e4, -74 ], [ null, 'he', 5e4, 8e3, -79 ], [ 'garage-sensor', 'ht', 1e4, 4e3, -83 ]
	],
	'phy0-ap1': [
		[ 'guest-phone', 'he', 9e5, 1e5, -66 ], [ null, 'he', 2e5, 3e4, -71 ], [ 'visitor-laptop', 'ht', 1.5e6, 2e5, -69 ], [ null, 'he', 4e4, 6e3, -77 ]
	],
	'phy0-ap2': [
		[ 'thermostat', 'ht', 8e3, 4e3, -61 ], [ 'smoke-alarm', 'ht', 3e3, 2e3, -72 ], [ 'light-bridge', 'ht', 2e4, 1e4, -57 ],
		[ 'doorbell-cam', 'ht', 6e4, 1.4e6, -75 ], [ 'plug-kitchen', 'ht', 2e3, 1e3, -63 ], [ 'plug-desk', 'ht', 2e3, 1e3, -59 ],
		[ 'plug-tv', 'ht', 2e3, 1e3, -66 ], [ 'robot-vacuum', 'ht', 3e4, 2e4, -70 ], [ 'weather-station', 'ht', 5e3, 3e3, -81 ],
		[ 'camera-porch', 'ht', 5e4, 1.8e6, -73 ], [ 'camera-garden', 'ht', 5e4, 1.2e6, -80 ], [ 'sprinkler', 'ht', 1e3, 1e3, -78 ],
		[ 'washer', 'ht', 2e3, 1e3, -69 ], [ 'fridge', 'ht', 2e3, 1e3, -64 ]
	],
	'phy1-ap0': [
		[ 'macbook-pro', 'eht', 45e6, 4e6, -48 ], [ 'iphone', 'he', 6e6, 5e5, -55 ], [ 'ipad-air', 'he', 3e6, 3e5, -60 ],
		[ 'pixel-8', 'he', 2e6, 2e5, -57 ], [ 'surface-laptop', 'he', 8e6, 9e5, -62 ], [ 'work-laptop', 'he', 12e6, 3e6, -59 ],
		[ 'handheld-console', 'he', 22e6, 4e5, -63 ], [ null, 'he', 4e5, 5e4, -70 ], [ null, 'eht', 1e6, 1e5, -66 ],
		[ 'ereader', 'vht', 5e4, 1e4, -72 ], [ 'game-console', 'vht', 4e6, 3e5, -68 ], [ 'galaxy-s24', 'eht', 5e6, 6e5, -54 ],
		[ 'smartwatch', 'he', 2e4, 1e4, -71 ], [ 'kitchen-display', 'vht', 3e5, 2e4, -60 ], [ 'chromebook', 'vht', 1.8e6, 2e5, -73 ],
		[ null, 'he', 1e5, 2e4, -80 ]
	],
	'phy1-ap1': [
		[ 'guest-iphone', 'he', 3e6, 3e5, -64 ], [ 'guest-laptop', 'vht', 6e6, 7e5, -69 ], [ null, 'he', 5e5, 6e4, -75 ],
		[ null, 'he', 1e5, 2e4, -78 ], [ 'guest-tablet', 'vht', 1e6, 1e5, -71 ]
	],
	'phy1-ap2': [
		[ 'living-room-tv', 'vht', 38e6, 5e5, -56 ], [ 'bedroom-tv', 'vht', 18e6, 3e5, -67 ], [ 'chromecast', 'vht', 9e6, 2e5, -62 ],
		[ 'apple-tv', 'he', 26e6, 4e5, -52 ], [ 'soundbar', 'vht', 3e5, 2e4, -60 ], [ 'projector', 'vht', 0, 0, -76 ]
	],
	'phy2-ap0': [
		[ 'workstation', 'eht', 180e6, 22e6, -46 ], [ 'pixel-9-pro', 'eht', 14e6, 1e6, -58 ], [ 'galaxy-s25', 'eht', 8e6, 8e5, -61 ],
		[ 'ipad-pro', 'he', 6e6, 5e5, -63 ], [ 'framework-laptop', 'he', 30e6, 2e6, -57 ], [ 'vr-headset', 'he', 40e6, 6e6, -55 ],
		[ null, 'eht', 3e5, 4e4, -74 ]
	],
	'phy2-ap1': [
		[ 'mlo-laptop', 'eht', 95e6, 8e6, -51 ], [ 'mlo-phone', 'eht', 7e6, 6e5, -62 ], [ 'mlo-tablet', 'eht', 3e6, 3e5, -66 ]
	],
	'phy3-ap0': [
		[ 'mesh-attic', 'eht', 60e6, 12e6, -64 ], [ 'mesh-garage', 'eht', 25e6, 4e6, -71 ]
	],
	'phy3-ap1': [
		[ 'office-desktop', 'he', 15e6, 2e6, -55 ], [ 'meeting-room-tv', 'vht', 6e6, 2e5, -63 ], [ 'office-printer', 'ht', 5e4, 2e4, -66 ],
		[ 'docking-station', 'he', 9e6, 1e6, -58 ], [ 'desk-phone-1', 'vht', 9e4, 9e4, -62 ], [ 'desk-phone-2', 'vht', 9e4, 9e4, -69 ],
		[ null, 'he', 5e5, 6e4, -73 ], [ 'scanner', 'vht', 2e4, 3e5, -75 ]
	]
};

/* wired ports of br-lan, after eth0 (the uplink) */
const PORTS = [
	{ dev: 'lan1', speed: '1000F' }, { dev: 'lan2', speed: '2500F' }, { dev: 'lan3', speed: '1000F' },
	{ dev: 'lan4', speed: '100F' }, { dev: 'lan5', speed: '2500F' },
	/* a VLAN on a swconfig switch: its speed is the CPU port's */
	{ dev: 'eth1.1', speed: '10000F', devtype: 'vlan' }
];

/* switch0 as luci.vantage wired reports it behind eth1.1, and its link
   state as LuCI's getSwconfigPortState answers (port 5: the CPU's) */
const SWITCH = { name: 'switch0', vlan: 1, ports: [ 0, 1, 2, 3 ].map(n => ({ num: n, role: 'lan', index: n + 1 })) };
const SWITCH_STATE = [ [ 0, false, 0 ], [ 1, true, 2500 ], [ 2, true, 1000 ], [ 3, true, 1000 ], [ 4, false, 0 ], [ 5, true, 10000 ] ]
	.map(p => ({ port: p[0], duplex: p[1], speed: p[2], link: p[1], auto: p[1] && p[0] !== 5, rxflow: false, txflow: false }));

/* [ port, name, bit/s to it, bit/s from it ]: lan3 has a switch behind
   it, lan5 a second access point */
const WIRED = [
	[ 'lan1', 'desktop', 120e6, 9e6 ],
	[ 'lan2', 'nas', 30e6, 210e6 ],
	[ 'lan3', 'office-switch', 1e4, 1e4 ], [ 'lan3', 'laser-printer', 2e5, 2e4 ], [ 'lan3', 'voip-base', 9e4, 9e4 ],
	[ 'lan3', 'nvr', 1e5, 8e6 ], [ 'lan3', 'game-console-2', 25e6, 1e6 ], [ 'lan3', 'zigbee-hub', 1e4, 1e4 ], [ 'lan3', null, 3e5, 4e4 ],
	[ 'lan4', 'ups-monitor', 2e3, 2e3 ],
	[ 'lan5', 'ap-upstairs', 5e4, 5e4 ], [ 'lan5', 'upstairs-tv', 22e6, 3e5 ], [ 'lan5', null, 2e6, 3e5 ],
	[ 'eth1.1', 'media-server', 40e6, 2e6 ], [ 'eth1.1', 'printer-upstairs', 1e4, 1e4 ], [ 'eth1.1', 'tv-box', 15e6, 2e5 ]
];

/* the share of station and host traffic that crosses the uplink (the rest
   stays on the LAN) */
const UPLINK_SHARE = 0.8;

/* counters start an hour before the replay did, so they stay well within
   a double's integers */
const T0 = Date.now() / 1000 - 3600;

/* the recorded LAN: first three octets and the gateway, learned from the
   network.interface dump that passes through */
const lan = { prefix: '192.0.2', gateway: null };

function hash01(a, b) {
	let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
	return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
function smooth(seed, t, period) {
	const x = t / period, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
	return hash01(seed, i) * (1 - u) + hash01(seed, i + 1) * u;
}
/* bytes so far at a mean of `bps` bit/s: a slope plus a bounded wobble
   whose derivative stays below the slope, so the counter never drops */
function bytes(bps, seed, t) {
	const B = bps / 8, P = 20;
	return Math.round(B * t + 0.4 * B * P * smooth(seed, t, P));
}
const hex = n => (n < 16 ? '0' : '') + n.toString(16);

/* every station once: { mac, name, ifname, radio, std, down, up, signal, seed } */
const STA = [];
NETS.forEach(n => {
	(STATIONS[n[0]] || []).forEach(s => {
		const i = STA.length;
		STA.push({
			/* named ones on the documentation block, the others private
			   (locally administered) as phones randomise them */
			mac: s[0] ? '00:00:5e:00:53:' + hex(0x40 + i) : '02:00:5e:10:00:' + hex(0x40 + i),
			name: s[0], ifname: n[0], radio: n[1], std: s[1], down: s[2], up: s[3], signal: s[4], seed: 100 + 2 * i, ip: 100 + i
		});
	});
});
const HOSTS = WIRED.map((w, i) => ({
	mac: w[1] ? '00:00:5e:00:53:' + hex(0xc0 + i) : '02:00:5e:10:00:' + hex(0xc0 + i),
	port: w[0], name: w[1], down: w[2], up: w[3], seed: 400 + 2 * i, ip: 20 + i
}));
const GATEWAY_MAC = '00:00:5e:00:53:fe';

function radioOf(id) { return RADIOS.filter(r => r.id === id)[0]; }
function netOf(ifname) { return NETS.filter(n => n[0] === ifname)[0] || null; }
function bssid(ifname) { return '02:00:5e:20:00:' + hex(NETS.indexOf(netOf(ifname)) + 1); }
function now() { return Date.now() / 1000 - T0; }

/* the PHY rate in kbit/s of a station's standard, the width it gets and
   its signal: two streams at the top MCS, scaled down with the signal */
function phy(sta, wobble) {
	const r = radioOf(sta.radio), rw = +(r.htmode.match(/\d+$/) || [ 20 ])[0];
	const mhz = sta.std === 'ht' ? 20 : sta.std === 'vht' ? Math.min(80, rw) : sta.std === 'he' ? Math.min(160, rw) : rw;
	const per20 = { ht: 72.2, vht: 86.7, he: 143.4, eht: 172.1 }[sta.std];
	const q = Math.max(0.12, Math.min(1, (sta.signal + wobble + 92) / 44));
	return { mhz: mhz, rate: Math.round(per20 * mhz / 20 * 2 * q * 10) * 100, mcs: Math.max(0, Math.round(q * (sta.std === 'eht' ? 13 : sta.std === 'he' ? 11 : sta.std === 'vht' ? 9 : 7))), nss: 2 };
}

function stationAt(sta, t) {
	const wob = Math.round(6 * (smooth(sta.seed, t, 15) - 0.5));
	const p = phy(sta, wob), flags = { ht: sta.std === 'ht', vht: sta.std === 'vht', he: sta.std === 'he', eht: sta.std === 'eht' };
	const tx = bytes(sta.down, sta.seed, t), rx = bytes(sta.up, sta.seed + 1, t);
	return {
		mac: sta.mac.toUpperCase(), signal: sta.signal + wob, signal_avg: sta.signal, noise: radioOf(sta.radio).noise,
		inactive: sta.down + sta.up > 1e5 ? 0 : Math.floor(hash01(sta.seed, Math.floor(t / 5)) * 9000),
		connected_time: Math.floor(t + 600 * (sta.seed % 7)), thr: 0, authorized: true, authenticated: true, preamble: 'long', wme: true,
		mfp: sta.std !== 'ht', tdls: false,
		rx: Object.assign({ drop_misc: 0, packets: Math.round(rx / 700), bytes: rx, mhz: p.mhz, rate: Math.round(p.rate * 0.85 / 100) * 100, mcs: Math.max(0, p.mcs - 1), nss: p.nss }, flags),
		tx: Object.assign({ failed: Math.round(tx / 9e5), retries: Math.round(tx / 4e5), packets: Math.round(tx / 1200), bytes: tx, mhz: p.mhz, rate: p.rate, mcs: p.mcs, nss: p.nss }, flags)
	};
}

function counters(rx, tx) {
	return { rx_bytes: rx, tx_bytes: tx, rx_packets: Math.round(rx / 900), tx_packets: Math.round(tx / 900), rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0, multicast: 0, collisions: 0 };
}
function sumBytes(list, t) {
	let rx = 0, tx = 0;
	list.forEach(s => { tx += bytes(s.down, s.seed, t); rx += bytes(s.up, s.seed + 1, t); });
	return [ rx, tx ];
}

function wireless() {
	const out = {};
	RADIOS.forEach(r => {
		out[r.id] = {
			up: true, pending: false, disabled: false, autostart: true, retry_setup_failed: false,
			config: { band: r.band, channel: String(r.channel), htmode: r.htmode, country: 'US', txpower: r.txpower, disabled: false },
			interfaces: NETS.filter(n => n[1] === r.id).map(n => ({
				ifname: n[0], section: n[2],
				config: { ssid: n[3], mode: 'ap', hidden: n[6] ? true : null, encryption: n[4], ieee80211w: n[5], ieee80211r: null, ieee80211k: null, ieee80211v: null, network: [ 'lan' ], macaddr: bssid(n[0]) }
			}))
		};
	});
	return out;
}

function iwinfo(ifname) {
	const n = netOf(ifname), r = radioOf(n[1]);
	const sae = /sae/.test(n[4]);
	return {
		phy: r.phy, ssid: n[3], bssid: bssid(ifname).toUpperCase(), country: 'US', mode: 'Master',
		channel: r.channel, center_chan1: r.centre, frequency: r.freq, txpower: r.txpower, quality_max: 70, noise: r.noise,
		encryption: { enabled: true, wpa: n[4] === 'sae' ? [ 3 ] : sae ? [ 2, 3 ] : [ 2 ], authentication: n[4] === 'sae' ? [ 'sae' ] : sae ? [ 'psk', 'sae' ] : [ 'psk' ], ciphers: [ 'ccmp' ] },
		htmodes: r.band === '2g' ? [ 'HT20', 'HT40', 'HE20', 'HE40' ] : [ 'HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'VHT160', 'HE20', 'HE40', 'HE80', 'HE160', 'EHT20', 'EHT40', 'EHT80', 'EHT160' ].concat(r.band === '6g' ? [ 'EHT320' ] : []),
		hwmodes: r.band === '2g' ? [ 'b', 'g', 'n', 'ax' ] : r.band === '6g' ? [ 'ax', 'be' ] : [ 'a', 'n', 'ac', 'ax', 'be' ],
		hwmode: /^EHT/.test(r.htmode) ? 'be' : 'ax', htmode: r.htmode, hardware: { id: [ 0, 0, 0, 0 ], name: 'Generic MAC80211' }
	};
}

function hapdClients(ifname, t) {
	const clients = {};
	STA.filter(s => s.ifname === ifname).forEach(s => {
		const a = stationAt(s, t);
		clients[s.mac] = {
			auth: true, assoc: true, authorized: true, preauth: false, wds: false, wmm: true,
			ht: true, vht: s.std !== 'ht' && radioOf(s.radio).band !== '2g', he: s.std === 'he' || s.std === 'eht', eht: s.std === 'eht',
			wps: false, mfp: s.std !== 'ht', mbo: s.std === 'he' || s.std === 'eht', rrm: [ s.std === 'ht' ? 0 : 0x73, 0, 0, 0, 0 ], extended_capabilities: [],
			aid: 1 + STA.indexOf(s) % 2007, bytes: { rx: a.rx.bytes, tx: a.tx.bytes }, packets: { rx: a.rx.packets, tx: a.tx.packets },
			rate: { rx: a.rx.rate * 100, tx: a.tx.rate * 100 }, signal: a.signal, capabilities: {}
		};
	});
	return { freq: radioOf(netOf(ifname)[1]).freq, clients: clients };
}

function hapdStatus(ifname, t) {
	const n = netOf(ifname), r = radioOf(n[1]);
	const util = Math.round(r.util * (0.8 + 0.4 * smooth(r.channel, t, 30)));
	return {
		status: 'ENABLED', bssid: bssid(ifname), ssid: n[3], freq: r.freq, channel: r.channel, op_class: { '2g': 81, '5g': 128, '6g': 137 }[r.band],
		beacon_interval: 100, bss_color: 1 + RADIOS.indexOf(r) * 9, phy: r.phy,
		/* busy time is cumulative: grow it at the radio's mean load, so it
		   never falls between polls while the utilisation moves */
		airtime: { time: Math.round(t * 1e6), time_busy: Math.round(t * 1e6 * r.util / 255), utilization: util },
		dfs: { cac_seconds: 0, cac_active: false, cac_seconds_left: 0 }
	};
}

function devices(recorded, t) {
	const out = Object.assign({}, recorded);
	NETS.forEach(n => {
		const s = sumBytes(STA.filter(x => x.ifname === n[0]), t);
		out[n[0]] = { external: true, present: true, type: 'Network device', devtype: 'wlan', up: true, carrier: true, macaddr: bssid(n[0]), statistics: counters(s[0], s[1]) };
	});
	PORTS.forEach(p => {
		const s = sumBytes(HOSTS.filter(h => h.port === p.dev), t);
		out[p.dev] = { external: false, present: true, type: 'Network device', devtype: p.devtype || 'ethernet', up: true, carrier: true, speed: p.speed, statistics: counters(s[0], s[1]) };
	});
	/* the uplink carries most of the stations' and hosts' traffic: from
	   the gateway what goes to them, to it what they send */
	const all = sumBytes(STA.concat(HOSTS), t);
	out.eth0 = Object.assign({}, recorded.eth0 || {}, { present: true, up: true, carrier: true, devtype: 'ethernet', speed: '2500F',
		statistics: counters(Math.round(all[1] * UPLINK_SHARE), Math.round(all[0] * UPLINK_SHARE)) });
	out['br-lan'] = Object.assign({}, recorded['br-lan'] || {}, { type: 'bridge', devtype: 'bridge', up: true, carrier: true,
		'bridge-members': [ 'eth0' ].concat(PORTS.map(p => p.dev), NETS.map(n => n[0])) });
	return out;
}

function fdb(t) {
	return HOSTS.map((h, i) => ({ mac: h.mac, port: h.port, bridge: 'br-lan', vlan: null, seen: h.down + h.up > 1e5 ? 0 : Math.floor(t * (i + 3)) % (40 + 30 * i) }))
		.concat([ { mac: GATEWAY_MAC, port: 'eth0', bridge: 'br-lan', vlan: null, seen: 0 } ]);
}

function hints(recorded) {
	const out = Object.assign({}, recorded);
	STA.concat(HOSTS).forEach(h => {
		out[h.mac.toUpperCase()] = Object.assign({ ipaddrs: [ lan.prefix + '.' + h.ip ], ip6addrs: [] }, h.name ? { name: h.name } : {});
	});
	if (lan.gateway) out[GATEWAY_MAC.toUpperCase()] = { name: 'router', ipaddrs: [ lan.gateway ], ip6addrs: [] };
	return out;
}

/* the uplink's first three octets and gateway, from a dump */
function learn(dump) {
	(dump.interface || []).forEach(i => {
		const r = (i && i.route || []).filter(x => x && +x.mask === 0 && x.target === '0.0.0.0')[0];
		const a = i && (i['ipv4-address'] || [])[0];
		if (!r || !a || !/^\d+\.\d+\.\d+\.\d+$/.test(a.address)) return;
		lan.prefix = a.address.split('.').slice(0, 3).join('.');
		if (typeof r.nexthop === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(r.nexthop)) lan.gateway = r.nexthop;
	});
}

const ok = v => ({ result: [ 0, v ] });

/* reply: { result: [ status, data ] } from the store; returns the reply to send */
function transform(object, method, args, reply) {
	const t = now(), res = reply && reply.result, data = Array.isArray(res) && res[0] === 0 ? res[1] : null;
	const dev = args && typeof args.device === 'string' ? args.device : null;
	if ((object === 'luci.vantage' && method === 'wireless') || (object === 'network.wireless' && method === 'status'))
		return ok(wireless());
	if (object === 'iwinfo' && method === 'info' && netOf(dev)) return ok(iwinfo(dev));
	if (object === 'iwinfo' && method === 'assoclist' && netOf(dev))
		return ok({ results: STA.filter(s => s.ifname === dev).map(s => stationAt(s, t)) });
	const hm = /^hostapd\.(.+)$/.exec(object);
	if (hm && netOf(hm[1])) {
		if (method === 'get_clients') return ok(hapdClients(hm[1], t));
		if (method === 'get_status') return ok(hapdStatus(hm[1], t));
	}
	if (object === 'luci.vantage' && method === 'wired') return ok({ hosts: fdb(t), switches: { 'eth1.1': SWITCH } });
	if (object === 'luci' && method === 'getSwconfigPortState' && args && args.switch === SWITCH.name) return ok({ result: SWITCH_STATE });
	if (object === 'network.interface' && method === 'dump' && data && Array.isArray(data.interface)) { learn(data); return reply; }
	if (object === 'luci-rpc' && method === 'getHostHints') return ok(hints(data && typeof data === 'object' ? data : {}));
	if (object === 'network.device' && method === 'status' && !(args && args.name))
		return ok(devices(data && typeof data === 'object' ? data : {}, t));
	return reply;
}

module.exports = { transform, RADIOS, NETS, STA, HOSTS, PORTS, SWITCH };
