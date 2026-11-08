#!/usr/bin/env node
'use strict';
/* Offline LuCI replay server for theme work.

   Serves the LuCI web UI on 127.0.0.1 entirely from a recorded mirror
   (see README, Recording format), the device rootfs dump (core templates,
   bootstrap, menu.d) and optionally a theme under development. Nothing is
   forwarded anywhere; writes land in an in-memory uci overlay.

   usage: node server.js --mirror <dir> [--port 8025] [--theme-dir <htdocs/luci-static/name>]
                         [--theme <name>] [--templates <ucode/template dir>] [--rootfs <dir>]
                         [--app-dir <package dir>]... [--keep-uniwrt] [--[no-]synthetic] [--demo]
                         [--wired | --big] [--multiwan] [--fullvpn]
                         [--lang <LuCI language, e.g. de or zh_Hans>] [--fixtures <dir>]...

   Pages are rendered like the device does: the dispatcher logic below
   resolves the request against the recorded menu, then the core
   view/header/footer templates from the rootfs and the theme's templates
   are run through a small ucode template engine (ut.js).

   --demo pseudonymises the recording as it is loaded (demo.js): documentation
   MACs/addresses, neutral hostname/SSIDs/client names, for screenshots.

   --wired serves the device as a router without Wi-Fi (wired.js): no
   radios, the uplink renamed wan, synthetic lan/vpn/guest interfaces.

   --big serves the device as a larger access point (big.js): four radios,
   ten networks, 74 stations, five wired ports with hosts behind them.

   --multiwan adds a second line to the internet (multiwan.js): a backup
   WAN with a default route of a higher metric; with --wired or --big too.

   --fullvpn gives the 'vpn' WireGuard interface a default route at the
   uplink's metric, a full-tunnel VPN the kernel prefers (fullvpn.js);
   with --wired, --big and --multiwan too.

   --fixtures <dir> (repeatable) adds hand-written data for pages the
   recording lacks (fixtures.js): rpcd plugin stand-ins, uci configs, a small
   file system for file.read/stat/list and cgi-download, exec outputs. The
   recording always answers first.

   --lang previews a translation: the UI runs in that language with the
   theme's and apps' po/<lang>/*.po (compiled the way po2lmo does, read on
   every request) over the recorded catalogue of that language.

   Trust model: the templates (--templates, --theme-dir, the theme and app
   packages), the --rootfs dump and the *-plugin.js files of --fixtures
   directories are executed as JavaScript with your privileges (ut.js
   compiles .ut files to functions; plugins are require()d). This is not a
   sandbox: use only themes, dumps and fixtures you trust, or run the
   replay in a disposable container or as an unprivileged user. Recorded
   data, the rest of a fixture directory and HTTP requests only ever reach
   templates as values.

   HTTP: only requests addressed to 127.0.0.1/localhost/[::1] on --port are
   answered (DNS rebinding), cross-site POSTs are refused (CSRF), ubus
   calls need the session the login created (or fall under rpcd's
   "unauthenticated" ACL of the rootfs), and request-derived text is escaped
   before it reaches HTML or the terminal. */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Engine } = require('./ut');
const { Store, safe } = require('./store');
const { Fixtures } = require('./fixtures');
const i18n = require('../i18n/catalog');
const policy = require('./policy');
const wired = require('./wired');
const big = require('./big');
const multiwan = require('./multiwan');
const fullvpn = require('./fullvpn');

/* ------------------------------------------------------------ arguments */

function parseArgs(argv) {
	const o = { port: 8025, synthetic: true };
	for (let i = 0; i < argv.length; i++) {
		const m = /^--(mirror|port|theme-dir|theme|templates|rootfs|app-dir|lang|fixtures)(?:=(.*))?$/.exec(argv[i]);
		if (!m) { if (argv[i] === '--keep-uniwrt') o.keepUniwrt = true; else if (argv[i] === '--synthetic') o.synthetic = true; else if (argv[i] === '--no-synthetic') o.synthetic = false; else if (argv[i] === '--demo') o.demo = true; else if (argv[i] === '--wired') o.wired = true; else if (argv[i] === '--big') o.big = true; else if (argv[i] === '--multiwan') o.multiwan = true; else if (argv[i] === '--fullvpn') o.fullvpn = true; else if (argv[i] === '-h' || argv[i] === '--help') o.help = true; else o.bad = argv[i]; continue; }
		const v = (m[2] !== undefined) ? m[2] : argv[++i];
		if (m[1] === 'app-dir') (o.appDirs = o.appDirs || []).push(v);
		else if (m[1] === 'fixtures') (o.fixtures = o.fixtures || []).push(v);
		else o[m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
	}
	return o;
}

const USAGE = 'usage: server.js --mirror <dir> [--port 8025] [--theme-dir <htdocs/luci-static/name>] [--theme <name>] [--templates <dir>] [--rootfs <dir>] [--app-dir <pkg>]... [--keep-uniwrt] [--no-synthetic] [--demo] [--wired | --big] [--multiwan] [--fullvpn] [--lang <lang>] [--fixtures <dir>]...';
const opts = parseArgs(process.argv.slice(2));
if (opts.help || opts.bad || !opts.mirror) {
	console.error(opts.bad ? `unknown argument ${opts.bad}\n${USAGE}` : USAGE);
	process.exit(2);
}
if (opts.wired && opts.big) { console.error(`--wired and --big are two different devices\n${USAGE}`); process.exit(2); }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } }

const port = parseInt(opts.port, 10);
if (!(port > 0 && port < 65536)) { console.error('bad --port'); process.exit(2); }

