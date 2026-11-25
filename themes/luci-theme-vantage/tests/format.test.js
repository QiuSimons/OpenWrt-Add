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
	/* a row's download and upload: one unit where both read in it */
	assert.equal(fmt.rates(376e6, 3.4e6), '↓ 376  ↑ 3.4 Mbit/s');
	assert.equal(fmt.rates(12.3e6, 800), '↓ 12.3 Mbit/s  ↑ 800 bit/s');
	assert.equal(fmt.rates(0, 0), 'idle');
	assert.equal(fmt.rates(null, 2e3), '↓ —  ↑ 2 kbit/s');
	assert.deepEqual(fmt.rateParts(400e6, 1.5e9), { dn: '400 Mbit/s', up: '1.5 Gbit/s', unit: '' });
	/* counts: thousands apart from five digits on */
	assert.equal(fmt.count(20224239), '20\u202f224\u202f239');
	assert.equal(fmt.count(1234), '1234');
	assert.equal(fmt.count(12345), '12\u202f345');
	assert.equal(fmt.count(-12345), '−12\u202f345');
	assert.equal(fmt.count('x'), '—');
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
	assert.equal(fmt.macTail('00:00:5e:00:53:c1'), '53:C1');
	assert.equal(fmt.macTail('nonsense'), '');
});


test('fmt: traffic reads in bytes when picked; link rates stay bitrates', () => {
	try {
		fmt.setSpeedUnits('bytes');
		assert.equal(fmt.speedUnits(), 'bytes');
		assert.equal(fmt.bits(8e6), '1 MB/s');
		assert.equal(fmt.bits(372.3e6), '46.5 MB/s');
		assert.equal(fmt.bits(12.34e3), '1.54 kB/s');
		assert.equal(fmt.bits(800), '100 B/s');
		assert.equal(fmt.bits(0), '0 B/s');
		assert.equal(fmt.bits(-1), '—');
		assert.equal(fmt.bits('x'), '—');
		assert.equal(fmt.rates(12.3e6, 800), '↓ 1.54 MB/s  ↑ 100 B/s');
		assert.equal(fmt.rates(0, 0), 'idle');
		assert.deepEqual(fmt.rateParts(400e6, 1.6e9), { dn: '50.0', up: '200', unit: 'MB/s' }, 'one unit for both, as in bits');
		assert.equal(fmt.phyRate(576400), '576 Mbit/s', 'a negotiated speed, not traffic');
		fmt.setSpeedUnits('nibbles');
		assert.equal(fmt.speedUnits(), 'bytes', 'an unknown unit changes nothing');
	} finally {
		fmt.setSpeedUnits('bits');
	}
	assert.equal(fmt.bits(8e6), '8 Mbit/s');
});

/* #168: the Ports tile breaks a note between these two, in every language */
test('fmt.labelled: a note as its label and the rest, at the first colon, Chinese\'s too', () => {
	assert.deepEqual(fmt.labelled('Dropped: 0 in · 3 out'), [ 'Dropped: ', '0 in · 3 out' ]);
	assert.deepEqual(fmt.labelled('已丢弃：0 入 · 3 出'), [ '已丢弃：', '0 入 · 3 出' ]);
	assert.deepEqual(fmt.labelled('Erreurs : 12 entrantes'), [ 'Erreurs : ', '12 entrantes' ]);
	assert.deepEqual(fmt.labelled('Ratio: 1:2'), [ 'Ratio: ', '1:2' ], 'the first one');
	for (const t of [ 'no colon here', 'ends with one:', '', ':' ]) assert.deepEqual(fmt.labelled(t), [ t ], t);
	assert.deepEqual([ fmt.labelled(null), fmt.labelled(undefined), fmt.labelled(7) ], [ [ '' ], [ '' ], [ '7' ] ]);
});

