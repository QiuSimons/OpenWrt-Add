'use strict';
/* Health checks, experience score, top talkers, presence, radio insights. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const insight = load('vantage.insight');

function baseModel() {
	return {
		device: { load: [ 65536 ], memory: { usedPct: 40, available: 600, total: 1000 }, storage: [ { usedPct: 2, free: 1000 } ] },
		uplink: { dev: 'eth0', carrier: true, speed: { mbps: 2500, duplex: 'full' }, gateway: '192.0.2.1' },
		radios: [ { id: 'radio0', bandLabel: '2.4 GHz', up: true, disabled: false }, { id: 'radio1', bandLabel: '6 GHz', up: true, disabled: false } ],
		ssids: [ { up: true, clients: 0 }, { up: true, clients: 2 } ],
		clients: [ { mac: 'a', name: 'A', signal: -50 }, { mac: 'b', name: 'B', signal: -60 } ]
	};
}
const byId = (list, id) => list.filter(c => c.id === id)[0];

test('health: healthy AP is all ok; an idle SSID is counted, not excused', () => {
	const h = insight.health(baseModel(), { cpu: { pct: 7, cores: [ 1, 2, 3, 4 ] } });
	assert.deepEqual(h.map(c => c.id), [ 'uplink', 'cpu', 'memory', 'radios', 'signal', 'storage' ]);
	assert.ok(h.every(c => c.level === 'ok'), JSON.stringify(h.map(c => c.level)));
	assert.equal(byId(h, 'radios').reason, '2 SSIDs · 1 idle');
	assert.equal(byId(h, 'radios').detail, '2 SSIDs broadcasting, 1 idle');
	assert.doesNotMatch(JSON.stringify(h), /fine/);
	/* one SSID: singular */
	const one = Object.assign(baseModel(), { ssids: [ { up: true, clients: 2 } ] });
	assert.equal(byId(insight.health(one, {}), 'radios').reason, '1 SSID on air');
	assert.equal(byId(insight.health(one, {}), 'radios').detail, '1 SSID broadcasting');
	one.ssids[0].clients = 0;
	assert.equal(byId(insight.health(one, {}), 'radios').reason, '1 SSID · 1 idle');
	assert.match(byId(h, 'cpu').detail, /on 4 cores/);
	assert.ok(h.every(c => Array.isArray(c.page) && c.page[0] === 'admin'), 'every check links to a page');
	assert.equal(insight.summary(h).count, 0);
});

test('health: the CPU check adds the hottest sensor when there is one', () => {
	const live = { cpu: { pct: 7, cores: [ 1, 2 ] } };
	const plain = byId(insight.health(baseModel(), live), 'cpu');
	assert.doesNotMatch(plain.reason + plain.detail, /°C/);
	const hot = byId(insight.health(baseModel(), Object.assign({ temps: [ { name: 'cpu-thermal', celsius: 77.6 }, { name: 'gpu', celsius: 50 } ] }, live)), 'cpu');
	assert.equal(hot.reason, 'Load 1.00 · 2 cores · 78\u00a0°C');
	assert.equal(hot.detail, 'Load 1.00 on 2 cores · Temperature 78\u00a0°C');
	assert.equal(hot.level, 'ok', 'a temperature alone never raises the level');
	const single = byId(insight.health(baseModel(), { cpu: { pct: 7, cores: [ 1 ] }, temps: [] }), 'cpu');
	assert.deepEqual([ single.reason, single.detail ], [ 'Load 1.00 · 1 core', 'Load 1.00 on 1 core' ]);
	assert.match(byId(insight.health(baseModel(), { cpu: { pct: 95, cores: [ 1 ] } }), 'cpu').detail, /^Busy; load 1\.00 on 1 core;/);
});

test('health: several weak clients open the list of them, the weakest first in the chip', () => {
	const m = baseModel();
	m.clients.push({ mac: 'c', name: 'Weak one', signal: -79 }, { mac: 'd', name: 'Weaker', signal: -84 }, { mac: 'e', name: 'Third', signal: -77 });
	const s = byId(insight.health(m, { cpu: { pct: 7, cores: [ 1 ] } }), 'signal');
	assert.equal(s.value, '3 weak');
	assert.match(s.reason.replace(/\u00a0/g, ' '), /Weaker · −84 dBm/);
	assert.equal(s.list, 'weak');
	assert.equal(s.client, 'd', 'the weakest, for a layout without the list');
});

