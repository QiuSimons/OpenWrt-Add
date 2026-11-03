'use strict';
/* SYNTHETIC replies for data the recorded device cannot provide.

   Status -> Realtime Graphs reads `luci getRealtimeStats`, which runs
   luci-bwc; the recorded firmware lacks it for load/conntrack, and the rows
   that were recorded for interface/wireless carry old timestamps, so a
   replayed graph never advances. Status -> Channel Analysis reads
   `iwinfo scan`, which a recording never holds (a scan disturbs clients).
   Everything here is generated, labelled "synthetic" once on stderr, and
   switched off with --no-synthetic.

   Where the mirror has real numbers they drive the shape:
     load       system.info load[] (x/65536, stored x100 like luci-bwc)
     interface  network.device status statistics (rx/tx bytes + packets)
     wireless   iwinfo info signal / noise / bitrate of that interface
   Conntrack counts and the conntrack list are invented (documentation
   addresses only). Scan results are the AP's own sibling BSSIDs (read from
   the mirror at run time, never written to the repo) plus invented
   neighbours with example SSIDs and locally administered 02:00:5E:xx BSSIDs.
   The bridge forwarding database (luci.vantage wired) holds three invented
   hosts with documentation MACs (00:00:5E:00:53:Ax) on the first wired
   member of the recorded bridge, heard a few seconds to minutes ago.

   luci-bwc output shape (rpcd `luci` wraps its lines into { result: [...] }):
     -l load       [ ts, load1*100, load5*100, load15*100 ]
     -i interface  [ ts, rx_bytes, rx_packets, tx_bytes, tx_packets ]
     -r wireless   [ ts, rate_kbit, rssi+256, noise+256 ]
     -c conntrack  [ ts, udp, tcp, other ]
   one row per second, the last 180 seconds (STEP_TIME 1, STEP_COUNT 180). */

const HISTORY = 180;
const SSH_STEP = 5;        /* seconds between ssh samples in the mirror */

