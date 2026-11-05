'use strict';
/* The page switcher in the top bar (menu-vantage.js), run against a small
   fake DOM: its button is a disclosure (no aria-haspopup), a rail timer
   left pending does not close it, passing over the rail leaves it open,
   and the keyboard can open it, walk into it and leave it. Also what the
   shell lists: crumbs (a repeated one merged, a 404), flyouts and the
   palette's rows. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('./luci-stub');      /* String.prototype.format, _() */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js'), 'utf8');

/* ------------------------------------------------------------ fake DOM */

function matchOne(el, sel) {
	const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
	if (!m || !el.tagName) return false;
	if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
	for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!el.classList.contains(c.slice(1))) return false;
	for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
		const [ k, v ] = a.slice(1, -1).split('=');
		if (!el.hasAttribute(k)) return false;
		if (v != null && el.getAttribute(k) !== v.replace(/"/g, '')) return false;
	}
	return true;
}

class El {
	constructor(doc, tag) {
		this.ownerDocument = doc;
		this.tagName = tag.toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.attrs = {};
		this.listeners = {};
		this.hidden = false;
		this.value = '';
		this.style = { setProperty: (k, v) => { this.style[k] = v; } };
		const cls = new Set();
		this.classList = {
			add: (...c) => { c.forEach(x => cls.add(x)); this.attrs.class = [ ...cls ].join(' '); },
			remove: (...c) => { c.forEach(x => cls.delete(x)); this.attrs.class = [ ...cls ].join(' '); },
			contains: c => cls.has(c),
			toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c); this.attrs.class = [ ...cls ].join(' '); return cls.has(c); }
		};
		this._cls = cls;
	}
	setAttribute(k, v) {
		v = String(v);
		if (k === 'class') { this._cls.clear(); v.split(/\s+/).filter(Boolean).forEach(c => this._cls.add(c)); }
		if (k === 'hidden') { this.hidden = true; return; }
		this.attrs[k] = v;
	}
	getAttribute(k) { return k === 'hidden' ? (this.hidden ? '' : null) : (k in this.attrs ? this.attrs[k] : null); }
	hasAttribute(k) { return k === 'hidden' ? this.hidden : k in this.attrs; }
	removeAttribute(k) { if (k === 'hidden') this.hidden = false; else delete this.attrs[k]; }
	get className() { return this.attrs.class || ''; }
	get id() { return this.attrs.id || ''; }
	get lastChild() { return this.children[this.children.length - 1] || null; }
	get firstChild() { return this.children[0] || null; }
	get textContent() { return this.children.map(c => c.nodeType === 3 ? c.data : c.textContent).join(''); }
	set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; if (v) this.appendChild(this.ownerDocument.createTextNode(v)); }
	appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; }
	insertBefore(c, ref) { this.appendChild(c); if (ref) { this.children.pop(); this.children.splice(this.children.indexOf(ref), 0, c); } return c; }
	remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
	addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
	dispatch(t, ev) {
		ev = Object.assign({ type: t, target: this, preventDefault() { this.defaultPrevented = true; } }, ev);
		(this.listeners[t] || []).forEach(fn => fn(ev));
		return ev;
	}
	contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
	closest(sel) { for (let n = this; n && n.tagName; n = n.parentNode) if (sel.split(',').some(s => matchOne(n, s))) return n; return null; }
	walk(out) { for (const c of this.children) if (c.tagName) { out.push(c); c.walk(out); } return out; }
	querySelectorAll(sel) { return this.walk([]).filter(n => sel.split(',').some(s => matchOne(n, s))); }
	querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
	focus() { this.ownerDocument.activeElement = this; }
	click() { this.dispatch('click', { detail: 1 }); }
	get tabIndex() { return ('tabindex' in this.attrs) ? +this.attrs.tabindex : (/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(this.tagName) ? 0 : -1); }
	getBoundingClientRect() { return { left: 200, top: 8, right: 320, bottom: 44, width: 120, height: 36 }; }
	getClientRects() { let n = this; for (; n && n.tagName; n = n.parentNode) if (n.hidden) return []; return [ 1 ]; }
}

