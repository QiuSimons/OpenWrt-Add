'use strict';
/* The network path's wires and the dots that flow along them
   (vantage/wires.js): the path the SVG draws and the points the dots move
   through are the same curve; the dots are evenly spaced, about 16 px
   apart, and move at the old dash animation's speeds. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const wires = load('vantage.wires');
const box = (l, t, w, h) => ({ l, r: l + w, t, b: t + h, cy: t + h / 2 });
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('curve: side by side an S-curve between the facing edges, same ends as its points', () => {
	const c = wires.curve(box(0, 0, 100, 40), box(200, 60, 100, 40));
	assert.equal(c.d, 'M100.0 20.0C150.0 20.0 150.0 80.0 200.0 80.0');
	assert.deepEqual(c.pts[0], [ 100, 20 ]);
	assert.deepEqual(c.pts[c.pts.length - 1], [ 200, 80 ]);
	/* the Bézier's midpoint */
	const mid = c.pts[(c.pts.length - 1) / 2];
	near(mid[0], 150, 1e-9, 'mid x');
	near(mid[1], 50, 1e-9, 'mid y');
});

test('curve: stacked, an elbow down the left side; a straight drop when there is no room', () => {
	const c = wires.curve(box(0, 0, 200, 40), box(60, 100, 150, 40));
	assert.equal(c.d, 'M18.0 40.0V112.0Q18.0 120.0 26.0 120.0H60.0');
	assert.deepEqual(c.pts[0], [ 18, 40 ]);
	assert.deepEqual(c.pts[c.pts.length - 1], [ 60, 120 ]);
	const drop = wires.curve(box(0, 0, 200, 40), box(10, 100, 150, 40));
	assert.equal(drop.d, 'M18.0 40.0V100.0');
	assert.deepEqual(drop.pts, [ [ 18, 40 ], [ 18, 100 ] ]);
});

test('resample: equal steps along the curve, direction of travel without jumps', () => {
	const c = wires.curve(box(0, 0, 200, 40), box(60, 100, 150, 40));
	const r = wires.resample(c.pts, 8);
	near(r.len, 72 + 34 + 13, 0.5, 'length');   /* the two straight runs plus the 8 px corner (about 13 px) */
	const steps = r.pts.slice(1).map((p, i) => Math.hypot(p[0] - r.pts[i][0], p[1] - r.pts[i][1]));
	assert.ok(Math.max(...steps) <= 8 + 1e-9, 'no step longer than asked');
	assert.ok(Math.min(...steps) > 7, 'and none much shorter (chords across the corner)');
	near(r.pts[0][2], 90, 1e-9, 'starts going down');
	near(r.pts[r.pts.length - 1][2], 0, 1e-9, 'ends going right');
	r.pts.slice(1).forEach((p, i) => assert.ok(Math.abs(p[2] - r.pts[i][2]) <= 90, 'no turn the long way round'));
	assert.deepEqual(wires.resample([ [ 5, 5 ], [ 5, 5 ] ], 8), { pts: [], len: 0 }, 'a zero-length wire has no dots');
});

test('keyframes: transform only, numbers only', () => {
	const f = wires.keyframes([ [ 1, 2, 90 ], [ 3.456, 4, -0.04 ] ]);
	assert.deepEqual(f, [
		{ transform: 'translate(1.00px, 2.00px) rotate(90.0deg)' },
		{ transform: 'translate(3.46px, 4.00px) rotate(-0.0deg)' }
	]);
});

test('dots and speed: one dot per 16 px, 32 px per 1.6 / 1.05 / 0.6 s', () => {
	assert.equal(wires.dots(4), 1);
	assert.equal(wires.dots(160), 10);
	assert.equal(wires.dots(167), 10);
	assert.equal(wires.trip(32), 1600);
	assert.equal(wires.trip(320), 16000);
	assert.equal(wires.rate(1), 1);
	near(32 / (wires.trip(32) / wires.rate(2)), 32 / 1050, 1e-12, 'speed 2');
	near(32 / (wires.trip(32) / wires.rate(3)), 32 / 600, 1e-12, 'speed 3');
	assert.deepEqual([ wires.speed(1e6), wires.speed(50e6), wires.speed(500e6) ], [ 1, 2, 3 ]);
});