/* deterministic noise in [0, 1) from integers */
function hash01(a, b) {
	let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
	h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
	return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function strSeed(s) { let h = 7; for (const c of String(s)) h = Math.imul(h, 31) + c.charCodeAt(0) | 0; return h; }

/* smooth value noise in [0, 1) over seconds */
function smooth(seed, t, period) {
	const x = t / period, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
	return hash01(seed, i) * (1 - u) + hash01(seed, i + 1) * u;
}

/* a recorded 5-s gauge series as a looping function of unix seconds */
function gauge(values) {
	const n = values.length;
	return t => {
		const x = (((t / SSH_STEP) % n) + n) % n, i = Math.floor(x), f = x - i;
		return values[i] * (1 - f) + values[(i + 1) % n] * f;
	};
}

/* a recorded 5-s counter series as a monotonic function of unix seconds:
   laps repeat the recorded deltas on top of the previous lap's total */
function counter(values) {
	const n = values.length;
	const d = [];
	for (let i = 0; i < n - 1; i++) d.push(Math.max(0, values[i + 1] - values[i]));
	d.push(d.length ? d[d.length - 1] : 0);
	const prefix = [ 0 ];
	for (let i = 0; i < n; i++) prefix.push(prefix[i] + d[i]);
	const lapTotal = prefix[n];
	return t => {
		const s = t / SSH_STEP, lap = Math.floor(s / n), rem = s - lap * n, i = Math.floor(rem), f = rem - i;
		return Math.round(values[0] + lap * lapTotal + prefix[i] + f * d[i]);
	};
}

function window180(now, row) {
	const out = [];
	for (let ts = now - HISTORY + 1; ts <= now; ts++) out.push([ ts ].concat(row(ts)));
	return out;
}

/* invented neighbours: example SSIDs, locally administered BSSIDs */
const NEIGHBOURS = {
	2: [
		{ ssid: 'ExampleNet', ch: 1, sig: -58 },
		{ ssid: 'ExampleNet-Guest', ch: 1, sig: -61 },
		{ ssid: 'Neighbour-A', ch: 1, sig: -79 },
		{ ssid: 'Lab-Test-24', ch: 3, sig: -83, w: 40, sec: 'above' },
		{ ssid: 'Office-Demo', ch: 6, sig: -67 },
		{ ssid: null, ch: 6, sig: -88 },
		{ ssid: 'DIRECT-42-Printer-Example', ch: 6, sig: -72 },
		{ ssid: 'Cafe-Example', ch: 9, sig: -85 },
		{ ssid: 'HomeNet-Example', ch: 11, sig: -63 },
		{ ssid: 'IoT-Example', ch: 11, sig: -74 },
		{ ssid: 'Neighbour-B', ch: 11, sig: -90 },
		{ ssid: 'Example-Mesh', ch: 13, sig: -81 }
	],
	6: [                                            /* EU: channels 1-93 */
		{ ssid: 'Example-Mesh-6G', ch: 21, sig: -84, w: 80 },
		{ ssid: 'ExampleNet-6E', ch: 37, sig: -64, w: 160 },
		{ ssid: 'HomeNet-Example-6G', ch: 53, sig: -71, w: 160 },
		{ ssid: 'Office-Demo-6G', ch: 69, sig: -76, w: 80 },
		{ ssid: 'Cafe-Example-6G', ch: 77, sig: -89, w: 20 },
		{ ssid: 'Lab-Test-6G', ch: 85, sig: -82, w: 40 },
		{ ssid: 'Neighbour-C', ch: 93, sig: -87, w: 20 }
	]
};

function mhzOf(band, ch) { return band === 2 ? (ch === 14 ? 2484 : 2407 + 5 * ch) : 5950 + 5 * ch; }

/* 6 GHz: centre channel of the w-MHz block holding primary channel ch */
function centre6(ch, w) {
	const span = w / 5;                          /* channel numbers per block */
	const start = Math.floor((ch - 1) / span) * span + 1;
	return start + (span - 4) / 2;
}

function scanEntry(band, n, i, now, own) {
	const jitter = Math.round((smooth(strSeed(n.bssid || n.ssid) + i, now, 20) - .5) * 6);
	const signal = Math.max(-95, Math.min(-20, n.sig + jitter));
	const e = {
		ssid: n.ssid == null ? undefined : n.ssid,
		bssid: n.bssid,
		mode: 'Master',
		band,
		channel: n.ch,
		mhz: mhzOf(band, n.ch),
		signal,
		quality: Math.max(0, Math.min(70, signal + 110)),
		quality_max: 70,
		encryption: own ? own.encryption : { enabled: true, wpa: [ band === 6 ? 3 : 2 ], authentication: [ band === 6 ? 'sae' : 'psk' ], ciphers: [ 'ccmp' ] }
	};
	if (e.ssid === undefined) delete e.ssid;
	const w = n.w || 20;
	if (band === 2) {
		e.ht_operation = { primary_channel: n.ch, secondary_channel_offset: w === 40 ? (n.sec || 'above') : 'no secondary', channel_width: w === 40 ? 2040 : 20 };
	}
	else {
		e.he_operation = { channel_width: w, center_freq_1: w > 20 ? centre6(n.ch, Math.min(w, 80)) : n.ch, center_freq_2: w === 160 ? centre6(n.ch, 160) : 0 };
		if (w === 20) e.he_operation.channel_width = 20;
	}
	return e;
}

class Synthetic {
	constructor(store) {
		this.store = store;
		this.announced = new Set();
		this.cache = new Map();
		/* counters restart from their recorded values an hour before start,
		   so they stay far below 2^53 however long the server runs */
		this.origin = Math.floor(Date.now() / 1000) - 3600;
	}

	announce(what) {
		/* what carries request arguments: no control characters on the
		   terminal, and a bounded set however many names a client sends */
		what = String(what).replace(/[\x00-\x1f\x7f-\x9f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
		if (this.announced.has(what) || this.announced.size >= 256) return;
		this.announced.add(what);
		console.error(`[replay] synthetic: ${what} (generated, not recorded; --no-synthetic to disable)`);
	}

	rows(object, method, args) {
		return this.store.series.get(`${object}\0${method}\0${args}`) || null;
	}

	memo(key, build) {
		if (!this.cache.has(key)) this.cache.set(key, build());
		return this.cache.get(key);
	}

	/* an rtnl-shaped dump of the bridge forwarding database (see the
	   header), for the plugin stand-in; [] without a recorded bridge */
	fdb() {
		const devs = this.store.data('network.device', 'status', {}) || {};
		let bridge = null, port = null;
		for (const [ name, d ] of Object.entries(devs)) {
			if (!d || d.type !== 'bridge' || !Array.isArray(d['bridge-members'])) continue;
			const wired = d['bridge-members'].filter(m => typeof m === 'string' && devs[m] && devs[m].devtype !== 'wlan' && !/^(phy|wlan|ra)/.test(m));
			if (wired.length) { bridge = name; port = wired[0]; break; }
		}
		if (!bridge) return [];
		this.announce('luci.vantage wired');
		const t = Math.floor(Date.now() / 1000);
		return [ 1, 2, 3 ].map(i => ({
			family: 7, dev: port, master: bridge, lladdr: '00:00:5e:00:53:a' + i, state: 0x02, flags: 0,
			cacheinfo: { confirmed: 0, used: 0, updated: ((t * i * 7) % (i * 90)) * 100, refcnt: 0 }
		}));
	}

	/* reply body or null when this call is not synthesised */
	call(object, method, args) {
		if (object === 'luci' && method === 'getRealtimeStats') {
			const res = this.realtime(args.mode, args.device);
			if (res == null) return null;
			this.announce(`luci getRealtimeStats ${args.mode}${args.device ? ' ' + args.device : ''}`);
			return { result: [ 0, { result: res } ] };
		}
		if (object === 'luci' && method === 'getConntrackList') {
			this.announce('luci getConntrackList');
			return { result: [ 0, { result: this.conntrackList(Math.floor(Date.now() / 1000)) } ] };
		}
		if (object === 'iwinfo' && method === 'scan' && typeof args.device === 'string') {
			const res = this.scan(args.device);
			if (res == null) return null;
			this.announce(`iwinfo scan ${args.device}`);
			return { result: [ 0, { results: res } ] };
		}
		if (object === 'iwinfo' && method === 'info' && typeof args.device === 'string' && /^radio\d+$/.test(args.device)) {
			/* iwinfo resolves a radio name to its first interface; the mirror
			   only recorded this for radio0 (derived from real data, no invention) */
			if (this.store.exact.has(`iwinfo\0info\0${JSON.stringify({ device: args.device }).replace(/\s/g, '')}`)) return null;
			const ifname = this.firstIfname(args.device);
			const rows = ifname && this.rows('iwinfo', 'info', `{"device":${JSON.stringify(ifname)}}`);
			if (!rows) return null;
			this.announce(`iwinfo info ${args.device} (aliased to recorded ${ifname})`);
			return { result: [ 0, this.store.sample(`iwinfo\0info\0{"device":${JSON.stringify(ifname)}}`) ] };
		}
		return null;
	}

	wireless() {
		const rows = this.rows('network.wireless', 'status', '{}');
		return rows && rows[rows.length - 1] || {};
	}

	firstIfname(radio) {
		const r = this.wireless()[radio];
		const i = r && Array.isArray(r.interfaces) ? r.interfaces.find(x => x.ifname) : null;
		return i ? i.ifname : null;
	}

	realtime(mode, device) {
		const now = Math.floor(Date.now() / 1000);
		switch (mode) {
		case 'load': {
			const f = this.memo('load', () => {
				const rows = this.rows('system', 'info', '{}');
				const pick = k => rows ? rows.map(r => (r.load && r.load[k] || 0) / 65536 * 100) : null;
				return rows ? [ gauge(pick(0)), gauge(pick(1)), gauge(pick(2)) ] : null;
			});
			return window180(now, ts => f
				? f.map((g, k) => Math.round(g(ts) * (k ? 1 : .85 + .3 * smooth(11, ts, 9))))
				: [ 40 + Math.round(30 * smooth(1, ts, 15)), 38 + Math.round(10 * smooth(2, ts, 60)), 35 + Math.round(4 * smooth(3, ts, 200)) ]);
		}
		case 'interface': {
			if (typeof device !== 'string') return [];
			const f = this.memo('if ' + device, () => {
				const rows = this.rows('network.device', 'status', '{}');
				const st = rows ? rows.map(r => (r[device] && r[device].statistics) || null) : [];
				if (!st.length || st.some(s => !s)) return null;
				return [ 'rx_bytes', 'rx_packets', 'tx_bytes', 'tx_packets' ].map(k => counter(st.map(s => +s[k] || 0)));
			});
			if (!f) {
				/* a device the mirror has no counters for: a quiet synthetic trickle */
				const seed = strSeed(device);
				let rb = 0, tb = 0;
				const out = [];
				for (let ts = now - 3600; ts <= now; ts++) {
					rb += 2000 + 18000 * smooth(seed, ts, 12); tb += 1500 + 9000 * smooth(seed + 1, ts, 17);
					if (ts > now - HISTORY) out.push([ ts, Math.round(rb), Math.round(rb / 700), Math.round(tb), Math.round(tb / 600) ]);
				}
				return out;
			}
			return window180(now, ts => f.map(c => c(ts - this.origin)));
		}
		case 'wireless': {
			if (typeof device !== 'string') return [];
			const f = this.memo('wl ' + device, () => {
				const rows = this.rows('iwinfo', 'info', `{"device":${JSON.stringify(device)}}`);
				if (!rows) return null;
				return [ gauge(rows.map(r => +r.bitrate || 0)), gauge(rows.map(r => +r.signal || 0)), gauge(rows.map(r => +r.noise || 0)) ];
			});
			if (!f) return [];
			return window180(now, ts => {
				const sig = f[1](ts), noise = f[2](ts);
				/* luci-bwc stores signal/noise as uint8 (dBm + 256); 0 = no value */
				return [ Math.max(0, Math.round(f[0](ts) * (.8 + .4 * smooth(strSeed(device), ts, 7)))),
				         sig ? Math.round(sig + (smooth(strSeed(device) + 3, ts, 5) - .5) * 4) + 256 : 0,
				         noise ? Math.round(noise) + 256 : 0 ];
			});
		}
		case 'conntrack':
			return window180(now, ts => [
				Math.round(14 + 12 * smooth(21, ts, 11) + 4 * smooth(22, ts, 3)),
				Math.round(38 + 26 * smooth(23, ts, 23) + 6 * smooth(24, ts, 4)),
				Math.round(2 + 3 * smooth(25, ts, 31))
			]);
		}
		return null;
	}

	conntrackList(now) {
		const out = [];
		const lan = i => '192.0.2.' + (20 + i % 9);
		const wan4 = i => (i % 2 ? '198.51.100.' : '203.0.113.') + (10 + (i * 37) % 200);
		const ports = [ 443, 443, 443, 80, 53, 123, 993, 8443, 5223, 3478 ];
		const n = 24 + Math.round(8 * smooth(31, now, 20));
		for (let i = 0; i < n; i++) {
			const dport = ports[i % ports.length];
			const l4 = (dport === 53 || dport === 123 || dport === 3478) ? 'udp' : (i % 17 === 5 ? 'icmp' : 'tcp');
			const v6 = i % 6 === 4;
			const bytes = Math.round(400 + 2e6 * Math.pow(hash01(i, 77), 6) + 5000 * smooth(40 + i, now, 9));
			const e = {
				bytes, packets: Math.max(1, Math.round(bytes / 900)),
				layer3: v6 ? 'ipv6' : 'ipv4', layer4: l4, timeout: 30 + (i * 53) % 400,
				src: v6 ? '2001:db8:1::' + (20 + i).toString(16) : lan(i),
				dst: v6 ? '2001:db8:ffff::' + (100 + i * 7).toString(16) : wan4(i)
			};
			if (l4 !== 'icmp') { e.sport = String(40000 + (i * 7919) % 25000); e.dport = String(dport); }
			out.push(e);
		}
		return out;
	}

	scan(device) {
		const radio = this.wireless()[device];
		if (!radio) return null;
		const band = String(radio.config && radio.config.band || '').startsWith('6') ? 6 : String(radio.config && radio.config.band || '').startsWith('2') ? 2 : null;
		if (!band) return [];
		const now = Math.floor(Date.now() / 1000);
		const list = [];
		/* the AP's own sibling BSSIDs on this radio (the first one is what
		   `iwinfo info radioN` reports and Channel Analysis draws itself) */
		(radio.interfaces || []).slice(1).forEach(i => {
			const c = i.config || {};
			const bssid = (i.iwinfo && i.iwinfo.bssid) || c.macaddr;
			if (!bssid || c.mode && c.mode !== 'ap') return;
			list.push(scanEntry(band, { ssid: c.ssid || null, bssid: String(bssid).toUpperCase(), ch: +radio.config.channel || 1, sig: -31 }, list.length, now,
				{ encryption: { enabled: true, wpa: [ 2 ], authentication: [ 'psk' ], ciphers: [ 'ccmp' ] } }));
		});
		NEIGHBOURS[band].forEach((n, k) => {
			const bssid = '02:00:5E:' + (band === 2 ? '24' : '60') + ':' + (0x10 + k).toString(16).toUpperCase().padStart(2, '0') + ':' + (0xa0 + k * 3).toString(16).toUpperCase();
			list.push(scanEntry(band, Object.assign({ bssid }, n), list.length, now));
		});
		return list;
	}
}

module.exports = { Synthetic, gauge, counter, centre6 };
