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
	assert.deepEqual(layout.defaults('wide', true).map(e => [ e.id, e.c, e.w ]), [ [ 'hero', 0, 4 ], [ 'chart', 0, 3 ], [ 'sys', 3, 1 ], [ 'clients', 0, 3 ], [ 'talk', 3, 1 ] ]);
	assert.deepEqual(layout.defaults('mid', true).map(e => [ e.id, e.c, e.w ]), [ [ 'hero', 0, 2 ], [ 'chart', 0, 2 ], [ 'clients', 0, 2 ], [ 'talk', 0, 1 ], [ 'sys', 1, 1 ] ]);
	assert.deepEqual(ids(layout.defaults('narrow', true)), [ 'hero', 'clients', 'talk', 'chart', 'sys' ], 'wired hosts are clients too, and talkers');
	assert.equal(layout.key('wide', true), 'wide-wired');
});

/* #129: a wired-only device has Top talkers too; Radios and Wireless
   networks stay Wi-Fi's */
test('tiles: five without Wi-Fi, seven with it', () => {
	const on = wired => layout.TILES.filter(id => layout.available(id, wired));
	assert.deepEqual(on(true), [ 'hero', 'chart', 'clients', 'sys', 'talk' ]);
	assert.deepEqual(on(false), [ 'hero', 'chart', 'radios', 'clients', 'sys', 'talk', 'ssids' ]);
	for (const tier of [ 'wide', 'mid', 'narrow' ]) {
		assert.deepEqual(ids(layout.defaults(tier, true)).sort(), on(true).sort(), tier);
		assert.equal(layout.defaults(tier, false).length, 7, tier);
	}
	assert.equal(layout.available('nosuch', true), false);
});

/* a wired layout saved before Top talkers existed there does not mention
   it: it comes in by the rule for any tile a stored layout leaves out,
   after the tile it follows by default (Clients) */
test('normalize: a wired layout saved without Top talkers gets it after Clients, the rest as saved', () => {
	const before = {
		wide: [ { id: 'hero', c: 0, w: 4 }, { id: 'chart', c: 0, w: 3 }, { id: 'sys', c: 3, w: 1 }, { id: 'clients', c: 0, w: 4 } ],
		mid: [ { id: 'hero', c: 0, w: 2 }, { id: 'chart', c: 0, w: 2 }, { id: 'sys', c: 0, w: 2 }, { id: 'clients', c: 0, w: 2 } ],
		narrow: [ { id: 'hero', c: 0, w: 1 }, { id: 'clients', c: 0, w: 1 }, { id: 'chart', c: 0, w: 1 }, { id: 'sys', c: 0, w: 1 } ]
	};
	const flat = list => list.map(e => [ e.id, e.c, e.w, e.hide ]);
	assert.deepEqual(flat(layout.normalize(before.wide, 'wide', true)),
		[ [ 'hero', 0, 4, false ], [ 'chart', 0, 3, false ], [ 'sys', 3, 1, false ], [ 'clients', 0, 4, false ], [ 'talk', 3, 1, false ] ]);
	assert.deepEqual(flat(layout.normalize(before.mid, 'mid', true)),
		[ [ 'hero', 0, 2, false ], [ 'chart', 0, 2, false ], [ 'sys', 0, 2, false ], [ 'clients', 0, 2, false ], [ 'talk', 0, 1, false ] ]);
	assert.deepEqual(ids(layout.normalize(before.narrow, 'narrow', true)), [ 'hero', 'clients', 'talk', 'chart', 'sys' ]);
	/* the viewer's own order and hidden tiles stay; the new tile is shown */
	const mine = layout.normalize([ { id: 'clients', c: 0, w: 4 }, { id: 'sys', c: 0, w: 1, hide: true }, { id: 'hero', c: 0, w: 4 }, { id: 'chart', c: 1, w: 3 } ], 'wide', true);
	assert.deepEqual(flat(mine), [ [ 'clients', 0, 4, false ], [ 'talk', 3, 1, false ], [ 'sys', 0, 1, true ], [ 'hero', 0, 4, false ], [ 'chart', 1, 3, false ] ]);
	/* once saved with it, it stays where the viewer put it, hidden too */
	const kept = layout.normalize(layout.compact(layout.setHidden(layout.move(mine, 'talk', 1), 'talk', true)), 'wide', true);
	assert.deepEqual(flat(kept).filter(e => e[0] === 'talk'), [ [ 'talk', 3, 1, true ] ]);
	assert.deepEqual(ids(kept), [ 'clients', 'sys', 'hero', 'talk', 'chart' ]);
	/* a Wi-Fi layout is as before: nothing is added to one that names every tile */
	const wifi = layout.compact(layout.defaults('wide', false));
	assert.deepEqual(layout.normalize(wifi, 'wide', false), layout.defaults('wide', false));
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
	/* (the WireGuard tile only with a tunnel, the Ports tile only with ports: below) */
	assert.deepEqual(ids(n).slice().sort(), layout.TILES.filter(id => id !== 'wg' && id !== 'ports').sort(), 'every tile present once');
});

