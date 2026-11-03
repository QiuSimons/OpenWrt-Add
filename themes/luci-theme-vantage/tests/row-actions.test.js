'use strict';
/* Row action menus (menu-vantage.js decorateRowActions): a row with a main
   action (Edit, else LuCI's "important" one) and at least two others keeps
   the main one and a ⋯ button; LuCI's other buttons stay in place, hidden,
   and a menu item clicks the original, so LuCI's handler, label and
   disabled state are the ones that count. Run against a fake DOM just big
   enough for these calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./luci-stub');      /* String.prototype.format */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js'), 'utf8');

/* "button, .a, input[type="button"]" with optional :not-free simple parts */
function matches(el, list) {
	return list.split(',').some(sel => {
		const m = /^([a-z]+)?((?:\.[\w-]+)*)(?:\[(\w+)="([^"]*)"\])?$/i.exec(sel.trim());
		if (!m) throw new Error('fake DOM: unsupported selector ' + sel);
		if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
		for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!el.cls.has(c.slice(1))) return false;
		if (m[3] && el.attrs[m[3]] !== m[4]) return false;
		return true;
	});
}

class El {
	constructor(tag, attrs, kids) {
		this.tagName = tag.toUpperCase();
		this.attrs = {}; this.cls = new Set(); this.children = []; this.parentNode = null;
		this.listeners = {}; this.hidden = false; this.disabled = false; this.style = {}; this.clicks = 0;
		this.classList = {
			add: (...c) => c.forEach(x => this.cls.add(x)),
			remove: (...c) => c.forEach(x => this.cls.delete(x)),
			contains: c => this.cls.has(c),
			toggle: (c, on) => { (on === undefined ? !this.cls.has(c) : on) ? this.cls.add(c) : this.cls.delete(c); return this.cls.has(c); }
		};
		for (const [ k, v ] of Object.entries(attrs || {})) {
			if (typeof v === 'function') this.addEventListener(k, v);
			else if (v != null) this.setAttribute(k, v);
		}
		for (const c of [].concat(kids == null ? [] : kids)) this.appendChild(typeof c === 'object' ? c : { nodeType: 3, text: String(c) });
	}
	setAttribute(k, v) {
		if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach(c => this.cls.add(c));
		else if (k === 'hidden') this.hidden = true;
		else if (k === 'disabled') this.disabled = true;
		else this.attrs[k] = String(v);
	}
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	removeAttribute(k) { delete this.attrs[k]; }
	appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; }
	remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
	set textContent(v) { this.children = []; if (v) this.appendChild({ nodeType: 3, text: v }); }
	get textContent() { return this.children.map(c => c.nodeType === 3 ? c.text : c.textContent).join(''); }
	matches(sel) { return matches(this, sel); }
	closest(sel) { for (let n = this; n && n.tagName; n = n.parentNode) if (matches(n, sel)) return n; return null; }
	contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
	walk(out) { for (const c of this.children) if (c.tagName) { out.push(c); c.walk(out); } return out; }
	querySelectorAll(sel) {
		const scope = /^:scope > (.+)$/.exec(sel);
		if (scope) return this.children.filter(c => c.tagName && matches(c, scope[1]));
		return this.walk([]).filter(n => matches(n, sel));
	}
	querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
	addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
	dispatch(t, ev) { ev = Object.assign({ type: t, target: this, preventDefault() {}, stopPropagation() {} }, ev); (this.listeners[t] || []).forEach(fn => fn(ev)); }
	click() { this.clicks++; this.dispatch('click', { detail: 1 }); }
	focus() { doc.activeElement = this; }
	get isConnected() { for (let n = this; n; n = n.parentNode) if (n === doc.body) return true; return false; }
	getBoundingClientRect() { return { left: 1100, right: 1140, top: 300, bottom: 336 }; }
	get offsetWidth() { return 168; }
	get offsetHeight() { return 96; }
}

