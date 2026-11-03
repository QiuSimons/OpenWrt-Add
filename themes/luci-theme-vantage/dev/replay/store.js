'use strict';
/* Recorded device data for the replay server.

   Loads every browser-* and ssh-* directory of a mirror (oldest first, so
   newer recordings win for identical keys), pseudonymises it with
   opts.demo (demo.js), and answers ubus calls:
     0. plugins        dev/replay/*-plugin.js stand-ins for rpcd plugins the
                       replay cannot run (see "Plugins" below)
     1. uci.*          in-memory overlay seeded from recorded uci.get, so
                       Save/Apply visibly work for the session
     2. session.access always granted
     2b. synthetic     (unless opts.synthetic === false) generated replies
                       for what the device cannot provide: getRealtimeStats,
                       getConntrackList, iwinfo scan (see synthetic.js)
     3. ssh series     exact object/method/args: cycles through samples by
                       wall clock, so pollers see changing data
     4. browser rows   exact object/method/args
     5. loose match    same object/method, other args (not for file/uci,
                       whose args select the resource)
     6. dropped writes known state-changing calls answer success
     7. anything else  [ 4 ] (UBUS_STATUS_NOT_FOUND), logged once
   Nothing is ever forwarded: there is no upstream.

   Plugins: every dev/replay/<name>-plugin.js is loaded at start, then the
   --fixtures ones (fixtures.js; they cannot replace a built-in plugin, uci
   or session). A plugin exports
     OBJECT (or OBJECTS: [ ... ])  the ubus object name(s) it answers
     call(store, method, args, next)
                                   -> { result: [ status, data? ] } | { error };
                                   next() is the reply without the plugin
     POLICY (optional)             { method: { arg: type } }, for `list`
   and may use the store API (data, call, uci, uciGet, uciSeed, fixtures).

   Fixtures (opts.fixtures, a fixtures.js Fixtures) answer file.read/stat/
   list and file.exec only where the recording has no answer.

   The uci overlay keeps configs and sections in prototype-less objects and
   refuses names libuci would refuse (uci_validate_name), so a request can
   neither reach Object.prototype nor create state the device could not. */

const fs = require('fs');
const path = require('path');
const { Synthetic } = require('./synthetic');

const NOT_FOUND = 4;
const INVALID_ARGUMENT = 2;

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
/* libuci: config names [A-Za-z0-9_-], section/option/type names [A-Za-z0-9_] */
const UCI_CONFIG = /^[A-Za-z0-9_-]{1,64}$/;
const UCI_NAME = /^[A-Za-z0-9_]{1,64}$/;
const UNSAFE_KEY = new Set([ '__proto__', 'constructor', 'prototype' ]);
const uciName = (v, re) => typeof v === 'string' && re.test(v) && !UNSAFE_KEY.has(v);

/* request-derived text on the terminal: control characters (C0, DEL, C1,
   which some terminals read as CSI) escaped */
const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));

/* deep copy with prototype-less objects (uci state) */
function nclone(v) {
	if (Array.isArray(v)) return v.map(nclone);
	if (v && typeof v === 'object') {
		const o = Object.create(null);
		for (const k of Object.keys(v)) if (!UNSAFE_KEY.has(k)) o[k] = nclone(v[k]);
		return o;
	}
	return v;
}

/* optional stand-ins for rpcd plugins: dev/replay/<name>-plugin.js, then
   those of --fixtures directories, which may not replace a built-in one or
   the replay's own uci overlay and session */