function setup(dispatchpath, nodespec) {
	const timers = [];
	let now = 0, seq = 0;
	const window = {
		innerWidth: 1440,
		setTimeout: (fn, ms) => { timers.push({ id: ++seq, at: now + (ms || 0), fn }); return seq; },
		clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
		requestAnimationFrame: () => 0,
		matchMedia: () => ({ matches: false, addEventListener() {} })
	};
	const advance = ms => {
		now += ms;
		for (;;) {
			timers.sort((a, b) => a.at - b.at);
			if (!timers.length || timers[0].at > now) break;
			timers.shift().fn();
		}
	};

	const document = {
		activeElement: null,
		listeners: {},
		createElementNS: (ns, tag) => new El(document, tag),
		createTextNode: data => ({ nodeType: 3, data: String(data), parentNode: null }),
		getElementById: id => document.body.querySelector('[id=' + id + ']'),
		querySelectorAll: sel => document.body.querySelectorAll(sel),
		querySelector: sel => document.body.querySelector(sel),
		addEventListener: (t, fn) => { (document.listeners[t] = document.listeners[t] || []).push(fn); }
	};
	const E = (tag, attrs, kids) => {
		const el = new El(document, tag);
		for (const [ k, v ] of Object.entries(attrs || {})) {
			if (typeof v === 'function') el.addEventListener(k, v);
			else if (v != null) el.setAttribute(k, v);
		}
		for (const c of (Array.isArray(kids) ? kids : (kids == null || kids === '' ? [] : [ kids ])))
			if (c !== '' && c != null) el.appendChild(typeof c === 'object' ? c : document.createTextNode(c));
		return el;
	};
	document.body = E('body', {}, [
		E('nav', { 'id': 'vt-rail' }, [ E('ul', { 'id': 'vt-rail-list' }) ]),
		E('div', { 'id': 'vt-flyout', 'class': 'vt-flyout', 'hidden': '' }),
		E('div', { 'id': 'vt-scrim', 'hidden': '' }),
		E('header', {}, [
			E('nav', { 'id': 'vt-crumbs' }),
			E('button', { 'id': 'vt-search-btn' }, [ 'Search' ])
		]),
		E('nav', { 'id': 'vt-tabs', 'hidden': '' })
	]);

	const page = (title, kids) => ({ title, action: { type: kids ? 'firstchild' : 'view' }, children: kids });
	const tree = { children: { admin: { children: {
		status: page('Status', {
			overview: page('Overview'),
			realtime: page('Realtime Graphs', { load: page('Load'), bandwidth: page('Bandwidth'), connections: page('Connections') }),
			syslog: page('System Log', { syslog: page('System Log'), dmesg: page('Kernel Log') })
		}),
		system: page('System', { system: page('System'), flash: page('Backup / Flash Firmware') }),
		logout: page('Log out')
	} } } };
	const ui = { menu: {
		load: () => ({ then() {} }),
		getChildren: node => Object.keys((node && node.children) || {}).map(name => Object.assign({ name }, node.children[name]))
	} };
	const L = { url: (...a) => '/' + a.join('/'), env: { dispatchpath, nodespec }, bind: (f, o) => f.bind(o) };
	const rpc = { declare: () => () => Promise.resolve({}) };
	const baseclass = { extend: proto => proto };

	const proto = new Function('baseclass', 'ui', 'rpc', 'host', 'E', 'L', '_', 'document', 'window', SRC)(baseclass, ui, rpc, {}, E, L, s => s, document, window);
	const shell = Object.assign(Object.create(proto), {
		root: new El(document, 'html'),
		mqMobile: window.matchMedia(), mqNarrow: window.matchMedia(),
		closeTimer: null, openTimer: null, entries: [], trail: { all: new Set(), page: new Set() }
	});
	shell.render(tree);
	const fly = document.getElementById('vt-flyout');
	const btn = document.querySelector('button.vt-crumb-switch');
	const rail = document.querySelector('li.vt-rail-item');
	const key = (el, k, more) => el.dispatch('keydown', Object.assign({ key: k }, more));
	return { shell, document, fly, btn, rail, advance, key, search: document.getElementById('vt-search-btn') };
}