test('normalize: tiles missing from a stored layout return after their default neighbour', () => {
	const n = layout.normalize([ { id: 'clients', w: 3 }, { id: 'hero', w: 4 } ], 'wide', false);
	/* sys follows clients by default, chart follows hero, and so on */
	assert.deepEqual(ids(n), [ 'clients', 'sys', 'talk', 'ssids', 'hero', 'chart', 'radios' ]);
});

test('normalize: Wi-Fi tiles never appear on a wired device; one tile always shows', () => {
	const n = layout.normalize([ { id: 'radios', w: 2 }, { id: 'ssids', w: 1 }, { id: 'sys', w: 1, hide: true }, { id: 'hero', w: 4, hide: true }, { id: 'chart', w: 2, hide: true },
		{ id: 'clients', w: 4, hide: true }, { id: 'talk', w: 1, hide: true } ], 'wide', true);
	assert.deepEqual(ids(n), [ 'sys', 'hero', 'chart', 'clients', 'talk' ]);
	assert.equal(shown(n).length, 1);
});

/* the WireGuard tile exists only with a tunnel, on a device with Wi-Fi or without: the third argument */
test('the WireGuard tile: only with a tunnel; without one every layout is as it was', () => {
	assert.ok(layout.TILES.includes('wg'));
	for (const wired of [ false, true ]) {
		assert.equal(layout.available('wg', wired), false);
		assert.equal(layout.available('wg', wired, false), false);
		assert.equal(layout.available('wg', wired, true), true);
		for (const tier of [ 'wide', 'mid', 'narrow' ]) {
			const without = layout.defaults(tier, wired), wth = layout.defaults(tier, wired, true);
			assert.ok(!ids(without).includes('wg'), tier);
			assert.deepEqual(layout.defaults(tier, wired, false), without);
			/* with a tunnel: the same tiles in the same places, and the tile after them */
			assert.deepEqual(wth.slice(0, -1), without, tier);
			assert.equal(wth[wth.length - 1].id, 'wg', tier);
			assert.deepEqual(layout.normalize(null, tier, wired, true), wth);
		}
	}
	/* the other tiles' conditions stand: Wi-Fi tiles need Wi-Fi, with a tunnel too */
	assert.equal(layout.available('radios', true, true), false);
	assert.deepEqual(ids(layout.defaults('wide', true, true)), [ 'hero', 'chart', 'sys', 'clients', 'talk', 'wg' ]);
	assert.deepEqual(layout.defaults('wide', false, true).slice(-1), [ { id: 'wg', c: 0, w: 2, hide: false } ], 'two columns under Clients');
	assert.deepEqual(layout.defaults('narrow', false, true).slice(-1), [ { id: 'wg', c: 0, w: 1, hide: false } ]);
	/* a stored layout that names it, read without a tunnel (a login that may not ask, an interface that is down) */
	const stored = [ { id: 'wg', c: 0, w: 4 }, { id: 'hero', c: 0, w: 4 }, { id: 'chart', c: 0, w: 2, hide: true } ];
	assert.ok(!ids(layout.normalize(stored, 'wide', false)).includes('wg'));
	assert.deepEqual(layout.normalize(stored, 'wide', false), layout.normalize(stored.slice(1), 'wide', false), 'as if it were not named');
	const n = layout.normalize(stored, 'wide', false, true);
	assert.deepEqual(n[0], { id: 'wg', c: 0, w: 4, hide: false }, 'and with one: where the viewer put it');
	assert.equal(ids(n).length, layout.TILES.length - 1, 'every tile but Ports, which needs ports');
	/* hidden with a tunnel: it stays hidden */
	assert.deepEqual(layout.normalize([ { id: 'hero', c: 0, w: 4 }, { id: 'wg', c: 0, w: 2, hide: true } ], 'wide', false, true).filter(e => e.hide).map(e => e.id), [ 'wg' ]);
});