/* device rootfs dump: --rootfs, $VANTAGE_ROOTFS, or ../vantage-rootfs next to the repository */
const rootfs = path.resolve(opts.rootfs || process.env.VANTAGE_ROOTFS ||
	path.join(__dirname, '../../../vantage-rootfs'));
const coreTemplates = path.join(rootfs, 'usr/share/ucode/luci/template');
if (!fs.existsSync(path.join(coreTemplates, 'view.ut'))) {
	console.error(`no LuCI templates under ${coreTemplates}; pass --rootfs <device rootfs dump>`);
	process.exit(2);
}

const themeDir = opts.themeDir ? path.resolve(opts.themeDir) : null;
const theme = opts.theme || (themeDir ? path.basename(themeDir) : 'bootstrap');
if (!/^[A-Za-z0-9_-]+$/.test(theme)) { console.error('bad --theme'); process.exit(2); }

/* theme packages keep templates in ucode/template next to htdocs/ */
let themeTemplates = opts.templates ? path.resolve(opts.templates) : null;
if (!themeTemplates && themeDir) {
	const guess = path.resolve(themeDir, '../../../ucode/template');
	if (fs.existsSync(guess)) themeTemplates = guess;
}

/* app packages under development (luci-app-*): htdocs/ is served before
   the mirror, root/usr/share/luci/menu.d is merged into the menu and
   root/etc/config/* seeds the uci overlay (configs the package ships) */
const appDirs = (opts.appDirs || []).map(d => path.resolve(d));
for (const d of appDirs) {
	if (!fs.existsSync(path.join(d, 'htdocs')) && !fs.existsSync(path.join(d, 'root'))) {
		console.error(`--app-dir ${d}: no htdocs/ or root/ inside`);
		process.exit(2);
	}
}

/* --lang: a LuCI language code (po/ directory name, e.g. zh_Hans) or its
   package suffix (zh-cn); LuCI itself uses the suffix (luci.main.lang
   zh_cn -> catalogue *.zh-cn.lmo, /admin/translations/zh-cn) */
let preview = null;
if (opts.lang != null) {
	const langs = i18n.languages(readText(path.join(__dirname, '../i18n/luci-languages.mk')));
	const hit = [ ...langs ].find(([ code, l ]) => code === opts.lang || l.lc === opts.lang);
	if (!hit) { console.error(`--lang ${opts.lang}: not a LuCI language (see dev/i18n/luci-languages.mk)`); process.exit(2); }
	/* the theme package is three levels above htdocs/luci-static/<name> */
	const pkgs = [ themeDir && path.resolve(themeDir, '../../..'), ...appDirs ].filter(Boolean);
	preview = { code: hit[0], lc: hit[1].lc, dirs: pkgs.map(d => path.join(d, 'po', hit[0])) };
}

for (const d of opts.fixtures || []) {
	let st = null;
	try { st = fs.statSync(d); } catch (e) {}
	if (!st || !st.isDirectory()) { console.error(`--fixtures ${d}: not a directory`); process.exit(2); }
}
const fixtures = new Fixtures(opts.fixtures);
const store = new Store(path.resolve(opts.mirror), { synthetic: opts.synthetic, demo: !!opts.demo, fixtures });

/* --------------------------------------------------------------- device */

const version = (() => {
	const v = readText(path.join(rootfs, 'usr/share/ucode/luci/version.uc'));
	const res = {
		luciname: (/branch\s*=\s*'([^']*)'/.exec(v) || [])[1] || 'LuCI',
		luciversion: (/revision\s*=\s*'([^']*)'/.exec(v) || [])[1] || '?'
	};
	const osr = readText(path.join(rootfs, 'etc/os-release')) || readText(path.join(rootfs, 'usr/lib/os-release'));
	const map = { NAME: 'distname', VERSION: 'distversion', HOME_URL: 'disturl', BUILD_ID: 'distrevision' };
	for (const line of osr.split('\n')) {
		const kv = /^(\w+)=(.*)$/.exec(line);
		if (kv && map[kv[1]]) res[map[kv[1]]] = kv[2].replace(/^["'\s]+|["'\s]+$/g, '');
	}
	return res;
})();

/* recorded menu; nodes the recording's secret filter blanked out (e.g. a
   node named "password") are restored from the rootfs menu.d */
const menuSpecs = {};
for (const f of fs.readdirSync(path.join(rootfs, 'usr/share/luci/menu.d')).filter(f => f.endsWith('.json'))) {
	try { Object.assign(menuSpecs, JSON.parse(readText(path.join(rootfs, 'usr/share/luci/menu.d', f)))); } catch (e) {}
}
function repairMenu(node, p) {
	for (const [ name, child ] of Object.entries(node.children || {})) {
		const cp = p ? p + '/' + name : name;
		if (child && typeof child === 'object') repairMenu(child, cp);
		else if (menuSpecs[cp]) node.children[name] = Object.assign({ satisfied: true }, menuSpecs[cp]);
		else delete node.children[name];
	}
	return node;
}
/* the device still runs the old UniWRT theme, whose pages (Dashboard,
   theme settings) need that theme's CSS; drop them unless asked */