const isOpen = (fly, btn) => !fly.hidden && fly.classList.contains('is-switch') && btn.getAttribute('aria-expanded') === 'true';

test('switcher: a disclosure on the current crumb of a page with page tabs', () => {
	const { btn } = setup([ 'admin', 'status', 'realtime', 'connections' ]);
	assert.ok(btn, 'the crumb is a switch');
	assert.equal(btn.getAttribute('aria-expanded'), 'false');
	assert.equal(btn.getAttribute('aria-controls'), 'vt-flyout');
	assert.equal(btn.getAttribute('aria-haspopup'), null, 'a region of links, not a menu');
	assert.equal(setup([ 'admin', 'status', 'overview' ]).btn, null, 'no page tabs, no switch');
});

test('switcher: a rail timer left pending does not close it', () => {
	/* close timer: the pointer left a category just before the click */
	let s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	s.rail.dispatch('pointerenter', { pointerType: 'mouse' });
	s.advance(120);                                    /* the category opened */
	s.rail.dispatch('pointerleave', { pointerType: 'mouse' });
	s.btn.click();
	s.advance(400);
	assert.ok(isOpen(s.fly, s.btn), 'still open after the close delay');

	/* close timer with the panel still hidden: a category crossed too
	   briefly to open, then the crumb clicked (closeFlyout() returned early
	   on a hidden panel and never cancelled it) */
	s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	s.rail.dispatch('pointerenter', { pointerType: 'mouse' });
	s.advance(30);
	s.rail.dispatch('pointerleave', { pointerType: 'mouse' });
	s.advance(20);
	s.btn.click();
	s.advance(400);
	assert.ok(isOpen(s.fly, s.btn), 'not closed by the pending timer');

	/* open timer: the pointer crossed a category on its way to the crumb */
	s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	s.rail.dispatch('pointerenter', { pointerType: 'mouse' });
	s.btn.click();
	s.advance(400);
	assert.ok(isOpen(s.fly, s.btn), 'not replaced by the category');
});

test('switcher: passing over the rail leaves it open; a click on a category swaps it', () => {
	const s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	s.btn.click();
	s.rail.dispatch('pointerenter', { pointerType: 'mouse' });
	s.advance(200);
	s.rail.dispatch('pointerleave', { pointerType: 'mouse' });
	s.advance(400);
	assert.ok(isOpen(s.fly, s.btn));
	s.rail.querySelector('button').click();
	assert.ok(!s.fly.hidden && !s.fly.classList.contains('is-switch'), 'the category flyout');
	assert.equal(s.btn.getAttribute('aria-expanded'), 'false');
});

test('switcher keys: arrows open it at the current page, Tab moves on past it', () => {
	const s = setup([ 'admin', 'status', 'realtime', 'bandwidth' ]);
	s.btn.focus();
	assert.ok(s.key(s.btn, 'ArrowDown').defaultPrevented);
	assert.ok(isOpen(s.fly, s.btn));
	assert.equal(s.document.activeElement.textContent, 'Bandwidth', 'the current page');
	assert.equal(s.document.activeElement.getAttribute('aria-current'), 'page');

	/* Tab from the last link: closed, focus on the next control after the crumb */
	const links = s.fly.querySelectorAll('a');
	links[links.length - 1].focus();
	assert.ok(s.key(s.fly, 'Tab').defaultPrevented);
	assert.ok(s.fly.hidden);
	assert.equal(s.document.activeElement, s.search);

	/* opened with the mouse: Tab from the crumb goes into the list */
	s.btn.focus();
	s.btn.click();
	assert.ok(s.key(s.btn, 'Tab').defaultPrevented);
	assert.equal(s.document.activeElement, s.fly.querySelector('a'));
	/* Shift+Tab from the first link: back to the crumb, closed */
	s.key(s.fly, 'Tab', { shiftKey: true });
	assert.ok(s.fly.hidden);
	assert.equal(s.document.activeElement, s.btn);
	/* Tab on a closed switch is left to the browser */
	assert.ok(!s.key(s.btn, 'Tab').defaultPrevented);
});

