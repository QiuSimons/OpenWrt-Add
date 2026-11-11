#!/usr/bin/env node
'use strict';
/*
 * luci-theme-vantage template security.
 *
 *   node security-tests/test_templates.js     (or node --test ...)
 *
 * Renders themes/vantage/{header,footer,sysauth}.ut with the replay's ucode
 * template engine (dev/replay/ut.js) under benign and hostile inputs and
 * checks the browser-facing invariants of docs/luci-contract.md section 2.
 * These assertions are about the markup the THEME emits. On the device
 * the core header.ut wraps the theme header and adds its own
 * `L = new LuCI({...})` script (LuCI build, pathinfo, nodespec) to every
 * page, anonymous ones included, and core footer.ut adds its apply and
 * media_error scripts; that is luci-base, not the theme. The last tests
 * render the core error404 page from a device rootfs around the theme
 * ($VANTAGE_ROOTFS, skipped without one) and track the core's anonymous
 * leaks as known upstream failures (node:test `todo`). ut.js is not
 * ucode: its entityencode/striptags are close stand-ins, and the HTML
 * tokenizer below is not an HTML5 script-data tokenizer.
 *
 *
 * - markup is stable: the tag/attribute skeleton of a hostile render equals
 *   the benign one, so no input adds an element or an attribute, and no raw
 *   payload reaches the output (request_path, dispatched title, version
 *   strings, dispatcher.lang, duser, fuser, uhttpd listen_https);
 * - inline scripts are data-free: identical for benign and hostile inputs
 *   and free of every input string;
 * - `fuser` is never echoed; the login error is generic;
 * - for visitors who are not logged in (login, 404 and CSRF pages) the
 *   theme emits no menu, no menu script, no host, model or version, no
 *   dispatched page title, and makes no ubus call;
 * - the login form posts back without an action attribute, with the
 *   contract's field names and autocomplete tokens;
 * - JSON handed to the login script arrives entity-encoded in an attribute
 *   and holds port numbers only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Engine } = require('../dev/replay/ut');

/* VANTAGE_TEMPLATES: render another template tree (used to mutation-test this file) */
const TEMPLATES = process.env.VANTAGE_TEMPLATES || path.join(__dirname, '..', 'luci-theme-vantage', 'ucode', 'template');
const THEME = 'themes/vantage';

/* payloads covering element, attribute (both quotes), script and URL contexts */
const XSS = [
	'"><script>alert(1)</script>',
	"'><img src=x onerror=alert(2)>",
	'</title><svg onload=alert(3)>',
	'javascript:alert(4)//',
	'</script><script>alert(5)</script>',
	'&lt;b&gt;pre-encoded&amp;'
];
const HOSTILE = XSS.join(' ');

/* strings that identify the device; unauthenticated renders must not contain them */
const SECRET = {
	hostname: 'SECRET-HOSTNAME',
	model: 'SECRET-MODEL',
	board: 'secret,board-name',
	distname: 'SECRET-DISTNAME',
	distversion: '99.1-SECRET',
	luciname: 'SECRETLUCI',
	luciversion: '77.42-secret',
	title: 'SECRET-PAGE-TITLE'
};

/* ------------------------------------------------------------ rendering */

