'use strict';
/* Dashboard layout rules: defaults, stored layouts, editing, packing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const layout = load('vantage.layout');
const ids = list => list.map(e => e.id);
const shown = list => list.filter(e => !e.hide).map(e => e.id);

test('tier follows the stylesheet breakpoints', () => {
	assert.equal(layout.tier(390), 'narrow');
	assert.equal(layout.tier(699), 'narrow');
	assert.equal(layout.tier(700), 'mid');
	assert.equal(layout.tier(1099), 'mid');
	assert.equal(layout.tier(1100), 'wide');
	assert.deepEqual([ layout.cols('wide'), layout.cols('mid'), layout.cols('narrow') ], [ 4, 2, 1 ]);
});

test('defaults: Wi-Fi and wired devices', () => {
	assert.deepEqual(ids(layout.defaults('wide', false)), [ 'hero', 'chart', 'radios', 'clients', 'sys', 'talk', 'ssids' ]);
	assert.deepEqual(ids(layout.defaults('narrow', false)), [ 'clients', 'talk', 'radios', 'hero', 'ssids', 'chart', 'sys' ]);
	assert.deepEqual(layout.defaults('wide', true).map(e => [ e.id, e.c, e.w ]), [ [ 'hero', 0, 4 ], [ 'chart', 0, 3 ], [ 'sys', 3, 1 ], [ 'clients', 0, 4 ] ]);
	assert.deepEqual(ids(layout.defaults('narrow', true)), [ 'hero', 'clients', 'chart', 'sys' ], 'wired hosts are clients too');
	assert.equal(layout.key('wide', true), 'wide-wired');
});

test('normalize: junk, unknown and duplicate tiles are dropped; widths clamped', () => {
	assert.deepEqual(layout.normalize(null, 'wide', false), layout.defaults('wide', false));
	assert.deepEqual(layout.normalize('x', 'wide', false), layout.defaults('wide', false));
	const n = layout.normalize([ { id: 'sys', c: 2, w: 9 }, { id: '__proto__', w: 1 }, { id: 'sys', w: 1 }, 7, { id: 'hero', c: 3, w: 1 }, { id: 'evil', w: 2 }, { id: 'talk', c: -5, w: 'x' } ], 'wide', false);
	assert.equal(n[0].id, 'sys');
	assert.deepEqual([ n[0].c, n[0].w ], [ 0, 4 ], 'clamped to the column count');
	assert.equal(n.filter(e => e.id === 'sys').length, 1);
	const hero = n[layout.indexOf(n, 'hero')], talk = n[layout.indexOf(n, 'talk')];
	assert.deepEqual([ hero.c, hero.w ], [ 1, 3 ], 'raised to the path minimum, kept inside the grid');
	assert.deepEqual([ talk.c, talk.w ], [ 0, 1 ]);
	assert.deepEqual(ids(n).slice().sort(), layout.TILES.slice().sort(), 'every tile present once');
});

test('normalize: tiles missing from a stored layout return after their default neighbour', () => {
	const n = layout.normalize([ { id: 'clients', w: 3 }, { id: 'hero', w: 4 } ], 'wide', false);
	/* sys follows clients by default, chart follows hero, and so on */
	assert.deepEqual(ids(n), [ 'clients', 'sys', 'talk', 'ssids', 'hero', 'chart', 'radios' ]);
});

test('normalize: Wi-Fi tiles never appear on a wired device; one tile always shows', () => {
	const n = layout.normalize([ { id: 'talk', w: 2 }, { id: 'sys', w: 1, hide: true }, { id: 'hero', w: 4, hide: true }, { id: 'chart', w: 2, hide: true }, { id: 'clients', w: 4, hide: true } ], 'wide', true);
	assert.deepEqual(ids(n), [ 'sys', 'hero', 'chart', 'clients' ]);
	assert.equal(shown(n).length, 1);
});

test('encode and decode: the router\'s form of a layout', () => {
	const list = [ { id: 'hero', c: 0, w: 4 }, { id: 'chart', c: 0, w: 2, hide: true } ];
	assert.equal(layout.encode(list), 'hero:0:4 chart:0:2:h');
	assert.equal(layout.option('wide'), 'layout_wide');
	assert.equal(layout.option('narrow-wired'), 'layout_narrow_wired');
	const got = layout.decode('wide=hero:0:4 chart:0:2:h;mid=default;narrow_wired=sys:0:1');
	assert.deepEqual(Object.keys(got), [ 'wide', 'mid', 'narrow-wired' ]);
	assert.deepEqual([ ...got.wide ], list);
	assert.equal(got.mid, null, 'null is the default layout');
	for (const junk of [ '', null, undefined, 'x', 'wide', 'wide=', '=hero:0:4', 'tall=hero:0:4', '__proto__=hero:0:4' ])
		assert.deepEqual(Object.keys(layout.decode(junk)), [], String(junk));
	assert.deepEqual(layout.normalize(layout.decode('wide=nosuch:0:4').wide, 'wide', false), layout.defaults('wide', false), 'normalize has the last word');
	assert.equal(layout.encode([ null, 1, 'x', { id: 'hero', c: 0, w: 4 } ]), 'hero:0:4', 'stored junk is skipped');
	assert.deepEqual(layout.normalize([], 'wide', false), layout.defaults('wide', false), 'an empty layout is the default');
});

