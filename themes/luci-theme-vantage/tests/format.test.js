'use strict';
/* Formatting, Wi-Fi vocabulary and series geometry. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const fmt = load('vantage.fmt');
const wifi = load('vantage.wifi');
const series = load('vantage.series');

test('fmt: bits, bytes, PHY rates, durations, placeholders for junk', () => {
	assert.equal(fmt.bits(372.3e6), '372 Mbit/s');
	assert.equal(fmt.bits(2.95e6), '2.95 Mbit/s');
	assert.equal(fmt.bits(12.34e3), '12.3 kbit/s');
	assert.equal(fmt.bits(0), '0 bit/s');
	assert.equal(fmt.bits(-1), '—');
	assert.equal(fmt.bits('x'), '—');
	assert.equal(fmt.bitsShort(400e6), '400M');
	assert.equal(fmt.bitsShort(1.5e9), '1.5G');
	assert.equal(fmt.bytes(897781760), '856 MiB');
	assert.equal(fmt.bytes(null), '—');
	assert.equal(fmt.phyRate(576400), '576 Mbit/s');
	assert.equal(fmt.phyRate(1000), '1 Mbit/s');
	assert.equal(fmt.phyRate(0), '—');
	assert.equal(fmt.duration(515975), '5d 23h');
	assert.equal(fmt.duration(125), '2m 5s');
	assert.equal(fmt.duration(undefined), '—');
	assert.equal(fmt.dbm(-81), '−81 dBm');
	assert.equal(fmt.dbm(0), '—');
	assert.equal(fmt.load(26048), '0.40');
	assert.equal(fmt.mac('02-00-5e-00-53-0f'), '02:00:5E:00:53:0F');
	assert.equal(fmt.macTail('00:00:5e:00:53:c1'), '…00:53:C1');
});

test('fmt.safeText: neutralises reordering characters, cuts by code point', () => {
	assert.equal(fmt.safeText('abc\u202egnp', 64), 'abc�gnp');
	assert.equal(fmt.safeText('\u200b', 64), '�');
	assert.equal(fmt.safeText('x'.repeat(10), 5), 'xxxx…');
	assert.equal(fmt.safeText('😀😀😀', 2), '😀…');
	assert.equal(fmt.safeText(null), '');
});

test('wifi: bands, widths, generations (6E on 6 GHz)', () => {
	assert.equal(wifi.bandKey('6g'), '6g');
	assert.equal(wifi.bandKey('constructor', 2437), '2g');
	assert.equal(wifi.bandKey(null, 5975), '6g');
	assert.equal(wifi.bandKey(null, 5180), '5g');
	assert.deepEqual(wifi.htmode('EHT160'), { std: 'EHT', gen: 'Wi-Fi 7', width: 160 });
	assert.deepEqual(wifi.htmode('NOHT'), { std: null, gen: 'legacy', width: 20 });
	assert.equal(wifi.genName('HE', '6g'), 'Wi-Fi 6E');
	assert.equal(wifi.genName('HE', '5g'), 'Wi-Fi 6');
	assert.equal(wifi.clientStd({ ht: false }, { vht: true }, { he: true }), 'HE');
	assert.equal(wifi.clientStd({}, {}, { ht: true }), 'HT');
	assert.equal(wifi.clientStd(null, null, null), null);
});

test('wifi.phy: friendly PHY label and details', () => {
	const p = wifi.phy({ rate: 576400, mhz: 160, eht: true, mcs: 3, nss: 2, eht_gi: 0 });
	assert.equal(p.label, '576 Mbit/s · 160 MHz · EHT');
	assert.equal(p.detail, 'MCS 3 · 2×2');
	assert.equal(wifi.phy({ rate: 1000, mhz: 20 }).label, '1 Mbit/s · 20 MHz · legacy');
	assert.equal(wifi.phy(null), null);
});

test('wifi: signal levels, placeholder noise, security labels', () => {
	assert.deepEqual([ -48, -60, -72, -81, 0 ].map(v => wifi.signal(v).bars), [ 4, 3, 2, 1, 0 ]);
	assert.equal(wifi.noise(-87), -87);
	assert.equal(wifi.noise(-109), null);
	assert.equal(wifi.noise(-121), null);
	assert.equal(wifi.noise(0), null);
	assert.equal(wifi.security('sae').short, 'WPA3');
	assert.equal(wifi.security('sae-mixed').short, 'WPA2/3');
	assert.equal(wifi.security('psk2+ccmp').short, 'WPA2');
	assert.equal(wifi.security('none').tone, 'open');
	assert.equal(wifi.security(undefined).short, 'Open');
	assert.equal(wifi.security('owe').long, 'Enhanced Open (OWE)');
});

test('wifi.spectrum: channel block inside its band', () => {
	const s = wifi.spectrum('6g', 5, 15, 160);
	assert.equal(s.centre, 6025);
	assert.equal(s.lo, 5945);
	assert.equal(s.hi, 6105);
	assert.ok(s.from > 0 && s.to < 0.2);
	const t = wifi.spectrum('2g', 6, 6, 20);
	assert.equal(t.centre, 2437);
	assert.equal(wifi.spectrum('xx', 1, 1, 20), null);
});

test('series: push trims by window and length, keeps order', () => {
	let s = [];
	for (let t = 0; t <= 10; t++) s = series.push(s, [ t * 1000, t ], 5000, 100);
	assert.deepEqual(s.map(p => p[1]), [ 5, 6, 7, 8, 9, 10 ]);
	series.push(s, [ 9000, 1 ], 5000, 100);
	assert.equal(s.length, 6, 'older point ignored');
	s = series.push(s, [ 11000, 11 ], 0, 3);
	assert.deepEqual(s.map(p => p[1]), [ 9, 10, 11 ]);
});

test('series.valid: stored data is validated', () => {
	const v = series.valid([ [ 1, 2, 3 ], [ 1, 5, 5 ], [ 2, -1, 0 ], 'x', [ 3, 1, 1 ], [ 4, 1 ], [ 9e15, 1, 1 ], [ 5, NaN, 1 ] ], 3, 10, 1e12);
	assert.deepEqual(v, [ [ 1, 2, 3 ], [ 3, 1, 1 ] ]);
	assert.deepEqual(series.valid('nope', 3, 10), []);
});

test('series: nice axis maximum and path geometry with gaps', () => {
	assert.equal(series.niceMax(372e6), 500e6);
	assert.equal(series.niceMax(0.3), 0.5);
	assert.equal(series.niceMax(0), 1);
	assert.equal(series.niceCeil(392e6), 400e6);
	assert.equal(series.niceCeil(418e6), 500e6);
	assert.equal(series.niceCeil(1000), 1000);
	assert.equal(series.niceCeil(1100), 1500);
	assert.equal(series.niceCeil(NaN), 1);
	const data = [ [ 0, 0 ], [ 1000, 50 ], [ 2000, 100 ], [ 20000, 50 ] ];
	const segs = series.segments(data, 1, 0, 20000, 100, 200, 100, 5000);
	assert.equal(segs.length, 2, 'a gap longer than maxGap breaks the line');
	assert.deepEqual(segs[0][2], [ 20, 0 ]);
	assert.equal(series.linePath(segs), 'M0 100L10 50L20 0M200 50h0.1');
	assert.equal(series.areaPath(segs, 100), 'M0 100L0 100L10 50L20 0L20 100Z');
	assert.equal(series.nearest(data, 1400), 1);
	assert.equal(series.max(data, [ 1 ]), 100);
});

test('series: stats over a window, filling domain', () => {
	const d = [ [ 1000, 5 ], [ 2000, NaN ], [ 3000, 1 ], [ 4000, 3 ] ];
	assert.deepEqual(series.stats(d, 1, 0), { now: 3, peak: 5, avg: 3, n: 3 });
	assert.deepEqual(series.stats(d, 1, 2500), { now: 3, peak: 3, avg: 2, n: 2 });
	assert.deepEqual(series.stats([], 1, 0), { now: null, peak: null, avg: null, n: 0 });
	/* 20 s of history: at least a minute is shown, drawn from the right */
	const now = 1e6;
	let dm = series.domain([ [ [ now - 20000, 1 ] ], null ], now, 60000, 300000);
	assert.equal(dm.span, 60000); assert.equal(dm.age, 20000); assert.equal(dm.full, false);
	dm = series.domain([ [ [ now - 150000, 1 ] ] ], now, 60000, 300000);
	assert.equal(dm.span, 150000); assert.equal(dm.t0, now - 150000);
	dm = series.domain([ [ [ now - 900000, 1 ], [ now - 400000, 1 ], [ now - 5000, 1 ] ] ], now, 60000, 300000);
	assert.equal(dm.span, 300000); assert.equal(dm.full, true);
	assert.equal(series.domain([], now, 60000, 300000).age, 0);
});