function dropUniwrt(node) {
	for (const [ name, child ] of Object.entries(node.children || {})) {
		if (/^uniwrt\//.test((child.action && child.action.path) || '')) delete node.children[name];
		else dropUniwrt(child);
	}
	return node;
}
/* menu.d entries of the app packages, as the device's dispatcher would
   merge them: missing parents become firstchild nodes */
function readMenuDir(dir) {
	const specs = {};
	let files = [];
	try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch (e) { return specs; }
	for (const f of files) {
		try { Object.assign(specs, JSON.parse(readText(path.join(dir, f)))); }
		catch (e) { console.error(`[replay] ${path.join(dir, f)}: ${e.message}`); }
	}
	return specs;
}
/* depends.fs on a page's files under /www, as the dispatcher checks it,
   against the rootfs dump and the app packages' htdocs: an entry whose
   view isn't there (luci-mod-dashboard's page) stays hidden. Other paths
   (an add-on's binaries) count as present: fixtures stand in for them */
function fsSatisfied(spec) {
	const d = spec.depends && spec.depends.fs;
	if (!d || typeof d !== 'object') return true;
	const bases = [ rootfs, ...appDirs.map(a => path.join(a, 'htdocs')) ];
	const present = p => bases.some((b, i) => fs.existsSync(path.join(b, i ? p.slice(4) : p)));
	const holds = (p, kind) => !/^\/www\//.test(p) || p.split('/').includes('..') || (kind === 'absent' ? !present(p) : present(p));
	return (Array.isArray(d) ? d : [ d ]).some(alt => alt && typeof alt === 'object' && Object.entries(alt).every(([ p, kind ]) => holds(p, kind)));
}
function mergeMenu(root, specs) {
	for (const [ p, spec ] of Object.entries(specs)) {
		if (!spec || typeof spec !== 'object' || !/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(p)) continue;
		let node = root;
		const segs = p.split('/');
		segs.forEach((seg, i) => {
			node.children = node.children || {};
			if (i === segs.length - 1)
				node.children[seg] = Object.assign({ satisfied: true }, node.children[seg] && node.children[seg].children ? { children: node.children[seg].children } : {}, spec, { satisfied: fsSatisfied(spec) });
			else if (!node.children[seg] || typeof node.children[seg] !== 'object')
				node.children[seg] = { satisfied: true, action: { type: 'firstchild' }, children: {} };
			node = node.children[seg];
		});
	}
	return root;
}
const appMenu = {};
for (const d of appDirs) Object.assign(appMenu, readMenuDir(path.join(d, 'root/usr/share/luci/menu.d')));
Object.assign(menuSpecs, appMenu);

const recordedMenu = repairMenu(store.menu() || { action: { type: 'firstchild' }, children: {} }, '');
const menu = mergeMenu(opts.keepUniwrt ? recordedMenu : dropUniwrt(recordedMenu), appMenu);

/* fixture configs, before the packages' defaults: new configs are seeded,
   recorded ones only gain the sections they lack (e.g. a WireGuard
   interface in network) */
for (const [ name, file ] of fixtures.configs()) {
	const values = parseUci(readText(file));
	if (!store.uciSeed(name, values)) store.uciAddSections(name, values);
}
/* uci configs shipped by the app packages and the theme's
   (/etc/config/vantage_theme), unless the mirror has them */
for (const d of appDirs.concat(themeDir ? [ path.resolve(themeDir, '../../..') ] : [])) {
	const cdir = path.join(d, 'root/etc/config');
	let files = [];
	try { files = fs.readdirSync(cdir).filter(f => /^[A-Za-z0-9_-]+$/.test(f)); } catch (e) {}
	for (const f of files) store.uciSeed(f, parseUci(readText(path.join(cdir, f))));
}
if (!store.menu()) console.error('[replay] no recorded menu in the mirror; pages will 404');

/* minimal uci file parser (config/option/list) -> rpcd-style values */
function parseUci(text) {
	const out = {};
	let cur = null, idx = 0;
	const unq = v => { const m = /^'([^']*)'$|^"([^"]*)"$/.exec(v); return m ? (m[1] ?? m[2]) : v; };
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^(config|option|list)\s+(\S+)(?:\s+(.*))?$/.exec(line);
		if (!m) continue;
		if (m[1] === 'config') {
			const name = m[3] ? unq(m[3].trim()) : null;
			const sid = name || ('cfg' + (idx + 1).toString(16).padStart(2, '0') + crypto.createHash('sha1').update(m[2] + idx).digest('hex').slice(0, 4));
			cur = out[sid] = { '.anonymous': !name, '.type': unq(m[2]), '.name': sid, '.index': idx++ };
		}
		else if (cur && m[3] != null) {
			const k = unq(m[2]), v = unq(m[3].trim());
			if (m[1] === 'list') (cur[k] = Array.isArray(cur[k]) ? cur[k] : []).push(v);
			else cur[k] = v;
		}
	}
	return out;
}

/* rpcd ACL group "unauthenticated" of the rootfs: what a call without the
   login session may do (session.access/login, luci.getFeatures) */
const anonAcl = new Map();
{
	const dir = path.join(rootfs, 'usr/share/rpcd/acl.d');
	let files = [];
	try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) {}
	for (const f of files) {
		let acl;
		try { acl = JSON.parse(readText(path.join(dir, f))); } catch (e) { continue; }
		const ubus = acl && acl.unauthenticated && acl.unauthenticated.read && acl.unauthenticated.read.ubus;
		if (!ubus || typeof ubus !== 'object') continue;
		for (const [ obj, methods ] of Object.entries(ubus))
			if (Array.isArray(methods)) for (const m of methods) if (typeof m === 'string') {
				if (!anonAcl.has(obj)) anonAcl.set(obj, new Set());
				anonAcl.get(obj).add(m);
			}
	}
}
const anonAllowed = (o, m) => anonAcl.has(o) && (anonAcl.get(o).has(m) || anonAcl.get(o).has('*'));

