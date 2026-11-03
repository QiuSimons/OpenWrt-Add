'use strict';
/* menu-vantage.js pieces that decide what reaches the DOM: the SVG helper's
   closed tag/attribute sets, Channel Analysis ownership (by BSSID, never by
   SSID text, which a neighbour controls), and the form chrome (which
   headings count as repeats, where the help button goes). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js');
const src = fs.readFileSync(FILE, 'utf8');

/* svgNode/svgAttr/svgEl and the ICONS table, evaluated with a recording document */
function svgKit() {
	const start = src.indexOf('function svgNode(');
	const end = src.indexOf('function svg(name, size)');
	assert.ok(start > 0 && end > start, 'found the SVG helpers');
	const icons = /\nconst ICONS = (\{[\s\S]*?\n\});\n/.exec(src);
	assert.ok(icons, 'found the ICONS table');
	const made = [];
	const document = {
		createElementNS: (ns, tag) => {
			const el = { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
			made.push(el);
			return el;
		}
	};
	const kit = new Function('document', 'SVGNS', src.slice(start, end) + '\nreturn { svgEl, ICONS: ' + icons[1] + ' };')(document, 'http://www.w3.org/2000/svg');
	return Object.assign(kit, { made });
}

test('svgEl: builds every icon; any other tag or attribute throws', () => {
	const { svgEl, ICONS, made } = svgKit();
	for (const parts of Object.values(ICONS)) for (const [ tag, attrs ] of parts) svgEl(tag, attrs);
	svgEl('svg', { 'viewBox': '0 0 24 24', 'width': 20, 'height': 20, 'aria-hidden': 'true', 'focusable': 'false' });
	svgEl('linearGradient', { 'id': 'v-grad-1', 'class': 'v-grad', 'x1': '0', 'y1': '0', 'x2': '0', 'y2': '1' });
	svgEl('stop', { 'offset': '0', 'class': 'v-stop-top' });
	assert.ok(made.length > 30);
	assert.equal(made.find(e => e.tag === 'svg').attrs.width, '20', 'values are strings');
	for (const tag of [ 'script', 'a', 'foreignObject', 'animate', 'set', 'image', 'use', 'style', 'SVG', 'iframe' ])
		assert.throws(() => svgEl(tag, {}), /tag not allowed/, tag);
	for (const k of [ 'href', 'xlink:href', 'onclick', 'onload', 'style', 'attributeName', 'to', 'values', 'begin', '__proto__' ])
		assert.throws(() => svgEl('path', { [k]: 'x' }), /attribute not allowed/, k);
});

test('repeated headings: case, spacing and a trailing colon do not count', () => {
	const start = src.indexOf('function headingKey(');
	assert.ok(start > 0, 'found headingKey');
	const end = src.indexOf('\n}\n', start) + 3;
	const headingKey = new Function(src.slice(start, end) + '\nreturn headingKey;')();
	assert.equal(headingKey('Router Password'), headingKey('router password'));
	assert.equal(headingKey('  General\n Settings: '), 'general settings');
	assert.equal(headingKey('Interfaces'), headingKey('Interfaces'));
	assert.notEqual(headingKey('System'), headingKey('System Properties'));
	assert.notEqual(headingKey('Firewall - Zone Settings'), headingKey('General Settings'));
	assert.equal(headingKey(null), '');
});

test('repeated headings: a card heading never counts as a repeat of the category', () => {
	const start = src.indexOf('function repeatsTrail(');
	assert.ok(start > 0, 'found repeatsTrail');
	const end = src.indexOf('\n}\n', start) + 3;
	const repeatsTrail = new Function(src.slice(start, end) + '\nreturn repeatsTrail;')();
	/* Services > Dynamic DNS: the page title repeats the page crumb, the
	   "Services" table heading only matches the category and is content */
	const ddns = { all: new Set([ 'services', 'dynamic dns' ]), page: new Set([ 'dynamic dns' ]) };
	assert.equal(repeatsTrail('dynamic dns', 'H2', ddns), true);
	assert.equal(repeatsTrail('services', 'H3', ddns), false);
	/* a page title may repeat the category (Status > Overview prints "Status") */
	assert.equal(repeatsTrail('services', 'H2', ddns), true);
	assert.equal(repeatsTrail('', 'H2', ddns), false);
	/* the trail: the category goes only to `all`, unless it is the page */
	assert.match(src, /this\.trail\.all\.add\(headingKey\(p\.title\)\);\n\t\t\t\/\*[^*]*\*\/\n\t\t\tif \(i \|\| parts\.length === 1\) this\.trail\.page\.add\(headingKey\(p\.title\)\);/);
	assert.match(src, /let repeat = repeatsTrail\(key, h\.tagName, this\.trail\);/);
});

test('form chrome: never stands between LuCI nodes, never changes their text', () => {
	const part = (from, to) => {
		const start = src.indexOf(from), end = src.indexOf(to, start);
		assert.ok(start > 0 && end > start, 'found ' + from.trim());
		return src.slice(start, end);
	};
	const field = part('\taddFieldHelp(desc) {', '\taddIntroHelp(desc) {');
	const intro = part('\taddIntroHelp(desc) {', '\thelpToggle(desc, holder, label) {');
	const toggle = part('\thelpToggle(desc, holder, label) {', '\tfitHelp(desc) {');
	const placing = /insertBefore|insertAdjacent|appendChild|\.before\(|\.after\(|\.prepend\(|\.append\(/g;
	/* field help goes after the field: LuCI's label click finds its widget
	   through nextElementSibling */
	assert.deepEqual(field.match(placing), [ 'appendChild' ]);
	assert.match(field, /row\.appendChild\(this\.helpToggle\(/);
	/* intro help goes inside the description, never beside it: ui.tabs finds
	   a tab menu as its pane group's previous sibling */
	assert.deepEqual(intro.match(placing), [ 'insertBefore' ]);
	assert.match(intro, /desc\.insertBefore\(this\.helpToggle\(.*\), desc\.firstChild\);/);
	assert.equal(toggle.match(placing), null);
	/* descriptions keep their text; folding is an attribute plus CSS */
	for (const body of [ field, intro, toggle ])
		assert.doesNotMatch(body, /textContent\s*=|innerHTML|\.remove\(\)|replaceChildren/);
	/* a heading that holds a control (Overview's Hide/Show label) is never hidden */
	const repeats = src.slice(src.indexOf('\tmarkRepeats() {'));
	assert.match(repeats, /h\.querySelector\('a, button, input, select, \[data-clickable\], \[tabindex\]'\)\) return;/);
});

test('channel analysis: a row or hump is ours by BSSID only', () => {
	assert.doesNotMatch(src, /Local Interface'/, 'no SSID-text match (a neighbour can broadcast that SSID)');
	assert.match(src, /const mine = own\.has\(bssid\);/);
	assert.match(src, /const mine = mineByColour\.has\(colour\);/);
	/* own BSSIDs come from this device's interfaces */
	assert.match(src, /\[ i\.iwinfo && i\.iwinfo\.bssid, i\.config && i\.config\.macaddr \]/);
	/* the view's own row has no colour dot: its colour is rebuilt with the
	   view's derive_color from the BSSID as printed, not upper-cased */
	assert.match(src, /L\.require\('tools\.prng'\)/);
	assert.match(src, /if \(mine && colourOf\) \{\s*const derived = hexRgb\(colourOf\(printed\)\);/);
});

test('channel analysis: a derived colour reads back like element.style', () => {
	const start = src.indexOf('function hexRgb(');
	assert.ok(start > 0, 'found hexRgb');
	const end = src.indexOf('\n}\n', start) + 3;
	const hexRgb = new Function(src.slice(start, end) + '\nreturn hexRgb;')();
	assert.equal(hexRgb('#89cdb4'), 'rgb(137, 205, 180)');
	assert.equal(hexRgb('#FFFFFF'), 'rgb(255, 255, 255)');
	for (const bad of [ '#fff', 'red', '', null, undefined, '#89cdb4 ', 'rgb(1, 2, 3)' ])
		assert.equal(hexRgb(bad), null, String(bad));
});

/* Status -> Overview's memory and storage enhancers on both LuCI layouts:
   25.12 wraps a section's heading in .cbi-title (with the Hide label),
   LuCI 24.10 puts the bare h3 first in the section */
test('status enhancers: memory and storage sections are found with and without .cbi-title (LuCI 24.10)', () => {
	require('./luci-stub');      /* String.prototype.format */
	const start = src.indexOf('const BYTE_UNITS');
	const end = src.indexOf('/* Wireless radio boxes');
	assert.ok(start > 0 && end > start, 'found the enhancers');

	/* a fake DOM just big enough for statusSections .. enhanceStorage */
	class N {
		constructor(tag, cls, kids, attrs) {
			this.tagName = tag.toUpperCase(); this.nodeType = 1; this.parentNode = null; this.children = []; this.childNodes = [];
			this.attrs = Object.assign({}, attrs); this.cls = new Set((cls || '').split(' ').filter(Boolean));
			this.classList = { add: c => this.cls.add(c), contains: c => this.cls.has(c) };
			for (const k of [].concat(kids || [])) this.append(k);
		}
		append(k) {
			if (typeof k === 'string') k = { nodeType: 3, data: k, textContent: k };
			k.parentNode = this; this.childNodes.push(k); if (k.nodeType === 1) this.children.push(k);
			return k;
		}
		get firstChild() { return this.childNodes[0] || null; }
		get firstElementChild() { return this.children[0] || null; }
		get previousElementSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) - 1] || null : null; }
		get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
		getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
		setAttribute(k, v) { this.attrs[k] = String(v); }
		hasAttribute(k) { return k in this.attrs; }
		insertBefore(n, ref) {
			n.parentNode = this;
			this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
			this.children.splice(this.children.indexOf(ref), 0, n);
		}
		remove() { const p = this.parentNode; p.childNodes.splice(p.childNodes.indexOf(this), 1); p.children.splice(p.children.indexOf(this), 1); }
		closest(sel) { for (let n = this; n && n.cls; n = n.parentNode) if (sel === '.cbi-section' && n.cls.has('cbi-section')) return n; return null; }
		all() { return this.children.reduce((a, c) => a.concat(c, c.all()), []); }
		querySelectorAll(sel) {
			if (sel === ':scope > tr, :scope > tbody > tr')
				return this.children.filter(c => c.tagName === 'TR').concat(...this.children.filter(c => c.tagName === 'TBODY').map(b => b.children));
			if (sel === ':scope > table.table') return this.children.filter(c => c.tagName === 'TABLE' && c.cls.has('table'));
			if (sel === '.cbi-progressbar') return this.all().filter(c => c.cls.has('cbi-progressbar'));
			throw new Error('fake DOM: ' + sel);
		}
		querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
	}
	const bar = (label, title) => new N('tr', 'tr', [ new N('td', 'td', [ label ]), new N('td', 'td', [ new N('div', 'cbi-progressbar', [], { title }) ]) ]);
	const memTable = () => new N('table', 'table', [
		bar('Total Available', '1.50 GiB / 2.00 GiB (75%)'), bar('Used', '400.00 MiB / 2.00 GiB (20%)'),
		bar('Buffered', '10.00 MiB / 2.00 GiB (0%)'), bar('Cached', '100.00 MiB / 2.00 GiB (5%)') ]);
	const diskTable = () => new N('table', 'table', [ bar('Disk space', '23.55 MiB / 98.33 MiB (23%)') ]);
	/* 25.12: <div.cbi-section><div.cbi-title><h3>Memory<span.label>Hide</span></h3></div><div><table/></div></div> */
	const v2512 = name => new N('div', 'cbi-section', [ new N('div', 'cbi-title', [ new N('h3', '', [ name, new N('span', 'label', [ 'Hide' ]) ]) ]),
		new N('div', '', [ name === 'Memory' ? memTable() : diskTable() ]) ]);
	/* LuCI 24.10: <div.cbi-section><h3>Memory</h3><div><table/></div></div> */
	const v2410 = name => new N('div', 'cbi-section', [ new N('h3', '', [ name ]), new N('div', '', [ name === 'Memory' ? memTable() : diskTable() ]) ]);

	for (const [ release, make ] of [ [ '25.12', v2512 ], [ '24.10', v2410 ] ]) {
		const view = new N('div', '', [ make('Memory'), make('Storage'), make('System') ]);
		const document = {
			querySelectorAll(sel) {
				assert.equal(sel, '#view .cbi-section > .cbi-title > h3, #view .cbi-section > h3:first-child');
				return view.all().filter(n => n.tagName === 'H3' && n.parentNode && (n.parentNode.cls.has('cbi-title')
					? n.parentNode.parentNode.cls.has('cbi-section') : n.parentNode.cls.has('cbi-section') && n.parentNode.children[0] === n));
			}
		};
		const E = (tag, attrs, kids) => {
			const n = new N(tag, (attrs || {})['class'], [], {});
			n.style = {};
			for (const k of [].concat(kids == null ? [] : kids)) if (k !== '') n.append(k);
			return n;
		};
		const kit = new Function('document', 'E', '_', 'String', src.slice(start, end) + '\nreturn { enhanceMemory, enhanceStorage };')(
			document, E, s => s, Object.assign(v => String(v), { format: (f, n) => Math.round(n) + ' B' }));
		kit.enhanceMemory();
		kit.enhanceStorage();
		const [ mem, disk ] = view.children;
		assert.ok(mem.children[1].children[0].cls.has('v-meter-mem'), release + ': memory bar built');
		assert.ok(mem.children[1].children[1].cls.has('v-src-hidden'), release + ': LuCI table kept, hidden');
		assert.ok(disk.children[1].children[0].cls.has('v-meter-disk'), release + ': storage rows built');
		/* a second pass (the next poll) finds nothing left to do */
		kit.enhanceMemory();
		assert.equal(mem.children[1].children.length, 2, release + ': idempotent');
	}
});