function environment(o) {
	const calls = { ubus: [], uci: [] };
	const board = {
		hostname: o.hostile ? SECRET.hostname + HOSTILE : SECRET.hostname,
		model: SECRET.model, board_name: SECRET.board,
		release: { distribution: SECRET.distname, version: SECRET.distversion, description: SECRET.distname + ' ' + SECRET.distversion }
	};
	const env = {
		http: {
			getenv: k => ({ PATH_INFO: '/' + o.path.join('/'), REQUEST_URI: '/cgi-bin/luci/' + o.path.join('/'),
				HTTP_HOST: o.hostile ? HOSTILE : 'ap.example', HTTP_REFERER: o.hostile ? HOSTILE : null,
				QUERY_STRING: o.hostile ? HOSTILE : '' })[k] ?? null,
			formvalue: k => o.hostile ? HOSTILE : (o.form ?? {})[k] ?? null,
			getcookie: () => null
		},
		ubus: {
			call: (obj, method, args) => {
				calls.ubus.push(obj + '.' + method);
				if (obj === 'system' && method === 'board') return board;
				if (obj === 'system' && method === 'info') return { uptime: 1, memory: {} };
				return null;
			}
		},
		uci: {
			get: (c, s, opt) => {
				calls.uci.push([ c, s, opt ].join('.'));
				if (c === 'uhttpd' && s === 'main' && opt === 'listen_https' && o.listen !== undefined)
					return o.listen;
				if (c === 'uhttpd' && s === 'main' && opt === 'listen_https')
					return o.hostile ? [ '0.0.0.0:443', '[::]:8443', '0.0.0.0:0', '0.0.0.0:70000', HOSTILE, HOSTILE + ':1' ] : [ '0.0.0.0:443', '[::]:443' ];
				/* Appearance saved for every browser (/etc/config/vantage_theme) */
				if (c === 'vantage_theme' && s === 'appearance')
					return o.hostile ? HOSTILE : (o.look || {})[opt] ?? null;
				return null;
			},
			get_first: (c, t, opt) => {
				calls.uci.push([ c, '@' + t, opt ].join('.'));
				if (c === 'system' && t === 'system' && opt === 'hostname' && !o.noHostname)
					return o.hostile ? SECRET.hostname + HOSTILE : SECRET.hostname;
				return null;
			},
			get_all: (c, s) => (c === 'vantage_theme' && s === 'appearance' && !o.noSection) ? {} : null,
			/* rpcd's logins: what a new login would be granted */
			foreach: (c, t, fn) => { if (c === 'rpcd' && t === 'login') for (const s of o.logins || []) fn(s); }
		},
		ctx: {
			path: o.path, request_path: o.path, request_args: [],
			authsession: o.authed ? 'a'.repeat(32) : null,
			authtoken: o.authed ? 'b'.repeat(32) : null,
			authuser: o.authed ? 'root' : null,
			authacl: o.acl
		},
		version: {
			distname: o.hostile ? SECRET.distname + HOSTILE : SECRET.distname,
			distversion: o.hostile ? SECRET.distversion + HOSTILE : SECRET.distversion,
			luciname: o.hostile ? SECRET.luciname + HOSTILE : SECRET.luciname,
			luciversion: o.hostile ? SECRET.luciversion + HOSTILE : SECRET.luciversion
		},
		config: { main: { lang: 'auto', mediaurlbase: '/luci-static/vantage' } },
		dispatcher: {
			lang: o.hostile ? 'en' + HOSTILE : 'en',
			build_url: (...p) => '/cgi-bin/luci/' + p.filter(x => /^[A-Za-z0-9_%.\/,;-]+$/.test(String(x))).join('/'),
			is_authenticated: () => o.authed ? { sid: 'a'.repeat(32) } : null,
			menu_json: () => ({ children: { admin: { title: SECRET.title } } }),
			rollback_pending: () => false
		},
		media: '/luci-static/vantage', theme: 'vantage', resource: '/luci-static/resources',
		/* o.missing: LuCI's 404 hands over the category it resolved */
		dispatched: { title: o.hostile ? SECRET.title + HOSTILE : SECRET.title, action: o.missing ? { type: 'firstchild' } : { type: 'view', path: 'status/index' } },
		_: s => s
	};
	return { env, calls };
}

const engine = new Engine([ TEMPLATES ], {}, {});

/* page: theme header + (core view goes here) + theme footer, as the runtime does */
function renderPage(o) {
	const { env, calls } = environment(o);
	const scope = { blank_page: !!o.blank };
	const html = engine.render(THEME + '/header', env, scope) + '<div id="view"></div>' + engine.render(THEME + '/footer', env, scope);
	return { html, calls };
}

function renderLogin(o) {
	const { env, calls } = environment(o);
	/* o.auth: what LuCI's authentication plugins add (auth_fields, auth_message, ...) */
	const html = engine.render(THEME + '/sysauth', env, { duser: o.hostile ? 'root' + HOSTILE : 'root', fuser: o.fuser ?? null, ...(o.auth ?? {}) });
	return { html, calls };
}

/* ------------------------------------------------------------- analysis */

/* minimal HTML tokenizer: tags with attribute names/values, raw script text */
function tokenize(html) {
	const tags = [], scripts = [];
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf('<', i);
		if (lt < 0) break;
		if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue; }
		if (html.startsWith('<!', lt)) { const e = html.indexOf('>', lt); tags.push({ name: '!doctype', close: false, attrs: [] }); i = e + 1; continue; }
		const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64));
		if (!m) { i = lt + 1; continue; }
		const tag = { name: m[2].toLowerCase(), close: !!m[1], attrs: [] };
		let j = lt + m[0].length;
		for (;;) {
			while (j < html.length && /[\s/]/.test(html[j])) j++;
			if (j >= html.length || html[j] === '>') { j++; break; }
			const an = /^[^\s"'>\/=]+/.exec(html.slice(j));
			if (!an) { j++; continue; }
			j += an[0].length;
			let value = null;
			while (/\s/.test(html[j] || '')) j++;
			if (html[j] === '=') {
				j++;
				while (/\s/.test(html[j] || '')) j++;
				const q = html[j];
				if (q === '"' || q === "'") { const e = html.indexOf(q, j + 1); value = html.slice(j + 1, e); j = e + 1; }
				else { const v = /^[^\s>]*/.exec(html.slice(j))[0]; value = v; j += v.length; }
			}
			tag.attrs.push([ an[0].toLowerCase(), value ]);
		}
		tags.push(tag);
		i = j;
		if (!tag.close && (tag.name === 'script' || tag.name === 'style')) {
			const e = html.toLowerCase().indexOf('</' + tag.name, i);
			scripts.push({ tag: tag.name, attrs: tag.attrs, text: html.slice(i, e < 0 ? html.length : e) });
			i = e < 0 ? html.length : e;
		}
	}
	return { tags, scripts };
}