const luciMain = store.uciGet('luci', 'main') || {};
const lang = preview ? preview.lc : (!luciMain.lang || luciMain.lang === 'auto') ? 'en' : String(luciMain.lang).replace('_', '-');

/* the --lang catalogue: key hash -> text, the recorded one for the language
   first, then every po/<lang>/*.po of the packages (theirs win, as the
   later key in window.TR does); rebuilt per request so edits show on reload */
function previewCatalogue() {
	const cat = new Map(i18n.parseTranslationsJs(store.translations(preview.lc)));
	for (const dir of preview.dirs) {
		let files = [];
		try { files = fs.readdirSync(dir).filter(f => f.endsWith('.po')).sort(); } catch (e) { continue; }
		for (const f of files) {
			let entries;
			try { entries = i18n.lmoEntries(fs.readFileSync(path.join(dir, f), 'utf8')); }
			catch (e) { console.error(`[replay] ${safe(path.join(dir, f))}: ${safe(e.message)}`); continue; }
			/* po2lmo writes its index sorted by key */
			for (const [ k, v ] of entries.sort((a, b) => a[0] - b[0])) { cat.delete(k); cat.set(k, v); }
		}
	}
	return cat;
}

/* ucode's _() (dispatcher.uc: translate(...) ?? key): lmo.c
   lmo_canon_hash() collapses ASCII whitespace and trims before hashing */
const canon = s => s.replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ | $/g, '');
function templateTranslate(cat) {
	return (key, ctx) => {
		if (typeof key !== 'string' || (ctx != null && typeof ctx !== 'string')) return key;
		const k = (ctx != null ? canon(ctx) + '\u0001' : '') + canon(key);
		const v = k ? cat.get(i18n.sfh(k)) : undefined;
		return v === undefined ? key : v;
	};
}
const startTime = Math.floor(Date.now() / 1000);

/* fake session: any login is accepted */
const SID = crypto.randomBytes(16).toString('hex');
/* luci.vantage routes (vantage-plugin.js) makes the kernel's table from
   the interface dump the dashboard gets: after --wired, --big,
   --multiwan and --fullvpn rewrote it */
store.ifaceDump = () => {
	const r = ubusReply({ jsonrpc: '2.0', id: 0, method: 'call', params: [ SID, 'network.interface', 'dump', {} ] }).result;
	return Array.isArray(r) && r[0] === 0 && r[1] && Array.isArray(r[1].interface) ? r[1].interface : null;
};
const TOKEN = crypto.randomBytes(16).toString('hex');
const SCRIPT = '/cgi-bin/luci';

/* ------------------------------------------------------------ templates */

/* shell used when the selected theme has no header/footer templates */
const SHELL = {
	[`themes/${theme}/header`]: `{%
	const boardinfo = ubus.call('system', 'board');
-%}
<!DOCTYPE html>
<html lang="{{ dispatcher.lang }}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ striptags(\`\${boardinfo?.hostname ?? '?'}\${dispatched?.title ? \` | \${_(dispatched.title)}\` : ''}\`) }}</title>
<link rel="stylesheet" href="{{ media }}/cascade.css">
<script src="{{ dispatcher.build_url('admin/translations', dispatcher.lang) }}"></script>
<script src="{{ resource }}/cbi.js"></script>
</head>
<body class="lang_{{ dispatcher.lang }}" data-page="{{ entityencode(join('-', ctx.request_path), true) }}">
{% if (!blank_page): %}
<header>
	<a class="brand" href="/">{{ striptags(boardinfo?.hostname ?? '?') }}</a>
	<ul class="nav" id="topmenu" style="display:none"></ul>
	<div id="indicators"></div>
</header>
<div id="maincontent" class="container">
	<div id="tabmenu" style="display:none"></div>
{% endif %}
`,
	[`themes/${theme}/footer`]: `{% if (!blank_page): %}
</div>
<footer><ul class="breadcrumb" id="modemenu" style="display:none"></ul></footer>
<script>L.require('menu-{{ theme }}').catch(function() { return L.require('menu-bootstrap') })</script>
{% endif %}
</body>
</html>
`
};

const engine = new Engine([ themeTemplates, coreTemplates ].filter(Boolean), SHELL, {
	'luci.core': { getuid: () => 0, getspnam: () => ({ pwdp: '*' }) },
	'fs': { basename: p => path.posix.basename(String(p)), access: () => false, stat: () => null, readfile: () => null },
	'luci.version': { revision: version.luciversion, branch: version.luciname }
});

const shellTheme = engine.locate(`themes/${theme}/header`).startsWith('builtin:');

/* ----------------------------------------------------------- dispatcher */

function nodeWeight(n) { return Math.min(n.order ?? 9999, 9999) + (n.auth && n.auth.login ? 10000 : 0); }
const authOf = (n, inherited) => (n.auth && typeof n.auth === 'object') ? n.auth : inherited;

function resolveFirstchild(node, ctx) {
	let best = null, bestCtx = null;
	for (const [ name, child ] of Object.entries(node.children || {})) {
		if (!child || typeof child !== 'object' || !child.satisfied || !child.title || !child.action || typeof child.action !== 'object') continue;
		if (best && nodeWeight(best) <= nodeWeight(child)) continue;
		const cctx = { path: ctx.path.concat(name), auth: authOf(child, ctx.auth) };
		if (child.action.type === 'firstchild') {
			if (resolveFirstchild(child, cctx)) { best = child; bestCtx = cctx; }
		}
		else if (!child.firstchild_ineligible) { best = child; bestCtx = cctx; }
	}
	if (!best) return false;
	Object.assign(ctx, bestCtx);
	return true;
}