const doc = { activeElement: null, listeners: {}, createElementNS: (ns, tag) => new El(tag), addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); } };
/* a key pressed with focus outside the menu reaches the document listeners */
const docKey = (key, extra) => { const ev = Object.assign({ key, target: doc.activeElement, preventDefault() {}, stopPropagation() {} }, extra); (doc.listeners.keydown || []).forEach(fn => fn(ev)); };

/* MutationObserver stand-in: the test calls notify() where the browser
   would deliver records for an attribute LuCI changed */
let observers = [];
class FakeObserver {
	constructor(cb) { this.cb = cb; observers.push(this); }
	observe(target) { this.target = target; }
	disconnect() {}
}
const notify = el => observers.filter(o => o.target.contains(el)).forEach(o => o.cb([ { type: 'attributes', target: el } ]));

function setup(rows, win) {
	observers = [];
	doc.listeners = {};
	doc.activeElement = null;
	doc.body = new El('body');
	doc.querySelectorAll = sel => {
		if (sel === '.cbi-section-actions > div') return doc.body.walk([]).filter(n => n.parentNode && n.parentNode.cls.has('cbi-section-actions') && n.tagName === 'DIV');
		return doc.body.querySelectorAll(sel);
	};
	doc.querySelector = sel => doc.querySelectorAll(sel)[0] || null;
	const window = Object.assign({ innerWidth: 1280, innerHeight: 900, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), MutationObserver: FakeObserver }, win);
	const E = (tag, attrs, kids) => new El(tag, attrs, kids);
	const proto = new Function('baseclass', 'ui', 'rpc', 'host', 'E', 'L', '_', 'document', 'window', SRC)(
		{ extend: p => p }, {}, { declare: () => () => Promise.resolve({}) }, {}, E, {}, s => s, doc, window);
	const shell = Object.assign(Object.create(proto), { mqMobile: window.matchMedia() });
	const boxes = rows.map(btns => {
		const box = new El('div', {}, btns);
		doc.body.appendChild(new El('div', { 'class': 'tr' }, [ new El('div', { 'class': 'td cbi-section-actions' }, [ box ]) ]));
		return box;
	});
	shell.decorateRowActions();
	return { shell, boxes };
}
const btn = (cls, label) => new El('button', { 'class': 'cbi-button ' + cls }, [ label ]);
const shown = box => box.children.filter(c => !c.cls.has('vt-acts-hidden')).map(c => c.cls.has('vt-acts-more') ? '⋯' : c.textContent);
const moreOf = box => box.children.find(c => c.cls.has('vt-acts-more'));
const menuEl = () => doc.body.children.find(c => c.attrs.id === 'vt-actmenu');