test('merge: the router first for a login that may save, this browser first for any other', () => {
	const mine = { wide: [ 'mine' ], mid: [ 'mine' ] }, saved = { wide: [ 'router' ], narrow: [ 'router' ], mid: null };
	const yes = layout.merge(mine, saved, true);
	assert.deepEqual(Object.assign({}, yes), { wide: [ 'router' ], narrow: [ 'router' ] }, 'the router\'s reset wins too');
	const no = layout.merge(mine, saved, false);
	assert.deepEqual(Object.assign({}, no), { wide: [ 'mine' ], mid: [ 'mine' ], narrow: [ 'router' ] });
	assert.deepEqual(Object.assign({}, layout.merge(mine, {}, true)), mine, 'a browser keeps its own until someone saves');
	assert.deepEqual(mine, { wide: [ 'mine' ], mid: [ 'mine' ] }, 'nothing changed in place');
});

test('move skips hidden tiles and stops at the ends', () => {
	let l = layout.setHidden(layout.defaults('wide', false), 'radios', true);
	l = layout.move(l, 'chart', 1);
	assert.deepEqual(ids(l).slice(0, 4), [ 'hero', 'radios', 'clients', 'chart' ]);
	assert.deepEqual(ids(layout.move(l, 'hero', -1)), ids(l));
	assert.deepEqual(ids(layout.move(l, 'ssids', 1)), ids(l));
});

test('drop puts a dragged tile in a column, before or after a target', () => {
	const d = layout.defaults('wide', false);
	let l = layout.drop(d, 'ssids', 0, 'hero', false, 'wide');
	assert.deepEqual(ids(l).slice(0, 2), [ 'ssids', 'hero' ]);
	assert.equal(l[0].c, 0);
	l = layout.drop(d, 'hero', 2, 'ssids', true, 'wide');
	assert.deepEqual(ids(l).slice(-2), [ 'ssids', 'hero' ]);
	assert.deepEqual([ l[6].c, l[6].w ], [ 0, 4 ], 'a full-width tile stays in column 0');
	l = layout.drop(d, 'talk', 1, null, false, 'wide');
	assert.deepEqual(ids(l), ids(d), 'no target keeps the order');
	assert.equal(l[layout.indexOf(l, 'talk')].c, 1);
});

test('shift moves a tile between columns inside the grid', () => {
	let l = layout.defaults('wide', false);
	l = layout.shift(l, 'sys', 1, 'wide');
	assert.equal(l[layout.indexOf(l, 'sys')].c, 3);
	l = layout.shift(l, 'sys', -2, 'wide');
	assert.equal(l[layout.indexOf(l, 'sys')].c, 1);
	assert.equal(layout.shift(l, 'hero', 1, 'wide')[0].c, 0);
});

test('resize respects per-tile minimums and the column count', () => {
	let l = layout.defaults('wide', false);
	l = layout.resize(l, 'hero', -3, 'wide');
	assert.equal(l[0].w, 3);
	l = layout.resize(l, 'sys', 1, 'wide');
	assert.deepEqual([ l[layout.indexOf(l, 'sys')].c, l[layout.indexOf(l, 'sys')].w ], [ 2, 2 ], 'grows to the left at the edge');
	l = layout.resize(l, 'sys', 9, 'wide');
	assert.deepEqual([ l[layout.indexOf(l, 'sys')].c, l[layout.indexOf(l, 'sys')].w ], [ 0, 4 ]);
	assert.equal(layout.resize(layout.defaults('narrow', false), 'chart', 1, 'narrow')[5].w, 1);
});

test('the last shown tile cannot be hidden', () => {
	let l = layout.defaults('wide', true);
	l = layout.setHidden(l, 'hero', true);
	l = layout.setHidden(l, 'chart', true);
	l = layout.setHidden(l, 'clients', true);
	l = layout.setHidden(l, 'sys', true);
	assert.deepEqual(shown(l), [ 'sys' ]);
	assert.deepEqual(shown(layout.setHidden(l, 'hero', false)), [ 'hero', 'sys' ]);
});