test('health: weak client, slow uplink, disabled radio, high memory', () => {
	const m = baseModel();
	m.clients.push({ mac: 'c', name: 'Weak one', signal: -81 });
	m.uplink.speed = { mbps: 100, duplex: 'full' };
	m.radios[1].disabled = true;
	m.device.memory.usedPct = 93;
	const h = insight.health(m, { cpu: { pct: 95, cores: [ 1 ] } });
	assert.equal(byId(h, 'signal').level, 'warn');
	assert.match(byId(h, 'signal').reason.replace(/\u00a0/g, ' '), /Weak one · −81 dBm/);
	assert.match(byId(h, 'signal').detail, /Weak one at −81 dBm; below −75 dBm/);
	assert.equal(byId(h, 'signal').client, 'c');
	assert.equal(byId(h, 'signal').list, null);
	assert.equal(byId(h, 'uplink').level, 'warn');
	/* switched off on purpose: shown, not counted (#110) */
	assert.equal(byId(h, 'radios').level, 'info');
	assert.equal(byId(h, 'radios').value, '1 radio off');
	assert.equal(byId(h, 'memory').level, 'err');
	assert.equal(byId(h, 'cpu').level, 'err');
	const s = insight.summary(h);
	assert.equal(s.level, 'err');
	assert.equal(s.count, 4);
});

test('health: a radio switched off is no warning; one enabled but down is an error', () => {
	const m = baseModel();
	m.radios[1].disabled = true;
	let h = insight.health(m, { cpu: { pct: 5, cores: [ 1 ] } });
	assert.equal(byId(h, 'radios').level, 'info');
	assert.match(byId(h, 'radios').reason, /is disabled/);
	assert.deepEqual([ insight.summary(h).level, insight.summary(h).count ], [ 'ok', 0 ]);
	m.radios[0].up = false;
	h = insight.health(m, { cpu: { pct: 5, cores: [ 1 ] } });
	assert.equal(byId(h, 'radios').level, 'err');
	assert.equal(insight.summary(h).count, 1);
});

test('health: chip text is short, framed like the System tile, with the full sentence as detail', () => {
	const h = insight.health(baseModel(), { cpu: { pct: 7, cores: [ 1, 2, 3, 4 ] }, uplinkRate: { rx: 374e6, tx: 3.77e6 } });
	/* the uplink value is live traffic; the link speed is context */
	assert.equal(byId(h, 'uplink').value, '↓ 374 Mbit/s');
	/* the path already names the device: with a rate, the reason doesn't */
	/* the link speed spelled as everywhere else ('2.5 Gbit/s') */
	assert.equal(byId(h, 'uplink').reason.replace(/\u00a0/g, ' '), '↑ 3.77 Mbit/s · 2.5 Gbit/s link');
	assert.equal(byId(insight.health(baseModel(), {}), 'uplink').reason.replace(/\u00a0/g, ' '), 'eth0 · 2.5 Gbit/s link');
	assert.match(byId(h, 'uplink').detail, /eth0 up at 2\.5 Gbit\/s, gateway 192\.0\.2\.1/);
	/* memory is framed as available, like the System tile; storage says used */
	assert.equal(byId(h, 'memory').value, '60% available');
	assert.equal(byId(h, 'storage').value, '2% used');
	for (const c of h) {
		assert.ok(c.reason.length <= 34, c.id + ' reason too long for a chip: ' + c.reason);
		assert.ok(typeof c.detail === 'string' && c.detail.length >= c.reason.length, c.id + ' has a detail');
	}
	/* before the first rate the value is just "Up" */
	assert.equal(byId(insight.health(baseModel(), {}), 'uplink').value, 'Up');
});