test('row actions: rows with a main action and two others fold; the rows LuCI and apps built around their buttons do not', () => {
	/* classes as LuCI 25.12 and the add-ons render them */
	const rows = {
		interfaces: [ btn('cbi-button-neutral reconnect', 'Restart'), btn('cbi-button-neutral down', 'Stop'), btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ],
		wifiNet: [ btn('cbi-button-neutral enable-disable', 'Disable'), btn('cbi-button-action important', 'Edit'), btn('cbi-button-negative remove', 'Remove') ],
		rule: [ btn('drag-handle', '☰'), btn('cbi-button-edit', 'Edit'), btn('cbi-button-neutral', 'Clone'), btn('cbi-button-remove', 'Delete') ],
		ddns: [ btn('cbi-button-neutral reload', 'Reload'), btn('cbi-button-neutral stop', 'Stop'), btn('drag-handle', '☰'), btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ],
		/* Wireless radio: Add is how a radio gets a network */
		radio: [ btn('cbi-button-neutral', 'Restart'), btn('cbi-button-action important', 'Scan'), btn('cbi-button-add', 'Add') ],
		/* Wake on LAN puts its own action in front of LuCI's buttons */
		wol: [ btn('cbi-button-action', 'Wake'), btn('drag-handle', '☰'), btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ],
		/* System -> Startup and Status -> Processes: peers, no main one */
		startup: [ btn('cbi-button-positive', 'Enabled'), btn('cbi-button-action', 'Start'), btn('cbi-button-action', 'Restart'), btn('cbi-button-action', 'Reload'), btn('cbi-button-action', 'Stop') ],
		processes: [ btn('cbi-button-action', 'Hang Up'), btn('cbi-button-negative', 'Terminate'), btn('cbi-button-negative', 'Kill') ],
		two: [ btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ]
	};
	const names = Object.keys(rows);
	const { boxes } = setup(names.map(n => rows[n]));
	const got = Object.fromEntries(names.map((n, i) => [ n, shown(boxes[i]) ]));
	assert.deepEqual(got, {
		interfaces: [ 'Edit', '⋯' ],
		wifiNet: [ 'Edit', '⋯' ],
		rule: [ '☰', 'Edit', '⋯' ],
		ddns: [ '☰', 'Edit', '⋯' ],
		radio: [ 'Restart', 'Scan', 'Add' ],
		wol: [ 'Wake', '☰', 'Edit', 'Delete' ],
		startup: [ 'Enabled', 'Start', 'Restart', 'Reload', 'Stop' ],
		processes: [ 'Hang Up', 'Terminate', 'Kill' ],
		two: [ 'Edit', 'Delete' ]
	});
	assert.equal(boxes[0].children.length, 5, "LuCI's buttons are kept, in their place, plus the ⋯");
	assert.equal(boxes[0].children[0].textContent, 'Restart');
	for (const i of [ 4, 5, 6, 7 ]) assert.ok(!boxes[i].cls.has('vt-acts'), names[i] + ' is left as LuCI drew it');
});

test('row actions: never a menu of one', () => {
	const { boxes } = setup([
		/* Wake and Add stay out, which leaves one button to fold */
		[ btn('cbi-button-action', 'Wake'), btn('cbi-button-edit', 'Edit'), btn('cbi-button-neutral', 'Clone') ],
		[ btn('cbi-button-add', 'Add'), btn('cbi-button-action important', 'Scan'), btn('cbi-button-remove', 'Delete') ]
	]);
	assert.deepEqual(shown(boxes[0]), [ 'Wake', 'Edit', 'Clone' ]);
	assert.deepEqual(shown(boxes[1]), [ 'Add', 'Scan', 'Delete' ]);
});

test('row actions: a second pass changes nothing; a button LuCI hides is not counted', () => {
	const hiddenByLuci = btn('cbi-button-neutral', 'Stop');
	hiddenByLuci.style.display = 'none';
	const { shell, boxes } = setup([
		[ btn('cbi-button-neutral', 'Restart'), btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ],
		[ btn('cbi-button-neutral', 'Restart'), hiddenByLuci, btn('cbi-button-edit', 'Edit') ]
	]);
	shell.decorateRowActions();
	assert.equal(boxes[0].children.filter(c => c.cls.has('vt-acts-more')).length, 1, 'one ⋯ only');
	assert.deepEqual(shown(boxes[1]), [ 'Restart', 'Stop', 'Edit' ], 'two visible actions: untouched');
});

test('row actions: the menu lists the hidden ones; an item clicks the original, with its label and state', () => {
	const disable = btn('cbi-button-neutral enable-disable', 'Disable');
	const remove = btn('cbi-button-negative remove', 'Remove');
	remove.setAttribute('disabled', '');
	const { boxes } = setup([ [ disable, btn('cbi-button-action important', 'Edit'), remove ] ]);
	const more = boxes[0].children.find(c => c.cls.has('vt-acts-more'));
	assert.equal(more.getAttribute('aria-haspopup'), 'menu');
	assert.equal(more.getAttribute('aria-label'), 'More actions');

	disable.textContent = 'Enable';     /* LuCI relabels its button; the menu reads it when it opens */
	more.click();
	const menu = doc.body.children.find(c => c.attrs.id === 'vt-actmenu');
	assert.ok(menu && !menu.hidden);
	assert.equal(more.getAttribute('aria-expanded'), 'true');
	const items = menu.children;
	assert.deepEqual(items.map(i => i.textContent), [ 'Enable', 'Remove' ]);
	assert.equal(items[0].getAttribute('role'), 'menuitem');
	assert.ok(items[1].cls.has('is-danger'), 'Remove reads as dangerous');
	assert.ok(items[1].disabled, "LuCI's disabled state carries over");

	items[0].click();
	assert.equal(disable.clicks, 1, 'the original button got the click');
	assert.ok(menu.hidden);
	assert.equal(more.getAttribute('aria-expanded'), 'false');
	assert.equal(doc.activeElement, more, 'focus goes back to ⋯');
});