function resolvePage(reqPath) {
	let node = menu;
	const ctx = { path: [], auth: null, request_args: [] };
	for (let i = 0; i < reqPath.length; i++) {
		node = node && node.children && node.children[reqPath[i]];
		if (!node || typeof node !== 'object' || !node.satisfied) break;
		ctx.path.push(reqPath[i]);
		ctx.auth = authOf(node, ctx.auth);
		if (node.wildcard && !(node.children && node.children[reqPath[i + 1]] && node.children[reqPath[i + 1]].satisfied)) {
			ctx.request_args = reqPath.slice(i + 1);
			break;
		}
	}
	if (node && node.action && node.action.type === 'firstchild') resolveFirstchild(node, ctx);
	ctx.request_path = reqPath.slice();
	let n = menu;
	for (const s of ctx.path) n = n.children[s];
	return { node: n, ctx };
}

function lookup(...segments) {
	let node = menu;
	const p = [];
	for (const seg of segments) for (const s of String(seg).split('/')) p.push(s);
	for (const s of p) {
		node = node.children && node.children[s];
		if (!node) return null;
		if (node.leaf) break;
	}
	return { node, url: buildUrl(...p) };
}

function buildUrl(...p) {
	const parts = p.filter(x => /^[A-Za-z0-9_%.\/,;-]+$/.test(String(x)));
	return parts.length ? SCRIPT + '/' + parts.join('/') : SCRIPT + '/';
}

/* the logged-in session's groups, as rpcd grants them to root (read and
   write '*'): every group of the packages' rpcd ACL files, for templates
   that look at ctx.authacl (the theme's Appearance) */
const ACL_GROUPS = {};
for (const d of appDirs.concat(themeDir ? [ path.resolve(themeDir, '../../..') ] : [])) {
	const adir = path.join(d, 'root/usr/share/rpcd/acl.d');
	let files = [];
	try { files = fs.readdirSync(adir).filter(f => /^[A-Za-z0-9_.-]+\.json$/.test(f)); } catch (e) {}
	for (const f of files) {
		let acl = null;
		try { acl = JSON.parse(readText(path.join(adir, f))); } catch (e) {}
		for (const g of Object.keys(acl && typeof acl === 'object' ? acl : {}))
			if (/^[A-Za-z0-9_.-]+$/.test(g)) ACL_GROUPS[g] = [ 'read', 'write' ];
	}
}

/* ucode environment the templates see */
function templateEnv(req, resolved, loggedIn, form) {
	const ctx = Object.assign({}, resolved.ctx, {
		authsession: loggedIn ? SID : null, authtoken: loggedIn ? TOKEN : null, authuser: loggedIn ? 'root' : null,
		authacl: loggedIn ? { 'access-group': Object.assign({}, ACL_GROUPS) } : null
	});
	const getenv = k => ({
		SCRIPT_NAME: SCRIPT, PATH_INFO: '/' + resolved.ctx.request_path.join('/'), DOCUMENT_ROOT: '/www',
		REQUEST_METHOD: req.method, HTTPS: 'off', REMOTE_ADDR: '127.0.0.1', HTTP_HOST: req.headers.host || ''
	})[k] ?? null;
	return {
		http: {
			getenv, prepare_content() {}, header() {}, status() {}, write_headers() {},
			formvalue: k => form[k] ?? null, getcookie: k => cookies(req)[k] ?? null
		},
		ubus: { call: (o, m, a) => store.data(o, m, a), error: () => null, list: () => store.list() },
		uci: {
			/* no https listener here: keeps the login page from probing localhost:443 */
			get: (c, s, o) => (c === 'uhttpd' && o === 'listen_https') ? null : store.uciGet(c, s, o),
			get_all: (c, s) => store.uciGet(c, s),
			/* the first section of a type: its option, or its name without one */
			get_first: (c, t, o) => {
				for (const s of Object.values(store.uciGet(c) || {})) if (s['.type'] === t) return o ? (s[o] ?? null) : s['.name'];
				return null;
			},
			foreach: (c, t, fn) => { for (const s of Object.values(store.uciGet(c) || {})) if (!t || s['.type'] === t) if (fn(s) === false) break; }
		},
		ctx, version,
		config: { main: store.uciGet('luci', 'main') || {}, apply: store.uciGet('luci', 'apply') || {} },
		dispatcher: {
			lang, build_url: buildUrl, lookup, menu_json: () => menu,
			rollback_pending: () => false, is_authenticated: () => loggedIn ? { sid: SID } : null
		},
		media: '/luci-static/' + theme, theme, resource: '/luci-static/resources',
		pkgs_update_time: startTime, lua_active: false,
		dispatched: resolved.node, requested: resolved.node,
		...(preview ? { _: templateTranslate(previewCatalogue()) } : {})
	};
}

/* --------------------------------------------------------------- server */