test('switcher: focus moving elsewhere closes it; within it, it stays', () => {
	const s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	s.btn.click();
	const link = s.fly.querySelector('a');
	s.btn.dispatch('focusout', { relatedTarget: link });
	s.fly.dispatch('focusout', { relatedTarget: s.btn });
	s.fly.dispatch('focusout', { relatedTarget: null });       /* a click on nothing focusable */
	assert.ok(isOpen(s.fly, s.btn));
	s.fly.dispatch('focusout', { relatedTarget: s.search });
	assert.ok(s.fly.hidden);
	assert.equal(s.btn.getAttribute('aria-expanded'), 'false');
});

test('palette opened from inside the switcher returns focus to the crumb', () => {
	const s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	s.key(s.btn, 'ArrowDown');
	assert.ok(s.fly.contains(s.document.activeElement));
	s.shell.openPalette();
	assert.ok(s.fly.hidden);
	s.shell.closePalette();
	assert.equal(s.document.activeElement, s.btn);
});

/* what a crumb bar or a list says: [ tag, text ] per child */
const said = el => el.children.filter(c => c.tagName).map(c => [ c.tagName.toLowerCase(), c.textContent ]);

test('crumbs: a crumb that repeats the one before it shows once, with the deeper link and the switch', () => {
	/* Status › System Log › System Log (the page's first tab) */
	let s = setup([ 'admin', 'status', 'syslog', 'syslog' ]);
	const nav = s.document.getElementById('vt-crumbs');
	assert.deepEqual(said(nav), [ [ 'a', 'Status' ], [ 'span', '›' ], [ 'button', 'System Log' ] ]);
	assert.ok(s.btn, 'the merged crumb keeps the switch to the other tabs');
	/* its caret is a down chevron (the separators are right chevrons) */
	assert.equal(s.btn.querySelector('path').getAttribute('d'), 'm6 9 6 6 6-6');
	s.btn.click();
	assert.deepEqual(s.fly.querySelectorAll('a').map(a => a.textContent), [ 'System Log', 'Kernel Log' ]);
	/* the heading trail still has every level, so "System Log" headings are repeats */
	assert.ok(s.shell.trail.page.has('system log'));
	assert.equal(s.shell.pageTitle, 'System Log');

	/* System › System: one crumb, the page */
	s = setup([ 'admin', 'system', 'system' ]);
	assert.deepEqual(said(s.document.getElementById('vt-crumbs')), [ [ 'span', 'System' ] ]);
	assert.ok(s.shell.trail.all.has('system') && s.shell.trail.page.has('system'));

	/* nothing to merge */
	s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	assert.deepEqual(said(s.document.getElementById('vt-crumbs')).map(c => c[1]), [ 'Status', '›', 'Realtime Graphs', '›', 'Load' ]);
});

test('crumbs on a 404: the category LuCI resolved, then "Not found"; no page tabs', () => {
	let s = setup([ 'admin', 'status' ], { title: 'Status', action: { type: 'firstchild' } });
	assert.deepEqual(said(s.document.getElementById('vt-crumbs')), [ [ 'a', 'Status' ], [ 'span', '›' ], [ 'span', 'Not found' ] ]);
	assert.equal(s.shell.pageTitle, 'Not found');
	/* /admin/nonexistent: LuCI resolves "admin" only */
	s = setup([ 'admin' ], { title: 'Administration', action: { type: 'firstchild' } });
	assert.deepEqual(said(s.document.getElementById('vt-crumbs')), [ [ 'span', 'Not found' ] ]);
	/* a page with tabs that has no such tab: no tab bar, no switch */
	s = setup([ 'admin', 'status', 'realtime' ], { title: 'Realtime Graphs', action: { type: 'firstchild' } });
	assert.ok(s.document.getElementById('vt-tabs').hidden);
	assert.equal(s.btn, null);
	/* a page LuCI found */
	s = setup([ 'admin', 'status', 'overview' ], { title: 'Overview', action: { type: 'template', path: 'admin_status/index' } });
	assert.deepEqual(said(s.document.getElementById('vt-crumbs')).map(c => c[1]), [ 'Status', '›', 'Overview' ]);
});

