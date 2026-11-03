'use strict';
/* What a dashboard poll does, and what it leaves alone (view/vantage/
   overview.js): an unchanged poll lays nothing out and rebuilds no node of
   the network path, and a tile height held after its content shrank is
   released when the hold ends, without a resize, a layout edit or another
   poll. The view runs with stub LuCI modules and a fake grid; timers,
   animation frames and the clock are the test's. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = { view: { extend: p => p }, rpc: { declare: () => () => Promise.resolve(null) }, poll: {}, ui: {}, dom: {} };
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

const view = loadView();
const layout = load('vantage.layout');

/* a browser just big enough for doLayout: timers and frames run when the
   test says so */
function fakeBrowser() {
	const b = { now: 0, frames: [], timers: [], seq: 0 };
	b.window = {
		requestAnimationFrame: fn => { b.frames.push(fn); return b.frames.length; },
		setTimeout: (fn, ms) => { const id = ++b.seq; b.timers.push({ id, fn, at: b.now + ms }); return id; },
		clearTimeout: id => { b.timers = b.timers.filter(t => t.id !== id); },
		getComputedStyle: () => ({ getPropertyValue: () => '14' })
	};
	b.document = { scrollingElement: { scrollTop: 0 }, activeElement: null };
	b.frame = () => { const f = b.frames; b.frames = []; f.forEach(fn => fn()); };
	b.advance = ms => {
		b.now += ms;
		for (;;) {
			const due = b.timers.filter(t => t.at <= b.now).sort((x, y) => x.at - y.at)[0];
			if (!due) break;
			b.timers = b.timers.filter(t => t !== due);
			due.fn();
		}
	};
	return b;
}

function style() {
	return { minHeight: '', height: '', setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] || ''; } };
}

/* a tile whose box is its content (nat) or its min-height, whichever is more */
function tile(id, nat) {
	return {
		id, nat, style: style(),
		classList: { toggle() {}, contains: c => c === 'vt-cell' },
		getBoundingClientRect() { const h = Math.max(this.nat, parseFloat(this.style.minHeight) || 0); return { height: h, top: 0, bottom: h }; }
	};
}

function dashboard(b) {
	const self = Object.create(view);
	self.tiles = {};
	layout.TILES.forEach(id => { self.tiles[id] = tile(id, 200); });
	const children = layout.TILES.map(id => self.tiles[id]);
	self.el = {
		root: { classList: { toggle() {} } },
		ghost: { classList: { toggle() {} }, style: style() },
		grid: { clientWidth: 1200, style: style(), children, classList: { remove() {} },
			appendChild(t) { children.splice(children.indexOf(t), 1); children.push(t); } }
	};
	self.m = { wired: false };
	self.layouts = Object.create(null);
	self.editing = false;
	self.drag = null;
	self.wireRo = {};
	/* a poll's painting, minus everything but what decides on layout */
	[ 'paintHead', 'paintHealth', 'paintHero', 'paintSystem', 'paintChart', 'paintRadios', 'paintClients',
		'paintTalkers', 'paintSsids', 'paintDrawer', 'paintLive' ].forEach(k => { self[k] = () => {}; });
	self.scheduleWires = () => { throw new Error('a poll must not schedule a wire redraw'); };
	self.drawWires = () => { throw new Error('a poll must not measure the wires'); };
	return self;
}

function withBrowser(fn) {
	const b = fakeBrowser();
	const saved = { window: global.window, document: global.document, now: Date.now };
	global.window = b.window;
	global.document = b.document;
	Date.now = () => b.now;
	try { return fn(b); }
	finally { global.window = saved.window; global.document = saved.document; Date.now = saved.now; }
}

