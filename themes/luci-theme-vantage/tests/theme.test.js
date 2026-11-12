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
	const toggle = part('\thelpToggle(desc, holder, label) {', '\tfitHelps(descs) {');
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

/* a top-level function of menu-vantage.js, with the ones it calls */
function fn(name, ...deps) {
	const body = [ name ].concat(deps).map(n => {
		const start = src.indexOf('function ' + n + '(');
		assert.ok(start >= 0, 'found ' + n);
		return src.slice(start, src.indexOf('\n}\n', start) + 3);
	}).join('\n');
	return new Function(body + '\nreturn ' + name + ';')();
}

test('crumbs: one that repeats the crumb before it takes its place, with the deeper link and level', () => {
	const mergeCrumbs = fn('mergeCrumbs', 'headingKey');
	const c = (title, level) => ({ title, level, segs: [ 'admin', 'x' + level ] });
	/* Status › System Log › System Log (its first tab) */
	assert.deepEqual(mergeCrumbs([ c('Status', 1), c('System Log', 2), c('System Log', 3) ]), [ c('Status', 1), c('System Log', 3) ]);
	/* System › System; case and a trailing colon do not count */
	assert.deepEqual(mergeCrumbs([ c('System', 1), c('system:', 2) ]), [ c('system:', 2) ]);
	assert.deepEqual(mergeCrumbs([ c('Network', 1), c('Firewall', 2), c('General Settings', 3) ]).map(p => p.level), [ 1, 2, 3 ]);
	assert.deepEqual(mergeCrumbs([]), []);
	/* the heading trail still sees every level (markRepeats) */
	assert.match(src, /this\.pageTitle = parts\[parts\.length - 1\]\.title;\n\t\tparts\.forEach\(\(p, i\) => \{/);
	assert.match(src, /const crumbs = mergeCrumbs\(parts\);/);
});

test('404: LuCI hands over a category or a node without an action', () => {
	const notFound = fn('notFound');
	assert.equal(notFound({ title: 'Administration', action: { type: 'firstchild' } }), true);
	assert.equal(notFound({ title: 'Status' }), true);
	assert.equal(notFound({ title: 'Overview', action: { type: 'template', path: 'admin_status/index' } }), false);
	assert.equal(notFound({ title: 'Wireless', action: { type: 'view', path: 'network/wireless' } }), false);
	assert.equal(notFound(undefined), false, 'no nodespec (older LuCI): a page');
	assert.equal(notFound(null), false);
});

test('palette: a path matches only as a substring or by word starts', () => {
	const pathScore = fn('pathScore');
	assert.equal(pathScore('wire', 'Network › Firewall'), null, 'no letters scattered over the path');
	assert.equal(pathScore('fire', 'Network › Firewall'), 10, 'a word start');
	assert.equal(pathScore('wall', 'Network › Firewall'), 6, 'inside a word');
	assert.equal(pathScore('net fire', 'Network › Firewall'), 4, 'each word starts one');
	assert.equal(pathScore('net wall', 'Network › Firewall'), null);
	assert.equal(pathScore('x', ''), null);
	assert.equal(pathScore('x', undefined), null);
	assert.equal(pathScore('  ', 'Status'), null);
});

test('palette ranking: titles first, path-only hits only without one, shallower pages win ties', () => {
	require('./luci-stub');
	const rank = fn('rankPalette', 'fuzzy', 'pathScore');
	const e = (title, path, segs) => ({ title, path, segs });
	const pool = [
		e('Wireless', 'Status › Realtime Graphs', [ 'admin', 'status', 'realtime', 'wireless' ]),
		e('Port Forwards', 'Network › Firewall', [ 'admin', 'network', 'firewall', 'forwards' ]),
		e('Traffic Rules', 'Network › Firewall', [ 'admin', 'network', 'firewall', 'rules' ]),
		e('Wireless', 'Network', [ 'admin', 'network', 'wireless' ]),
		e('Firewall', 'Network', [ 'admin', 'network', 'firewall' ]),
		e('Use dark theme', 'Appearance')
	];
	const titles = r => r.map(x => x.e.title + ' (' + x.e.path + ')');
	/* "wire": the two Wireless pages, Network's first; nothing from Firewall */
	assert.deepEqual(titles(rank('wire', pool)), [ 'Wireless (Network)', 'Wireless (Status › Realtime Graphs)' ]);
	/* "firewall": the page, not its tabs (they match on their path only) */
	assert.deepEqual(titles(rank('firewall', pool)), [ 'Firewall (Network)' ]);
	/* no title matches: the path decides */
	assert.deepEqual(titles(rank('appear', pool)), [ 'Use dark theme (Appearance)' ]);
	assert.deepEqual(rank('zzz', pool), []);
	assert.ok(rank('wire', pool)[0].idx.length, 'title matches carry their highlight');
});

test('palette layout without a query: headers only over categories of several rows, paths without the header', () => {
	const layout = fn('paletteLayout');
	const r = (title, path, group) => ({ e: { title, path, group }, idx: [] });
	const rows = layout([
		r('Dashboard', '', 'Dashboard'),
		r('Overview', 'Status', 'Status'),
		r('Kernel Log', 'Status › System Log', 'Status'),
		r('WireGuard', 'VPN', 'VPN'),
		r('Use dark theme', 'Appearance', 'Actions'),
		r('Log out', 'Session', 'Actions')
	]);
	assert.deepEqual(rows.map(x => [ x.head, x.r.e.title, x.path ]), [
		[ null, 'Dashboard', '' ],
		[ 'Status', 'Overview', '' ],
		[ null, 'Kernel Log', 'System Log' ],
		[ null, 'WireGuard', 'VPN' ],          /* one row: no header, its path stays */
		[ 'Actions', 'Use dark theme', 'Appearance' ],
		[ null, 'Log out', 'Session' ]
	]);
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
	const v2512 = (name, t) => new N('div', 'cbi-section', [ new N('div', 'cbi-title', [ new N('h3', '', [ name, new N('span', 'label', [ 'Hide' ]) ]) ]),
		new N('div', '', [ t || (name === 'Memory' ? memTable() : diskTable()) ]) ]);
	/* LuCI 24.10: <div.cbi-section><h3>Memory</h3><div><table/></div></div> */
	const v2410 = (name, t) => new N('div', 'cbi-section', [ new N('h3', '', [ name ]), new N('div', '', [ t || (name === 'Memory' ? memTable() : diskTable()) ]) ]);

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

		/* two more tables: "Total Available" without a value, read LuCI's way;
		   none at all (Kwrt, #103): "Used" is total - MemAvailable, swap as "Swap used" */
		const unknown = new N('table', 'table', [
			new N('tr', 'tr', [ new N('td', 'td', [ 'Total Available' ]), new N('td', 'td', [ '?' ]) ]),
			bar('Used', '400.00 MiB / 2.00 GiB (20%)'), bar('Buffered', '10.00 MiB / 2.00 GiB (0%)'), bar('Cached', '100.00 MiB / 2.00 GiB (5%)') ]);
		const kwrt = new N('table', 'table', [ bar('Used', '4.42 GiB / 15.38 GiB (29%)'), bar('Cached', '8.08 GiB / 15.38 GiB (52%)'),
			bar('Swap used', '16.00 MiB / 5.12 GiB (0%)') ]);
		view.append(make('Memory', unknown));
		view.append(make('Memory', kwrt));
		kit.enhanceMemory();
		const meter = sec => sec.children[1].children[0];
		const big = sec => meter(sec).children[0].children[0].textContent;
		assert.match(big(view.children[0]), /^80%/, release + ': LuCI\'s table, as before (the fixture\'s free beats its Total Available)');
		assert.match(big(view.children[3]), /^86%/, release + ': "?" is still LuCI\'s table: free + buffered + cached');
		assert.match(big(view.children[4]), /^71%/, release + ': Kwrt: total - Used is what is available');
		const legend = meter(view.children[4]).children[2].textContent;
		assert.match(legend, new RegExp('^In use' + Math.round(4.42 * 2 ** 30) + ' B'), release + ': in use is Kwrt\'s Used');
		const swap = meter(view.children[4]).children[3];
		assert.ok(swap && swap.cls.has('v-meter-swap'), release + ': Kwrt\'s swap row is read');
		assert.match(swap.textContent, new RegExp(16 * 2 ** 20 + ' B / '), release + ': swap used as given');
	}
});

/* Appearance for every browser (#89): /etc/config/vantage_theme, written
   through the theme's own rpcd group, read by the templates */
test('Appearance: a pick of this browser\'s own, then the router\'s, then one from before, then the default', () => {
	const start = src.indexOf('function lookValue(');
	assert.ok(start > 0, 'found lookValue');
	const end = src.indexOf('\n}\n', start) + 2;
	const lookValue = new Function(src.slice(start, end) + '\nreturn lookValue;')();
	const OK = [ 'auto', 'light', 'dark' ];
	/* [ pending, own, router, before ] */
	assert.equal(lookValue(OK, [ null, null, null, null ]), 'auto', 'the default');
	assert.equal(lookValue(OK, [ null, null, null, 'dark' ]), 'dark', 'a pick from before, the router silent');
	assert.equal(lookValue(OK, [ null, null, 'light', 'dark' ]), 'light', 'the router over a pick from before');
	assert.equal(lookValue(OK, [ null, null, 'auto', 'dark' ]), 'auto', 'auto saved for everyone is a value too');
	assert.equal(lookValue(OK, [ null, 'dark', 'light', null ]), 'dark', 'a pick without the right to save it, here only');
	assert.equal(lookValue(OK, [ 'light', 'dark', 'auto', null ]), 'light', 'a pick being saved');
	assert.equal(lookValue(OK, [ null, 'Dark', '', 'x' ]), 'auto', 'unknown values are skipped');
	assert.equal(lookValue([ 'grid', 'stars', 'none' ], [ undefined, null, '', 'stars' ]), 'stars');
});

test('Appearance: the templates and the login page read the same keys, in the same order', () => {
	const T = path.join(__dirname, '..', 'luci-theme-vantage');
	const header = fs.readFileSync(path.join(T, 'ucode/template/themes/vantage/header.ut'), 'utf8');
	const login = fs.readFileSync(path.join(T, 'ucode/template/themes/vantage/sysauth.ut'), 'utf8');
	const loginJs = fs.readFileSync(path.join(T, 'htdocs/luci-static/vantage/login.js'), 'utf8');
	/* no session here: the dashboard's history in this tab goes */
	const storeKey = /STORE_KEY = '([^']+)'/.exec(fs.readFileSync(path.join(T, '../luci-app-vantage/htdocs/luci-static/resources/view/vantage/overview.js'), 'utf8'))[1];
	assert.ok(loginJs.includes(`sessionStorage.removeItem('${storeKey}')`), 'the login page drops the dashboard history');
	const table = /\nconst LOOK = (\{[\s\S]*?\n\});\n/.exec(src);
	assert.ok(table, 'found LOOK');
	const LOOK = new Function('THEME_KEY', 'LOGIN_KEY', 'BACKDROP_KEY', 'return ' + table[1])('vantage.theme', 'vantage.login', 'vantage.backdrop.v1');
	assert.deepEqual(Object.keys(LOOK), [ 'theme', 'login', 'backdrop', 'power', 'brand' ]);
	assert.ok(header.includes("look('brand', [ 'none', 'hostname', 'model' ])"), 'the template keeps the same brand values');
	assert.ok(header.includes("look('theme', 'vantage.theme.own', 'vantage.theme', [ 'auto', 'light', 'dark' ])"));
	assert.ok(header.includes("look('backdrop', 'vantage.backdrop.own', 'vantage.backdrop.v1', [ 'grid', 'stars', 'none' ])"));
	assert.ok(header.includes("look('power', 'vantage.power.own', 'vantage.power', [ 'normal', 'low' ])"));
	assert.ok(header.includes("look('power', [ 'normal', 'low' ])"), 'the template keeps the same power values');
	assert.ok(login.includes("localStorage.getItem('vantage.theme.own'); v[2] = localStorage.getItem('vantage.theme')"));
	assert.ok(loginJs.includes("localStorage.getItem('vantage.login.own'); v[2] = localStorage.getItem('vantage.login')"));
	/* Low-power router: the login page draws no particles, picked the same way */
	assert.ok(loginJs.includes("localStorage.getItem('vantage.power.own'); p[2] = localStorage.getItem('vantage.power')"));
	assert.match(loginJs, /if \(pick === 'none' \|\| power === 'low'\) return;/);
	assert.ok(login.includes("look('power', [ 'normal', 'low' ])") && login.includes('data-vt-look-power="{{ look_power }}"'));
	for (const [ name, k ] of Object.entries(LOOK)) {
		assert.match(k.own, /^vantage\.[a-z]+\.own$/, name);
		assert.ok(header.includes(`data-vt-look-${name}="{{ look_${name} }}"`), `header hands over ${name}`);
	}
	assert.deepEqual(LOOK.theme.ok, [ 'auto', 'light', 'dark' ]);
	assert.deepEqual(LOOK.login.ok, [ 'grid', 'stars', 'none' ]);
	assert.deepEqual(LOOK.backdrop.ok, [ 'grid', 'stars', 'none' ]);
	assert.deepEqual(LOOK.power.ok, [ 'normal', 'low' ], 'Low-power router is off unless picked');
	assert.deepEqual(LOOK.brand.ok, [ 'none', 'hostname', 'model' ], 'nothing next to the logo unless picked');
	assert.ok(!login.includes('vt-look-brand'), 'the login page shows no device name');
	/* saved in config vantage_theme, section appearance, and nowhere else */
	assert.deepEqual([ ...src.matchAll(/callLook(?:Set|Commit|Revert)\(([^)]*?)[,)]/g) ].map(m => m[1]), [ "'vantage_theme'", "'vantage_theme'", "'vantage_theme'", "'vantage_theme'" ]);
	/* rpcd refuses revert while an apply is pending, as it does commit, so nothing is set that could not be taken back */
	assert.match(src, /callLookRevert\('vantage_theme'\)\s*\.then\(\(\) => callLookSet\(/);
	/* a commit that fails later is reverted, never left in the session */
	assert.match(src, /callLookCommit\('vantage_theme'\)\.catch\(e => callLookRevert\('vantage_theme'\)/);
	assert.match(src, /callLookSet\('vantage_theme', 'appearance', values\)/);
	assert.match(src, /lookWrite\(\{ \[name\]: value \}\)/);
});

test('Customize: the theme, the template and the dashboard keep the same chart styles and layout form', () => {
	const { load } = require('./luci-stub');
	const layout = load('vantage.layout'), series = load('vantage.series');
	const header = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-vantage/ucode/template/themes/vantage/header.ut'), 'utf8');
	const charts = new Function('return ' + /const VIEW_CHARTS = (\[[^\]]*\]);/.exec(src)[1])();
	assert.deepEqual(charts, series.CHART_STYLES);
	assert.ok(header.includes(`look('chart', ${JSON.stringify(charts).replace(/"/g, "'").replace(/,/g, ', ').replace('[', '[ ').replace(']', ' ]')})`));
	const form = /const VIEW_LAYOUT = (\/.*\/);/.exec(src)[1];
	assert.ok(header.includes(`const form = ${form};`) && header.includes('match(v, form)'), 'the template reads what the theme writes');
	const re = new Function('return ' + form)();
	/* every tile of every default layout, shown and hidden, fits the form and comes back */
	for (const tier of [ 'wide', 'mid', 'narrow' ]) for (const wired of [ false, true ]) {
		for (const hide of [ false, true ]) {
			const list = layout.compact(layout.defaults(tier, wired).map(e => Object.assign({}, e, { hide })));
			const text = layout.encode(list);
			assert.match(text, re, text);
			const k = layout.key(tier, wired), opt = layout.option(k);
			assert.match(opt, /^layout_(wide|mid|narrow)(_wired)?$/);
			assert.ok(header.includes(`'${opt.slice(7)}'`), `the template reads ${opt}`);
			assert.deepEqual([ ...layout.decode(`${opt.slice(7)}=${text}`)[k] ], list);
		}
	}
	/* the longest tile name still fits */
	for (const id of layout.TILES) assert.match(`${id}:0:1`, re, id);
	/* a failed save can be done again: only one under way stops a repeat */
	assert.match(src, /pending\[name\] === value && !failed\[name\]/);
	assert.match(src, /'click', \(\) => \{ if \(input\.checked && \(this\.lookFailed \|\| \{\}\)\[look\]\) set\(o\[0\]\)/);
	/* Esc in the palette stays there: the dashboard would take it as Done */
	assert.match(src, /case 'Escape': ev\.preventDefault\(\); ev\.stopPropagation\(\); this\.closePalette\(\)/);
	/* only a login that may save hands it to the router, in one write */
	assert.match(src, /VIEW_SAVE_EVENT, ev => \{[\s\S]{0,120}this\.lookState\(\) !== 'yes'[\s\S]{0,300}lookWrite\(values\)/);
});

test('Appearance: the theme\'s rpcd group writes config vantage_theme only, which ships empty', () => {
	const T = path.join(__dirname, '..', 'luci-theme-vantage');
	const acl = JSON.parse(fs.readFileSync(path.join(T, 'root/usr/share/rpcd/acl.d/luci-theme-vantage.json'), 'utf8'));
	assert.deepEqual(Object.keys(acl), [ 'luci-theme-vantage' ]);
	const g = acl['luci-theme-vantage'];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'write' ], 'a write group only, no read grants');
	assert.deepEqual(g.write, { ubus: { uci: [ 'set', 'commit', 'revert' ] }, uci: [ 'vantage_theme' ] });
	/* no read of its own: the dashboard gets these through the template */
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'write' ]);
	const conf = fs.readFileSync(path.join(T, 'root/etc/config/vantage_theme'), 'utf8');
	assert.deepEqual(conf.split('\n').filter(l => l.trim() && !/^\s*#/.test(l)), [ "config appearance 'appearance'" ], 'one section, nothing set');
	const mk = fs.readFileSync(path.join(T, 'Makefile'), 'utf8');
	assert.match(mk, /define Package\/luci-theme-vantage\/conffiles\n\/etc\/config\/vantage_theme\nendef/);
});