test('flyouts: the title and the links, nothing that counts or repeats them', () => {
	const s = setup([ 'admin', 'status', 'realtime', 'load' ]);
	s.rail.querySelector('button').click();
	const head = s.fly.querySelector('.vt-fly-head');
	assert.deepEqual(said(head), [ [ 'span', 'Status' ] ], 'no icon, no page count');
	assert.equal(s.fly.querySelector('.vt-fly-meta'), null);
	assert.equal(s.fly.querySelector('.vt-fly-foot'), null);
	assert.equal(s.fly.querySelector('kbd'), null);
	assert.deepEqual(s.fly.querySelectorAll('.vt-fly-link').map(a => a.textContent), [ 'Overview', 'Realtime Graphs', 'System Log' ]);
	/* the page switcher's panel too */
	s.btn.click();
	assert.deepEqual(said(s.fly.querySelector('.vt-fly-head')), [ [ 'span', 'Realtime Graphs' ] ]);
});

test('palette: grouped rows say their category once; icons only on actions; hints and count', () => {
	const s = setup([ 'admin', 'status', 'overview' ]);
	s.shell.openPalette();
	const pal = s.shell.pal;
	const rows = () => pal.list.children.map(li => li.classList.contains('vt-pal-group') ? '# ' + li.textContent
		: li.classList.contains('vt-pal-empty') ? '! ' + li.textContent
		: [ li.querySelector('svg') ? '*' : '', li.querySelector('.vt-pal-title').textContent, (li.querySelector('.vt-pal-path') || { textContent: '' }).textContent ].join('|'));
	assert.deepEqual(rows(), [
		'# Status',
		'|Overview|', '|Realtime Graphs|', '|Load|Realtime Graphs', '|Bandwidth|Realtime Graphs', '|Connections|Realtime Graphs',
		'|System Log|', '|Kernel Log|System Log',             /* the "System Log" tab is the page's entry */
		'# System',
		'|System|', '|Backup / Flash Firmware|',
		'# Actions',
		'*|Use dark theme|Appearance', '*|Use light theme|Appearance',
		'*|Login background: Starfield|Appearance', '*|Login background: None|Appearance',
		'*|Log out|Session'
	]);
	/* Esc once, in the footer; no count without a query */
	assert.equal(pal.overlay.querySelector('.vt-pal-field').querySelector('kbd'), null);
	assert.equal(pal.overlay.querySelector('.vt-pal-foot').querySelectorAll('kbd').filter(k => k.textContent === 'Esc').length, 1);
	assert.equal(pal.count.textContent, '');

	/* a query: the path in full, a pluralised count of every match */
	pal.input.value = 'kernel';
	s.shell.filterPalette();
	assert.deepEqual(rows(), [ '|Kernel Log|Status › System Log' ]);
	assert.equal(pal.count.textContent, '1 result');
	/* titles that start with it first; System Log and Kernel Log score the same, the page wins */
	pal.input.value = 'log';
	s.shell.filterPalette();
	assert.deepEqual(rows(), [ '*|Log out|Session', '*|Login background: None|Appearance', '*|Login background: Starfield|Appearance',
		'|System Log|Status', '|Kernel Log|Status › System Log' ]);
	assert.equal(pal.count.textContent, '5 results');
	pal.input.value = 'zzz';
	s.shell.filterPalette();
	assert.equal(pal.count.textContent, '0 results');
});