function cookies(req) {
	const out = Object.create(null);
	for (const part of String(req.headers.cookie || '').split(/;\s*/)) {
		const i = part.indexOf('=');
		if (i > 0) { try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch (e) {} }
	}
	return out;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []; let n = 0;
		req.on('data', c => { n += c.length; if (n > (4 << 20)) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

/* on every response; LuCI needs inline and eval'd scripts, so the CSP is
   defence in depth and escaping is the real guard */
const HARDENING = {
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	/* not no-referrer: under that policy Chromium sends "Origin: null" on
	   same-origin form posts */
	'Referrer-Policy': 'same-origin',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Cross-Origin-Opener-Policy': 'same-origin'
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; " +
	"object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function head(res, status, headers) {
	const h = Object.assign({}, HARDENING, headers || {});
	if (/^text\/html/i.test(h['Content-Type'] || '')) h['Content-Security-Policy'] = CSP;
	res.writeHead(status, h);
}

function send(res, status, type, body, headers) {
	head(res, status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, headers || {}));
	res.end(body);
}

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const MIME = {
	'.js': 'application/javascript; charset=UTF-8', '.css': 'text/css; charset=UTF-8', '.svg': 'image/svg+xml',
	'.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
	'.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json',
	'.html': 'text/html; charset=UTF-8', '.txt': 'text/plain; charset=UTF-8', '.map': 'application/json'
};

/* a recording keeps response bodies, not statuses: a mirrored file that is
   uhttpd's 404 page was a 404 on the device too */
function recorded404(file, size) {
	if (size > 512) return false;
	try { return fs.readFileSync(file, 'utf8').startsWith('<h1>Not Found</h1>'); } catch (e) { return false; }
}

/* /luci-static lookup: theme dir, theme package htdocs, mirror, rootfs www;
   null: not found, false: recorded as a 404 */
function staticFile(rel) {
	const roots = [];
	if (themeDir) {
		if (rel.startsWith(theme + '/')) roots.push([ themeDir, rel.slice(theme.length + 1) ]);
		roots.push([ path.dirname(themeDir), rel ]);
	}
	for (const d of appDirs) roots.push([ path.join(d, 'htdocs/luci-static'), rel ]);
	for (const d of store.staticDirs) roots.push([ path.join(d, 'luci-static'), rel, true ]);
	roots.push([ path.join(rootfs, 'www/luci-static'), rel ]);
	for (const [ root, r, mirrored ] of roots) {
		const file = path.join(root, r);
		if (!file.startsWith(root + path.sep)) continue;
		let st;
		try { st = fs.statSync(file); } catch (e) { continue; }
		if (!st.isFile()) continue;
		if (mirrored && recorded404(file, st.size)) return false;
		return file;
	}
	return null;
}

function ubusReply(msg) {
	const reply = { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null };
	if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.id == null)
		return Object.assign(reply, { id: null, error: { code: -32600, message: 'Invalid request' } });
	/* object and method names only, as uhttpd lists them */
	if (msg.method === 'list')
		return Object.assign(reply, { result: store.list(msg.params) });
	if (msg.method !== 'call')
		return Object.assign(reply, { error: { code: -32601, message: 'Method not found' } });
	if (!Array.isArray(msg.params) || msg.params.length < 3)
		return Object.assign(reply, { error: { code: -32600, message: 'Invalid parameters' } });
	const [ sid, object, method, args ] = msg.params;
	if (args != null && (typeof args !== 'object' || Array.isArray(args)))
		return Object.assign(reply, { error: { code: -32602, message: 'Invalid parameters' } });
	if (sid !== SID) {
		/* like rpcd: without the login session only the unauthenticated ACL */
		if (!anonAllowed(object, method)) return Object.assign(reply, { error: { code: -32002, message: 'Access denied' } });
		if (object === 'session' && method === 'access')
			return Object.assign(reply, { result: [ 0, { access: !!(args && args.scope === 'ubus' && anonAllowed(args.object, args.function)) } ] });
	}
	/* one device by name, as netifd answers it: that device's entry in
	   the (transformed) dump, which is what the recording has */
	if (object === 'network.device' && method === 'status' && args && typeof args.name === 'string' && Object.keys(args).length === 1) {
		const all = ubusReply({ jsonrpc: '2.0', id: reply.id, method: 'call', params: [ sid, object, method, {} ] }).result;
		const devs = Array.isArray(all) && all[0] === 0 && all[1] && typeof all[1] === 'object' ? all[1] : null;
		return Object.assign(reply, { result: devs && Object.prototype.hasOwnProperty.call(devs, args.name) ? [ 0, devs[args.name] ] : [ 4 ] });
	}
	const r = store.call(object, method, args || {});
	const dev = opts.wired ? wired.transform(object, method, args, r) : opts.big ? big.transform(object, method, args, r) : r;
	const lines = opts.multiwan ? multiwan.transform(object, method, args, dev) : dev;
	return Object.assign(reply, opts.fullvpn ? fullvpn.transform(object, method, args, lines) : lines);
}

async function handleUbus(req, res) {
	if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed');
	/* LuCI's rpc.js posts JSON; a text/plain "simple" cross-site POST is not */
	if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, 'text/plain', 'Unsupported Media Type');
	let body;
	try { body = JSON.parse(await readBody(req)); }
	catch (e) { return send(res, 200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); }
	send(res, 200, 'application/json; charset=UTF-8', JSON.stringify(Array.isArray(body) ? body.map(m => ubusReply(m)) : ubusReply(body)));
}

/* /admin/uci/* endpoints of the apply/confirm/revert flow */
function handleUciAction(action, res) {
	switch (action) {
	case 'apply_rollback':
		if (!store.uciPending()) return send(res, 204, 'text/plain', '');
		store.uciCommit();
		console.error('[replay] apply (checked): changes committed to the in-memory overlay');
		return send(res, 200, 'application/json; charset=UTF-8', JSON.stringify({ token: crypto.randomBytes(16).toString('hex') }));
	case 'apply_unchecked':
		store.uciCommit();
		console.error('[replay] apply (unchecked): changes committed to the in-memory overlay');
		return send(res, 204, 'text/plain', '');
	case 'confirm':
		return send(res, 204, 'text/plain', '');
	case 'revert':
		store.uciRevert();
		return send(res, 200, 'text/plain', 'OK');
	}
	return send(res, 404, 'text/plain', 'Not found');
}