/* Check for updates (#102): only when asked, one known URL, only a version passes */
test('update check: reads the theme\'s version from the package list, compares, builds its own link', () => {
	const pick = name => { const s = src.indexOf('function ' + name + '('); return src.slice(s, src.indexOf('\n}\n', s) + 2); };
	const entry = /^const UPDATE_ENTRY = .*$/m.exec(src)[0];
	const { versionParts, newerVersion, listedVersion } = new Function(
		[ entry ].concat([ 'versionParts', 'newerVersion', 'listedVersion' ].map(pick)).join('\n') + '\nreturn { versionParts, newerVersion, listedVersion };')();
	const list = [ 'Package: luci-app-vantage', 'Version: 9.9.9-r1', '', 'Package: luci-theme-vantage', 'Version: 1.0.17-r1', 'Depends: luci-base', '' ].join('\n');
	assert.equal(listedVersion(list), '1.0.17', 'the theme\'s own entry, not the app\'s');
	for (const odd of [ 'Version: 1.0.17<script>', 'Version: 1.0.17-r1 x', 'Version: javascript:1', 'Version: 1', 'Version: 1.0.17-rc1', 'Version: 12345.0.0' ])
		assert.equal(listedVersion('Package: luci-theme-vantage\n' + odd + '\n'), null, odd);
	assert.equal(listedVersion('Package: luci-theme-vantage-extra\nVersion: 2.0.0\n'), null, 'another package');
	assert.equal(listedVersion('<html>not a list</html>'), null);
	const newer = (a, b) => newerVersion(versionParts(a), versionParts(b));
	assert.ok(newer('1.0.17', '1.0.16'));
	assert.ok(newer('1.1.0', '1.0.16'));
	assert.ok(!newer('1.0.16', '1.0.16'));
	assert.ok(!newer('1.0.16', '1.0.16.2'), 'a test build ahead of the release');
	assert.ok(newer('1.0.16.1', '1.0.16'));
	/* one request, to the constant URL, from the click handler only; nothing else leaves for the internet */
	assert.equal(src.split('fetch(UPDATE_INDEX,').length - 1, 1);
	assert.match(src, /const UPDATE_INDEX = 'https:\/\/anothadev\.github\.io\/luci-theme-vantage\/24\.10\/Packages';/);
	assert.match(src, /fetch\(UPDATE_INDEX, \{ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'/);
	assert.match(src, /btn\.addEventListener\('click', \(\) => this\.checkUpdates\(btn, out\)\)/);
	assert.equal(src.split('checkUpdates(').length - 1, 2, 'defined once, called from the click only');
	assert.deepEqual([ ...src.matchAll(/fetch\(([^,)]+)/g) ].map(m => m[1]).filter(a => !/^L\.resource\(/.test(a)), [ 'UPDATE_INDEX' ]);
	/* the link is a constant: nothing from the list reaches an attribute */
	assert.match(src, /'href': 'https:\/\/github\.com\/anothaDev\/luci-theme-vantage\/releases\/latest',/);
});

/* the theme's clock: a pulse CSS cancelled since the last step (the dot's
   state changed, the window lost the focus) is dropped, not stepped */
test('theme motion clock: a cancelled pulse is dropped, not stepped', () => {
	const src = fs.readFileSync(FILE, 'utf8');
	const m = /\n\tstepPulses\(dt\) \{\n([\s\S]*?)\n\t\},\n/.exec(src);
	assert.ok(m, 'stepPulses found');
	const stepPulses = new Function('dt', m[1]);
	const live = { playState: 'paused', currentTime: 0 }, gone = { playState: 'idle', currentTime: null };
	const self = { clock: { anims: [ { a: live, dur: 1000, at: 0 }, { a: gone, dur: 1000, at: 0 } ] } };
	stepPulses.call(self, 50);
	assert.equal(live.currentTime, 50);
	assert.equal(gone.currentTime, null, 'not written: it stays cancelled');
	assert.deepEqual(self.clock.anims.map(x => x.a), [ live ]);
});