test('a held tile height is released when the hold ends, though nothing else happens', () => withBrowser(b => {
	const self = dashboard(b), sys = self.tiles.sys, talk = self.tiles.talk;
	sys.nat = 500;
	self.paint();                      /* first poll: lays out once */
	assert.equal(b.frames.length, 1);
	b.frame();
	const yTall = talk.style['--y'];
	assert.equal(sys.style.minHeight, '');

	/* the System tile's content shrinks: the observer lays out, the
	   height is held */
	b.advance(1000);
	sys.nat = 300;
	self.scheduleLayout();
	b.frame();
	assert.equal(sys.style.minHeight, '500.0px', 'held at its old height');
	assert.equal(talk.style['--y'], yTall, 'the tile below stays put');

	/* unchanged polls: no layout, no frame */
	for (let k = 0; k < 5; k++) {
		b.advance(5000);
		self.paint();
		assert.equal(b.frames.length, 0, 'poll ' + k + ' scheduled a layout');
	}
	assert.equal(sys.style.minHeight, '500.0px', 'still held before the hold ends');

	/* the hold ends: the view wakes up by itself and lets go */
	b.advance(layout.HOLD_MS - 25000 + 100);
	assert.equal(b.frames.length, 1, 'the end of the hold scheduled a layout');
	b.frame();
	assert.equal(sys.style.minHeight, '', 'released');
	assert.equal(parseFloat(talk.style['--y']), parseFloat(yTall) - 200, 'the tile below moved up');
	assert.equal(b.timers.length, 0, 'nothing left to wake up for');
}));

test('a hold that ends while content grows back: the clock is cleared, no stale wake-up', () => withBrowser(b => {
	const self = dashboard(b), sys = self.tiles.sys;
	sys.nat = 500;
	self.paint();
	b.frame();
	b.advance(1000);
	sys.nat = 300;
	self.scheduleLayout();
	b.frame();
	assert.equal(b.timers.length, 1, 'one wake-up armed');
	/* the content grows back to the held height: the observer (it watches
	   the content too) lays out, the clock clears and so does the timer */
	b.advance(2000);
	sys.nat = 500;
	self.scheduleLayout();
	b.frame();
	assert.equal(b.timers.length, 0);
	assert.equal(sys.style.minHeight, '');
}));

test('the network path: a poll with the same radios and SSIDs updates the nodes in place', () => {
	const self = Object.create(view);
	let key = 'r\nradio0=a,b', built = 0, updated = 0;
	self.heroKey = () => key;
	self.buildHeroNodes = k => { built++; self.hero = { key: k }; };
	self.updateHero = () => { updated++; };
	self.paintKpis = () => {};
	self.paintWireState = () => {};
	self.paintHero();
	self.paintHero();
	self.paintHero();
	assert.deepEqual([ built, updated ], [ 1, 3 ]);
	key = 'r\nradio0=a';               /* an SSID went away */
	self.paintHero();
	assert.deepEqual([ built, updated ], [ 2, 4 ]);
});

test('a folded or hidden network path: polls rebuild no flow dots until it has a size again', () => withBrowser(b => {
	b.window.matchMedia = () => ({ matches: false });
	const self = Object.create(view);
	const el = () => ({ attrs: {}, getAttribute(k) { return this.attrs[k] || null; }, setAttribute(k, v) { this.attrs[k] = v; } });
	const g = { base: el(), flow: el(), fw: el(), d: 'M0 0H100', dots: [], anims: [] };
	let built = 0;
	self.hero = { key: 'k' };
	self.wireMap = { gw: g };
	const node = (l, t) => ({ getBoundingClientRect: () => ({ left: l, right: l + 120, top: t, bottom: t + 60 }) });
	const gw = node(0, 70), ap = node(300, 70);
	self.wireList = () => [ { key: 'gw', from: gw, to: ap, active: true, speed: 2, main: true } ];
	self.buildDots = wire => { built++; wire.dotsFor = wire.d; wire.dots = [ {} ]; };
	self.clearDots = wire => { wire.dots = []; wire.anims = []; wire.dotsFor = null; };

	self.paintWireState();               /* busy and visible: dots */
	assert.equal(built, 1);
	self.stopFlows();                    /* folded: drawWires found no size */
	for (let k = 0; k < 3; k++) self.paintWireState();   /* polls while folded */
	assert.equal(built, 1, 'a poll rebuilt dots inside a hidden path');
	assert.equal(g.dots.length, 0);

	/* unfolded: the observer measures a size again and the dots return */
	self.el = { path: { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 200 }) }, wires: el() };
	self.drawWires();
	assert.equal(built, 2);
}));