test('the WireGuard tile: a stored layout from before it gets the tile where the default has it', () => {
	/* a 1.0.x layout: every tile of then, rearranged; nothing about wg */
	const old = [ { id: 'clients', c: 0, w: 4 }, { id: 'hero', c: 0, w: 4 }, { id: 'chart', c: 0, w: 2 }, { id: 'radios', c: 2, w: 2 },
		{ id: 'ssids', c: 0, w: 1 }, { id: 'sys', c: 1, w: 1 }, { id: 'talk', c: 2, w: 1, hide: true } ];
	assert.deepEqual(layout.normalize(old, 'wide', false), old.map(e => Object.assign({ hide: false }, e)), 'without a tunnel: exactly the stored one');
	const n = layout.normalize(old, 'wide', false, true);
	/* after the tile that precedes it by default (the wireless networks), with its default place and width */
	assert.deepEqual(ids(n), [ 'clients', 'hero', 'chart', 'radios', 'ssids', 'wg', 'sys', 'talk' ]);
	assert.deepEqual(n[5], { id: 'wg', c: 0, w: 2, hide: false });
	assert.deepEqual(n.filter(e => e.id !== 'wg'), layout.normalize(old, 'wide', false), 'the others stay as stored');
	/* the router's form of it (decode), and a wired device's, from before Top talkers was a tile there:
	   that one after Clients, the tunnels' after it, each as its default has it */
	const dec = layout.decode('wide_wired=clients:0:4 hero:0:4 sys:3:1:h chart:0:3')['wide-wired'];
	assert.deepEqual(ids(layout.normalize(dec, 'wide', true, true)), [ 'clients', 'talk', 'wg', 'hero', 'sys', 'chart' ]);
	assert.deepEqual(ids(layout.normalize(dec, 'wide', true)), [ 'clients', 'talk', 'hero', 'sys', 'chart' ]);
	/* editing goes on as for any tile, and the result reads back */
	let l = layout.resize(n, 'wg', 1, 'wide');
	l = layout.setHidden(layout.move(l, 'wg', -1), 'wg', true);
	assert.deepEqual(l[layout.indexOf(l, 'wg')], { id: 'wg', c: 0, w: 3, hide: true });
	assert.deepEqual(layout.normalize(layout.decode('wide=' + layout.encode(layout.compact(l))).wide, 'wide', false, true), l);
});

/* the Ports tile exists only on a device with two Ethernet ports or more, with Wi-Fi or without, a tunnel or none:
   the fourth argument */