test('row actions: keys open the menu at either end, walk it, and Escape returns to ⋯', () => {
	const { boxes } = setup([ [ btn('a', 'Restart'), btn('cbi-button-edit', 'Edit'), btn('b', 'Stop'), btn('cbi-button-remove', 'Delete') ] ]);
	const more = boxes[0].children.find(c => c.cls.has('vt-acts-more'));
	const menu = () => doc.body.children.find(c => c.attrs.id === 'vt-actmenu');
	more.dispatch('keydown', { key: 'ArrowUp' });
	assert.equal(doc.activeElement.textContent, 'Delete', 'ArrowUp starts at the last item');
	menu().dispatch('keydown', { key: 'ArrowDown' });
	assert.equal(doc.activeElement.textContent, 'Restart', 'and wraps around');
	menu().dispatch('keydown', { key: 'End' });
	assert.equal(doc.activeElement.textContent, 'Delete');
	menu().dispatch('keydown', { key: 'Escape' });
	assert.ok(menu().hidden);
	assert.equal(doc.activeElement, more);
});

test('row actions: ⋯ shows the busy state of a hidden original until it settles', () => {
	const restart = btn('cbi-button-neutral reconnect', 'Restart');
	/* what ui.createHandlerFn does around a handler's promise */
	restart.addEventListener('click', () => { restart.classList.add('spinning'); restart.disabled = true; notify(restart); });
	const { boxes } = setup([ [ restart, btn('cbi-button-neutral down', 'Stop'), btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ] ]);
	const more = moreOf(boxes[0]);
	more.click();
	menuEl().children[0].click();
	assert.equal(restart.clicks, 1);
	assert.ok(more.cls.has('spinning'), '⋯ spins while the hidden Restart does');
	assert.equal(more.getAttribute('aria-busy'), 'true');
	assert.ok(!more.disabled, '⋯ stays usable for the other actions');
	more.click();
	assert.ok(menuEl().children[0].disabled, 'the busy action itself is disabled in the menu');
	more.click();

	restart.classList.remove('spinning'); restart.disabled = false; notify(restart);
	assert.ok(!more.cls.has('spinning'));
	assert.equal(more.getAttribute('aria-busy'), null);
});

test('row actions: Escape and Tab close a menu opened with the mouse; Tab from inside goes on from ⋯', () => {
	const { boxes } = setup([ [ btn('a', 'Restart'), btn('cbi-button-edit', 'Edit'), btn('b', 'Stop'), btn('cbi-button-remove', 'Delete') ] ]);
	const more = moreOf(boxes[0]);
	more.click();                       /* a pointer open: focus stays on ⋯ */
	more.focus();
	assert.ok(!menuEl().hidden);
	docKey('Escape');
	assert.ok(menuEl().hidden, 'Escape closes it');
	assert.equal(more.getAttribute('aria-expanded'), 'false');
	assert.equal(doc.activeElement, more);

	more.click();
	docKey('Tab');
	assert.ok(menuEl().hidden, 'Tab from ⋯ closes it and moves on natively');
	assert.equal(doc.activeElement, more);

	more.dispatch('keydown', { key: 'ArrowDown' });
	assert.equal(doc.activeElement.textContent, 'Restart');
	let defaultPrevented = false;
	menuEl().dispatch('keydown', { key: 'Tab', preventDefault() { defaultPrevented = true; } });
	assert.ok(menuEl().hidden);
	assert.equal(doc.activeElement, more, 'focus is back on ⋯ before the browser moves it');
	assert.ok(!defaultPrevented, 'the browser still moves focus, from the row');
});