test('pack: the default wide layout keeps System beside Clients', () => {
	const h = { hero: 360, chart: 400, radios: 418, clients: 420, sys: 500, talk: 120, ssids: 260 };
	const items = layout.defaults('wide', false).map(e => ({ id: e.id, c: e.c, w: e.w, h: h[e.id] }));
	const p = layout.pack(items, 4, 14).rects;
	assert.deepEqual([ p.hero.c, p.hero.top ], [ 0, 0 ]);
	assert.deepEqual([ p.chart.c, p.radios.c ], [ 0, 2 ]);
	assert.equal(p.chart.h, 418, 'the chart lines up with the radio cards');
	assert.deepEqual([ p.clients.c, p.clients.top ], [ 0, 360 + 14 + 418 + 14 ]);
	assert.deepEqual([ p.sys.c, p.sys.top ], [ 3, p.clients.top ]);
	assert.deepEqual([ p.talk.c, p.talk.top ], [ 3, p.sys.top + 500 + 14 ], 'stays in its column even beside short Clients');
	assert.equal(p.ssids.c, 3);
	assert.equal(p.clients.h, 420, 'Clients keeps its height beside a taller column');
});

test('pack: a short tile beside a tall one leaves room for the next tile', () => {
	/* the old problem: path beside System. Now the chart fills in under
	   the path instead of the path stretching */
	const p = layout.pack([ { id: 'hero', c: 0, w: 3, h: 360 }, { id: 'sys', c: 3, w: 1, h: 520 }, { id: 'chart', c: 0, w: 2, h: 300 } ], 4, 14);
	assert.equal(p.rects.hero.h, 360);
	assert.deepEqual([ p.rects.chart.c, p.rects.chart.top ], [ 0, 374 ]);
});

test('pack: small gaps snap, large ones only for the chart', () => {
	const near = layout.pack([ { id: 'talk', c: 0, w: 1, h: 100 }, { id: 'ssids', c: 1, w: 1, h: 130 }, { id: 'sys', c: 0, w: 2, h: 50 } ], 2, 10).rects;
	assert.equal(near.talk.h, 130);
	const far = layout.pack([ { id: 'talk', c: 0, w: 1, h: 100 }, { id: 'ssids', c: 1, w: 1, h: 400 }, { id: 'sys', c: 0, w: 2, h: 50 } ], 2, 10).rects;
	assert.equal(far.talk.h, 100);
	const wired = layout.pack(layout.defaults('wide', true).map(e => ({ id: e.id, c: e.c, w: e.w, h: { hero: 360, chart: 330, sys: 520, clients: 300 }[e.id] })), 4, 14);
	assert.equal(wired.rects.chart.h, 520, 'the chart fills the row beside System');
	assert.equal(wired.height, 360 + 14 + 520 + 14 + 300);
});

test('pack: a tile never stretches over a tile placed under it', () => {
	/* the chart widened to three columns, the radio cards under its
	   last column, Clients after them: the chart must not grow down to
	   Clients, it would cover the radio cards */
	const h = { hero: 360, chart: 400, radios: 418, clients: 420, sys: 500, talk: 120, ssids: 260 };
	let l = layout.resize(layout.defaults('wide', false), 'chart', 1, 'wide');
	const p = layout.pack(l.filter(e => !e.hide).map(e => ({ id: e.id, c: e.c, w: e.w, h: h[e.id] })), 4, 14).rects;
	assert.deepEqual([ p.chart.c, p.chart.w, p.radios.c ], [ 0, 3, 2 ]);
	assert.equal(p.radios.top, p.chart.top + p.chart.h + 14, 'radio cards start under the chart');
	assert.equal(p.chart.h, 400);
	for (const a of Object.keys(p)) for (const b of Object.keys(p)) {
		if (a >= b) continue;
		const x = p[a], y = p[b];
		const cols = x.c < y.c + y.w && y.c < x.c + x.w, rows = x.top < y.top + y.h && y.top < x.top + x.h;
		assert.ok(!(cols && rows), a + ' overlaps ' + b);
	}
});

test('settle: tiles grow at once and shrink only after holding for a while', () => {
	let s = layout.settle(null, 300, 0);
	assert.deepEqual(s, { h: 300, since: null });
	s = layout.settle(s, 360, 5000);
	assert.deepEqual(s, { h: 360, since: null }, 'grows immediately');
	s = layout.settle(s, 320, 10000);
	assert.deepEqual(s, { h: 360, since: 10000 }, 'holds when the content shrinks');
	s = layout.settle(s, 300, 20000);
	assert.deepEqual(s, { h: 360, since: 10000 }, 'still holding, the clock keeps running');
	assert.deepEqual(layout.settle(s, 380, 25000), { h: 380, since: null }, 'growing again clears the clock');
	s = layout.settle(s, 300, 10000 + layout.HOLD_MS);
	assert.deepEqual(s, { h: 300, since: null }, 'shrinks once held long enough');
});

test('nextRelease: ms to the earliest held height, null without one', () => {
	assert.equal(layout.nextRelease({}, 0), null);
	assert.equal(layout.nextRelease({ a: { h: 300, since: null } }, 0), null);
	assert.equal(layout.nextRelease({ a: { h: 300, since: 1000 }, b: { h: 200, since: 5000 } }, 2000), layout.HOLD_MS - 1000);
	assert.equal(layout.nextRelease({ a: { h: 300, since: 0 } }, layout.HOLD_MS + 5), 0, 'overdue: now');
});
