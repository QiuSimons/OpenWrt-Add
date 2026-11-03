'use strict';
/* Throughput chart styles: series.chartGeom and the smooth paths. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const series = load('vantage.series');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('chart styles: overlaid is the default, and unknown styles fall back to it', () => {
	assert.equal(series.CHART_STYLES[0], 'overlay');
	assert.deepEqual(series.CHART_STYLES, [ 'overlay', 'log', 'mirror', 'mirror-split', 'lanes' ]);
	const g = series.chartGeom('nonsense', 40e6, 1e6);
	near(g.dn.frac(0), 1);
	assert.equal(g.dn.scale, g.up.scale);
});

test('chart styles: linear scales never go below 10 kbit/s and round up', () => {
	for (const style of [ 'overlay', 'mirror', 'mirror-split', 'lanes' ]) {
		const idle = series.chartGeom(style, 413, 0);
		assert.equal(idle.dn.scale, 1e4, style + ': an idle link keeps a 10 kbit/s scale');
		assert.equal(idle.up.scale, 1e4, style);
		assert.ok(Math.abs(idle.dn.frac(413) - idle.dn.base) < .05, style + ': chatter stays near the baseline');
	}
	assert.equal(series.chartGeom('overlay', 372e6, 3e6).dn.scale, 400e6);
	assert.equal(series.chartGeom('overlay', null, undefined).dn.scale, 1e4);
});

test('chart styles: shared scales show both directions honestly', () => {
	for (const style of [ 'overlay', 'mirror' ]) {
		const g = series.chartGeom(style, 27.6e3, 62.9e3);
		assert.equal(g.dn.scale, g.up.scale, style);
		const hd = Math.abs(g.dn.frac(27.6e3) - g.dn.base), hu = Math.abs(g.up.frac(62.9e3) - g.up.base);
		near(hd / hu, 27.6 / 62.9);
	}
	/* mirrored: download rises from the middle, upload hangs below it */
	const m = series.chartGeom('mirror', 1e6, 1e6);
	near(m.dn.base, .5); near(m.up.base, .5);
	assert.ok(m.dn.frac(1e6) < .5 && m.up.frac(1e6) > .5);
	assert.equal(m.dn.flip, false);
	assert.equal(m.up.flip, true, 'the hanging area fades towards its baseline');
});

test('chart styles: per-direction scales keep a small upload visible', () => {
	for (const style of [ 'mirror-split', 'lanes' ]) {
		const g = series.chartGeom(style, 40e6, .8e6);
		assert.ok(g.up.scale < g.dn.scale, style);
		assert.ok(Math.abs(g.up.frac(.8e6) - g.up.base) > .25, style + ': upload fills a good part of its space');
		assert.ok(g.labels.some((l) => l.dir === 'dn') && g.labels.some((l) => l.dir === 'up'), style + ': each scale is labelled with its direction');
	}
	/* lanes: download above, upload below, never overlapping */
	const l = series.chartGeom('lanes', 40e6, .8e6);
	assert.ok(l.dn.frac(40e6) >= 0 && l.dn.base <= l.up.frac(1e12));
	near(l.up.base, 1);
});

test('chart styles: log scale counts in decades from 1 kbit/s, at least to 1 Mbit/s', () => {
	const g = series.chartGeom('log', 44e6, .9e6);
	assert.equal(g.dn.scale, 1e8);
	near(g.dn.frac(1e3), 1);
	near(g.dn.frac(10), 1, 'less than 1 kbit/s sits on the baseline');
	near(g.dn.frac(1e8), 0);
	near(g.dn.frac(1e5), .6);
	assert.equal(g.grid.length, 1 + 4, 'the top line and one per decade between');
	const idle = series.chartGeom('log', 2.8e3, 0);
	assert.equal(idle.dn.scale, 1e6);
	assert.ok(idle.dn.frac(2.8e3) > .8, 'idle chatter stays low');
	assert.deepEqual(idle.labels.map((x) => x.v), [ 1e6, 1e3 ]);
});

test('chart styles: every style maps into the plot, whatever the value', () => {
	for (const style of series.CHART_STYLES)
		for (const [ pd, pu ] of [ [ 0, 0 ], [ 5e8, 1e3 ], [ 1e3, 5e8 ] ]) {
			const g = series.chartGeom(style, pd, pu);
			for (const v of [ 0, 1, 999, 1e4, pd, pu, 1e12 ]) {
				for (const dir of [ g.dn, g.up ]) {
					const f = dir.frac(v);
					assert.ok(f >= 0 && f <= 1, `${style} ${v}: ${f}`);
				}
			}
			for (const f of g.grid.concat(g.axis, g.labels.map((x) => x.at)))
				assert.ok(f >= 0 && f <= 1, style);
		}
});