const RESERVED = new Set([ 'uci', 'session' ]);
function loadPlugins(extra) {
	const plugins = new Map();
	let files = [];
	try { files = fs.readdirSync(__dirname).filter(f => /^[a-z0-9_-]+-plugin\.js$/.test(f)).sort(); } catch (e) {}
	for (const f of files) {
		const mod = require(path.join(__dirname, f));
		const objects = Array.isArray(mod.OBJECTS) ? mod.OBJECTS : [ mod.OBJECT ];
		if (typeof mod.call !== 'function') continue;
		for (const o of objects) if (typeof o === 'string' && o) plugins.set(o, mod);
	}
	const builtin = new Set(plugins.keys());
	for (const f of extra || []) {
		const mod = require(f);
		const objects = Array.isArray(mod.OBJECTS) ? mod.OBJECTS : [ mod.OBJECT ];
		if (typeof mod.call !== 'function') continue;
		for (const o of objects) {
			if (typeof o !== 'string' || !o) continue;
			if (builtin.has(o) || RESERVED.has(o) || plugins.has(o)) { console.error(`[replay] ${safe(f)}: ${safe(o)} is already answered, ignored`); continue; }
			plugins.set(o, mod);
		}
	}
	return plugins;
}

/* state-changing calls a page may make on Save/Apply; answered with
   success and dropped */
const WRITES = {
	'file': [ 'write', 'remove' ],
	'luci': [ 'setInitAction', 'setLocaltime', 'setPassword' ],
	'rc': [ 'init' ],
	'system': [ 'reboot' ],
	'network': [ 'reload', 'restart' ],
	'network.interface': [ 'up', 'down', 'renew' ],
	'session': [ 'set', 'destroy' ]
};

/* stable key: sorted object keys, ubus_rpc_session ignored */
function canon(v) {
	if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
	if (v && typeof v === 'object')
		return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
	return JSON.stringify(v === undefined ? null : v);
}
function argsKey(args) {
	const a = Object.assign({}, args || {});
	delete a.ubus_rpc_session;
	return canon(a);
}

function readJsonl(file) {
	let text;
	try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
	const rows = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try { rows.push(JSON.parse(line)); } catch (e) {}   /* tolerate a half-written last line */
	}
	return rows;
}

const clone = v => (v === undefined) ? undefined : JSON.parse(JSON.stringify(v));

class Store {
	constructor(mirror, opts) {
		this.opts = opts || {};
		this.exact = new Map();     /* obj\0method\0args -> { result } | { error } */
		this.loose = new Map();     /* obj\0method -> latest reply */
		this.series = new Map();    /* obj\0method\0args -> [ data, ... ] */
		this.seriesLoose = new Map();
		this.http = new Map();      /* url path -> body */
		this.exec = new Map();      /* argv json -> stdout */
		this.objects = new Map();   /* obj -> method -> { arg: type } (for `list`) */
		this.staticDirs = [];
		this.warned = new Set();
		this.interval = 5000;
		this.t0 = Date.now();
		this.fixtures = this.opts.fixtures || null;
		this.plugins = (this.opts.plugins === false) ? new Map() : loadPlugins(this.fixtures && this.fixtures.pluginFiles());
		this.load(mirror);
		/* --demo: rewrite every recorded reply before anything reads it */
		if (this.opts.demo) this.demo = require('./demo').pseudonymiseStore(this, mirror, argsKey);
		this.uciInit();
		this.synthetic = (this.opts.synthetic === false) ? null : new Synthetic(this);
	}