const skeleton = html => tokenize(html).tags.map(t => (t.close ? '/' : '') + t.name + (t.attrs.length ? '[' + t.attrs.map(a => a[0]).join(',') + ']' : ''));
const inlineScripts = html => tokenize(html).scripts.filter(s => s.tag === 'script' && !s.attrs.some(a => a[0] === 'src')).map(s => s.text);
const NAMED = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
const decode = s => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(quot|apos|lt|gt|amp));/gi,
	(m, d, h, n) => d ? String.fromCharCode(+d) : h ? String.fromCharCode(parseInt(h, 16)) : NAMED[n.toLowerCase()]);

function assertNoPayload(html, what) {
	/* payloads with markup characters must only appear encoded ('javascript:'
	   is plain text in element content; the URL check below covers attributes) */
	for (const p of XSS.filter(x => /[<>"'&]/.test(x)))
		assert.ok(!html.includes(p), `${what}: raw payload reached the output: ${p}`);
	const { tags } = tokenize(html);
	for (const t of tags) {
		for (const [ k, v ] of t.attrs) {
			assert.ok(!/^on/.test(k), `${what}: event handler attribute ${k} on <${t.name}>`);
			if (v != null && /^(href|src|action|formaction)$/.test(k))
				assert.doesNotMatch(decode(v).replace(/[\s\u0000-\u001f]/g, ''), /^[a-z][a-z0-9+.-]*:/i, `${what}: scheme in ${k}=${v}`);
		}
	}
	/* no img/iframe/object/embed at all in these templates */
	assert.ok(!tags.some(t => /^(img|iframe|object|embed)$/.test(t.name)), `${what}: injected embedded content`);
}

function assertNoSecrets(html, what) {
	for (const [ k, v ] of Object.entries(SECRET))
		assert.ok(!html.includes(v), `${what}: ${k} (${v}) leaked to an unauthenticated visitor`);
}

const ADMIN = [ 'admin', 'status', 'overview' ];
const EVIL_PATH = [ 'admin', XSS[0], XSS[1], XSS[2] ];

/* ---------------------------------------------------------------- tests */

test('header/footer (logged in): hostile inputs change no markup and are encoded', () => {
	for (const blank of [ false, true ]) {
		const good = renderPage({ authed: true, path: ADMIN, blank }).html;
		const evil = renderPage({ authed: true, path: EVIL_PATH, hostile: true, blank }).html;
		assert.deepEqual(skeleton(evil), skeleton(good), `blank_page=${blank}: markup skeleton changed`);
		assertNoPayload(evil, `authed page blank_page=${blank}`);
		assert.deepEqual(inlineScripts(evil), inlineScripts(good), `blank_page=${blank}: inline scripts depend on input`);
		for (const s of inlineScripts(evil))
			for (const p of [ SECRET.hostname, SECRET.title, SECRET.distname, 'alert(' ])
				assert.ok(!s.includes(p), `inline script carries data: ${p}`);
	}
	const page = renderPage({ authed: true, path: EVIL_PATH, hostile: true }).html;
	assert.match(renderPage({ authed: true, path: ADMIN }).html, /<title>SECRET-PAGE-TITLE · LuCI<\/title>/, 'the page title, then LuCI');
	const body = tokenize(page).tags.find(t => t.name === 'body');
	assert.equal(decode(body.attrs.find(a => a[0] === 'data-page')[1]), EVIL_PATH.join('-'), 'data-page round-trips through entity encoding');
	/* the version footer is for sessions, trimmed to its leading token, and encoded */
	assert.match(page, /<footer class="vt-foot">[\s\S]*SECRET-DISTNAME&#34;&#62;&#60;script&#62;[\s\S]*99\.1-SECRET<\/span>/);
	assert.match(page, /<span>SECRETLUCI 77\.42<\/span>/);
	assert.match(page, /<script>L\.require\('menu-vantage'\);<\/script>/);
	assert.match(page, /id="vt-rail-list"/);
});

test('header/footer (not logged in: 404, CSRF): no menu, no host, no version, no title', () => {
	for (const blank of [ false, true ]) for (const hostile of [ false, true ]) {
		const { html, calls } = renderPage({ authed: false, path: hostile ? EVIL_PATH : [ 'admin', 'nonexistent' ], hostile, blank });
		const what = `anon page blank_page=${blank} hostile=${hostile}`;
		assertNoSecrets(html, what);
		assertNoPayload(html, what);
		assert.deepEqual(calls.ubus, [], `${what}: ubus called for an anonymous visitor`);
		assert.deepEqual(calls.uci, [], `${what}: uci read for an anonymous visitor`);
		for (const bad of [ 'vt-rail', 'vt-flyout', 'vt-host', 'vt-search', 'menu-vantage', 'admin/logout', 'L.require' ])
			assert.ok(!html.includes(bad), `${what}: ${bad} rendered for an anonymous visitor`);
		assert.match(html, /<title>LuCI<\/title>/, `${what}: generic title`);
		assert.match(html, /id="maincontent"/, `${what}: #maincontent is required`);
		assert.match(html, /id="indicators"/, `${what}: #indicators is required`);
		assert.ok(!/<footer class="vt-foot">[^<]*<span/.test(html), `${what}: version footer for an anonymous visitor`);
	}
	const good = renderPage({ authed: false, path: [ 'admin', 'x' ] }).html;
	const evil = renderPage({ authed: false, path: EVIL_PATH, hostile: true }).html;
	assert.deepEqual(skeleton(evil), skeleton(good), 'anonymous markup skeleton changed');
	assert.deepEqual(inlineScripts(evil), inlineScripts(good), 'anonymous inline scripts depend on input');
});

test('header (logged in, 404): titled "Not found", not after the category LuCI resolved', () => {
	for (const hostile of [ false, true ]) {
		const html = renderPage({ authed: true, path: [ 'admin', 'nonexistent' ], missing: true, hostile }).html;
		assert.match(html, /<title>Not found · LuCI<\/title>/);
		assert.match(html, /<span class="vt-crumb vt-crumb-current">Not found<\/span>/);
		assert.ok(!html.includes(SECRET.title), 'the resolved node\'s title');
	}
});

test('header: the contract hooks and script order are in place', () => {
	const html = renderPage({ authed: true, path: ADMIN }).html;
	const srcs = tokenize(html).tags.filter(t => t.name === 'script' && !t.close).map(t => (t.attrs.find(a => a[0] === 'src') || [])[1]).filter(Boolean);
	assert.deepEqual(srcs, [ '/cgi-bin/luci/admin/translations/en', '/luci-static/resources/cbi.js' ], 'translations, then cbi.js (before core luci.js)');
	assert.ok(html.indexOf('id="maincontent"') > 0 && !/<\/main>[\s\S]*<div id="view">/.test(html), '#view lands inside #maincontent');
	assert.ok(!/id="view"/.test(engine.render(THEME + '/header', environment({ authed: true, path: ADMIN }).env, { blank_page: false })), 'the theme never emits #view');
	/* SubstituteVersion (luci.mk) adds ?v= only to "{{ media }}/x.css" / "{{ resource }}/x.js" */
	for (const t of [ 'header', 'sysauth' ]) {
		const src = fs.readFileSync(path.join(TEMPLATES, THEME, t + '.ut'), 'utf8');
		for (const m of src.matchAll(/(?:href|src)="([^"]*\.(?:css|js))"/g))
			assert.match(m[1], /^\{\{ (media|resource) \}\}\/[\w.-]+$/, `${t}.ut: asset URL ${m[1]} is not in the cache-busting form`);
	}
});

test('login: fuser is never echoed, hostile inputs change no markup, the hostname and nothing else about the device', () => {
	const good = renderLogin({ path: ADMIN, fuser: 'root' });
	const evil = renderLogin({ path: EVIL_PATH, hostile: true, fuser: HOSTILE + 'FUSER-MARK' });
	assert.deepEqual(skeleton(evil.html), skeleton(good.html), 'login markup skeleton changed');
	assertNoPayload(evil.html, 'login');
	assert.ok(!evil.html.includes('FUSER-MARK'), 'fuser echoed');
	/* the hostname is the heading, encoded; nothing else about the device */
	const notHost = html => { for (const [ k, v ] of Object.entries(SECRET)) if (k !== 'hostname') assert.ok(!html.includes(v), `login: ${k} (${v}) leaked`); };
	notHost(evil.html);
	notHost(good.html);
	assert.match(good.html, /<h1 class="vt-login-title">SECRET-HOSTNAME<\/h1>/, 'the hostname is the heading');
	assert.equal(good.html.split(SECRET.hostname).length - 1, 1, 'the hostname once');
	assert.match(evil.html, /<h1 class="vt-login-title">SECRET-HOSTNAME&#34;&#62;&#60;script&#62;/, 'a hostile hostname is encoded');
	assert.match(renderLogin({ path: ADMIN, noHostname: true }).html, /<h1 class="vt-login-title">Authorization Required<\/h1>/, 'none: as before');
	assert.deepEqual(evil.calls.ubus, [], 'login page called ubus');
	assert.deepEqual(evil.calls.uci, [ 'uhttpd.main.listen_https', 'vantage_theme.appearance.theme', 'vantage_theme.appearance.login', 'vantage_theme.appearance.power', 'system.@system.hostname' ],
		'login page read more than the HTTPS ports, the Appearance saved for every browser and the hostname');
	assert.match(evil.html, /role="alert">Invalid username and\/or password! Please try again\.</, 'generic error for a failed login');
	assert.ok(!renderLogin({ path: ADMIN }).html.includes('role="alert"'), 'no error before a login attempt');
	assert.deepEqual(inlineScripts(evil.html), inlineScripts(good.html), 'login inline scripts depend on input');
	for (const s of inlineScripts(evil.html))
		assert.ok(!/443|SECRET|alert\(|luci-static/.test(s), 'login inline script carries data');
});

/* LuCI's authentication plugins (luci-plugin-2fa, after 25.12): the
   dispatcher adds the plugin's fields and guidance, and auth_plugin once
   the password was right */
test('login with an authentication plugin: its fields, guidance and errors, encoded; its HTML and scripts as Bootstrap prints them', () => {
	const otp = { name: 'luci_otp', type: 'text', label: 'One-Time Password', placeholder: '123456', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 6, autocomplete: 'one-time-code', required: true };
	const pending = { auth_fields: [ otp ], auth_message: 'Enter the code from your app.' };
	const input = html => tokenize(html).tags.find(t => t.name === 'input' && t.attrs.some(a => a[0] === 'name' && a[1] === 'luci_otp'));

	const first = renderLogin({ path: ADMIN, auth: pending }).html;
	assert.deepEqual(Object.fromEntries(input(first).attrs.filter(a => a[0] !== 'class')), { id: 'luci_otp', type: 'text', name: 'luci_otp', placeholder: '123456',
		inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'one-time-code', required: null }, 'the plugin\'s field');
	assert.match(first, /<label class="vt-field" for="luci_otp">\s*<span class="vt-field-label">One-Time Password<\/span>/, 'labelled');
	assert.match(first, /class="vt-login-info" role="status">Enter the code from your app\.</, 'guidance, not an error');
	assert.ok(!first.includes('role="alert"'), 'no error before a login attempt');

	const badPassword = renderLogin({ path: ADMIN, fuser: 'root', auth: pending }).html;
	assert.match(badPassword, /role="alert">Invalid username and\/or password!/, 'a wrong password still says so');
	assert.match(badPassword, /role="status">Enter the code/, 'with the guidance');

	const right = { ...pending, auth_plugin: 'TOTP', auth_message: 'Invalid one-time password.' };
	const wrongCode = renderLogin({ path: ADMIN, fuser: 'root', form: { luci_otp: '000000' }, auth: right }).html;
	assert.match(wrongCode, /class="vt-login-error" role="alert">Invalid one-time password\.</, 'a wrong code is an error');
	assert.ok(!wrongCode.includes('Invalid username'), 'not a wrong password');
	assert.match(renderLogin({ path: ADMIN, fuser: 'root', auth: right }).html, /class="vt-login-info" role="status">Invalid one-time password\.</, 'no code sent yet: guidance');

	const evil = renderLogin({ path: ADMIN, auth: { auth_message: HOSTILE, auth_fields: [ Object.fromEntries(Object.keys(otp).map(k => [ k, k === 'required' ? true : HOSTILE ])) ] } }).html;
	const calm = renderLogin({ path: ADMIN, auth: { auth_message: 'x', auth_fields: [ Object.fromEntries(Object.keys(otp).map(k => [ k, k === 'required' ? true : 'x' ])) ] } }).html;
	assertNoPayload(evil, 'login with a plugin');
	assert.deepEqual(skeleton(evil), skeleton(calm), 'plugin values changed the markup');
	/* a script path with markup in it stays an attribute value (LuCI also refuses quotes and <> there) */
	const odd = renderLogin({ path: ADMIN, auth: { auth_assets: [ { type: 'script', src: '/luci-static/plugins/u/a.js"><x>' } ] } }).html;
	assert.ok(odd.includes('src="/luci-static/plugins/u/a.js&#34;&#62;&#60;x&#62;"'), 'the script path encoded');
	assert.ok(!odd.includes('<x>'));

	const extra = renderLogin({ path: ADMIN, auth: { ...pending, auth_html: '<div class="cbi-value-description">Plugin UI</div>',
		auth_assets: [ { type: 'script', src: '/luci-static/plugins/0123/ui.js' }, { type: 'style', src: '/luci-static/plugins/0123/ui.css' } ] } }).html;
	assert.match(extra, /<div class="vt-login-plugin"><div class="cbi-value-description">Plugin UI<\/div><\/div>/, 'the plugin\'s own HTML');
	assert.deepEqual(tokenize(extra).scripts.filter(x => x.attrs.some(a => a[0] === 'src')).map(x => x.attrs.find(a => a[0] === 'src')[1]),
		[ '/luci-static/vantage/login.js', '/luci-static/plugins/0123/ui.js' ], 'its scripts, and nothing else');

	const plain = renderLogin({ path: ADMIN }).html;
	assert.ok(!/luci_otp|vt-login-plugin|vt-login-info/.test(plain), 'without a plugin (24.10, 25.12): none of it');
});

test('Appearance saved for every browser: only values the theme knows reach the pages, as data attributes', () => {
	const looks = html => Object.fromEntries(tokenize(html).tags.find(t => t.name === 'html').attrs.filter(a => /^data-vt-look-(theme|login|backdrop|brand)$/.test(a[0])));
	const look = { theme: 'dark', login: 'stars', backdrop: 'none', brand: 'hostname' };
	assert.deepEqual(looks(renderLogin({ path: ADMIN, look }).html), { 'data-vt-look-theme': 'dark', 'data-vt-look-login': 'stars' });
	/* Low-power router: the login page draws no particles (login.js) */
	const power = html => attrOf(html, 'html', 'data-vt-look-power');
	assert.equal(power(renderLogin({ path: ADMIN, look: { power: 'low' } }).html), 'low');
	assert.equal(power(renderPage({ path: ADMIN, authed: true, look: { power: 'low' } }).html), 'low');
	for (const odd of [ HOSTILE, 'Low', ' low', 'on', '' ]) {
		assert.equal(power(renderLogin({ path: ADMIN, look: { power: odd } }).html), '', `login power ${JSON.stringify(odd)}`);
		assert.equal(power(renderPage({ path: ADMIN, authed: true, look: { power: odd } }).html), '', `header power ${JSON.stringify(odd)}`);
	}
	assert.deepEqual(looks(renderPage({ path: ADMIN, authed: true, look }).html),
		{ 'data-vt-look-theme': 'dark', 'data-vt-look-login': 'stars', 'data-vt-look-backdrop': 'none', 'data-vt-look-brand': 'hostname' });
	for (const odd of [ HOSTILE, 'Dark', ' dark', 'stars ', [ 'dark' ], {}, 1, '' ]) {
		const o = { theme: odd, login: odd, backdrop: odd, brand: odd };
		assert.deepEqual(looks(renderLogin({ path: ADMIN, look: o }).html), { 'data-vt-look-theme': '', 'data-vt-look-login': '' }, `login ${JSON.stringify(odd)}`);
		assert.deepEqual(looks(renderPage({ path: ADMIN, authed: true, look: o }).html),
			{ 'data-vt-look-theme': '', 'data-vt-look-login': '', 'data-vt-look-backdrop': '', 'data-vt-look-brand': '' }, `header ${JSON.stringify(odd)}`);
	}
	/* the dashboard's chart style and layouts: logged in only, in their form only */
	const view = (html, n) => attrOf(html, 'html', 'data-vt-look-' + n);
	const lay = { chart: 'log', layout_wide: 'hero:0:4 chart:0:2:h', layout_mid: 'default', layout_narrow_wired: 'sys:0:1' };
	const mine = renderPage({ path: ADMIN, authed: true, look: lay }).html;
	assert.equal(view(mine, 'chart'), 'log');
	assert.equal(view(mine, 'layout'), 'wide=hero:0:4 chart:0:2:h;mid=default;narrow_wired=sys:0:1');
	for (const o of [ renderPage({ path: [ 'admin', 'x' ], authed: false, look: lay }).html ]) {
		assert.equal(view(o, 'chart'), '', 'anonymous');
		assert.equal(view(o, 'layout'), '', 'anonymous');
	}
	assert.ok(!/data-vt-look-(chart|layout)/.test(renderLogin({ path: ADMIN, look: lay }).html), 'the login page has no use for them');
	for (const odd of [ HOSTILE, 'hero:0:4;mid=x', 'hero:0:4"', 'Hero:0:4', 'hero:9:9', 'hero:0:4 ', ' hero:0:4', 'hero', 'default x',
		Array(9).fill('hero:0:1').join(' '), 'x'.repeat(9) + ':0:1', [ 'hero:0:4' ], {}, 1, '' ]) {
		const page = renderPage({ path: ADMIN, authed: true, look: { chart: odd, layout_wide: odd } }).html;
		assert.equal(view(page, 'chart'), '', `chart ${JSON.stringify(odd)}`);
		assert.equal(view(page, 'layout'), '', `layout ${JSON.stringify(odd)}`);
	}
	/* may this login save it: held now, granted at a new login, or not at all */
	const save = o => attrOf(renderPage(Object.assign({ path: ADMIN, authed: true }, o)).html, 'html', 'data-vt-look-save');
	const held = { 'access-group': { 'luci-theme-vantage': [ 'read', 'write' ] } };
	const root = [ { username: 'root', read: [ '*' ], write: [ '*' ] } ];
	assert.equal(save({ acl: held, logins: root }), 'yes');
	assert.equal(save({ acl: { 'access-group': { 'luci-base': [ 'read', 'write' ] } }, logins: root }), 'relogin', 'a login from before the group');
	assert.equal(save({ acl: { 'access-group': {} }, logins: [ { username: 'root', write: 'luci-*' } ] }), 'relogin', 'one pattern, as rpcd matches it');
	assert.equal(save({ acl: { 'access-group': {} }, logins: [ { username: 'root', write: [ 'luci-app-*' ] } ] }), 'no');
	assert.equal(save({ acl: { 'access-group': {} }, logins: [ { username: 'admin', write: [ '*' ] } ] }), 'no', 'another user\'s grant');
	assert.equal(save({ acl: { 'access-group': { 'luci-theme-vantage': [ 'read' ] } }, logins: [] }), 'no');
	assert.equal(save({ acl: held, logins: root, noSection: true }), 'no', 'no section to save into');
	assert.equal(attrOf(renderPage({ path: [ 'admin', 'x' ], authed: false, acl: held, logins: root }).html, 'html', 'data-vt-look-save'), 'no', 'anonymous');
	/* the inline scripts stay data-free: they read the attributes */
	assert.deepEqual(inlineScripts(renderLogin({ path: ADMIN, look }).html), inlineScripts(renderLogin({ path: ADMIN }).html));
	assert.deepEqual(inlineScripts(renderPage({ path: ADMIN, authed: true, look: Object.assign({}, look, lay) }).html), inlineScripts(renderPage({ path: ADMIN, authed: true }).html));
});

test('login form: post back without action, contract field names and autocomplete', () => {
	const { tags } = tokenize(renderLogin({ path: EVIL_PATH, hostile: true, fuser: HOSTILE }).html);
	const forms = tags.filter(t => t.name === 'form' && !t.close);
	assert.equal(forms.length, 1);
	const attr = (t, k) => { const a = t.attrs.find(x => x[0] === k); return a ? a[1] : undefined; };
	assert.equal(attr(forms[0], 'method'), 'post');
	assert.equal(attr(forms[0], 'action'), undefined, 'the login form must not carry an action');
	const inputs = tags.filter(t => t.name === 'input');
	assert.deepEqual(inputs.map(t => [ attr(t, 'name'), attr(t, 'type'), attr(t, 'autocomplete') ]),
		[ [ 'luci_username', 'text', 'username' ], [ 'luci_password', 'password', 'current-password' ] ]);
	assert.equal(decode(attr(inputs[0], 'value')), 'root' + HOSTILE, 'duser round-trips through entity encoding');
	assert.equal(attr(inputs[1], 'value'), undefined, 'the password is never prefilled');
	/* HTTPS probe data: entity-encoded JSON of valid port numbers only */
	const ports = JSON.parse(decode(attr(forms[0], 'data-https-ports')));
	assert.deepEqual(ports, [ 443, 8443, 1 ]);
	assert.ok(ports.every(p => Number.isInteger(p) && p > 0 && p < 65536));
	assert.equal(decode(attr(forms[0], 'data-https-probe')), '/luci-static/resources/icons/loading.svg');
});

test('login: odd uci and fuser values render without an exception and change no markup', () => {
	/* sysauth.ut throwing would make the dispatcher fall back to the core
	   login page (core header, core footer with media_error) */
	const base = skeleton(renderLogin({ path: ADMIN, fuser: 'root' }).html);
	for (const listen of [ '0.0.0.0:443 [::]:8443', '', null, 443, [ 443, null, {} ], {} ]) {
		const r = renderLogin({ path: ADMIN, fuser: 'root', listen });
		assert.deepEqual(skeleton(r.html), base, `listen_https=${JSON.stringify(listen)}`);
	}
	const ports = attrOf(renderLogin({ path: ADMIN, listen: '0.0.0.0:443 [::]:8443' }).html, 'form', 'data-https-ports');
	assert.deepEqual(JSON.parse(decode(ports)), [ 443, 8443 ], 'a whitespace-separated listen_https string');
	for (const fuser of [ [ 'a', 'b' ], '', 0, 'x\u0000y', '\u2028' ]) {
		const r = renderLogin({ path: ADMIN, fuser });
		assert.ok(!r.html.includes('x\u0000y') && !r.html.includes('\u2028'), `fuser ${JSON.stringify(fuser)} echoed`);
	}
});

function attrOf(html, tag, name) {
	const t = tokenize(html).tags.find(x => x.name === tag && !x.close);
	const a = t && t.attrs.find(x => x[0] === name);
	return a ? a[1] : undefined;
}

/* --------------------------------------- core error404 around the theme */

/* A device rootfs dump provides LuCI's own templates (as for the replay). */
const ROOTFS = process.env.VANTAGE_ROOTFS ||
	path.join(__dirname, '../../vantage-rootfs');
const CORE = path.join(ROOTFS, 'usr/share/ucode/luci/template');
const HAVE_CORE = fs.existsSync(path.join(CORE, 'error404.ut')) && fs.existsSync(path.join(CORE, 'header.ut'));
const NO_CORE = HAVE_CORE ? false : 'no LuCI core templates (set VANTAGE_ROOTFS to a device rootfs dump)';

/* what dispatcher.uc hands the templates for GET /cgi-bin/luci/<x> without
   a session: no node matches, so `dispatched` is the root of the page
   tree (build_pagetree(), every node with its depends/satisfied) */
const TREE = {
	action: { type: 'firstchild' }, satisfied: true,
	children: {
		admin: {
			title: 'Administration', order: 10, satisfied: true, action: { type: 'firstchild' },
			auth: { methods: [ 'cookie:sysauth_https', 'cookie:sysauth_http' ], login: true },
			children: {
				dashboard: { title: SECRET.title, satisfied: true, action: { type: 'view', path: 'vantage/overview' }, depends: { acl: [ 'luci-app-vantage' ] } },
				network: { title: 'Network', satisfied: true, depends: { fs: { '/sbin/fw3': 'executable' }, uci: { network: true } } }
			}
		}
	}
};

function renderCore404(reqPath) {
	const coreEngine = new Engine([ TEMPLATES, CORE ], {}, {});
	const { env, calls } = environment({ authed: false, path: [] });
	const pathinfo = '/' + reqPath.join('/');
	env.http.getenv = k => ({ PATH_INFO: pathinfo, SCRIPT_NAME: '/cgi-bin/luci', DOCUMENT_ROOT: '/www', REQUEST_URI: '/cgi-bin/luci' + pathinfo })[k] ?? null;
	env.ctx = Object.assign({}, env.ctx, { path: [], request_path: reqPath });
	env.config = { main: {}, apply: {} };
	env.dispatched = TREE;
	env.requested = TREE;
	env.pkgs_update_time = 1700000000;
	env.lua_active = false;
	const html = coreEngine.render('error404', env, { message: '' });
	/* the core header's environment script */
	const m = /<script>\s*L = new LuCI\(([\s\S]*?)\);\s*<\/script>/.exec(html);
	return { html, calls, envText: m ? m[1] : null, lenv: m ? JSON.parse(m[1]) : null };
}

test('core 404 around the theme: the theme part adds nothing about the device', { skip: NO_CORE }, () => {
	const r = renderCore404([ 'foo' ]);
	assert.ok(r.lenv, 'found the core L.env script');
	assert.deepEqual(r.calls.ubus, [], 'ubus called for an anonymous visitor');
	const rest = r.html.replace(/<script>\s*L = new LuCI\([\s\S]*?\);\s*<\/script>/, '');
	assertNoSecrets(rest, 'core 404 without the core L.env script');
	for (const bad of [ 'vt-rail', 'menu-vantage', 'L.require' ])
		assert.ok(!rest.includes(bad), `${bad} rendered for an anonymous visitor`);
});

test('core 404 around the theme: L.env nodespec carries no page tree for an anonymous visitor', {
	skip: NO_CORE,
	todo: HAVE_CORE && 'upstream luci-base: template/header.ut prints `nodespec: dispatched`, the whole page tree on an anonymous 404; ' +
		'not fixable from a theme (docs/luci-contract.md section 2)'
}, () => {
	const { lenv } = renderCore404([ 'foo' ]);
	assert.equal(lenv.sessionid, null);
	const spec = lenv.nodespec;
	assert.ok(spec == null || (spec.children === undefined && spec.depends === undefined),
		'nodespec exposes ' + Object.keys(spec || {}).join(', '));
});

test('core 404 around the theme: a <!--<script> path cannot swallow the page', {
	skip: NO_CORE,
	todo: HAVE_CORE && 'upstream luci-base: template/header.ut escapes only "/" in the L.env JSON, not "<"; ' +
		'the theme header runs before it and cannot repair it (docs/luci-contract.md section 2)'
}, () => {
	const { envText } = renderCore404([ 'foo<!--<script>' ]);
	assert.ok(envText, 'found the core L.env script');
	/* inside a script element, "<!--" followed by "<script" enters the
	   double-escaped state: the element's own </script> no longer ends it */
	assert.ok(!/<!--/.test(envText) && !/<script/i.test(envText), 'raw <!-- / <script in the L.env script');
});