test('chart traces, gaps and smooth paths', () => {
	const data = [ [ 0, 0 ], [ 1000, 50 ], [ 2000, 100 ], [ 20000, 50 ] ];
	const segs = series.trace(data, 1, 0, 20000, 200, 100, 5000, (v) => 1 - v / 100);
	assert.deepEqual(segs, [ [ [ 0, 100 ], [ 10, 50 ], [ 20, 0 ] ], [ [ 200, 50 ] ] ]);
	assert.deepEqual(series.gaps(data, 0, 20000, 5000), [ [ .1, 1 ] ]);
	assert.deepEqual(series.gaps(data, 0, 20000, 30000), []);
	const path = series.curvePath(segs);
	assert.match(path, /^M0 100C[\d. -]+C[\d. -]+M200 50h0\.1$/);
	assert.equal(series.curveArea(segs, 100), series.curvePath([ segs[0] ]) + 'L20 100L0 100Z',
		'a single point has no area');
	/* monotone: a step never overshoots its samples */
	const step = [ [ [ 0, 100 ], [ 10, 100 ], [ 20, 0 ], [ 30, 0 ] ] ];
	const ys = series.curvePath(step).match(/-?\d+(\.\d+)?/g).map(Number).filter((_, i) => i % 2 === 1);
	assert.ok(ys.every((y) => y >= 0 && y <= 100), ys.join(' '));
});

/* the dashboard keeps the viewer's pick in this browser */
function loadView() {
	const fs = require('fs'), path = require('path');
	const { RES } = require('./luci-stub');
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = { view: { extend: p => p }, rpc: { declare: () => () => Promise.resolve(null) }, poll: {}, ui: {}, dom: {} };
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

function withStorage(initial, fn) {
	const store = Object.assign({}, initial), saved = global.window;
	global.window = {
		localStorage: { getItem: k => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
		sessionStorage: { getItem: () => null, setItem() {} }
	};
	try { return fn(store); } finally { global.window = saved; }
}

test('chart style pick: read back, junk ignored, a change repaints and is remembered', () => {
	const view = loadView();
	for (const [ stored, want ] of [ [ undefined, 'overlay' ], [ 'lanes', 'lanes' ], [ 'log', 'log' ],
		[ '"><img src=x>', 'overlay' ], [ 'constructor', 'overlay' ], [ 'LANES', 'overlay' ] ])
		withStorage(stored === undefined ? {} : { 'vantage.chart.v1': stored }, () => {
			const self = Object.create(view);
			self.initState({});
			assert.equal(self.chartStyle, want, String(stored));
		});

	withStorage({}, (store) => {
		const self = Object.create(view);
		self.initState({});
		let painted = 0, hidden = 0;
		self.paintChart = () => { painted++; };
		self.chartHide = () => { hidden++; };
		self.setChartStyle('mirror');
		assert.equal(self.chartStyle, 'mirror');
		assert.equal(store['vantage.chart.v1'], 'mirror');
		assert.deepEqual([ painted, hidden ], [ 1, 1 ]);
		self.setChartStyle('mirror');
		self.setChartStyle('bogus');
		assert.equal(painted, 1, 'the same or an unknown style changes nothing');
		assert.equal(self.chartStyle, 'mirror');
		self.setChartStyle('overlay');
		assert.ok(!('vantage.chart.v1' in store), 'the default is not stored');
	});
});

test('chart styles: the lanes upload label sits at its lane\'s top line', () => {
	const g = series.chartGeom('lanes', 40e6, .8e6);
	const up = g.labels.find((l) => l.dir === 'up');
	near(up.at, .64);
	assert.ok(g.grid.includes(.64), 'on a grid line');
	/* at the 72 px minimum plot: the label (10.5 px text, 3 px above its
	   line) stays clear of a zero download's line and its end dot
	   (4.5 px radius below the line) */
	const h = 72, labelTop = up.at * h - 3 - 10.5, dotBottom = g.dn.base * h + 4.5;
	assert.ok(labelTop - dotBottom >= 1.5, `label top ${labelTop} vs download dot ${dotBottom}`);
});

test('chart history: restored values above the rate ceiling are dropped; scales stay finite', () => {
	const t = Date.now();
	const stored = [ [ t - 2000, 5e6, 1e6 ], [ t - 1000, Number.MAX_VALUE, Number.MAX_VALUE ], [ t, 5e11, 1 ] ];
	assert.deepEqual(series.valid(stored, 3, 90, t, 400e9).map((p) => p[0]), [ t - 2000 ], 'MAX_VALUE and 5e11 dropped');
	assert.equal(series.valid(stored, 3, 90, t).length, 3, 'without a ceiling nothing changes');
	for (const style of series.CHART_STYLES)
		for (const peak of [ Number.MAX_VALUE, 1e300, Infinity ]) {
			const g = series.chartGeom(style, peak, peak);
			for (const d of [ g.dn, g.up ]) {
				assert.ok(Number.isFinite(d.scale), `${style} ${peak}: scale ${d.scale}`);
				const f = d.frac(peak);
				assert.ok(f >= 0 && f <= 1, `${style}: ${f}`);
			}
		}
});
