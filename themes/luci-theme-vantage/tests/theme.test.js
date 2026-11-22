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

/* the palette's functions for what a provider hands over (PALETTE_EVENT),
   with the constants they read */
function provided(name, ...deps) {
	const consts = [ 'PROVIDED_KINDS', 'PROVIDED_MAX', 'PROVIDED_SCAN', 'PROVIDED_TEXT' ].map(c => {
		const m = new RegExp('^const ' + c + ' = .*$', 'm').exec(src);
		assert.ok(m, 'found ' + c);
		return m[0];
	}).join('\n');
	const body = [ name ].concat(deps).map(n => {
		const start = src.indexOf('function ' + n + '(');
		assert.ok(start >= 0, 'found ' + n);
		return src.slice(start, src.indexOf('\n}\n', start) + 3);
	}).join('\n');
	return new Function('window', consts + '\n' + body + '\nreturn ' + name + ';')({});
}

test('palette provider: only entries of the form are taken, eight a kind, and their text as it came', () => {
	require('./luci-stub');
	const check = provided('providedEntries', 'kindTitle');
	let ran = 0;
	const run = () => { ran++; };
	const e = more => Object.assign({ kind: 'client', title: 'den-phone', detail: '192.0.2.22 · Harbor', words: '00:00:5e:00:53:22', run }, more);
	const got = check([ e(), e({ kind: 'radio', title: '5 GHz · Wi-Fi 6', detail: 'Ch 36 · 80 MHz', words: undefined }),
		e({ kind: 'ssid', title: 'Harbor', detail: undefined }), e({ kind: 'interface', title: 'lan' }) ]);
	assert.deepEqual(got.map(x => [ x.kind, x.group, x.title, x.path, x.find ]), [
		[ 'client', 'Clients', 'den-phone', '192.0.2.22 · Harbor', '192.0.2.22 · Harbor 00:00:5e:00:53:22' ],
		[ 'radio', 'Radios', '5 GHz · Wi-Fi 6', 'Ch 36 · 80 MHz', 'Ch 36 · 80 MHz ' ],
		[ 'ssid', 'Wireless networks', 'Harbor', '', ' 00:00:5e:00:53:22' ],
		[ 'interface', 'Interfaces', 'lan', '192.0.2.22 · Harbor', '192.0.2.22 · Harbor 00:00:5e:00:53:22' ]
	]);
	/* nothing but these fields comes along: no page, no icon, no markup flag */
	assert.deepEqual(Object.keys(check([ e({ segs: [ 'admin', 'x' ], icon: 'logout', href: 'https://example.net/', html: true }) ])[0]).sort(),
		[ 'find', 'group', 'kind', 'path', 'run', 'title' ]);
	got[0].run();
	assert.equal(ran, 1);
	/* markup is text to it: kept as it came, for a text node */
	assert.equal(check([ e({ title: '<img src=x onerror=alert(1)>' }) ])[0].title, '<img src=x onerror=alert(1)>');

	/* not of the form: dropped, one by one */
	for (const bad of [ null, 'den-phone', 7, [ 'client' ], e({ kind: 'page' }), e({ kind: 'constructor' }), e({ kind: [ 'client' ] }), e({ kind: undefined }),
		e({ title: '' }), e({ title: '   ' }), e({ title: 7 }), e({ title: null }), e({ title: [ 'den' ] }), e({ title: 'x'.repeat(129) }),
		e({ detail: 7 }), e({ detail: {} }), e({ detail: 'x'.repeat(129) }), e({ words: [ 'a' ] }), e({ words: 'x'.repeat(513) }),
		e({ run: 'alert(1)' }), e({ run: null }), e({ run: undefined }) ])
		assert.deepEqual(check([ bad ]), [], JSON.stringify(bad));
	assert.equal(check([ e({ title: 'x'.repeat(128), detail: 'y'.repeat(128), words: 'z'.repeat(512) }) ]).length, 1, 'at the bounds');
	for (const bad of [ null, undefined, 'clients', { length: 3 }, e() ]) assert.deepEqual(check(bad), [], 'not a list');

	/* eight of a kind, of the first 64 looked at */
	const many = [];
	for (let i = 0; i < 20; i++) many.push(e({ title: 'c' + i }), e({ kind: 'radio', title: 'r' + i }));
	const cut = check(many);
	assert.deepEqual(cut.filter(x => x.kind === 'client').map(x => x.title), [ 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7' ]);
	assert.equal(cut.filter(x => x.kind === 'radio').length, 8);
	assert.equal(check(new Array(64).fill({}).concat(e())).length, 0, 'past the first 64: not looked at');
	assert.equal(check(new Array(63).fill({}).concat(e())).length, 1);

	/* what an entry's function throws stays with it */
	const noisy = check([ e({ run: () => { throw new Error('gone'); } }) ])[0];
	assert.doesNotThrow(() => noisy.run());
});

test('palette provider: entries rank as pages do, by their name first, else by their second text and words', () => {
	require('./luci-stub');
	const rank = provided('rankPalette', 'fuzzy', 'pathScore');
	const check = provided('providedEntries', 'kindTitle');
	const run = () => {};
	const pool = check([
		{ kind: 'client', title: 'den-phone', detail: '192.0.2.22 · Harbor-5G · via ap-den', words: '02:00:5e:20:00:12 2001:db8::22', run },
		{ kind: 'client', title: 'living-tv', detail: '192.0.2.31 · Harbor-5G', words: '00:00:5e:00:53:31', run },
		{ kind: 'client', title: 'Private device 53:0F', detail: '00:00:5E:00:53:0F · Harbor', words: '00:00:5e:00:53:0f', run }
	]);
	const titles = q => rank(q, pool).map(x => x.e.title);
	/* the fuzzy match of titles: "tv" as a word before its letters scattered */
	assert.deepEqual(titles('tv'), [ 'living-tv', 'Private device 53:0F' ]);
	assert.deepEqual(titles('living'), [ 'living-tv' ]);
	assert.ok(rank('tv', pool)[0].idx.length, 'a name match carries its highlight');
	assert.deepEqual(titles('53:31'), [ 'living-tv' ], 'a MAC fragment, from the words');
	assert.deepEqual(rank('53:31', pool)[0].idx, [], 'nothing of the name to highlight');
	assert.deepEqual(titles('192.0.2.22'), [ 'den-phone' ], 'an address, from the second text');
	assert.deepEqual(titles('2001:db8::22'), [ 'den-phone' ]);
	assert.deepEqual(titles('ap-den'), [ 'den-phone' ], 'its access point');
	assert.deepEqual(titles('53:0f'), [ 'Private device 53:0F' ], 'the name first, whatever case');
	assert.deepEqual(titles('harbor-5g'), [ 'den-phone', 'living-tv' ]);
	assert.deepEqual(titles('zzz'), []);
	/* several words: the query as typed, or each starting a word; "6" does not start 36 */
	const radios = check([
		{ kind: 'radio', title: '2.4 GHz · Wi-Fi 6', detail: 'Ch 6 · 20 MHz', words: 'radio0 HE20 Channel 6', run },
		{ kind: 'radio', title: '5 GHz · Wi-Fi 6', detail: 'Ch 36 · 80 MHz', words: 'radio1 HE80 Channel 36', run }
	]);
	assert.deepEqual(rank('ch 6', radios).map(x => x.e.path), [ 'Ch 6 · 20 MHz' ]);
	assert.deepEqual(rank('channel 36', radios).map(x => x.e.path), [ 'Ch 36 · 80 MHz' ]);
	assert.deepEqual(rank('5 GHz', radios).map(x => x.e.path), [ 'Ch 36 · 80 MHz' ]);
	assert.deepEqual(rank('radio0', radios).map(x => x.e.path), [ 'Ch 6 · 20 MHz' ]);
	assert.equal(rank('6', radios).length, 2, 'both are Wi-Fi 6 by name: the names decide, as for pages');
	/* a page beside them is ranked as ever: its path, not a `find` */
	assert.deepEqual(rank('net', pool.concat({ title: 'Wireless', path: 'Network', segs: [ 'admin', 'network', 'wireless' ] })).map(x => x.e.title), [ 'Wireless' ]);
});

test('palette with a query: each kind under its header, the part with the best match first, the pages on a tie', () => {
	require('./luci-stub');
	const sections = provided('paletteSections', 'rankPalette', 'fuzzy', 'pathScore');
	const rank = provided('rankPalette', 'fuzzy', 'pathScore');
	const check = provided('providedEntries', 'kindTitle');
	const run = () => {};
	const pages = [
		{ title: 'Wireless', path: 'Network', segs: [ 'admin', 'network', 'wireless' ] },
		{ title: 'Channel Analysis', path: 'Status', segs: [ 'admin', 'status', 'channel_analysis' ] },
		{ title: 'Interfaces', path: 'Network', segs: [ 'admin', 'network', 'network' ] }
	];
	const got = check([
		{ kind: 'client', title: 'ap-den', detail: '192.0.2.11 · lan', run },
		{ kind: 'client', title: 'living-tv', detail: '192.0.2.31 · Wireless-Guest', run },
		{ kind: 'ssid', title: 'Wireless-Guest', detail: '5 GHz · 1 client', run },
		{ kind: 'ssid', title: 'Wireless', detail: '5 GHz · 3 clients', run },
		{ kind: 'interface', title: 'lan', detail: '192.0.2.1 · static', run }
	]);
	const rows = q => sections(q, rank(q, pages), got, 'Pages and actions').map(x => (x.head ? '# ' + x.head + ' | ' : '') + x.r.e.title + ' | ' + x.path);
	/* the interface named so, before the page it only scatters over; the
	   pages then say what they are; clients on that network last */
	assert.deepEqual(rows('lan'), [
		'# Interfaces | lan | 192.0.2.1 · static',
		'# Pages and actions | Channel Analysis | Status',
		'# Clients | ap-den | 192.0.2.11 · lan'
	]);
	/* a page and a network of one name: the page leads, without a header, as it does alone */
	assert.deepEqual(rows('wireless'), [
		'Wireless | Network',
		'# Wireless networks | Wireless | 5 GHz · 3 clients',
		'Wireless-Guest | 5 GHz · 1 client',
		'# Clients | living-tv | 192.0.2.31 · Wireless-Guest'
	]);
	/* nothing from a provider: as before */
	assert.deepEqual(sections('wire', rank('wire', pages), [], 'Pages and actions').map(x => [ x.head, x.r.e.title, x.path ]), [ [ null, 'Wireless', 'Network' ] ]);
	/* no page: the kinds alone */
	assert.deepEqual(rows('192.0.2.31'), [ '# Clients | living-tv | 192.0.2.31 · Wireless-Guest' ]);
	assert.deepEqual(rows('zzz'), []);
});

test('palette layout without a query: a provider\'s kind always has its header, and its second text stays whole', () => {
	require('./luci-stub');
	const layout = fn('paletteLayout');
	const check = provided('providedEntries', 'kindTitle');
	const run = () => {};
	const r = e => ({ e, idx: [] });
	const rows = layout([
		r({ title: 'Dashboard', path: '', group: 'Dashboard' }),
		r({ title: 'Log out', path: 'Session', group: 'Actions' })
	].concat(check([
		{ kind: 'client', title: 'den-phone', detail: 'Clients › 192.0.2.22', run },
		{ kind: 'client', title: 'living-tv', detail: 'Clients', run },
		{ kind: 'radio', title: '5 GHz · Wi-Fi 6', detail: 'Ch 36 · 80 MHz', run }
	]).map(r)));
	assert.deepEqual(rows.map(x => [ x.head, x.r.e.title, x.path ]), [
		[ null, 'Dashboard', '' ],
		[ null, 'Log out', 'Session' ],
		[ 'Clients', 'den-phone', 'Clients › 192.0.2.22' ],
		[ null, 'living-tv', 'Clients' ],
		[ 'Radios', '5 GHz · Wi-Fi 6', 'Ch 36 · 80 MHz' ]       /* one row, and still headed */
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
	assert.deepEqual(Object.keys(LOOK), [ 'theme', 'login', 'backdrop', 'power', 'unfocused', 'brand', 'units' ]);
	assert.ok(header.includes("look('brand', [ 'none', 'hostname', 'model' ])"), 'the template keeps the same brand values');
	assert.ok(header.includes("look('units', [ 'bits', 'bytes' ])"), 'the template keeps the same units values');
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
	/* Motion when not in focus (#131): the dashboard's attribute, the refresh dot and the login page follow the pick */
	assert.ok(header.includes("look('unfocused', 'vantage.unfocused.own', 'vantage.unfocused', [ 'still', 'moving' ])"));
	assert.ok(header.includes("look('unfocused', [ 'still', 'moving' ])"), 'the template keeps the same values');
	assert.ok(login.includes("look('unfocused', [ 'still', 'moving' ])") && login.includes('data-vt-look-unfocused="{{ look_unfocused }}"'));
	assert.ok(loginJs.includes("localStorage.getItem('vantage.unfocused.own'); u[2] = localStorage.getItem('vantage.unfocused')"));
	assert.match(loginJs, /if \(unfocused !== 'moving'\) \{\n\t\twindow\.addEventListener\('blur'/, 'the login page pauses on blur unless picked');
	assert.ok(src.includes("root.toggleAttribute('data-vt-blur', !document.hasFocus() && root.getAttribute('data-vt-unfocused') !== 'moving')"));
	assert.ok(src.includes("window.addEventListener(UNFOCUSED_EVENT, focus);"), 'the dot follows a pick made while the page is open');
	assert.equal(src.split('this.applyUnfocused();').length, 3, 'applied when the page opens and when another tab picks');
	assert.ok(src.includes("else if (name === 'unfocused') root.setAttribute('data-vt-look-unfocused', value);"), 'a saved pick becomes the page\'s');
	assert.equal(src.split("'vt-unfocused': 'unfocused'").length, 2, 'a failed save can be tried again');
	assert.equal(src.split("'vt-units': 'units'").length, 2, 'Speed units too');
	/* Speed units: handed over like the others, and the dashboard hears a pick */
	assert.ok(header.includes("look('units', 'vantage.units.own', 'vantage.units', [ 'bits', 'bytes' ])"), 'this browser\'s pick, before the first paint');
	assert.ok(!/units/.test(login) && !/units/.test(loginJs), 'the login page has no use for it');
	assert.equal(src.split('this.applyUnits();').length, 3, 'applied when the page opens and when another tab picks');
	assert.ok(src.includes("else if (name === 'units') root.setAttribute('data-vt-look-units', value);"), 'a saved pick becomes the page\'s');
	assert.ok(src.includes("'vt-units': this.unitsPref()"), 'the panel shows the pick in force');
	assert.ok(src.includes("this.root.setAttribute('data-vt-units', v);\n\t\t\twindow.dispatchEvent(new CustomEvent(UNITS_EVENT));"), 'and tells the dashboard');
	assert.ok(src.includes("const UNITS_EVENT = 'vantage:units';"));
	assert.ok(src.indexOf('this.backdropGroup(),') < src.indexOf("this.appearGroup('vt-units'") && src.indexOf("this.appearGroup('vt-units'") < src.indexOf("this.appearGroup('vt-power'"),
		'Speed units sits between the network path\'s background and Low-power router');
	assert.ok(src.includes("'vt-unfocused': this.unfocusedPref()"), 'the panel shows the pick in force');
	for (const [ name, k ] of Object.entries(LOOK)) {
		assert.match(k.own, /^vantage\.[a-z]+\.own$/, name);
		assert.ok(header.includes(`data-vt-look-${name}="{{ look_${name} }}"`), `header hands over ${name}`);
	}
	assert.deepEqual(LOOK.theme.ok, [ 'auto', 'light', 'dark' ]);
	assert.deepEqual(LOOK.login.ok, [ 'grid', 'stars', 'none' ]);
	assert.deepEqual(LOOK.backdrop.ok, [ 'grid', 'stars', 'none' ]);
	assert.deepEqual(LOOK.power.ok, [ 'normal', 'low' ], 'Low-power router is off unless picked');
	assert.deepEqual(LOOK.unfocused.ok, [ 'still', 'moving' ], 'nothing moves without the focus unless picked');
	assert.deepEqual(LOOK.brand.ok, [ 'none', 'hostname', 'model' ], 'nothing next to the logo unless picked');
	assert.deepEqual(LOOK.units.ok, [ 'bits', 'bytes' ], 'traffic reads in bits unless picked');
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
	/* every tile of every default layout, shown and hidden, fits the form and comes back:
	   without and with the WireGuard tile, without and with the Ports tile */
	for (const tier of [ 'wide', 'mid', 'narrow' ]) for (const wired of [ false, true ]) {
		for (const hide of [ false, true ]) for (const wg of [ false, true ]) for (const ports of [ false, true ]) {
			const list = layout.compact(layout.defaults(tier, wired, wg, ports).map(e => Object.assign({}, e, { hide })));
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
	/* a layout holds twelve entries: the nine tiles there are, and room for three more before the form must grow again */
	const all = layout.defaults('wide', false, true, true);
	assert.equal(all.length, layout.TILES.length);
	assert.ok(layout.TILES.length <= 12, 'a tile more than the form takes: widen VIEW_LAYOUT and the template\'s form together');
	const entries = n => Array.from({ length: n }, (x, i) => i < all.length ? layout.encode([ all[i] ]) : 'hero:0:1:h').join(' ');
	for (let n = 1; n <= 12; n++) assert.match(entries(n), re, n + ' entries');
	assert.doesNotMatch(entries(13), re, 'a thirteenth entry is no layout');
	assert.doesNotMatch(entries(12) + ' ', re);
	assert.ok(form.endsWith('){0,11})$/'), 'one entry and up to eleven more');
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
	/* one request, to the constant URL, from the click handler or, where it is on, the daily check
	   (below); nothing else leaves for the internet */
	assert.equal(src.split('fetch(UPDATE_INDEX,').length - 1, 1);
	assert.match(src, /const UPDATE_INDEX = 'https:\/\/anothadev\.github\.io\/luci-theme-vantage\/24\.10\/Packages';/);
	assert.match(src, /fetch\(UPDATE_INDEX, \{ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'/);
	assert.match(src, /btn\.addEventListener\('click', \(\) => this\.checkUpdates\(btn, out\)\)/);
	assert.equal(src.split('checkUpdates(').length - 1, 2, 'defined once, called from the click only');
	assert.deepEqual([ ...src.matchAll(/fetch\(([^,)]+)/g) ].map(m => m[1]).filter(a => !/^L\.resource\(/.test(a)), [ 'UPDATE_INDEX' ]);
	/* the link is a constant: nothing from the list reaches an attribute */
	assert.match(src, /'href': 'https:\/\/github\.com\/anothaDev\/luci-theme-vantage\/releases\/latest',/);
});

/* The daily check (#133): menu-vantage.js whole, as LuCI evaluates it, on a
   browser just big enough for it. `store` is this browser's localStorage and
   outlives a page; page() is one page load, up to its idle time. */
function updateBrowser(store) {
	require('./luci-stub');      /* String.prototype.format */
	const DAY = 24 * 3600 * 1000;
	const b = { store: store || {}, now: 1700000000000, asked: [], saved: [], list: null, size: null, read: 0, full: false, visible: true, auth: true, idle: true, DAY };
	const text = t => ({ nodeType: 3, data: String(t) });
	const E = (tag, attrs, kids) => {
		const el = {
			tagName: tag.toUpperCase(), attrs: {}, children: [], listeners: {}, hidden: false, checked: false,
			setAttribute(k, v) { if (k === 'hidden') this.hidden = true; else this.attrs[k] = String(v); },
			getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
			hasAttribute(k) { return k in this.attrs; },
			removeAttribute(k) { delete this.attrs[k]; },
			toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; },
			appendChild(c) { this.children.push(c); return c; },
			addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
			fire(t) { (this.listeners[t] || []).forEach(f => f({ type: t, target: this })); },
			all() { return this.children.filter(c => c.tagName).reduce((a, c) => a.concat(c, c.all()), []); },
			get textContent() { return this.children.map(c => c.nodeType === 3 ? c.data : c.textContent).join(''); },
			set textContent(v) { this.children = v ? [ text(v) ] : []; }
		};
		for (const [ k, v ] of Object.entries(attrs || {})) el.setAttribute(k, v);
		for (const c of [].concat(kids == null ? [] : kids)) if (c !== '') el.appendChild(typeof c === 'object' ? c : text(c));
		return el;
	};
	const localStorage = {
		getItem: k => (Object.prototype.hasOwnProperty.call(b.store, k) ? b.store[k] : null),
		/* b.full: a browser whose storage takes no more */
		setItem: (k, v) => { if (b.full) throw new Error('QuotaExceededError'); b.store[k] = String(v); },
		removeItem: k => { delete b.store[k]; }
	};
	/* the list: a string answers 200 with it, a number is that HTTP status, null no answer at all;
	   b.size: the length its host says it has (Content-Length), b.read: how often its text was taken */
	const fetch = (url, opts) => {
		b.asked.push({ url, opts });
		if (b.list == null) return Promise.reject(new TypeError('Failed to fetch'));
		const headers = { get: k => (String(k).toLowerCase() === 'content-length' && b.size != null ? String(b.size) : null) };
		return Promise.resolve(typeof b.list === 'number' ? { ok: false, status: b.list, headers } : { ok: true, status: 200, headers, text: () => { b.read++; return Promise.resolve(b.list); } });
	};
	const rpc = { declare: spec => (...args) => { b.saved.push([ spec.object, spec.method ].concat(args)); return Promise.resolve({}); } };
	b.settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
	b.page = async save => {
		const idle = [], timers = [];
		const gear = E('button', { 'id': 'vt-look', 'aria-label': 'Appearance', 'title': 'Appearance' });
		const heard = {};
		const document = {
			visibilityState: b.visible ? 'visible' : 'hidden',
			body: { classList: { contains: c => c === (b.auth ? 'vt-auth' : 'vt-login-page') } },
			getElementById: id => (id === 'vt-look' ? gear : null),
			createTextNode: text,
			addEventListener: (t, f) => { (heard[t] = heard[t] || []).push(f); }
		};
		const window = b.idle ? { requestIdleCallback: f => { idle.push(f); } } : {};
		const proto = new Function('baseclass', 'ui', 'rpc', 'host', 'E', 'L', '_', 'document', 'window', 'localStorage', 'fetch', 'Date', 'setTimeout', 'clearTimeout', src)(
			{ extend: x => x }, {}, rpc, {}, E, {}, t => t, document, window, localStorage, fetch, { now: () => b.now }, (f, ms) => { timers.push({ f, ms }); return timers.length; }, () => {});
		const root = E('html', { 'data-vt-look-save': save || 'no' });
		const shell = Object.assign(Object.create(proto), { root });
		/* what __init__ does for it (setupTheme's last line, then setupUpdate) */
		shell.applyUpdate();
		shell.setupUpdate();
		const page = { shell, gear, timers, line: null, waiting: idle.length + timers.length };
		/* the tab comes into view, or goes out of it */
		page.show = async on => { document.visibilityState = on ? 'visible' : 'hidden'; (heard.visibilitychange || []).forEach(f => f()); await b.settle(); };
		/* the browser reaches its idle time */
		idle.splice(0).forEach(f => f());
		await b.settle();
		/* Appearance's last line and the daily check's group, as appearanceEl builds them */
		page.open = () => { const ver = shell.versionEl(), set = shell.updateGroup(); page.line = ver.children[3]; page.check = ver.children[2]; page.set = set; return page; };
		page.dot = () => gear.hasAttribute('data-vt-update');
		page.pick = v => { const r = page.set.all().find(e => e.tagName === 'INPUT' && e.attrs.value === v); r.checked = true; r.fire('change'); };
		return page;
	};
	b.packages = v => [ 'Package: luci-app-vantage', 'Version: 9.9.9-r1', '', 'Package: luci-theme-vantage', 'Version: ' + v, 'Depends: luci-base', '' ].join('\n');
	b.last = () => (b.store['vantage.update.last'] ? JSON.parse(b.store['vantage.update.last']) : null);
	return b;
}
/* versions around the one the theme has, whatever a release makes it */
const RUNNING = /^const VERSION = '([^']+)';/m.exec(src)[1];
const [ MAJOR, MINOR ] = RUNNING.split('.').map(Number);
const NEWER = [ MAJOR, MINOR + 1, 0 ].join('.'), OLDER = [ MAJOR - 1, 9999, 9999 ].join('.');

test('daily update check: off unless picked, and silent: nothing asked, nothing kept, no dot', async () => {
	const b = updateBrowser();
	b.list = b.packages(NEWER + '-r1');
	const p = await b.page();
	assert.equal(p.waiting, 0, 'nothing waits for the idle time');
	assert.equal(b.asked.length, 0);
	assert.deepEqual(b.store, {}, 'nothing written');
	assert.ok(!p.dot());
	assert.equal(p.gear.getAttribute('aria-label'), 'Appearance');
	assert.equal(p.shell.updatePref(), 'off');
	/* only the word 'on' switches it on */
	for (const odd of [ 'On', '1', 'true', 'yes', ' on', '' ]) {
		const o = updateBrowser({ 'vantage.update.auto': odd });
		o.list = o.packages(NEWER);
		await o.page();
		assert.equal(o.asked.length, 0, JSON.stringify(odd));
	}
	/* a result left behind by an earlier pick tells nothing while it is off */
	const left = updateBrowser({ 'vantage.update.last': JSON.stringify({ at: 1700000000000, latest: NEWER }) });
	assert.ok(!(await left.page()).dot());
	assert.equal(left.asked.length, 0);
	/* the manual check still works as before, and keeps nothing */
	p.open();
	p.check.fire('click');
	await b.settle();
	assert.equal(b.asked.length, 1, 'asked on the click');
	assert.equal(p.line.textContent, 'Version ' + NEWER + ' is available. What\'s new');
	assert.deepEqual(b.store, {}, 'off: the answer is not kept');
	assert.ok(!p.dot(), 'off: no dot');
});

test('daily update check: on, one request in 24 hours, whatever pages load', async () => {
	const b = updateBrowser({ 'vantage.update.auto': 'on' });
	b.list = b.packages(RUNNING + '-r1');
	const t0 = b.now;
	await b.page();
	assert.equal(b.asked.length, 1, 'the first page asks');
	/* the manual check's request, to the letter: no cookies, no referrer, one URL */
	assert.equal(b.asked[0].url, 'https://anothadev.github.io/luci-theme-vantage/24.10/Packages');
	assert.deepEqual(b.asked[0].opts, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: undefined });
	assert.deepEqual(b.last(), { at: t0, latest: RUNNING }, 'the time and what the list had');
	for (const later of [ 0, 1000, 3600 * 1000, b.DAY - 1 ]) {
		b.now = t0 + later;
		await b.page();
		assert.equal(b.asked.length, 1, 'no second request after ' + later + ' ms');
	}
	b.now = t0 + b.DAY;
	await b.page();
	assert.equal(b.asked.length, 2, 'a day later: the next one');
	assert.equal(b.last().at, t0 + b.DAY);
	/* two pages at once: the try is written down before the answer comes */
	const two = updateBrowser({ 'vantage.update.auto': 'on' });
	two.list = two.packages(NEWER);
	await Promise.all([ two.page(), two.page() ]);
	assert.equal(two.asked.length, 1, 'the second page finds the first one\'s try');
	/* a clock set back: a try dated ahead of it does not hold the check off for ever */
	b.now = t0 - 5 * b.DAY;
	await b.page();
	assert.equal(b.asked.length, 3);
	/* a browser without requestIdleCallback waits two seconds instead, and asks the same */
	const old = updateBrowser({ 'vantage.update.auto': 'on' });
	old.list = old.packages(NEWER);
	old.idle = false;
	const p = await old.page();
	assert.equal(old.asked.length, 0, 'not while the page loads');
	assert.deepEqual(p.timers.map(t => t.ms), [ 2000 ]);
	p.timers[0].f();
	await old.settle();
	assert.equal(old.asked.length, 1);
	/* the page-load call sites: applied with the theme, checked from __init__ only */
	assert.match(src, /\t\tthis\.loadHost\(\);\n\t\tthis\.setupUpdate\(\);\n/);
	assert.equal(src.split('this.setupUpdate()').length - 1, 1);
	assert.equal(src.split('this.dailyCheck()').length - 1, 3, 'from the idle callback or its timer, and when the tab comes into view');
	assert.equal(src.split('askLatest(').length - 1, 3, 'defined once; the manual check and the daily one ask through it');
	assert.match(src, /const UPDATE_EVERY = 24 \* 3600 \* 1000;/);
});

test('daily update check: nothing asked from a hidden tab or the login page', async () => {
	const hidden = updateBrowser({ 'vantage.update.auto': 'on' });
	hidden.list = hidden.packages(NEWER);
	hidden.visible = false;
	await hidden.page();
	assert.equal(hidden.asked.length, 0, 'hidden tab');
	assert.equal(hidden.last(), null, 'and no try counted: the next page in view asks');
	hidden.visible = true;
	await hidden.page();
	assert.equal(hidden.asked.length, 1);

	const anon = updateBrowser({ 'vantage.update.auto': 'on' });
	anon.list = anon.packages(NEWER);
	anon.auth = false;
	await anon.page();
	assert.equal(anon.asked.length, 0, 'a page without a login');
	/* the login page itself: its template and script load no menu script and read nothing of the check */
	const T = path.join(__dirname, '..', 'luci-theme-vantage');
	const login = fs.readFileSync(path.join(T, 'ucode/template/themes/vantage/sysauth.ut'), 'utf8');
	const loginJs = fs.readFileSync(path.join(T, 'htdocs/luci-static/vantage/login.js'), 'utf8');
	const footer = fs.readFileSync(path.join(T, 'ucode/template/themes/vantage/footer.ut'), 'utf8');
	for (const [ name, body ] of [ [ 'sysauth.ut', login ], [ 'login.js', loginJs ] ])
		assert.doesNotMatch(body, /vantage\.update|vt-update|L\.require|fetch\(|XMLHttpRequest/, name);
	assert.ok(!login.includes('menu-vantage'), 'the login page loads no menu script');
	assert.deepEqual([ ...(login + loginJs).matchAll(/localStorage\.getItem\('([^']+)'\)/g) ].map(m => m[1]).sort(),
		[ 'vantage.login', 'vantage.login.own', 'vantage.power', 'vantage.power.own', 'vantage.theme', 'vantage.theme.own', 'vantage.unfocused', 'vantage.unfocused.own' ],
		'what the login page reads from this browser');
	assert.match(footer, /\{% if \(ctx\.authsession && !blank_page\): %\}\n<script>L\.require\('menu-vantage'\);<\/script>/, 'the menu script loads for a session only');
});

test('daily update check: a newer version is told, an equal, older or unreadable one is not', async () => {
	const told = async (listed, running) => {
		const b = updateBrowser({ 'vantage.update.auto': 'on' });
		b.list = b.packages(listed);
		await b.page();
		assert.equal(b.asked.length, 1, listed);
		/* the page after it: what was kept tells, not the request */
		const p = await b.page();
		assert.equal(b.asked.length, 1, listed);
		return { dot: p.dot(), last: b.last() };
	};
	assert.deepEqual(await told(NEWER + '-r1'), { dot: true, last: { at: 1700000000000, latest: NEWER } }, 'newer; the package release is left out');
	assert.equal((await told([ MAJOR, MINOR + 1 ].join('.'))).dot, true, 'two parts');
	assert.equal((await told([ MAJOR + 1, 0, 0 ].join('.'))).dot, true);
	assert.equal((await told(RUNNING)).dot, false, 'this version');
	assert.equal((await told(RUNNING + '-r7')).dot, false, 'this version, another package release');
	assert.equal((await told(OLDER)).dot, false, 'older');
	for (const odd of [ NEWER + '-rc1', 'v' + NEWER, NEWER + '<img src=x>', '99999.0.0', '9', 'latest', '' ])
		assert.deepEqual(await told(odd), { dot: false, last: { at: 1700000000000, latest: null } }, 'unreadable, kept as a try: ' + JSON.stringify(odd));

	/* numbers, not text: 1.0.9 < 1.0.10 < 1.1 */
	const { newerKnown, updateMemory } = new Function([ 'versionParts', 'newerVersion', 'updateMemory', 'newerKnown' ].map(n => {
		const at = src.indexOf('function ' + n + '(');
		return src.slice(at, src.indexOf('\n}\n', at) + 3);
	}).join('\n') + '\nreturn { newerKnown, updateMemory };')();
	/* as the browser keeps it and the theme reads it back */
	const kept = latest => updateMemory(JSON.stringify({ at: 1, latest }));
	const newer = (latest, running) => newerKnown(kept(latest), running) === latest;
	assert.ok(newer('1.0.10', '1.0.9') && !newer('1.0.9', '1.0.10'));
	assert.ok(newer('1.1', '1.0.10') && !newer('1.0.10', '1.1'));
	assert.ok(newer('1.1.0', '1.0.21') && newer('1.10.0', '1.9.9') && newer('2.0', '1.99.99') && newer('1.0.21.1', '1.0.21'));
	assert.ok(!newer('1.1', '1.1.0') && !newer('1.1.0', '1.1'), 'the same version, written shorter');
	assert.ok(!newer('1.0.22', '1.0.22-r3') && newer('1.0.22-r1', '1.0.21-r9'), 'a package release does not count');
	for (const odd of [ null, undefined, '', 'x', '1', '1.2.3.4.5', '1.0.22 ', '1.0.x', [ '9.9.9' ], 9.9, {} ])
		assert.equal(newerKnown(kept(odd), '1.0.21'), null, 'unreadable: ' + JSON.stringify(odd));
	for (const odd of [ null, undefined, '', 'x', '1', '1.2.3.4.5', '1.0.22 ', '1.0.x' ])
		assert.equal(newerKnown(kept('9.9.9'), odd), null, 'this version unreadable: ' + JSON.stringify(odd));
	assert.equal(newerKnown(null, '1.0.21'), null, 'nothing kept');

	/* what the browser kept is read as carefully as the list: anything else is no notice */
	for (const kept of [ 'x', '{', 'null', '[]', '"9.9.9"', '9', JSON.stringify({ latest: '9.9.9' }), JSON.stringify({ at: 'now', latest: '9.9.9' }), JSON.stringify({ at: 1700000000000, latest: '9.9.9<b>' }),
		JSON.stringify({ at: 1700000000000, latest: [ '9.9.9' ] }), JSON.stringify({ at: 1700000000000, latest: { toString: 1 } }), JSON.stringify({ at: 1700000000000 }) ]) {
		const b = updateBrowser({ 'vantage.update.auto': 'on', 'vantage.update.last': kept });
		b.visible = false;       /* just what was kept: no request to replace it */
		const p = await b.page();
		assert.ok(!p.dot(), kept);
		assert.equal(p.gear.getAttribute('aria-label'), 'Appearance', kept);
	}
});

test('daily update check: a check that fails is that day\'s try, says nothing and keeps what was known', async () => {
	for (const failure of [ null, 404, 500, '<html>not a list</html>', 'Package: luci-theme-vantage-extra\nVersion: 9.9.9\n' ]) {
		const b = updateBrowser({ 'vantage.update.auto': 'on' });
		const t0 = b.now;
		b.list = failure;
		const p = await b.page();
		p.open();
		assert.equal(b.asked.length, 1, String(failure));
		assert.deepEqual(b.last(), { at: t0, latest: null }, 'kept as a try');
		assert.ok(!p.dot() && p.line.hidden && p.line.textContent === '', 'nothing shown');
		assert.equal(p.gear.getAttribute('aria-label'), 'Appearance');
		/* no second try that day, however often a page loads */
		b.now = t0 + b.DAY - 1;
		for (let i = 0; i < 5; i++) await b.page();
		assert.equal(b.asked.length, 1, 'no retry');
		b.now = t0 + b.DAY;
		await b.page();
		assert.equal(b.asked.length, 2, 'the next day\'s');
	}
	/* a version known from an earlier day stays known through a failed one */
	const b = updateBrowser({ 'vantage.update.auto': 'on' });
	const t0 = b.now;
	b.list = b.packages(NEWER);
	await b.page();
	b.list = null;
	b.now = t0 + b.DAY;
	const p = await b.page();
	assert.equal(b.asked.length, 2);
	assert.deepEqual(b.last(), { at: t0 + b.DAY, latest: NEWER });
	assert.ok(p.dot());
	/* silent: the daily check's own failure reaches no console and no page text */
	assert.match(src, /this\.askLatest\(true\)\.catch\(\(\) => \{\}\);/);
});

test('daily update check: a list larger than a list is, is not read; where the try cannot be kept, nothing is asked', async () => {
	const LIMIT = +/const UPDATE_MAX = (\d+);/.exec(src)[1];
	assert.equal(LIMIT, 262144);
	/* its host says it is larger: not read, and that day's try all the same */
	const big = updateBrowser({ 'vantage.update.auto': 'on' });
	big.list = big.packages(NEWER); big.size = LIMIT + 1;
	let p = await big.page();
	assert.deepEqual([ big.asked.length, big.read, p.dot() ], [ 1, 0, false ]);
	assert.deepEqual(big.last(), { at: big.now, latest: null });
	/* at the limit it is read */
	const fits = updateBrowser({ 'vantage.update.auto': 'on' });
	fits.list = fits.packages(NEWER); fits.size = LIMIT;
	p = await fits.page();
	assert.deepEqual([ fits.read, p.dot() ], [ 1, true ]);
	/* no length given: read, and no more of it looked at than a list has */
	const long = updateBrowser({ 'vantage.update.auto': 'on' });
	long.list = 'x'.repeat(LIMIT) + '\n\n' + long.packages(NEWER);
	p = await long.page();
	assert.deepEqual([ long.read, p.dot() ], [ 1, false ], 'the entry lies past what is looked at');
	/* storage that takes no more: every page would find no try kept and ask again, so the daily check asks nothing */
	const full = updateBrowser({ 'vantage.update.auto': 'on' });
	full.full = true; full.list = full.packages(NEWER);
	for (let i = 0; i < 3; i++) p = await full.page();
	assert.equal(full.asked.length, 0);
	/* the manual check is asked for each time it runs: it still does */
	p.open().check.fire('click');
	await full.settle();
	assert.equal(full.asked.length, 1);
	assert.match(p.line.textContent, new RegExp('^Version ' + NEWER.replace(/\./g, '\\.') + ' is available\\.'));
});

test('daily update check: the dot on the gear, its label, and the manual check\'s line under Appearance', async () => {
	const b = updateBrowser({ 'vantage.update.auto': 'on' });
	b.list = b.packages(NEWER + '-r1');
	const first = await b.page();
	/* the page that asked shows it as soon as the answer is in */
	assert.ok(first.dot(), 'a dot on the gear');
	const label = 'Appearance: Version ' + NEWER + ' is available.';
	assert.equal(first.gear.getAttribute('aria-label'), label, 'said in the gear\'s name');
	assert.equal(first.gear.getAttribute('title'), label);
	/* the next page knows it from the start, without asking */
	const p = (await b.page()).open();
	assert.equal(b.asked.length, 1);
	assert.ok(p.dot());
	assert.equal(p.line.hidden, false);
	assert.equal(p.line.textContent, 'Version ' + NEWER + ' is available. What\'s new', 'the manual check\'s own line');
	const link = p.line.children.find(c => c.tagName === 'A');
	assert.deepEqual(link.attrs, { href: 'https://github.com/anothaDev/luci-theme-vantage/releases/latest', target: '_blank', rel: 'noopener noreferrer' }, 'the constant link');
	assert.equal(p.line.getAttribute('role'), 'status');
	/* the dot is drawn from the attribute, at the gear's corner: still, in the notice colour, and no mark of any kind */
	const css = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-vantage/htdocs/luci-static/vantage/vantage.css'), 'utf8');
	const dot = /\n#vt-look\[data-vt-update\]::after \{([^}]*)\}/.exec(css);
	assert.ok(dot, 'the dot\'s rule');
	assert.match(dot[1], /content:\s*"";/);
	assert.match(dot[1], /width:\s*7px;\s*height:\s*7px;\s*border-radius:\s*50%/, 'the indicators\' size');
	assert.match(dot[1], /background:\s*var\(--info\)/);
	assert.doesNotMatch(dot[1], /animation|transition/);
	/* the gear's own drawing is the template's, untouched: the script changes attributes only */
	const apply = src.slice(src.indexOf('\tapplyUpdate() {'), src.indexOf('\tsetupUpdate() {'));
	assert.doesNotMatch(apply, /btn\.(textContent|appendChild|innerHTML|replaceChildren)/);
	/* a manual check with the daily one on is that day's try, and its answer is kept */
	const m = updateBrowser({ 'vantage.update.auto': 'on', 'vantage.update.last': JSON.stringify({ at: 1700000000000, latest: RUNNING }) });
	m.list = m.packages(NEWER);
	m.now += 3600 * 1000;
	const mp = (await m.page()).open();
	assert.equal(m.asked.length, 0, 'not due');
	assert.ok(!mp.dot() && mp.line.hidden);
	mp.check.fire('click');
	assert.equal(mp.line.textContent, 'Checking…');
	await m.settle();
	assert.equal(m.asked.length, 1);
	assert.deepEqual(m.last(), { at: 1700000000000 + 3600 * 1000, latest: NEWER });
	assert.ok(mp.dot(), 'the dot comes with the answer');
	assert.equal(mp.line.textContent, 'Version ' + NEWER + ' is available. What\'s new');
	m.now += m.DAY - 1;
	await m.page();
	assert.equal(m.asked.length, 1, 'the daily check waits a day from it');
	/* this version catches up: the notice is over, with nothing asked */
	const up = updateBrowser({ 'vantage.update.auto': 'on', 'vantage.update.last': JSON.stringify({ at: 1700000000000, latest: RUNNING }) });
	const done = (await up.page()).open();
	assert.ok(!done.dot() && done.line.hidden);
	assert.equal(done.gear.getAttribute('aria-label'), 'Appearance');
	const past = updateBrowser({ 'vantage.update.auto': 'on', 'vantage.update.last': JSON.stringify({ at: 1700000000000, latest: OLDER }) });
	assert.ok(!(await past.page()).dot(), 'a version behind this one');
});

test('daily update check: switched off, the notice and what was kept go; switched on, it asks with the next page', async () => {
	const b = updateBrowser({ 'vantage.update.auto': 'on' });
	b.list = b.packages(NEWER);
	await b.page();
	const p = (await b.page()).open();
	assert.ok(p.dot() && !p.line.hidden);
	p.pick('off');
	assert.ok(!p.dot(), 'the dot goes');
	assert.equal(p.gear.getAttribute('aria-label'), 'Appearance');
	assert.equal(p.gear.getAttribute('title'), 'Appearance');
	assert.ok(p.line.hidden && p.line.textContent === '', 'the line goes');
	assert.deepEqual(b.store, {}, 'nothing of it is left in the browser');
	b.now += 30 * b.DAY;
	assert.ok(!(await b.page()).dot());
	assert.equal(b.asked.length, 1, 'off: nothing more is asked');
	/* on again: no request from the click; the next page asks */
	const q = (await b.page()).open();
	q.pick('on');
	await b.settle();
	assert.deepEqual(b.store, { 'vantage.update.auto': 'on' });
	assert.equal(b.asked.length, 1, 'the pick itself asks nothing');
	await b.page();
	assert.equal(b.asked.length, 2);
	/* another tab switches it off, or learns of a version: this page follows (the storage event) */
	const tab = await b.page();
	assert.ok(tab.dot());
	delete b.store['vantage.update.auto'];
	tab.shell.applyUpdate();
	assert.ok(!tab.dot());
	assert.match(src, /if \(ev\.key === UPDATE_AUTO_KEY \|\| ev\.key === UPDATE_LAST_KEY\) this\.applyUpdate\(\);/);
	/* a manual result is not the daily check's to take away */
	const manual = updateBrowser();
	manual.list = manual.packages(NEWER);
	const mp = (await manual.page()).open();
	mp.check.fire('click');
	await manual.settle();
	mp.pick('on');
	mp.pick('off');
	assert.equal(mp.line.textContent, 'Version ' + NEWER + ' is available. What\'s new');
	assert.equal(mp.line.hidden, false);
});

test('daily update check: this browser\'s alone: never saved for every browser, unknown to the templates and the login page', async () => {
	/* a login that may save Appearance for every browser */
	const b = updateBrowser();
	const p = (await b.page('yes')).open();
	p.pick('on');
	p.pick('off');
	p.pick('on');
	await b.settle();
	assert.deepEqual(b.saved, [], 'no uci call for it');
	assert.deepEqual(b.store, { 'vantage.update.auto': 'on' }, 'kept in this browser');
	/* the same page does save a real Appearance pick, so the harness would have seen one */
	p.shell.setLook('power', 'low', () => {});
	await b.settle();
	assert.deepEqual(b.saved.map(c => c.slice(0, 3)), [ [ 'uci', 'revert', 'vantage_theme' ], [ 'uci', 'set', 'vantage_theme' ], [ 'uci', 'commit', 'vantage_theme' ] ]);
	assert.deepEqual(b.saved[1][4], { power: 'low' }, 'and only that pick');
	/* it is not one of the looks: setLook, the router's attributes and the other-tab sync never see it */
	const table = /\nconst LOOK = (\{[\s\S]*?\n\});\n/.exec(src);
	const LOOK = new Function('THEME_KEY', 'LOGIN_KEY', 'BACKDROP_KEY', 'return ' + table[1])('vantage.theme', 'vantage.login', 'vantage.backdrop.v1');
	assert.deepEqual(Object.keys(LOOK), [ 'theme', 'login', 'backdrop', 'power', 'unfocused', 'brand', 'units' ]);
	assert.doesNotMatch(JSON.stringify(LOOK), /update/);
	const setPref = src.slice(src.indexOf('\tsetUpdatePref(pref) {'), src.indexOf('\tupdateGroup() {'));
	assert.doesNotMatch(setPref, /setLook|lookWrite|callLook|LOOK_SYNC/);
	assert.doesNotMatch(src, /setLook\('update'|data-vt-look-update|look_update/);
	assert.deepEqual([ ...src.matchAll(/storage(?:Get|Set)\((UPDATE_\w+)/g) ].map(m => m[1]).filter((k, i, a) => a.indexOf(k) === i).sort(), [ 'UPDATE_AUTO_KEY', 'UPDATE_LAST_KEY' ]);
	assert.match(src, /const UPDATE_AUTO_KEY = 'vantage\.update\.auto';\nconst UPDATE_LAST_KEY = 'vantage\.update\.last';/);
	/* the panel shows the pick, and tells its cost where it is picked */
	assert.ok(src.includes("'vt-update': this.updatePref()"), 'the panel shows the pick in force');
	assert.equal(p.set.children[0].textContent, 'Daily update check');
	const help = p.set.all().find(e => e.tagName === 'P');
	assert.match(help.textContent, /^Once a day this browser reads the project's package list on GitHub Pages, which shows GitHub this computer's IP address and the address this page was opened at\. For this browser only\.$/);
	assert.equal(p.set.getAttribute('aria-describedby'), help.getAttribute('id'), 'the help belongs to the group');
	assert.deepEqual(p.set.all().filter(e => e.tagName === 'INPUT').map(e => [ e.attrs.type, e.attrs.name, e.attrs.value ]), [ [ 'radio', 'vt-update', 'off' ], [ 'radio', 'vt-update', 'on' ] ], 'off comes first');
	/* neither template hands it over, the shipped config has no such option, and the login page reads none of it */
	const T = path.join(__dirname, '..', 'luci-theme-vantage');
	for (const f of [ 'ucode/template/themes/vantage/header.ut', 'ucode/template/themes/vantage/sysauth.ut', 'ucode/template/themes/vantage/footer.ut', 'htdocs/luci-static/vantage/login.js', 'root/etc/config/vantage_theme',
		'root/usr/share/rpcd/acl.d/luci-theme-vantage.json', 'root/etc/uci-defaults/30_luci-theme-vantage' ])
		assert.doesNotMatch(fs.readFileSync(path.join(T, f), 'utf8'), /update/i, f);
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

/* #111: vantage.css keeps cells of numbers and addresses on one line by
   English words in their data-title, which is the column's title as shown;
   under a translated title the theme marks the same columns .vt-nowrap */
test('translated column titles: the columns the English rule keeps on one line take .vt-nowrap in any language (#111)', () => {
	const list = new Function('return ' + /\nconst NOWRAP_TITLES = (\[[\s\S]*?\]);\n/.exec(src)[1])();
	const body = [ 'nowrapTitles', 'titleKey' ].map(n => {
		const start = src.indexOf('function ' + n + '(');
		return src.slice(start, src.indexOf('\n}\n', start) + 3);
	}).join('\n');
	const { nowrapTitles, titleKey } = new Function('NOWRAP_TITLES', body + '\nreturn { nowrapTitles, titleKey };')(list);
	/* every title is one the English rule matches, so no language gets more than English does */
	const css = fs.readFileSync(path.join(__dirname, '..', 'luci-theme-vantage/htdocs/luci-static/vantage/vantage.css'), 'utf8');
	const rule = /\n(\.td\.vt-nowrap:not\(\.cbi-value-field\),\n[^{]*)\{([^}]*)\}/.exec(css);
	assert.ok(rule, 'one rule for .vt-nowrap and the English titles');
	const words = [ ...rule[1].matchAll(/\[data-title\*?="([^"]+)" ?i?\]/g) ].map(m => m[1].toLowerCase());
	assert.ok(words.length >= 10, 'found the English words');
	for (const t of list) assert.ok(words.some(w => t.toLowerCase().includes(w)), t + ' is matched in English');
	assert.match(rule[2], /white-space:\s*nowrap/);
	/* LuCI 25.12 and 24.10 column titles, the whole list: one dropped from it would wrap again in every language but English */
	assert.deepEqual(list, [ 'CPU usage (%)', 'DUID', 'Gateway', 'IP address', 'IPv4 address', 'IPv6 address', 'IPv6 addresses', 'Lease time remaining', 'MAC address',
		'Memory usage (%)', 'Metric', 'PID', 'Priority', 'Remaining time', 'Source', 'Start priority', 'Target' ]);
	/* English: nothing to add, the CSS has it */
	assert.equal(nowrapTitles(t => t).size, 0);
	/* Chinese, as LuCI's catalogue has it; uppercase, as the theme shows titles */
	const zh = { 'Remaining time': '剩余时间', 'IPv4 address': 'IPv4 地址', 'Gateway': '网关' };
	const keys = nowrapTitles(t => zh[t] || t);
	assert.deepEqual([ ...keys ].sort(), [ 'IPV4 地址', '剩余时间', '网关' ].sort());
	assert.ok(keys.has(titleKey('IPV4  地址 ')), 'data-title from innerText: uppercase, spaces collapsed');
	/* a script with case: the theme's uppercase title still matches */
	const ru = nowrapTitles(t => (t === 'Remaining time' ? 'Оставшееся время' : t));
	assert.ok(ru.has(titleKey('ОСТАВШЕЕСЯ ВРЕМЯ')) && ru.has(titleKey('Оставшееся время')));
	assert.ok(nowrapTitles(t => (t === 'Source' ? 'Straße' : t)).has(titleKey('STRASSE')), 'ß as CSS uppercases it');
	/* the browser uppercases a heading by the page's language, and innerText gives that: Turkish i, Greek accents */
	const tr = nowrapTitles(t => (t === 'IPv4 address' ? 'IPv4 adresi' : t), 'tr');
	assert.ok(tr.has(titleKey('IPV4 ADRESİ', 'tr')) && !tr.has('IPV4 ADRESI'), 'as Chromium shows it under lang="tr"');
	const el = nowrapTitles(t => (t === 'IPv4 address' ? 'Διεύθυνση IPv4' : t), 'el');
	assert.ok(el.has(titleKey('ΔΙΕΥΘΥΝΣΗ IPV4', 'el')), 'as Chromium shows it under lang="el"');
	/* LuCI's language codes (zh-cn, pt-br) are taken; one the browser refuses falls back to plain uppercase */
	assert.ok(nowrapTitles(t => zh[t] || t, 'zh-cn').has('IPV4 地址'));
	assert.equal(titleKey('Straße', 'not a language'), 'STRASSE');
	/* an empty or missing translation adds nothing */
	assert.equal(nowrapTitles(t => (t === 'PID' ? '' : t === 'DUID' ? null : t)).size, 0);
	/* the numerals scan marks them, once a cell, never a form field */
	const scan = src.slice(src.indexOf('\tsetupNumerals() {'), src.indexOf('\t/* --------------------------------------------------------- tooltips */'));
	assert.match(scan, /const lang = document\.documentElement\.lang, nowrap = nowrapTitles\(_, lang\);/);
	assert.match(scan, /cell\._vtNowrap = !cell\.classList\.contains\('cbi-value-field'\) && nowrap\.has\(titleKey\(cell\.getAttribute\('data-title'\), lang\)\);/);
	assert.match(scan, /if \(cell\._vtNowrap\) cell\.classList\.add\('vt-nowrap'\);/);
	/* LuCI's own catalogue translates them: no literal _('...') of these titles in the theme */
	for (const t of list) assert.ok(!src.includes("_('" + t + "')"), t + ' stays out of the theme catalogue');
});

/* The tab's title (1.1): while the dashboard says something needs
   attention, how many things do, in front of "Page · hostname" */
test('tab title: the count while the dashboard warns or errs, a plain mark without one, nothing otherwise', () => {
	const alertMark = fn('alertMark');
	assert.equal(alertMark('warn', '2'), '(2) ');
	assert.equal(alertMark('err', '1'), '(1) ');
	assert.equal(alertMark('warn', '12'), '(12) ');
	assert.equal(alertMark('err', 3), '(3) ', 'a number too');
	/* no count with the level (a dashboard from before 1.1), or not a count */
	for (const none of [ null, undefined, '', '0', '-1', '1.5', '007', '1000', ' 2', '2 ', '2\n', 'two', '<b>2</b>', '2) Log in', {}, NaN ])
		assert.equal(alertMark('warn', none), '(!) ', JSON.stringify(none));
	/* no level, no mark, whatever the count says */
	for (const level of [ null, undefined, '', 'ok', 'info', 'paused', 'WARN', 'warn ', 'error', true ])
		assert.equal(alertMark(level, '2'), '', JSON.stringify(level));
	/* signs and digits only, at any count: nothing of it is a word, an emoji or a check mark */
	for (let n = 1; n < 1000; n++) assert.match(alertMark('warn', String(n)), /^\(\d{1,3}\) $/);
});

/* menu-vantage.js whole, on a page that has a title, <html> and
   MutationObserver: set() is the dashboard writing an attribute */
function titlePage(attrs) {
	require('./luci-stub');      /* String.prototype.format */
	const p = { watched: [], writes: [] };
	let title = 'Dashboard · LuCI';      /* as header.ut wrote it */
	p.document = { get title() { return title; }, set title(v) { title = String(v); p.writes.push(title); } };
	p.root = { attrs: Object.assign({}, attrs), getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } };
	p.set = (k, v) => { p.root.attrs[k] = String(v); p.watched.filter(w => w.node === p.root && w.opts.attributes && w.opts.attributeFilter.includes(k)).forEach(w => w.f()); };
	const window = { MutationObserver: function(f) { this.observe = (node, opts) => { p.watched.push({ node, opts, f }); }; } };
	p.proto = new Function('baseclass', 'ui', 'rpc', 'host', 'E', 'L', '_', 'document', 'window', src)(
		{ extend: x => x }, {}, { declare: () => () => Promise.resolve({}) }, {}, () => ({}), {}, t => t, p.document, window);
	p.shell = Object.assign(Object.create(p.proto), { root: p.root });
	p.window = window;
	return p;
}

test('tab title: follows the dashboard, is written once a change, and is the title as before without one', () => {
	/* the theme alone, or any page but the dashboard: "Page · hostname", as before */
	let p = titlePage();
	p.shell.watchAlert();
	p.shell.updateTitle();
	assert.equal(p.document.title, 'Dashboard · LuCI', 'nothing known yet: the template\'s title stands');
	p.shell.pageTitle = 'Dashboard';
	p.shell.updateTitle();
	p.shell.hostname = 'attic-ap';
	p.shell.updateTitle();
	assert.deepEqual(p.writes, [ 'Dashboard', 'Dashboard · attic-ap' ]);
	/* one observer, on <html>, for the dashboard's two attributes and nothing else of the page */
	assert.equal(p.watched.length, 1);
	assert.equal(p.watched[0].node, p.root);
	assert.deepEqual(p.watched[0].opts, { attributes: true, attributeFilter: [ 'data-vt-alert', 'data-vt-alert-count' ] });

	/* the dashboard reports: the level, then the count, as paintHead sets them */
	p.writes.length = 0;
	p.set('data-vt-alert', '');
	p.set('data-vt-alert-count', '');
	assert.deepEqual(p.writes, [], 'all fine: not written again');
	p.set('data-vt-alert', 'warn');
	p.set('data-vt-alert-count', '2');
	assert.equal(p.document.title, '(2) Dashboard · attic-ap');
	/* the same word at every poll writes nothing */
	const n = p.writes.length;
	for (let i = 0; i < 5; i++) { p.set('data-vt-alert', 'warn'); p.set('data-vt-alert-count', '2'); }
	assert.equal(p.writes.length, n);
	p.set('data-vt-alert', 'err');
	p.set('data-vt-alert-count', '3');
	assert.equal(p.document.title, '(3) Dashboard · attic-ap');
	/* it clears: the title as before */
	p.set('data-vt-alert', '');
	p.set('data-vt-alert-count', '');
	assert.equal(p.document.title, 'Dashboard · attic-ap');

	/* a dashboard from before 1.1 sets the level only */
	p = titlePage();
	Object.assign(p.shell, { pageTitle: 'Dashboard', hostname: 'attic-ap' });
	p.shell.watchAlert();
	p.set('data-vt-alert', 'warn');
	assert.equal(p.document.title, '(!) Dashboard · attic-ap');
	p.set('data-vt-alert', '');
	assert.equal(p.document.title, 'Dashboard · attic-ap');

	/* the dashboard painted before the menu and the hostname came: whichever comes last finds its word */
	p = titlePage({ 'data-vt-alert': 'err', 'data-vt-alert-count': '1' });
	p.shell.watchAlert();
	p.shell.updateTitle();
	assert.equal(p.document.title, 'Dashboard · LuCI');
	p.shell.pageTitle = 'Dashboard';
	p.shell.updateTitle();
	assert.equal(p.document.title, '(1) Dashboard');
	p.shell.hostname = 'attic-ap';
	p.shell.updateTitle();
	assert.equal(p.document.title, '(1) Dashboard · attic-ap');
	/* what is not a count never reaches the title */
	p.set('data-vt-alert-count', '2) Log in again');
	assert.equal(p.document.title, '(!) Dashboard · attic-ap');

	/* a browser without MutationObserver: the title as before, and no error */
	p = titlePage();
	delete p.window.MutationObserver;
	Object.assign(p.shell, { pageTitle: 'Dashboard', hostname: 'attic-ap' });
	p.shell.watchAlert();
	p.shell.updateTitle();
	assert.equal(p.document.title, 'Dashboard · attic-ap');

	/* one place writes the title, with text only; the watch starts with the shell */
	assert.equal(src.split('document.title = ').length - 1, 1);
	assert.match(src, /\n\t\tthis\.watchAlert\(\);\n\t\tthis\.loadHost\(\);\n/);
	const part = src.slice(src.indexOf('function alertMark('), src.indexOf('/* Does help text carry a warning?')) + src.slice(src.indexOf('\tupdateTitle() {'), src.indexOf('\t/* -------------------------------------------------- indicators */'));
	assert.doesNotMatch(part, /innerHTML|querySelector\('title'\)|textContent|_\(/);
});

/* --------------------------- from the review of the 1.1 batch: the wiring */

test('daily update check: the theme itself applies what is kept at page load and puts the group in the panel', () => {
	assert.match(src, /\t\tthis\.applyBrand\(\);\n\t\tthis\.applyUpdate\(\);\n\t\},/, 'setupTheme ends by applying it');
	assert.match(src, /\n\t\t\tthis\.updateGroup\(\),\n\t\t\tthis\.versionEl\(\)\n/, 'the Appearance panel has the group');
});

test('daily update check: a manual check that finds this version current says so, after a notice', async () => {
	const w = updateBrowser({ 'vantage.update.auto': 'on', 'vantage.update.last': JSON.stringify({ at: 1700000000000, latest: NEWER }) });
	w.list = w.packages(RUNNING);
	w.now += 3600 * 1000;
	const wp = (await w.page()).open();
	assert.ok(wp.dot() && !wp.line.hidden, 'the notice from what was kept');
	wp.check.fire('click');
	await w.settle();
	assert.deepEqual([ wp.line.textContent, wp.line.hidden, wp.dot() ], [ 'Up to date', false, false ]);
});

test('daily update check: switched off before the page is idle, nothing is asked', async () => {
	const late = updateBrowser({ 'vantage.update.auto': 'on' });
	late.list = late.packages(NEWER);
	late.idle = false;
	const lp = await late.page();
	delete late.store['vantage.update.auto'];
	lp.timers[0].f();
	await late.settle();
	assert.equal(late.asked.length, 0);
});

test('daily update check: setupTheme applies what is kept, and another tab\'s storage event reaches it', () => {
	require('./luci-stub');
	const store = { 'vantage.update.auto': 'on', 'vantage.update.last': JSON.stringify({ at: 1, latest: NEWER }) };
	const heard = {};
	const gear = { attrs: { 'aria-label': 'Appearance' }, addEventListener() {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = String(v); },
		toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; } };
	const document = { getElementById: id => (id === 'vt-look' ? gear : null) };
	const window = { addEventListener: (t, f) => { (heard[t] = heard[t] || []).push(f); } };
	const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
	const proto = new Function('baseclass', 'ui', 'rpc', 'host', 'E', 'L', '_', 'document', 'window', 'localStorage', src)(
		{ extend: x => x }, {}, { declare: () => () => Promise.resolve({}) }, {}, () => ({}), {}, t => t, document, window, localStorage);
	const shell = Object.assign(Object.create(proto), { root: { getAttribute: () => null, setAttribute() {} } });
	for (const k of [ 'applyTheme', 'applyBackdrop', 'applyPower', 'applyUnfocused', 'applyUnits', 'applyBrand' ]) shell[k] = () => {};
	shell.setupTheme();
	assert.ok(gear.hasAttribute('data-vt-update'), 'applied with the theme, at page load');
	delete store['vantage.update.auto'];
	heard.storage.forEach(f => f({ key: 'vantage.update.auto', newValue: null }));
	assert.ok(!gear.hasAttribute('data-vt-update'), 'another tab switched it off: the dot goes here');
	store['vantage.update.auto'] = 'on';
	heard.storage.forEach(f => f({ key: 'vantage.update.last', newValue: store['vantage.update.last'] }));
	assert.ok(gear.hasAttribute('data-vt-update'), 'another tab learned of a version');
});

test('daily update check: a page left open, or loaded out of view, checks when its tab comes into view, once a day', async () => {
	/* loaded in a background tab: nothing asked there, and the check is not lost */
	const b = updateBrowser({ 'vantage.update.auto': 'on' });
	b.list = b.packages(NEWER);
	b.visible = false;
	const p = await b.page();
	assert.equal(b.asked.length, 0);
	await p.show(true);
	assert.deepEqual([ b.asked.length, p.dot() ], [ 1, true ]);
	/* looked at again and again that day: no more questions */
	for (let i = 0; i < 3; i++) { await p.show(false); await p.show(true); }
	assert.equal(b.asked.length, 1);
	/* the same page, still open the next day */
	b.now += b.DAY;
	await p.show(false);
	assert.equal(b.asked.length, 1, 'going out of view asks nothing');
	await p.show(true);
	assert.equal(b.asked.length, 2);
	/* switched off, or on the login page: coming into view asks nothing */
	const off = updateBrowser({});
	off.list = off.packages(NEWER);
	const q = await off.page();
	await q.show(false); await q.show(true);
	assert.equal(off.asked.length, 0);
	const login = updateBrowser({ 'vantage.update.auto': 'on' });
	login.auth = false; login.list = login.packages(NEWER);
	const l = await login.page();
	await l.show(false); await l.show(true);
	assert.equal(login.asked.length, 0);
});