test('the Ports tile: only with ports; without them every layout is as it was', () => {
	assert.ok(layout.TILES.includes('ports'));
	for (const wired of [ false, true ]) for (const wg of [ false, true ]) {
		assert.equal(layout.available('ports', wired, wg), false);
		assert.equal(layout.available('ports', wired, wg, false), false);
		assert.equal(layout.available('ports', wired, wg, true), true);
		assert.equal(layout.available('wg', wired, wg, true), wg, 'ports are no tunnel');
		for (const tier of [ 'wide', 'mid', 'narrow' ]) {
			const without = layout.defaults(tier, wired, wg), wth = layout.defaults(tier, wired, wg, true);
			assert.ok(!ids(without).includes('ports'), tier);
			assert.deepEqual(layout.defaults(tier, wired, wg, false), without);
			/* with ports: the same tiles in the same places, and the tile after them */
			assert.deepEqual(wth.slice(0, -1), without, tier);
			assert.equal(wth[wth.length - 1].id, 'ports', tier);
			assert.deepEqual(layout.normalize(null, tier, wired, wg, true), wth);
		}
	}
	/* as wide as Clients on a wide screen (beside the right-hand column with Wi-Fi), the full width elsewhere */
	assert.deepEqual(layout.defaults('wide', false, false, true).slice(-1), [ { id: 'ports', c: 0, w: 3, hide: false } ]);
	assert.deepEqual(layout.defaults('wide', true, false, true).slice(-1), [ { id: 'ports', c: 0, w: 4, hide: false } ]);
	for (const wired of [ false, true ]) {
		assert.deepEqual(layout.defaults('mid', wired, false, true).slice(-1), [ { id: 'ports', c: 0, w: 2, hide: false } ]);
		assert.deepEqual(layout.defaults('narrow', wired, false, true).slice(-1), [ { id: 'ports', c: 0, w: 1, hide: false } ]);
	}
	/* every tile there is: nine with Wi-Fi, a tunnel and ports */
	assert.deepEqual(ids(layout.defaults('wide', false, true, true)), [ 'hero', 'chart', 'radios', 'clients', 'sys', 'talk', 'ssids', 'wg', 'ports' ]);
	assert.deepEqual(ids(layout.defaults('wide', false, true, true)).slice().sort(), layout.TILES.slice().sort());
	assert.equal(layout.available('radios', true, true, true), false, 'Wi-Fi tiles need Wi-Fi, with ports too');
	/* it may be one column wide and is not stretched to fill a slot: its cells wrap */
	assert.equal(layout.minW('ports', 'wide'), 1);
	assert.equal(layout.resize(layout.defaults('wide', false, false, true), 'ports', -9, 'wide').slice(-1)[0].w, 1);
	/* a stored layout that names it, read on a device with one port (or before two were seen) */
	const stored = [ { id: 'ports', c: 0, w: 4 }, { id: 'hero', c: 0, w: 4 }, { id: 'chart', c: 0, w: 2, hide: true } ];
	assert.ok(!ids(layout.normalize(stored, 'wide', false)).includes('ports'));
	assert.deepEqual(layout.normalize(stored, 'wide', false), layout.normalize(stored.slice(1), 'wide', false), 'as if it were not named');
	const n = layout.normalize(stored, 'wide', false, false, true);
	assert.deepEqual(n[0], { id: 'ports', c: 0, w: 4, hide: false }, 'and with ports: where the viewer put it');
	assert.deepEqual(layout.normalize([ { id: 'hero', c: 0, w: 4 }, { id: 'ports', c: 0, w: 2, hide: true } ], 'wide', false, false, true).filter(e => e.hide).map(e => e.id), [ 'ports' ], 'hidden stays hidden');
});

