'use strict';
/* Minimal ucode template engine, enough to render LuCI's core templates
   (view/header/footer/sysauth/admin_status) and theme header/footer/sysauth
   templates on the host, without a ucode binary.

   A .ut file is compiled to a JavaScript function:
     {{ expr }}  {% code %}  {# comment #}, with -/+ whitespace trimming
     colon blocks: if/elif/else/endif, for/endfor, while/endwhile,
                   function/endfunction
     for (k in v) / for (k, v in o) with ucode semantics (values of arrays)
     `${...}` in template literals prints objects as JSON, like ucode
     import { a, b as c } from 'mod'  (modules come from the host env)
   Code runs as JavaScript in a scope where unknown names read as null.
   ucode and JS agree on the syntax LuCI templates use (let/const, arrow
   functions, ?., ??, template literals, regex literals); anything beyond
   that fails with the template name in the error.

   Trust model: a template is code. It runs in this Node process with the
   developer's privileges and can reach anything Node can (the scope below
   is for ucode semantics, not isolation: any function literal leads to the
   Function constructor). Only render templates you trust: your own theme,
   LuCI's, a rootfs dump of your own device. Data (recorded replies, HTTP
   request values) is only ever passed in as values, never compiled. */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------ transpiler */

const REGEX_PREV = /^(?:[(,=:[!&|?{};+\-*%<>~^]|return|typeof|case|do|else|in|of|delete|void|throw|new|)$/;

function skipString(s, i) {
	const q = s[i++];
	while (i < s.length && s[i] !== q) i += (s[i] === '\\') ? 2 : 1;
	return i + 1;
}

function skipRegex(s, i) {
	let cls = false;
	for (i++; i < s.length; i++) {
		if (s[i] === '\\') { i++; continue; }
		if (s[i] === '[') cls = true;
		else if (s[i] === ']') cls = false;
		else if (s[i] === '/' && !cls) break;
	}
	for (i++; i < s.length && /[a-z]/.test(s[i]); i++);
	return i;
}

/* walk code from i, rewriting template literals and for-in headers, until
   stop(s, i) holds at bracket depth 0; returns [ output, index ] */
function walk(s, i, stop) {
	let out = '', depth = 0, prev = '';
	while (i < s.length) {
		if (depth === 0 && stop && stop(s, i)) break;
		const c = s[i], c2 = s.substr(i, 2);
		if (c === '"' || c === "'") {
			const j = skipString(s, i); out += s.slice(i, j); i = j; prev = 'str';
		}
		else if (c === '`') {
			const r = walkTemplate(s, i); out += r[0]; i = r[1]; prev = 'str';
		}
		else if (c2 === '//') {
			let j = s.indexOf('\n', i); if (j < 0) j = s.length;
			out += s.slice(i, j); i = j;
		}
		else if (c2 === '/*') {
			let j = s.indexOf('*/', i + 2); j = (j < 0) ? s.length : j + 2;
			out += s.slice(i, j); i = j;
		}
		else if (c === '/' && REGEX_PREV.test(prev)) {
			const j = skipRegex(s, i); out += s.slice(i, j); i = j; prev = 're';
		}
		else if (/[A-Za-z_$0-9]/.test(c)) {
			let j = i; while (j < s.length && /[\w$.]/.test(s[j]) && !(s[j] === '.' && !/[0-9]/.test(c))) j++;
			const word = s.slice(i, j); i = j;
			if (word === 'for') {
				let k = i; while (/\s/.test(s[k])) k++;
				if (s[k] === '(') {
					const r = walk(s, k + 1, (t, x) => t[x] === ')');
					out += 'for (' + forHeader(r[0]) + ')'; i = r[1] + 1; prev = ')';
					continue;
				}
			}
			out += word; prev = word;
		}
		else {
			if ('([{'.includes(c)) depth++;
			else if (')]}'.includes(c)) depth--;
			if (!/\s/.test(c)) prev = c;
			out += c; i++;
		}
	}
	return [ out, i ];
}

function walkTemplate(s, i) {
	let out = '`';
	for (i++; i < s.length; ) {
		if (s[i] === '\\') { out += s.substr(i, 2); i += 2; }
		else if (s[i] === '`') return [ out + '`', i + 1 ];
		else if (s.substr(i, 2) === '${') {
			const r = walk(s, i + 2, (t, x) => t[x] === '}');
			out += '${__rt.str(' + r[0] + ')}'; i = r[1] + 1;
		}
		else out += s[i++];
	}
	throw new SyntaxError('unterminated template literal');
}

/* ucode: for (x in arr) iterates values, for (k, v in obj) pairs */
function forHeader(h) {
	const m = /^\s*(?:(let|const|var)\s+)?([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s+in\s+([\s\S]+)$/.exec(h);
	if (!m) return h;
	const decl = m[1] ? m[1] + ' ' : '';
	return m[3] ? `${decl}[${m[2]}, ${m[3]}] of __rt.kv(${m[4]})` : `${decl}${m[2]} of __rt.iter(${m[4]})`;
}

function rewriteImports(code) {
	return code
		.replace(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
			(_, names, q, mod) => `const {${names.replace(/\bas\b/g, ':')}} = __rt.import(${JSON.stringify(mod)});`)
		.replace(/\bimport\s*\*\s*as\s+([\w$]+)\s*from\s*(['"])([^'"]+)\2\s*;?/g,
			(_, name, q, mod) => `const ${name} = __rt.import(${JSON.stringify(mod)});`)
		.replace(/\bimport\s+([\w$]+)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
			(_, name, q, mod) => `const ${name} = __rt.import(${JSON.stringify(mod)}).default;`);
}

/* index of the ')' matching the '(' at i */
function closeParen(s, i) {
	return walk(s, i + 1, (t, x) => t[x] === ')')[1];
}

/* colon block syntax -> braces */
function blockSyntax(code) {
	const c = code.trim();
	let m;
	if (/^else\s*:?$/.test(c)) return '} else {';
	if (/^end(if|for|while|function)\s*;?$/.test(c)) return '}';
	if ((m = /^(if|elif|while|for)\s*\(/.exec(c)) && c.endsWith(':')) {
		const open = m[0].length - 1, close = closeParen(c, open);
		if (c.slice(close + 1, -1).trim() === '') {
			const cond = c.slice(open, close + 1);
			return (m[1] === 'elif') ? `} else if ${cond} {` : `${m[1]} ${cond} {`;
		}
	}
	if ((m = /^function\s+[\w$]+\s*\(/.exec(c)) && c.endsWith(':')) {
		const close = closeParen(c, m[0].length - 1);
		if (c.slice(close + 1, -1).trim() === '') return c.slice(0, close + 1) + ' {';
	}
	return code;
}

function compile(src, name) {
	let js = '', i = 0, trimLead = false;
	const text = t => {
		if (trimLead) t = t.replace(/^\s+/, '');
		trimLead = false;
		if (t) js += `__rt.w(${JSON.stringify(t)});\n`;
	};
	while (i < src.length) {
		const m = /\{([{%#])/g; m.lastIndex = i;
		const hit = m.exec(src);
		if (!hit) { text(src.slice(i)); break; }
		const kind = hit[1];
		let t = src.slice(i, hit.index), j = hit.index + 2;
		if (src[j] === '-') { t = t.replace(/\s+$/, ''); j++; }
		else if (src[j] === '+') j++;
		text(t);
		if (kind === '#') {
			const e = src.indexOf('#}', j);
			if (e < 0) throw new SyntaxError(`${name}: unterminated comment`);
			trimLead = src[e - 1] === '-'; i = e + 2;
			continue;
		}
		const end = (kind === '{') ? '}}' : '%}';
		const r = walk(src, j, (s, x) => s.startsWith(end, x) || (s[x] === '-' && s.startsWith(end, x + 1)));
		let e = r[1];
		if (e >= src.length) throw new SyntaxError(`${name}: unterminated ${kind === '{' ? '{{' : '{%'} tag`);
		if (src[e] === '-') { trimLead = true; e++; }
		i = e + 2;
		if (kind === '{') js += `__rt.w(__rt.out(${r[0]}));\n`;
		else js += blockSyntax(rewriteImports(r[0])) + ';\n';
	}
	try {
		return new Function('__scope', '__rt', `with (__scope) {\n${js}\n}`);
	}
	catch (err) {
		err.message = `${name}: ${err.message}`;
		throw err;
	}
}

/* ---------------------------------------------------------------- stdlib */

function utype(v) {
	if (v == null) return null;
	if (Array.isArray(v)) return 'array';
	if (v instanceof RegExp) return 'regexp';
	if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
	if (typeof v === 'boolean') return 'bool';
	return typeof v === 'object' ? 'object' : typeof v;
}

function tostr(v) {
	if (v == null) return 'null';
	if (typeof v === 'object' && !(v instanceof RegExp)) return JSON.stringify(v, (k, x) => x === undefined ? null : x);
	return String(v);
}

function sprintf(fmt, ...args) {
	let n = 0;
	return String(fmt).replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifxXocJj%])/g, (all, flags, width, prec, conv) => {
		if (conv === '%') return '%';
		const v = args[n++];
		let s;
		switch (conv) {
		case 'd': case 'i': s = String(Math.trunc(+v || 0)); break;
		case 'f': s = (+v || 0).toFixed(prec != null ? +prec : 6); break;
		case 'x': s = (Math.trunc(+v || 0) >>> 0).toString(16); break;
		case 'X': s = (Math.trunc(+v || 0) >>> 0).toString(16).toUpperCase(); break;
		case 'o': s = (Math.trunc(+v || 0) >>> 0).toString(8); break;
		case 'c': s = String.fromCharCode(+v || 0); break;
		case 'J': case 'j': s = JSON.stringify(v ?? null); break;
		default: s = (v == null) ? '(null)' : tostr(v); if (prec != null) s = s.slice(0, +prec);
		}
		if (width && s.length < +width) {
			const left = flags.includes('-'), zero = flags.includes('0') && !left && /[difxXo]/.test(conv);
			s = left ? s.padEnd(+width) : s.padStart(+width, zero ? '0' : ' ');
		}
		return s;
	});
}

function toGlobal(re) {
	return re.global ? re : new RegExp(re.source, re.flags + 'g');
}

const stdlib = {
	type: utype,
	length: v => (v == null) ? null : (typeof v === 'string' || Array.isArray(v)) ? v.length : (typeof v === 'object') ? Object.keys(v).length : null,
	join: (sep, a) => Array.isArray(a) ? a.map(x => x == null ? '' : tostr(x)).join(sep) : null,
	split: (s, sep, limit) => {
		if (typeof s !== 'string') return null;
		const r = s.split(sep);
		return (limit > 0 && r.length > limit) ? r.slice(0, limit - 1).concat(r.slice(limit - 1).join(typeof sep === 'string' ? sep : '')) : r;
	},
	replace: (s, pat, repl, limit) => {
		if (s == null) return null;
		s = tostr(s);
		let n = 0;
		const re = (pat instanceof RegExp) ? toGlobal(pat) : new RegExp(String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
		return s.replace(re, (...m) => {
			if (limit > 0 && n++ >= limit) return m[0];
			if (typeof repl === 'function') return tostr(repl(...m.slice(0, -2)));
			return String(repl).replace(/\$(\d|&|\$)/g, (x, d) => d === '$' ? '$' : d === '&' ? m[0] : (m[+d] ?? ''));
		});
	},
	match: (s, re) => {
		if (typeof s !== 'string' || !(re instanceof RegExp)) return null;
		if (re.global) { const all = [ ...s.matchAll(re) ].map(m => [ ...m ]); return all.length ? all : null; }
		const m = re.exec(s);
		return m ? [ ...m ] : null;
	},
	trim: (s, c) => stdlib.rtrim(stdlib.ltrim(s, c), c),
	ltrim: (s, c) => (s == null) ? null : String(s).replace(new RegExp('^[' + (c ?? ' \t\r\n').replace(/[\]\\^-]/g, '\\$&') + ']+'), ''),
	rtrim: (s, c) => (s == null) ? null : String(s).replace(new RegExp('[' + (c ?? ' \t\r\n').replace(/[\]\\^-]/g, '\\$&') + ']+$'), ''),
	substr: (s, off, len) => (s == null) ? null : (len == null ? String(s).slice(off) : String(s).substr(off < 0 ? Math.max(String(s).length + off, 0) : off, len)),
	index: (h, n) => (h == null) ? null : h.indexOf(n),
	rindex: (h, n) => (h == null) ? null : h.lastIndexOf(n),
	lc: s => (s == null) ? null : tostr(s).toLowerCase(),
	uc: s => (s == null) ? null : tostr(s).toUpperCase(),
	keys: o => (o && typeof o === 'object') ? Object.keys(o) : null,
	values: o => (o && typeof o === 'object') ? Object.values(o) : null,
	exists: (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k),
	map: (a, fn) => Array.isArray(a) ? a.map((v, i) => fn(v, i, a)) : null,
	filter: (a, fn) => Array.isArray(a) ? a.filter((v, i) => fn(v, i, a)) : null,
	sort: (a, fn) => Array.isArray(a) ? a.sort(fn ? (x, y) => { const r = fn(x, y); return typeof r === 'boolean' ? (r ? -1 : 1) : r; } : undefined) : null,
	uniq: a => Array.isArray(a) ? [ ...new Set(a) ] : null,
	reverse: a => Array.isArray(a) ? a.slice().reverse() : (typeof a === 'string') ? [ ...a ].reverse().join('') : null,
	push: (a, ...v) => { a.push(...v); return v[v.length - 1]; },
	pop: a => a.pop(), shift: a => a.shift(), unshift: (a, ...v) => { a.unshift(...v); return v[v.length - 1]; },
	splice: (a, off, len, ...v) => { a.splice(off, len ?? a.length, ...v); return a; },
	slice: (a, s, e) => a.slice(s, e),
	min: (...v) => v.length ? v.reduce((a, b) => b < a ? b : a) : null,
	max: (...v) => v.length ? v.reduce((a, b) => b > a ? b : a) : null,
	abs: v => Math.abs(v),
	int: (v, base) => { const n = parseInt(v, base || 10); return isNaN(n) ? NaN : n; },
	hex: v => parseInt(v, 16),
	ord: (s, i) => (typeof s === 'string') ? s.charCodeAt(i || 0) : null,
	chr: (...c) => String.fromCharCode(...c),
	json: s => (typeof s === 'string') ? JSON.parse(s) : s,
	time: () => Math.floor(Date.now() / 1000),
	sprintf,
	proto: (o, p) => (p === undefined) ? Object.getPrototypeOf(o) : Object.setPrototypeOf(o, p),
	regexp: (src, flags) => new RegExp(src, (flags || '').replace(/s/g, '')),
	b64enc: s => Buffer.from(String(s)).toString('base64'),
	b64dec: s => Buffer.from(String(s), 'base64').toString(),
	hexenc: s => Buffer.from(String(s)).toString('hex'),
	wildcard: (s, pat, nocase) => new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', nocase ? 'i' : '').test(s),
	warn: (...a) => { process.stderr.write(a.map(tostr).join('')); },
	die: msg => { throw new Error(tostr(msg)); },
	assert: (c, msg) => { if (!c) throw new Error(msg ?? 'Assertion failed'); return c; },
	striptags: s => (s == null) ? null : tostr(s).replace(/<[^>]*>/g, ''),
	entityencode: (s, quot) => (s == null) ? null : tostr(s).replace(/[&<>"']/g, c => (!quot && (c === '"' || c === "'")) ? c : `&#${c.charCodeAt(0)};`),
	require: name => { throw new Error(`module '${name}' not available in the replay renderer`); },
	_: s => s,
	N_: (n, s, p) => n == 1 ? s : p
};

/* template scopes inherit from stdlib; keep Object.prototype (and anything
   ever added to it) out of that chain */
Object.setPrototypeOf(stdlib, null);

/* ------------------------------------------------------------------ engine */

/* roots: template directories searched in order; builtins: name -> source
   used when no root has the file */
class Engine {
	constructor(roots, builtins, modules) {
		this.roots = roots;
		this.builtins = builtins || {};
		this.modules = modules || {};
		this.cache = new Map();
	}

	locate(name) {
		for (const root of this.roots) {
			const file = path.join(root, name + '.ut');
			if (file.startsWith(root + path.sep) && fs.existsSync(file)) return file;
		}
		return Object.prototype.hasOwnProperty.call(this.builtins, name) ? 'builtin:' + name : null;
	}

	exists(name) { return this.locate(name) != null; }

	load(name) {
		const where = this.locate(name);
		if (!where) throw new Error(`template '${name}' not found in ${this.roots.join(', ')}`);
		const builtin = where.startsWith('builtin:');
		const stamp = builtin ? 0 : fs.statSync(where).mtimeMs;
		const hit = this.cache.get(where);
		if (hit && hit.stamp === stamp) return hit.fn;
		const src = builtin ? this.builtins[name] : fs.readFileSync(where, 'utf8');
		const fn = compile(src, builtin ? `${name} (builtin)` : where);
		this.cache.set(where, { stamp, fn });
		return fn;
	}

	/* render template `name` with env; returns the output string */
	render(name, env, scope) {
		const bufs = [ [] ];
		const scopes = [];
		const rt = {
			w: s => { bufs[bufs.length - 1].push(s); },
			out: v => (v == null) ? '' : tostr(v),
			str: v => (typeof v === 'string') ? v : tostr(v),
			iter: v => Array.isArray(v) ? v : (v && typeof v === 'object') ? Object.keys(v) : [],
			kv: v => Array.isArray(v) ? v.map((x, i) => [ i, x ]) : (v && typeof v === 'object') ? Object.entries(v) : [],
			import: mod => {
				if (!Object.prototype.hasOwnProperty.call(this.modules, mod)) throw new Error(`module '${mod}' not available in the replay renderer`);
				return this.modules[mod];
			}
		};
		const capture = fn => {
			bufs.push([]);
			try { fn(); } catch (err) { bufs.pop(); throw err; }
			return bufs.pop().join('');
		};
		const renderAny = (tpl, sc) => {
			const parent = scopes.length ? scopes[scopes.length - 1] : root;
			const s = Object.assign(Object.create(parent), sc || {});
			scopes.push(s);
			try { this.load(tpl)(proxy(s), rt); }
			catch (err) {
				if (!err.utStack) { err.utStack = true; err.message = `${tpl}: ${err.message}`; }
				throw err;
			}
			finally { scopes.pop(); }
		};
		const root = Object.assign(Object.create(stdlib), {
			print: (...a) => a.forEach(v => rt.w(v == null ? '' : tostr(v))),
			printf: (...a) => rt.w(sprintf(...a)),
			render: (fn, ...a) => capture(() => fn(...a)),
			include: renderAny
		}, env);
		renderAny(name, scope);
		return bufs[0].join('');
	}
}

/* scope where unknown identifiers read as null instead of throwing. The
   compiler's own names (__scope, __rt) are never looked up in the scope,
   so nothing in the data can shadow them. */
function proxy(obj) {
	return new Proxy(obj, {
		has: (t, k) => typeof k === 'string' && !k.startsWith('__') && (k in t || !(k in globalThis)),
		get: (t, k) => (k === Symbol.unscopables) ? undefined : t[k],
		set: (t, k, v) => { t[k] = v; return true; }
	});
}

module.exports = { Engine, compile, sprintf, stdlib };