function renderPage(res, status, name, env, scope, headers) {
	let html;
	try { html = engine.render(name, env, scope); }
	catch (err) {
		console.error(`[replay] render ${safe(name)}: ${safe(err.stack || err)}`);
		return send(res, 500, 'text/plain; charset=UTF-8', `Template error while rendering ${name}:\n\n${err.stack || err}`);
	}
	send(res, status, 'text/html; charset=UTF-8', html, headers);
}

async function dispatch(req, res, reqPath, depth) {
	const form = Object.create(null);
	if (req.method === 'POST' && /x-www-form-urlencoded/.test(req.headers['content-type'] || ''))
		for (const [ k, v ] of new URLSearchParams(await readBody(req))) form[k] = v;
	const loggedIn = cookies(req).sysauth_http === SID;
	const resolved = resolvePage(reqPath);
	const needAuth = resolved.ctx.auth && Object.keys(resolved.ctx.auth).length > 0;

	if (needAuth && !loggedIn) {
		if (form.luci_username != null && form.luci_password != null) {
			head(res, 302, { 'Location': buildUrl(...resolved.ctx.request_path),
				'Set-Cookie': `sysauth_http=${SID}; path=${SCRIPT}/; SameSite=strict; HttpOnly`, 'Cache-Control': 'no-store' });
			return res.end();
		}
		resolved.ctx.path = [];
		const env = templateEnv(req, resolved, false, form);
		const tpl = engine.exists(`themes/${theme}/sysauth`) ? `themes/${theme}/sysauth` : 'sysauth';
		return renderPage(res, 403, tpl, env, { duser: 'root', fuser: null }, { 'X-LuCI-Login-Required': 'yes' });
	}

	let action = resolved.node && resolved.node.action;
	if (resolved.ctx.request_args.length && resolved.node.wildcardaction) action = resolved.node.wildcardaction;
	if (action && action.type === 'arcombine') action = (action.targets || [])[resolved.ctx.request_args.length ? 1 : 0];
	const env = templateEnv(req, resolved, loggedIn, form);

	switch (action && action.type) {
	case 'view':
		return renderPage(res, 200, 'view', env, { view: action.path });
	case 'template':
		if (!engine.exists(action.path)) break;
		return renderPage(res, 200, action.path, env, {});
	case 'alias':
		if (depth > 8) break;
		return dispatch(req, res, action.path.split('/').concat(resolved.ctx.request_args), depth + 1);
	case 'rewrite':
		if (depth > 8) break;
		return dispatch(req, res, reqPath.slice(action.remove || 0).concat(action.path.split('/'), resolved.ctx.request_args), depth + 1);
	}
	const what = action ? `${action.type} action${action.path ? ' ' + action.path : action.function ? ' ' + action.module + '.' + action.function : ''}` : 'no page';
	const where = '/' + reqPath.join('/');
	console.error(`[replay] not replayable: ${safe(where)} (${safe(what)})`);
	/* error404.ut prints the message raw; the path is entity-encoded like
	   upstream's dispatcher does */
	if (engine.exists('error404')) return renderPage(res, 404, 'error404', env, { message: `No page is registered at '${esc(where)}' in the replay (${esc(what)}).` });
	send(res, 404, 'text/plain; charset=UTF-8', `No page is registered at '${where}' in the replay (${what}).`);
}

const missing = new Set();

/* the names this server answers to: anything else in Host is a DNS
   rebinding attempt or a mistake */
const HOSTS = new Set([ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ]);
const ORIGINS = new Set([ ...HOSTS ].map(h => 'http://' + h));

function refuseForeign(req, res) {
	const host = String(req.headers.host || '').toLowerCase();
	if (!HOSTS.has(host)) {
		send(res, 421, 'text/plain', 'Misdirected request: this replay only answers to 127.0.0.1, localhost and [::1] on its port\n');
		return true;
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		/* Sec-Fetch-Site decides when the browser sends it (same-origin, or
		   none for a user-initiated request); a form POST can carry
		   "Origin: null" then. Without it, an Origin must be ours. */
		const site = req.headers['sec-fetch-site'];
		const origin = req.headers.origin;
		const own = origin == null || ORIGINS.has(String(origin).toLowerCase());
		const ok = (site != null) ? ((site === 'same-origin' || site === 'none') && (own || origin === 'null')) : own;
		if (!ok) {
			console.error(`[replay] refused cross-site ${safe(req.method)} ${safe(req.url)} (origin ${safe(origin ?? '-')}, sec-fetch-site ${safe(site ?? '-')})`);
			send(res, 403, 'text/plain', 'Cross-site request refused\n');
			return true;
		}
	}
	return false;
}