test('health: all fine, Signal shows the weakest client and Wi-Fi counts radios', () => {
	const h = insight.health(baseModel(), { cpu: { pct: 7, cores: [ 1 ] } });
	assert.equal(byId(h, 'signal').value, '−60 dBm');
	assert.equal(byId(h, 'signal').reason, 'Weakest of 2 clients');
	assert.equal(byId(h, 'radios').value, '2 radios up');
	const one = baseModel();
	one.clients = [ { mac: 'a', name: 'A', signal: -52 } ];
	one.radios = [ one.radios[0] ];
	const h1 = insight.health(one, {});
	assert.equal(byId(h1, 'signal').reason, 'The only measured client');
	assert.equal(byId(h1, 'radios').value, '1 radio up');
	/* nobody there: no reason line that only repeats the value */
	const none = Object.assign(baseModel(), { clients: [] });
	assert.equal(byId(insight.health(none, {}), 'signal').value, 'No clients');
	assert.equal(byId(insight.health(none, {}), 'signal').reason, '');
	/* a driver without signal levels */
	const quiet = Object.assign(baseModel(), { clients: [ { mac: 'a', name: 'A' } ] });
	assert.equal(byId(insight.health(quiet, {}), 'signal').value, '—');
});

test('health: missing data degrades to info, never throws', () => {
	const h = insight.health({}, {});
	assert.equal(byId(h, 'uplink').level, 'err');
	assert.equal(byId(h, 'cpu').level, 'info');
	assert.equal(byId(h, 'signal').level, 'info');
	assert.equal(insight.summary([]).level, 'ok');
});

test('health: a wired-only device has no Wi-Fi or Signal check', () => {
	const m = Object.assign(baseModel(), { wired: true, radios: [], ssids: [], clients: [] });
	const ids = insight.health(m, { cpu: { pct: 7, cores: [ 1 ] } }).map(c => c.id);
	assert.deepEqual(ids, [ 'uplink', 'cpu', 'memory', 'storage' ]);
	/* no radios without the wired flag (unknown yet): the info checks stay */
	assert.equal(byId(insight.health(Object.assign(baseModel(), { radios: [], clients: [] }), {}), 'radios').level, 'info');
});

test('experience: strong active client is excellent with a positive reason', () => {
	const e = insight.experience({ signal: -48, rx: { rate: 576400 }, tx: { rate: 720600 }, txPackets: 1000, txFailed: 3, inactive: 0 });
	assert.equal(e.score, 100);
	assert.equal(e.grade, 'Excellent');
	assert.match(e.reason, /Strong signal −48 dBm, 721 Mbit\/s link/);
});

test('experience: weak signal dominates the explanation', () => {
	const e = insight.experience({ signal: -78, rx: { rate: 576400 }, txPackets: 1000, txFailed: 60, inactive: 0 });
	assert.equal(e.level, 'err');
	assert.equal(e.reason, 'Weak signal −78 dBm; may roam poorly');
	assert.equal(e.short, 'Weak signal');
	assert.equal(e.factors.length, 2);
	assert.equal(e.score, 100 - 55 - 10);
});

test('experience: low link rate despite good signal, retries, legacy note', () => {
	const e = insight.experience({ signal: -55, rx: { rate: 6000 }, tx: { rate: 1000 }, inactive: 200, txPackets: 900, txFailed: 100, legacyOnRadio: true, gen: 'Wi-Fi 4' });
	assert.equal(e.score, 100 - 20 - 25 - 5);
	assert.match(e.reason, /10% of frames to the device fail/);
	assert.ok(e.factors.some(f => /Wi-Fi 4 device on a newer radio/.test(f.text)));
	/* idle stations are not blamed for a low last-frame rate */
	assert.equal(insight.experience({ signal: -55, rx: { rate: 1000 }, inactive: 60000 }).score, 100);
});

test('topTalkers: ranked by live total, share of the sum, zero traffic left out', () => {
	const clients = [ { mac: 'a', name: 'A' }, { mac: 'b', name: 'B' }, { mac: 'c', name: 'C' }, { mac: 'd', name: 'D' } ];
	const rates = { a: { rx: 1e6, tx: 9e6 }, b: { rx: 0, tx: 30e6 }, c: { rx: 0, tx: 0 } };
	const t = insight.topTalkers(clients, rates, 5);
	assert.deepEqual(t.map(x => x.mac), [ 'b', 'a' ]);
	assert.equal(t[0].down, 30e6, 'AP transmit is the client download');
	assert.equal(t[1].up, 1e6);
	assert.equal(t[0].share, 0.75);
	assert.equal(insight.topTalkers(clients, rates, 1).length, 1);
	assert.deepEqual(insight.topTalkers([], {}), []);
});