test('fmt.daysAgo: days for two months, months for two years, then full years', () => {
	assert.deepEqual([ 0, 0.9, 1, 1.5, 2, 59, 60, 91, 365, 700, 730, 731, 1095, 1096, 4000 ].map(d => fmt.daysAgo(d)),
		[ 'today', 'today', '1 day ago', '1 day ago', '2 days ago', '59 days ago', '2 months ago', '3 months ago', '12 months ago', '23 months ago', '24 months ago', '2 years ago', '2 years ago', '3 years ago', '10 years ago' ]);
	for (const junk of [ -1, null, undefined, 'x', NaN ]) assert.equal(fmt.daysAgo(junk), '—', String(junk));
});

test('fmt.safeText: neutralises reordering characters, cuts by code point', () => {
	assert.equal(fmt.safeText('abc\u202egnp', 64), 'abc�gnp');
	assert.equal(fmt.safeText('\u200b', 64), '�');
	assert.equal(fmt.safeText('x'.repeat(10), 5), 'xxxx…');
	assert.equal(fmt.safeText('😀😀😀', 2), '😀…');
	assert.equal(fmt.safeText(null), '');
});

test('fmt.safeText: reads no more than its length can show, with the same result as reading all of it', () => {
	/* the result as it was made before: all of the text replaced, then cut */
	const src = require('fs').readFileSync(require('path').join(__dirname, '../luci-app-vantage/htdocs/luci-static/resources/vantage/fmt.js'), 'utf8');
	const UNSAFE = new Function('return ' + /^var UNSAFE_TEXT = (\/.+\/g);$/m.exec(src)[1])();
	const whole = (s, max) => {
		if (s == null) return '';
		const chars = Array.from(String(s).replace(UNSAFE, '\ufffd'));
		max = max > 1 ? max : 64;
		return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
	};
	/* pairs, lone halves of a pair, tag characters (a pair each), what is replaced and what is not */
	const parts = [ 'a', 'é', '\u{1F600}', '\u200b', '\u202e', '\u0000', '\uDB40\uDC41', '\uDB40', '\uDC41', '\ufe0f', '\u3164', '\u{E0100}', ' ' ];
	let seed = 7;
	const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
	for (let i = 0; i < 20000; i++) {
		let s = '';
		for (let k = rnd(160); k > 0; k--) s += parts[rnd(parts.length)];
		const max = [ undefined, 0, 1, 2, 3, 5, 8, 16, 32, 48, 64 ][rnd(11)];
		assert.equal(fmt.safeText(s, max), whole(s, max), JSON.stringify([ s, max ]));
	}
	/* a reply of a megabyte: what is replaced and spread is the part that can show */
	const seen = [], replace = String.prototype.replace, from = Array.from;
	String.prototype.replace = function(re, to) { if (re instanceof RegExp) seen.push(this.length); return replace.call(this, re, to); };
	Array.from = function(x) { seen.push(typeof x === 'string' ? x.length : -1); return from.apply(Array, arguments); };
	try { assert.equal(fmt.safeText('\u202e'.repeat(1 << 20), 32), '\ufffd'.repeat(31) + '…'); }
	finally { String.prototype.replace = replace; Array.from = from; }
	assert.ok(seen.length && seen.every(n => n >= 0 && n <= 66), seen.join(' '));
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
	/* "short GI" is HT and VHT's; HE and EHT's guard intervals count up from the shortest */
	assert.equal(wifi.phy({ rate: 866000, mhz: 80, vht: true, mcs: 9, nss: 2, short_gi: true }).detail, 'MCS 9 · 2×2 · short GI');
	assert.equal(wifi.phy({ rate: 650000, mhz: 80, he: true, mcs: 7, nss: 2, he_gi: 1 }).detail, 'MCS 7 · 2×2');
	assert.equal(wifi.phy({ rate: 650000, mhz: 80, eht: true, mcs: 7, nss: 2, eht_gi: 2 }).detail, 'MCS 7 · 2×2');
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
	assert.equal(series.niceCeil(392e6), 400e6);
	assert.equal(series.niceCeil(418e6), 500e6);
	assert.equal(series.niceCeil(1000), 1000);
	assert.equal(series.niceCeil(1100), 1500);
	assert.equal(series.niceCeil(NaN), 1);
	assert.equal(series.niceCeil(0), 1);
	assert.equal(series.niceCeil(-5), 1);
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