async function handle(req, res) {
	if (refuseForeign(req, res)) return;
	const url = new URL(req.url, 'http://127.0.0.1');
	let p;
	try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'text/plain', 'Bad request'); }
	/* uhttpd/LuCI paths never contain control characters */
	if (/[\x00-\x1f\x7f]/.test(p)) return send(res, 400, 'text/plain', 'Bad request');

	if (p === '/' || p === '/index.html' || p === SCRIPT) {
		head(res, 302, { 'Location': SCRIPT + '/' }); return res.end();
	}
	if (p.startsWith('/luci-static/')) {
		const file = staticFile(p.slice('/luci-static/'.length));
		if (!file) {
			if (!missing.has(p) && missing.size < 4096) { missing.add(p); console.error(`[replay] static ${file === false ? '404 (as on the device)' : 'not found'}: ${safe(p)}`); }
			return send(res, 404, 'text/plain', 'Not found');
		}
		head(res, 200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
		return fs.createReadStream(file).pipe(res);
	}
	if (/^\/ubus(\/|$)/.test(p) || p.startsWith(SCRIPT + '/admin/ubus')) return handleUbus(req, res);

	if (p === '/cgi-bin/cgi-exec') {
		if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed');
		/* parsed like cgi-io; the session id must be the login's */
		const r = policy.parseCgiExec(await readBody(req));
		if (!r.ok || r.sessionid !== SID) return send(res, 403, 'text/plain', 'Exec permission denied');
		const argv = r.argv;
		const out = store.execText(argv);
		if (out == null) {
			store.warn('unrecorded cgi-exec (answered 403)', JSON.stringify(argv));
			return send(res, 403, 'text/plain', 'Access to command denied by ACL');
		}
		return send(res, 200, 'text/plain; charset=UTF-8', out);
	}
	if (p === '/cgi-bin/cgi-download' && fixtures.dirs.length) {
		/* fs.read_direct() (cgi-io): the login session, then fixture files
		   only, never the host's or the recording's */
		if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed');
		const q = new URLSearchParams(await readBody(req));
		if (q.get('sessionid') !== SID) return send(res, 403, 'text/plain', 'Download permission denied');
		const body = fixtures.read(q.get('path'));
		if (body == null) {
			store.warn('no fixture for cgi-download (answered 404)', String(q.get('path')));
			return send(res, 404, 'text/plain', 'No such file');
		}
		return send(res, 200, 'application/octet-stream', body, { 'Content-Disposition': 'attachment' });
	}
	if (p.startsWith('/cgi-bin/') && !p.startsWith(SCRIPT + '/')) {
		console.error(`[replay] refused ${safe(req.method)} ${safe(p)}`);
		return send(res, 403, 'text/plain', 'Not available in the replay');
	}
	if (!p.startsWith(SCRIPT + '/')) return send(res, 404, 'text/plain', 'Not found');

	const segs = p.slice(SCRIPT.length).split('/').filter(Boolean);
	const sub = segs.join('/');
	if (sub === 'admin/menu') return send(res, 200, 'application/json; charset=UTF-8', JSON.stringify(menu));
	if (segs[0] === 'admin' && segs[1] === 'translations') {
		const want = segs[2] || lang;
		const body = (preview && want === preview.lc) ? i18n.translationsJs([ ...previewCatalogue() ]) : store.translations(want);
		return send(res, 200, 'application/javascript; charset=UTF-8', body);
	}
	if (segs[0] === 'admin' && segs[1] === 'uci' && segs[2]) {
		if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed');
		await readBody(req);
		/* ui.js sends ?sid=<session>; the cookie comes along same-origin */
		if (cookies(req).sysauth_http !== SID && url.searchParams.get('sid') !== SID) return send(res, 403, 'text/plain', 'Forbidden');
		return handleUciAction(segs[2], res);
	}
	if (sub === 'admin/logout') {
		head(res, 302, { 'Location': SCRIPT + '/', 'Set-Cookie': `sysauth_http=; expires=Thu, 01 Jan 1970 01:00:00 GMT; path=${SCRIPT}/` });
		return res.end();
	}
	return dispatch(req, res, segs, 0);
}

const server = http.createServer((req, res) => {
	handle(req, res).catch(err => {
		console.error(`[replay] ${safe(req.method)} ${safe(req.url)}: ${safe(err.stack || err)}`);
		if (!res.headersSent) send(res, 500, 'text/plain', 'Internal error (see the replay log)');
		else res.end();
	});
});

server.listen(port, '127.0.0.1', () => {
	console.error(`[replay] http://127.0.0.1:${port}/  theme=${theme}${shellTheme ? ' (built-in shell templates)' : ''}`);
	console.error(`[replay] templates: ${engine.roots.join(', ')}`);
	console.error(`[replay] static: ${[ themeDir, ...appDirs.map(d => path.join(d, 'htdocs')), ...store.staticDirs, path.join(rootfs, 'www') ].filter(Boolean).join(', ')}`);
	if (appDirs.length) console.error(`[replay] apps: ${appDirs.join(', ')} (menu: ${Object.keys(appMenu).join(', ') || 'none'})`);
	console.error(`[replay] ${store.exact.size} recorded calls, ${store.series.size} time series (${store.interval} ms), ${store.exec.size} exec outputs`);
	if (store.demo) console.error(`[replay] DEMO mode: recording pseudonymised (${store.demo.macs.size} MACs, ${store.demo.v4nets.size + store.demo.v4other.size} IPv4 networks/addresses, ${store.demo.v6nets.size} IPv6 prefixes, ${store.demo.names.size} names)`);
	console.error(`[replay] synthetic data ${store.synthetic ? 'ON (realtime stats, conntrack list, wifi scan; --no-synthetic to disable)' : 'OFF'}`);
	if (store.plugins.size) console.error(`[replay] plugins: ${[ ...store.plugins.keys() ].join(', ')}`);
	if (fixtures.dirs.length) console.error(`[replay] fixtures: ${fixtures.dirs.join(', ')} (${fixtures.pluginFiles().length} plugin files, ${fixtures.configs().length} uci configs, ${fixtures.exec.size} exec outputs)`);
	if (preview) console.error(`[replay] language ${preview.code} (${preview.lc}): catalogues from ${preview.dirs.join(', ')} over the recorded one`);
});