test('row actions: ⋯ names its menu; items carry LuCI\'s tooltip, and a label-less button its title', () => {
	const restart = btn('cbi-button-neutral reconnect', 'Restart');
	restart.setAttribute('title', 'Reconnect this interface');
	const icon = btn('cbi-button-neutral', '');
	icon.setAttribute('title', 'Stop this service');
	const { boxes } = setup([ [ restart, icon, btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ] ]);
	const more = moreOf(boxes[0]);
	assert.equal(more.getAttribute('aria-controls'), 'vt-actmenu');
	assert.ok(menuEl(), 'the menu it names exists before the first open');
	more.click();
	const items = menuEl().children;
	assert.deepEqual(items.map(i => [ i.textContent, i.getAttribute('title') ]),
		[ [ 'Restart', 'Reconnect this interface' ], [ 'Stop this service', 'Stop this service' ], [ 'Delete', null ] ]);
});

test('row actions: an open menu follows LuCI disabling or hiding an original', () => {
	const stop = btn('cbi-button-neutral stop', 'Stop');
	const reload = btn('cbi-button-neutral reload', 'Reload');
	const { boxes } = setup([ [ reload, stop, btn('cbi-button-edit', 'Edit'), btn('cbi-button-remove', 'Delete') ] ]);
	const more = moreOf(boxes[0]);
	more.dispatch('keydown', { key: 'ArrowDown' });
	const first = menuEl().children[0];
	notify(stop);                       /* a poll that changes nothing */
	assert.equal(menuEl().children[0], first, 'no change, no refill');

	stop.disabled = true; notify(stop);  /* DDNS's poll: the service stopped */
	assert.deepEqual(menuEl().children.map(i => i.textContent + (i.disabled ? ' (off)' : '')), [ 'Reload', 'Stop (off)', 'Delete' ]);
	assert.equal(doc.activeElement.textContent, 'Reload', 'focus stays on the same action');

	/* hidden by LuCI: no longer an action of this row */
	reload.style.display = 'none'; notify(reload);
	assert.deepEqual(menuEl().children.map(i => i.textContent), [ 'Stop', 'Delete' ]);
	assert.equal(doc.activeElement.textContent, 'Delete', 'focus moves on to an enabled item');
	/* one left to fold: the row unfolds and the menu closes */
	stop.hidden = true; notify(stop);
	assert.ok(menuEl().hidden);
	assert.deepEqual(shown(boxes[0]), [ 'Reload', 'Stop', 'Edit', 'Delete' ], 'LuCI hides those two itself');
	assert.ok(!moreOf(boxes[0]));
	assert.equal(doc.activeElement.textContent, 'Edit', 'focus moves to the row\'s first action');
});

test('row actions: with no room on either side the menu takes the roomier one and scrolls, clear of ⋯', () => {
	/* a landscape phone: 360 px high, the ⋯ in the middle */
	const { boxes } = setup([ [ btn('a', 'Start'), btn('cbi-button-edit', 'Edit'), btn('b', 'Reload'), btn('c', 'Stop'), btn('cbi-button-remove', 'Delete') ] ], { innerHeight: 360 });
	const more = moreOf(boxes[0]);
	more.getBoundingClientRect = () => ({ left: 560, right: 600, top: 150, bottom: 186 });
	more.click();
	more.click();
	Object.defineProperty(menuEl(), 'offsetHeight', { value: 190 });
	more.click();
	const m = menuEl();
	/* below: 360 - 8 - 192 = 160, above: 150 - 14 = 136 */
	assert.equal(m.style.top, '192px');
	assert.equal(m.style.maxHeight, '160px');
	more.click();
	more.getBoundingClientRect = () => ({ left: 560, right: 600, top: 200, bottom: 236 });
	more.click();
	/* below: 110, above: 186 */
	assert.equal(m.style.maxHeight, '186px');
	assert.equal(m.style.top, '8px');
	assert.ok(parseInt(m.style.top, 10) + 186 <= 200 - 6, 'ends above the button');
});
