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
			formvalue: () => o.hostile ? HOSTILE : null,
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
				return null;
			},
			get_all: () => null,
			foreach: () => {}
		},
		ctx: {
			path: o.path, request_path: o.path, request_args: [],
			authsession: o.authed ? 'a'.repeat(32) : null,
			authtoken: o.authed ? 'b'.repeat(32) : null,
			authuser: o.authed ? 'root' : null
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
		dispatched: { title: o.hostile ? SECRET.title + HOSTILE : SECRET.title },
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
	const html = engine.render(THEME + '/sysauth', env, { duser: o.hostile ? 'root' + HOSTILE : 'root', fuser: o.fuser ?? null });
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
		assert.match(html, /<title>LuCI · LuCI<\/title>/, `${what}: generic title`);
		assert.match(html, /id="maincontent"/, `${what}: #maincontent is required`);
		assert.match(html, /id="indicators"/, `${what}: #indicators is required`);
		assert.ok(!/<footer class="vt-foot">[^<]*<span/.test(html), `${what}: version footer for an anonymous visitor`);
	}
	const good = renderPage({ authed: false, path: [ 'admin', 'x' ] }).html;
	const evil = renderPage({ authed: false, path: EVIL_PATH, hostile: true }).html;
	assert.deepEqual(skeleton(evil), skeleton(good), 'anonymous markup skeleton changed');
	assert.deepEqual(inlineScripts(evil), inlineScripts(good), 'anonymous inline scripts depend on input');
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

test('login: fuser is never echoed, hostile inputs change no markup, nothing about the device', () => {
	const good = renderLogin({ path: ADMIN, fuser: 'root' });
	const evil = renderLogin({ path: EVIL_PATH, hostile: true, fuser: HOSTILE + 'FUSER-MARK' });
	assert.deepEqual(skeleton(evil.html), skeleton(good.html), 'login markup skeleton changed');
	assertNoPayload(evil.html, 'login');
	assert.ok(!evil.html.includes('FUSER-MARK'), 'fuser echoed');
	assertNoSecrets(evil.html, 'login');
	assertNoSecrets(good.html, 'login');
	assert.deepEqual(evil.calls.ubus, [], 'login page called ubus');
	assert.deepEqual(evil.calls.uci, [ 'uhttpd.main.listen_https' ], 'login page read more than the HTTPS ports');
	assert.match(evil.html, /role="alert">Invalid username and\/or password! Please try again\.</, 'generic error for a failed login');
	assert.ok(!renderLogin({ path: ADMIN }).html.includes('role="alert"'), 'no error before a login attempt');
	assert.deepEqual(inlineScripts(evil.html), inlineScripts(good.html), 'login inline scripts depend on input');
	for (const s of inlineScripts(evil.html))
		assert.ok(!/443|SECRET|alert\(|luci-static/.test(s), 'login inline script carries data');
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