test('presence: baseline, new arrivals, gone kept for a while', () => {
	const A = { mac: 'a' }, B = { mac: 'b' }, C = { mac: 'c' };
	let p = insight.presence(null, [ A, B ], 1000, 60000);
	assert.deepEqual(Object.keys(p.isNew), [], 'nothing is new on the first poll');
	p = insight.presence(p.state, [ A, C ], 6000, 60000);
	assert.deepEqual(Object.keys(p.isNew), [ 'c' ]);
	assert.deepEqual(p.gone.map(g => [ g.client.mac, g.at ]), [ [ 'b', 6000 ] ]);
	assert.equal(p.state.firstSeen.c, 6000);
	assert.equal(p.state.firstSeen.a, 1000);
	p = insight.presence(p.state, [ A, C ], 30000, 60000);
	assert.equal(p.gone.length, 1, 'still listed');
	p = insight.presence(p.state, [ A, C ], 70000, 60000);
	assert.equal(p.gone.length, 0, 'forgotten after keepMs');
	p = insight.presence(p.state, [ A, B, C, { mac: 'd' } ], 71000, 60000);
	assert.equal(p.isNew.b, undefined, 'b was there when the page opened');
	assert.equal(p.isNew.d, true);
});

test('radioInsights: busiest radio and legacy; nothing that only repeats the radio\'s rows', () => {
	const radios = [
		{ id: 'r0', up: true, clients: 2, legacy: 1, noise: -90, noiseRaw: -90 },
		{ id: 'r1', up: true, clients: 2, legacy: 0, noise: null, noiseRaw: -121 },
		{ id: 'r2', up: true, clients: 0, legacy: 0, noise: null, noiseRaw: null }
	];
	const r = insight.radioInsights(radios, { r0: { rx: 1, tx: 1 }, r1: { rx: 10, tx: 88 } });
	assert.equal(r.r1.busiest, true);
	assert.equal(r.r0.busiest, false);
	assert.equal(r.r1.share, 0.98);
	assert.ok(r.r1.notes.some(n => /Busiest radio: 98%/.test(n.text)));
	assert.ok(r.r0.notes.some(n => /1 older device/.test(n.text)));
	/* an unreported noise floor and an idle radio are no notes (the drawer
	   says why there is no noise floor) */
	assert.deepEqual(r.r2.notes, []);
	assert.ok(!r.r1.notes.some(n => /not reported/.test(n.text)));
});

/* LuCI's N_() picks the form by the page language's rule even where no
   catalogue has the string: in a one-form language that is always the
   singular, so vantage.fmt's N_ falls back to English's rule */
test('fmt.N_: English plural when the page language has one form and no translation', () => {
	const fmt = load('vantage.fmt'), saved = global.N_;
	try {
		global.N_ = (n, s) => s;                 /* plural=0, no catalogue */
		assert.equal(fmt.N_(2, '%d radio up', '%d radios up'), '%d radios up');
		assert.equal(fmt.N_(1, '%d radio up', '%d radios up'), '%d radio up');
		global.N_ = () => '%d 个射频已上线';     /* translated */
		assert.equal(fmt.N_(2, '%d radio up', '%d radios up'), '%d 个射频已上线');
	} finally { global.N_ = saved; }
});

/* #110: a station set quiet (far away on purpose) is no warning */
test('health: a quiet station\'s weak signal is left out of the warning and of the weakest', () => {
	const m = baseModel();
	m.clients.push({ mac: 'far', name: 'Garden camera', signal: -84 }, { mac: 'near', name: 'Phone', signal: -58 });
	const plain = byId(insight.health(m, {}), 'signal');
	assert.equal(plain.level, 'warn');
	const s = byId(insight.health(m, { quiet: { far: true } }), 'signal');
	assert.equal(s.level, 'ok');
	assert.ok(!/Garden camera|−84/.test(s.value + s.reason + s.detail), 'not named as the weakest either');
	/* another weak one still warns */
	m.clients.push({ mac: 'weak2', name: 'Laptop', signal: -80 });
	const w = byId(insight.health(m, { quiet: { far: true } }), 'signal');
	assert.equal(w.level, 'warn');
	assert.equal(w.value, '1 weak');
	assert.equal(w.client, 'weak2');
	/* every station set quiet: no warning, and not "No clients" */
	const all = byId(insight.health({ ...m, clients: [ m.clients[m.clients.length - 3] ] }, { quiet: { far: true } }), 'signal');
	assert.deepEqual([ all.level, all.value ], [ 'ok', '—' ]);
	assert.match(all.reason, /No warnings asked for/);
});