	load(mirror) {
		const dirs = fs.readdirSync(mirror).filter(d => /^(browser|ssh)-/.test(d)).sort((a, b) => a.replace(/^\w+-/, '').localeCompare(b.replace(/^\w+-/, '')));
		const stamps = [];
		for (const d of dirs) {
			const dir = path.join(mirror, d);
			if (d.startsWith('browser-')) {
				for (const r of readJsonl(path.join(dir, 'rpc.jsonl')).sort((a, b) => (a.at || 0) - (b.at || 0))) {
					if (typeof r.object !== 'string' || typeof r.method !== 'string') continue;
					const reply = (r.result !== undefined) ? { result: r.result } : r.error ? { error: r.error } : null;
					if (!reply) continue;
					this.exact.set(`${r.object}\0${r.method}\0${argsKey(r.args)}`, reply);
					this.loose.set(`${r.object}\0${r.method}`, reply);
					this.note(r.object, r.method, r.args);
				}
				for (const r of readJsonl(path.join(dir, 'http.jsonl')).sort((a, b) => (a.at || 0) - (b.at || 0))) {
					if (typeof r.url !== 'string') continue;
					if (Array.isArray(r.argv)) this.exec.set(JSON.stringify(r.argv), String(r.body ?? ''));
					else this.http.set(r.url.replace(/[?#].*$/, ''), r.body);
				}
				if (fs.existsSync(path.join(dir, 'static'))) this.staticDirs.unshift(path.join(dir, 'static'));
			}
			else {
				const byKey = new Map();
				for (const r of readJsonl(path.join(dir, 'snapshots.jsonl'))) {
					if (typeof r.object !== 'string' || typeof r.method !== 'string' || r.error || r.result === undefined) continue;
					const key = `${r.object}\0${r.method}\0${argsKey(r.args)}`;
					if (!byKey.has(key)) byKey.set(key, []);
					byKey.get(key).push(r);
					if (r.at) stamps.push(r.at);
					this.note(r.object, r.method, r.args);
				}
				for (const [ key, rows ] of byKey) {
					rows.sort((a, b) => (a.at || 0) - (b.at || 0));
					this.series.set(key, rows.map(r => r.result));
					this.seriesLoose.set(key.split('\0', 2).join('\0'), key);
				}
			}
		}
		/* sample spacing: median gap between distinct snapshot times */
		const t = [ ...new Set(stamps) ].sort((a, b) => a - b);
		const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
		if (gaps.length) this.interval = Math.max(gaps[gaps.length >> 1], 1000);
	}

	note(object, method, args) {
		if (!this.objects.has(object)) this.objects.set(object, new Map());
		const m = this.objects.get(object);
		if (!m.has(method)) m.set(method, {});
		const sig = m.get(method);
		for (const [ k, v ] of Object.entries(args || {}))
			sig[k] = Array.isArray(v) ? 'array' : (v === null) ? 'unknown' : typeof v;
	}

	warn(kind, what) {
		const k = kind + ' ' + what;
		if (this.warned.has(k) || this.warned.size >= 4096) return;
		this.warned.add(k);
		console.error(`[replay] ${kind}: ${safe(what)}`);
	}

	/* current sample of a series; system.info keeps uptime/localtime moving
	   forward across wrap-arounds */
	sample(key) {
		const rows = this.series.get(key);
		const tick = Math.floor((Date.now() - this.t0) / this.interval);
		const data = clone(rows[tick % rows.length]);
		const lap = Math.floor(tick / rows.length);
		if (lap && key.startsWith('system\0info\0') && data) {
			const add = Math.round(lap * rows.length * this.interval / 1000);
			if (typeof data.uptime === 'number') data.uptime += add;
			if (typeof data.localtime === 'number') data.localtime += add;
		}
		return data;
	}

	/* JSON-RPC reply body for one ubus call: { result } or { error } */
	call(object, method, args) {
		args = (args && typeof args === 'object') ? args : {};
		if (typeof object === 'string' && this.plugins.has(object))
			return this.plugins.get(object).call(this, method, args, () => this.answer(object, method, args));
		return this.answer(object, method, args);
	}

	/* the reply without plugins: what a plugin's next() returns */
	answer(object, method, args) {
		const sig = `${object}.${method} ${argsKey(args)}`;
		if (object === 'uci') return this.uci(method, args);
		if (object === 'session' && method === 'access') return { result: [ 0, { access: true } ] };
		if (this.synthetic) {
			const syn = this.synthetic.call(object, method, args);
			if (syn) return syn;
		}

		const key = `${object}\0${method}\0${argsKey(args)}`;
		if (this.series.has(key)) return { result: [ 0, this.sample(key) ] };
		if (this.exact.has(key)) return clone(this.exact.get(key));

		if (object === 'file' && method === 'exec') {
			const argv = [ args.command ].concat(Array.isArray(args.params) ? args.params : []);
			const out = this.exec.get(JSON.stringify(argv));
			if (out != null) return { result: [ 0, { code: 0, stdout: out } ] };
			const fx = this.fixtures && this.fixtures.execText(argv);
			if (fx != null) return { result: [ 0, { code: 0, stdout: fx } ] };
			this.warn('unrecorded exec (answered NOT_FOUND)', JSON.stringify(argv));
			return { result: [ NOT_FOUND ] };
		}

		if (object === 'file' && this.fixtures) {
			const fx = this.fixtures.file(method, args);
			if (fx) return fx;
		}

		if (WRITES[object] && WRITES[object].includes(method)) {
			this.warn('write dropped (answered OK)', sig);
			return { result: [ 0 ] };
		}

		if (object !== 'file' && object !== 'uci') {
			const lk = `${object}\0${method}`;
			if (this.loose.has(lk)) { this.warn('approximate (args differ)', sig); return clone(this.loose.get(lk)); }
			if (this.seriesLoose.has(lk)) { this.warn('approximate (args differ)', sig); return { result: [ 0, this.sample(this.seriesLoose.get(lk)) ] }; }
		}

		this.warn('unknown call (answered NOT_FOUND)', sig);
		return { result: [ NOT_FOUND ] };
	}

	/* plain data for server-side template code (ubus.call in .ut files) */
	data(object, method, args) {
		const r = this.call(object, method, args);
		return (r.result && r.result[0] === 0) ? (r.result[1] ?? null) : null;
	}

	list(params) {
		if (!Array.isArray(params) || !params.length)
			return [ ...new Set([ ...this.objects.keys(), ...this.plugins.keys(), 'session', 'uci' ]) ].sort();
		const rv = {};
		for (const o of params) {
			const plugin = typeof o === 'string' && this.plugins.get(o);
			if (plugin && plugin.POLICY && typeof plugin.POLICY === 'object') {
				rv[o] = {};
				for (const [ name, sig ] of Object.entries(plugin.POLICY)) rv[o][name] = Object.assign({}, sig);
				continue;
			}
			const m = this.objects.get(o);
			if (!m) continue;
			rv[o] = {};
			for (const [ name, sig ] of m) rv[o][name] = Object.assign({}, sig);
		}
		return rv;
	}

	menu() { return clone(this.http.get('/cgi-bin/luci/admin/menu')); }

	translations(lang) {
		const body = this.http.get('/cgi-bin/luci/admin/translations/' + lang);
		return (typeof body === 'string') ? body : 'window.TR={};';
	}

	execText(argv) {
		const out = this.exec.get(JSON.stringify(argv));
		if (out == null && this.fixtures) return this.fixtures.execText(argv);
		return (out == null) ? null : out;
	}

	/* ---------------------------------------------------------- uci overlay */

	uciInit() {
		this.uciCommitted = Object.create(null);
		for (const [ key, reply ] of this.exact) {
			const [ obj, method, a ] = key.split('\0');
			if (obj !== 'uci' || method !== 'get') continue;
			const args = JSON.parse(a);
			if (Object.keys(args).length !== 1 || !uciName(args.config, UCI_CONFIG)) continue;
			const r = reply.result;
			if (Array.isArray(r) && r[0] === 0 && r[1] && r[1].values && typeof r[1].values === 'object') this.uciCommitted[args.config] = nclone(r[1].values);
		}
		this.uciStaged = nclone(this.uciCommitted);
		this.uciChanges = Object.create(null);
	}

	/* a config a package ships (e.g. /etc/config/vantage) and the mirror
	   has not recorded: known from now on, so 'uci get' answers it */
	uciSeed(config, values) {
		if (!uciName(config, UCI_CONFIG) || hasOwn(this.uciCommitted, config) || !values || typeof values !== 'object') return false;
		this.uciCommitted[config] = nclone(values);
		this.uciStaged[config] = nclone(values);
		return true;
	}

	/* fixture sections for a recorded config: only names it lacks are
	   added, so recorded sections are never replaced */
	uciAddSections(config, values) {
		if (!uciName(config, UCI_CONFIG) || !hasOwn(this.uciCommitted, config) || !values || typeof values !== 'object') return 0;
		const conf = this.uciCommitted[config];
		let n = 0, idx = Object.keys(conf).length;
		for (const [ sid, s ] of Object.entries(values)) {
			if (!uciName(sid, UCI_NAME) || hasOwn(conf, sid) || !s || typeof s !== 'object' || !uciName(s['.type'], UCI_NAME)) continue;
			const sec = { '.anonymous': !!s['.anonymous'], '.type': s['.type'], '.name': sid, '.index': idx++ };
			for (const [ k, v ] of Object.entries(s)) if (uciName(k, UCI_NAME)) sec[k] = Array.isArray(v) ? v.map(String) : String(v);
			conf[sid] = nclone(sec);
			n++;
		}
		if (n) this.uciStaged[config] = nclone(conf);
		return n;
	}

	uciPending() {
		let n = 0;
		for (const c of Object.values(this.uciChanges)) n += c.length;
		return n;
	}

	uciChange(config, entry) {
		if (!hasOwn(this.uciChanges, config)) this.uciChanges[config] = [];
		this.uciChanges[config].push(entry);
	}

	uciCommit(config) {
		for (const c of config != null ? [ config ] : Object.keys(this.uciChanges)) {
			if (!uciName(c, UCI_CONFIG)) continue;
			if (hasOwn(this.uciStaged, c)) this.uciCommitted[c] = nclone(this.uciStaged[c]);
			delete this.uciChanges[c];
		}
	}

	uciRevert(config) {
		for (const c of config != null ? [ config ] : Object.keys(this.uciChanges)) {
			if (!uciName(c, UCI_CONFIG)) continue;
			if (hasOwn(this.uciCommitted, c)) this.uciStaged[c] = nclone(this.uciCommitted[c]);
			delete this.uciChanges[c];
		}
	}

	/* committed values, for server-side templates */
	uciGet(config, section, option) {
		const c = hasOwn(this.uciCommitted, config) ? this.uciCommitted[config] : null;
		if (!c) return null;
		if (section == null) return c;
		const s = hasOwn(c, section) ? c[section] : Object.values(c).find(x => x && x['.name'] === section);
		if (!s) return null;
		return (option == null) ? s : (hasOwn(s, option) ? s[option] ?? null : null);
	}

	uci(method, a) {
		const ok = data => ({ result: data === undefined ? [ 0 ] : [ 0, data ] });
		const nf = () => ({ result: [ NOT_FOUND ] });
		const inval = () => ({ result: [ INVALID_ARGUMENT ] });
		/* names libuci would refuse never touch the overlay */
		if (a.config != null && !uciName(a.config, UCI_CONFIG)) return inval();
		for (const k of [ 'section', 'option', 'type', 'name' ]) if (a[k] != null && !uciName(a[k], UCI_NAME)) return inval();
		if (a.options != null && !(Array.isArray(a.options) && a.options.every(o => uciName(o, UCI_NAME)))) return inval();
		if (a.sections != null && !(Array.isArray(a.sections) && a.sections.every(o => uciName(o, UCI_NAME)))) return inval();
		if (a.values != null && (typeof a.values !== 'object' || Array.isArray(a.values) || !Object.keys(a.values).every(k => uciName(k, UCI_NAME)))) return inval();
		const conf = hasOwn(this.uciStaged, a.config) ? this.uciStaged[a.config] : null;
		const sec = name => (conf && hasOwn(conf, name)) ? conf[name] : null;

		switch (method) {
		case 'configs':
			return ok({ configs: Object.keys(this.uciStaged).sort() });

		case 'get':
		case 'state': {
			if (!conf) {
				const rec = this.exact.get(`uci\0get\0${argsKey(a)}`);
				if (rec) return clone(rec);
				this.warn('unknown call (answered NOT_FOUND)', `uci.${method} ${argsKey(a)}`);
				return nf();
			}
			if (a.section != null) {
				const s = sec(a.section);
				if (!s) return nf();
				if (a.option != null) return !hasOwn(s, a.option) ? nf() : ok({ value: clone(s[a.option]) });
				return ok({ values: clone(s) });
			}
			const values = {};
			for (const [ sid, s ] of Object.entries(conf))
				if (a.type == null || s['.type'] === a.type) values[sid] = clone(s);
			return ok({ values });
		}

		case 'changes':
			if (a.config != null) return ok({ changes: clone(hasOwn(this.uciChanges, a.config) ? this.uciChanges[a.config] : []) });
			return ok({ changes: clone(this.uciChanges) });

		case 'add': {
			if (!conf || typeof a.type !== 'string') return nf();
			let sid = a.name;
			if (typeof sid !== 'string' || !sid) {
				do sid = 'cfg' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
				while (hasOwn(conf, sid));
			}
			const s = Object.create(null);
			Object.assign(s, { '.anonymous': !a.name, '.type': a.type, '.name': sid, '.index': Object.keys(conf).length });
			conf[sid] = s;
			this.uciChange(a.config, [ 'add', sid, a.type ]);
			this.uciSetValues(a.config, sid, a.values);
			return ok({ section: sid });
		}

		case 'set':
			if (!sec(a.section)) return nf();
			this.uciSetValues(a.config, a.section, a.values);
			return ok();

		case 'delete': {
			if (!sec(a.section)) return nf();
			const opts = (a.option != null) ? [ a.option ] : Array.isArray(a.options) ? a.options : null;
			if (opts) {
				for (const o of opts) {
					delete sec(a.section)[o];
					this.uciChange(a.config, [ 'remove', a.section, o ]);
				}
			}
			else {
				delete conf[a.section];
				this.uciChange(a.config, [ 'remove', a.section ]);
			}
			return ok();
		}

		case 'rename': {
			if (!sec(a.section) || typeof a.name !== 'string') return nf();
			if (a.option != null) {
				const s = sec(a.section);
				if (!hasOwn(s, a.option)) return nf();
				s[a.name] = s[a.option]; delete s[a.option];
				this.uciChange(a.config, [ 'rename', a.section, a.option, a.name ]);
			}
			else {
				const s = sec(a.section);
				delete conf[a.section];
				s['.name'] = a.name; s['.anonymous'] = false;
				conf[a.name] = s;
				this.uciChange(a.config, [ 'rename', a.section, a.name ]);
			}
			return ok();
		}

		case 'order':
			if (!conf || !Array.isArray(a.sections)) return nf();
			a.sections.forEach((sid, i) => {
				if (!sec(sid)) return;
				conf[sid]['.index'] = i;
				this.uciChange(a.config, [ 'order', sid, i ]);
			});
			return ok();

		case 'commit':
			this.uciCommit(a.config);
			return ok();

		case 'revert':
			this.uciRevert(a.config);
			return ok();

		case 'apply':
			this.uciCommit();
			return ok();

		case 'confirm':
		case 'rollback':
			return ok();
		}

		this.warn('unknown call (answered NOT_FOUND)', `uci.${method} ${argsKey(a)}`);
		return nf();
	}

	uciSetValues(config, sid, values) {
		const conf = hasOwn(this.uciStaged, config) ? this.uciStaged[config] : null;
		const s = (conf && hasOwn(conf, sid)) ? conf[sid] : null;
		if (!s) return;
		for (const [ k, v ] of Object.entries(values || {})) {
			if (!uciName(k, UCI_NAME)) continue;
			if (v === '' || v == null || (Array.isArray(v) && !v.length)) {
				delete s[k];
				this.uciChange(config, [ 'remove', sid, k ]);
			}
			else {
				s[k] = Array.isArray(v) ? v.map(String) : String(v);
				this.uciChange(config, [ 'set', sid, k, s[k] ]);
			}
		}
	}
}

module.exports = { Store, canon, argsKey, safe };
