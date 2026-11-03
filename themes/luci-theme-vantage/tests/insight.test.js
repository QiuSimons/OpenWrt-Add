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

test('health: healthy AP is all ok; idle SSID is explicitly fine', () => {
	const h = insight.health(baseModel(), { cpu: { pct: 7, cores: [ 1, 2, 3, 4 ] } });
	assert.deepEqual(h.map(c => c.id), [ 'uplink', 'cpu', 'memory', 'radios', 'signal', 'storage' ]);
	assert.ok(h.every(c => c.level === 'ok'), JSON.stringify(h.map(c => c.level)));
	assert.match(byId(h, 'radios').detail, /without clients, which is fine/);
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
	assert.equal(byId(insight.health(baseModel(), { cpu: { pct: 7, cores: [ 1 ] }, temps: [] }), 'cpu').reason, 'Load 1.00 · 1 cores');
});

test('health: weak client, slow uplink, disabled radio, high memory', () => {
	const m = baseModel();
	m.clients.push({ mac: 'c', name: 'Weak one', signal: -81 });
	m.uplink.speed = { mbps: 100, duplex: 'full' };
	m.radios[1].disabled = true;
	m.device.memory.usedPct = 93;
	const h = insight.health(m, { cpu: { pct: 95, cores: [ 1 ] } });
	assert.equal(byId(h, 'signal').level, 'warn');
	assert.match(byId(h, 'signal').reason, /Weak one · −81 dBm/);
	assert.match(byId(h, 'signal').detail, /Weak one at −81 dBm; below −75 dBm/);
	assert.equal(byId(h, 'signal').client, 'c');
	assert.equal(byId(h, 'uplink').level, 'warn');
	assert.equal(byId(h, 'radios').level, 'warn');
	assert.equal(byId(h, 'memory').level, 'err');
	assert.equal(byId(h, 'cpu').level, 'err');
	const s = insight.summary(h);
	assert.equal(s.level, 'err');
	assert.equal(s.count, 5);
});

test('health: chip text is short, framed like the System tile, with the full sentence as detail', () => {
	const h = insight.health(baseModel(), { cpu: { pct: 7, cores: [ 1, 2, 3, 4 ] }, uplinkRate: { rx: 374e6, tx: 3.77e6 } });
	/* the uplink value is live traffic; the link speed is context */
	assert.equal(byId(h, 'uplink').value, '↓ 374 Mbit/s');
	assert.equal(byId(h, 'uplink').reason.replace(/\u00a0/g, ' '), '↑ 3.77 Mbit/s · eth0 · 2.5G link');
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

test('radioInsights: busiest radio, legacy, placeholder noise, idle radio', () => {
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
	assert.ok(r.r1.notes.some(n => /not reported by the driver/.test(n.text)));
	assert.ok(r.r0.notes.some(n => /1 older device/.test(n.text)));
	assert.ok(!r.r0.notes.some(n => /not reported/.test(n.text)));
	assert.ok(r.r2.notes.some(n => /idle radios are fine/.test(n.text)));
});
