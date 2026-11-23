'use strict';
/* #154: "+n more" at the end of a network path node's client rows (the
   full path, with a paired access point) opens the rest in place. The
   line sits inside the node's button: its click must stay its own, and
   a list that shrinks to five or fewer closes it again. The view is
   loaded with stub LuCI modules and a small DOM; a click bubbles to the
   node unless it is stopped, as in a browser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = { view: { extend: p => p }, rpc: { declare: () => () => Promise.resolve(null) }, poll: {}, ui: {},
		dom: { content: (el, kids) => { el.kids = kids; } } };
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}
const view = loadView();

function withE(fn) {
	const saved = global.E;
	global.E = (tag, attrs, children) => {
		const n = { tag, cls: '', on: {}, kids: [] };
		for (const [ k, v ] of Object.entries(attrs || {})) if (typeof v === 'function') n.on[k] = v; else if (k === 'class') n.cls = v;
		n.kids = Array.isArray(children) ? children : [];
		Object.defineProperty(n, 'textContent', { get() { return n.kids.map(k => typeof k === 'string' ? k : k.textContent).join(''); } });
		return n;
	};
	try { return fn(); } finally { if (saved === undefined) delete global.E; else global.E = saved; }
}

const clients = n => Array.from({ length: n }, (x, i) => ({ mac: '00:00:5e:00:53:1' + i, name: 'h' + i, ips: [ '192.0.2.' + (10 + i) ], signal: -50, rate: { rx: 1, tx: 1 } }));
const rows = el => el.kids.filter(k => k.cls === 'vt-leaf-row').length;
const last = el => el.kids[el.kids.length - 1];

/* a click on `target` inside the node: the target's handler, then the
   node's, unless the event was stopped; what the browser would do by
   default only where it was not prevented */
function click(target, node) {
	const ev = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
	target.on.click(ev);
	if (!ev.stopped) node.on.click(ev);
	return ev;
}

test('#154: a click on "+n more" opens the rest in place and goes no further: not to the node (the Clients list), no default action', () => withE(() => {
	const self = Object.create(view);
	let opened = 0;
	const node = { on: { click: () => { opened++; } } };
	const el = { vtSig: null, kids: [] };
	self.paintLeaf(el, clients(7), false);
	assert.equal(last(el).textContent, '+2 more');
	const ev = click(last(el), node);
	assert.equal(rows(el), 7, 'the rest, in place');
	assert.equal(opened, 0, 'the node\'s own click (the Clients list) did not run: the event was stopped');
	assert.ok(ev.stopped);
	assert.ok(ev.prevented, 'and nothing done by default, as a row\'s own click');
	assert.equal(last(el).textContent, 'Show fewer');
	const back = click(last(el), node);
	assert.equal(rows(el), 5);
	assert.equal(opened, 0);
	assert.ok(back.stopped && back.prevented, '"Show fewer" alike');
}));

test('#154: opened, then the list shrinks to five or fewer: closed again, so when it grows it is folded behind "+n more"', () => withE(() => {
	const self = Object.create(view);
	const el = { vtSig: null, kids: [] };
	self.paintLeaf(el, clients(7), false);
	last(el).on.click({ preventDefault() {}, stopPropagation() {} });
	assert.equal(rows(el), 7);
	/* a poll with four clients there: no "Show fewer" for nothing hidden */
	self.paintLeaf(el, clients(4), false);
	assert.equal(rows(el), 4);
	assert.equal(el.kids.length, 4, 'no "Show fewer" line');
	assert.equal(el.vtAll, false);
	/* five again, then seven: folded */
	self.paintLeaf(el, clients(5), false);
	assert.equal(el.kids.length, 5);
	self.paintLeaf(el, clients(7), false);
	assert.equal(rows(el), 5);
	assert.equal(last(el).textContent, '+2 more');
	/* opened while there are more than five, it stays open as the list changes */
	last(el).on.click({ preventDefault() {}, stopPropagation() {} });
	self.paintLeaf(el, clients(9), false);
	assert.equal(rows(el), 9);
	assert.equal(last(el).textContent, 'Show fewer');
}));