test('the Ports tile: a stored layout from before it gets the tile where the default has it', () => {
	/* a 1.0.x layout: every tile of then, rearranged; nothing about ports (or wg) */
	const old = [ { id: 'clients', c: 0, w: 4 }, { id: 'hero', c: 0, w: 4 }, { id: 'chart', c: 0, w: 2 }, { id: 'radios', c: 2, w: 2 },
		{ id: 'ssids', c: 0, w: 1 }, { id: 'sys', c: 1, w: 1 }, { id: 'talk', c: 2, w: 1, hide: true } ];
	assert.deepEqual(layout.normalize(old, 'wide', false), old.map(e => Object.assign({ hide: false }, e)), 'one port: exactly the stored one');
	const n = layout.normalize(old, 'wide', false, false, true);
	/* after the tile that precedes it by default (without a tunnel: the wireless networks), with its default place and width */
	assert.deepEqual(ids(n), [ 'clients', 'hero', 'chart', 'radios', 'ssids', 'ports', 'sys', 'talk' ]);
	assert.deepEqual(n[5], { id: 'ports', c: 0, w: 3, hide: false });
	assert.deepEqual(n.filter(e => e.id !== 'ports'), layout.normalize(old, 'wide', false), 'the others stay as stored');
	/* with a tunnel too: after the WireGuard tile, which itself comes after the wireless networks */
	assert.deepEqual(ids(layout.normalize(old, 'wide', false, true, true)), [ 'clients', 'hero', 'chart', 'radios', 'ssids', 'wg', 'ports', 'sys', 'talk' ]);
	/* a layout arranged with a tunnel and before the Ports tile: after the WireGuard tile, wherever that was put */
	const tun = [ { id: 'wg', c: 0, w: 2 } ].concat(old);
	assert.deepEqual(ids(layout.normalize(tun, 'wide', false, true, true)), [ 'wg', 'ports', 'clients', 'hero', 'chart', 'radios', 'ssids', 'sys', 'talk' ]);
	/* the router's form of it (decode), and a wired device's: after the tile that precedes it in the wired default,
	   the full width; the tiles the layout names stay in its order */
	const dec = layout.decode('wide_wired=clients:0:4 hero:0:4 sys:3:1:h chart:0:3')['wide-wired'];
	const w = layout.normalize(dec, 'wide', true, false, true), def = ids(layout.defaults('wide', true, false, true));
	assert.equal(ids(w)[ids(w).indexOf('ports') - 1], def[def.indexOf('ports') - 1]);
	assert.deepEqual(w[layout.indexOf(w, 'ports')], { id: 'ports', c: 0, w: 4, hide: false });
	assert.deepEqual(ids(w).filter(id => [ 'clients', 'hero', 'sys', 'chart' ].includes(id)), [ 'clients', 'hero', 'sys', 'chart' ]);
	assert.deepEqual(w.filter(e => e.id !== 'ports'), layout.normalize(dec, 'wide', true), 'and without ports: as it was');
	/* editing goes on as for any tile, and the result reads back */
	let l = layout.resize(n, 'ports', -1, 'wide');
	l = layout.setHidden(layout.move(l, 'ports', -1), 'ports', true);
	assert.deepEqual(l[layout.indexOf(l, 'ports')], { id: 'ports', c: 0, w: 2, hide: true });
	assert.deepEqual(layout.normalize(layout.decode('wide=' + layout.encode(layout.compact(l))).wide, 'wide', false, false, true), l);
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
	l = layout.setHidden(l, 'talk', true);
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
	/* Clients across the whole width under the chart and System (the wired default before Top talkers) */
	const wired = layout.pack([ { id: 'hero', c: 0, w: 4, h: 360 }, { id: 'chart', c: 0, w: 3, h: 330 }, { id: 'sys', c: 3, w: 1, h: 520 }, { id: 'clients', c: 0, w: 4, h: 300 } ], 4, 14);
	assert.equal(wired.rects.chart.h, 520, 'the chart fills the row beside System');
	assert.equal(wired.height, 360 + 14 + 520 + 14 + 300);
});

test('pack: the default wired layout keeps Clients under the chart, Top talkers under System', () => {
	const h = { hero: 360, chart: 330, sys: 520, clients: 300, talk: 200 };
	const p = layout.pack(layout.defaults('wide', true).map(e => ({ id: e.id, c: e.c, w: e.w, h: h[e.id] })), 4, 14);
	assert.deepEqual([ p.rects.chart.top, p.rects.chart.h ], [ 374, 330 ], 'the chart at its own height');
	assert.deepEqual([ p.rects.clients.c, p.rects.clients.w, p.rects.clients.top ], [ 0, 3, 374 + 330 + 14 ]);
	assert.deepEqual([ p.rects.sys.c, p.rects.sys.top ], [ 3, 374 ]);
	assert.deepEqual([ p.rects.talk.c, p.rects.talk.top, p.rects.talk.h ], [ 3, 374 + 520 + 14, 200 ]);
	assert.equal(p.height, 374 + 520 + 14 + 200);
	/* two columns: Top talkers beside System, both under Clients */
	const m = layout.pack(layout.defaults('mid', true).map(e => ({ id: e.id, c: e.c, w: e.w, h: h[e.id] })), 2, 14).rects;
	assert.deepEqual([ m.talk.c, m.sys.c, m.talk.top, m.sys.top ], [ 0, 1, m.clients.top + 300 + 14, m.clients.top + 300 + 14 ]);
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
