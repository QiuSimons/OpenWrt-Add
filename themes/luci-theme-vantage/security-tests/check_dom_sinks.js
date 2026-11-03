#!/usr/bin/env node
/*
 * Dependency-free DOM-sink checker for the Vantage theme and app JavaScript.
 *
 * Wireless clients control hostnames and SSIDs that the dashboard renders, so
 * every piece of dynamic content must reach the DOM as a text node or an
 * element, never as HTML, script or a script-bearing URL. LuCI's
 * E()/dom.create()/dom.content()/dom.append() turn a *non-array, non-Node*
 * content argument into `node.innerHTML = value` and a tag string starting
 * with '<' into parsed HTML; array items are always inserted as text nodes.
 * dom.attr() (used by E() for the attribute object) adds a *function* value
 * as an event listener and passes anything else to setAttribute(), so a
 * string on an on* key is inline script and a string on href/src/action is a
 * URL that may be javascript:. This tool tokenizes the shipped JS (strings,
 * templates with ${} nesting, comments and regex literals), finds those
 * calls and the classic sinks, and fails unless it can trace each one to a
 * safe value. It is a heuristic checker, not a proof: whatever it cannot
 * trace is reported.
 *
 * Sinks and rules
 *   E(tag, attrs?, content?) / dom.create(...), including every alias
 *   (`var mk = E`, 'require dom as d' then d.create, L.dom.create,
 *   window.E):
 *     - tag must be a single string literal that does not start with '<' and
 *       does not name (case-insensitively, ignoring a 'ns:' prefix) script,
 *       style, iframe, frame, frameset, object, embed, applet, base, meta,
 *       link or portal; the same tag rule applies to
 *       document.createElement(tag) and createElementNS(ns, tag);
 *     - attrs, when an object literal, must not use spread or computed keys;
 *       attribute names are compared case-insensitively (setAttribute
 *       lowercases them; for 'prefix:local' the local name counts too);
 *       on* values must be functions (function/arrow expressions, L.bind(),
 *       x.bind(), function declarations, variables/properties traced to
 *       those); href/src/action/formaction/xlink:href/poster/data/srcset/
 *       ping/... values must be URL-safe (below); srcdoc must be constant
 *       markup; style must be a literal or a concatenation of literals and
 *       numeric expressions; on SVG animate/set/animateTransform/
 *       animateMotion every value must be a literal (or numeric) and
 *       to/from/values/by must be URL-safe literals (each ';' part);
 *     - content (3rd argument, or the 2nd when the 2nd is not an object
 *       literal or `null`) must be content-safe (below).
 *   dom.content(node, x) / dom.append(node, x): x must be content-safe.
 *   dom.attr(node, name, value) / el.setAttribute(name, value) /
 *   setAttributeNS(ns, name, value): name must be a literal; value follows
 *   the attribute rules above (on* via setAttribute: string literal only;
 *   to/from/values/by: URL-safe literal; attributeName: literal, since the
 *   element may be an SVG animation).
 *   ui.showModal(title, children), ui.addNotification(title, children),
 *   ui.addTimeLimitedNotification(title, children, ...): LuCI passes title
 *   to dom.create('h4', {}, title) and children to dom.append(), so children
 *   must be content-safe and title content-safe, constant markup or
 *   _('literal'). ui.itemlist(node, items): the even (label) items are
 *   rendered with E('strong', string), i.e. innerHTML: items must be an
 *   array literal with constant labels. cbi_update_table(t, rows, ph): every
 *   cell reaches E(td, {}, cell): rows must be an array literal of array
 *   literals whose cells are E()/dom.create() calls, constants or
 *   _('literal'). (ui.showIndicator(label) and ui.showTooltip() write text
 *   only and are not sinks.)
 *   Passing E, a dom sink method or the dom object itself as a value (other
 *   than a simple `var alias = E` that is then tracked) is a violation, as
 *   is computed access on dom / ui.
 *   dom.parse(x), DOMParser#parseFromString(x), el.setHTMLUnsafe(x) and
 *   Document.parseHTMLUnsafe(x): x must be constant markup (setHTMLUnsafe /
 *   parseHTMLUnsafe used other than as a direct call, or by name, is
 *   rejected).
 *   el.href/src/action/formAction/location/poster = x, location = x,
 *   location.assign/replace(x), window.open(x): x must be URL-safe.
 *   el.on<event> = x: x must be a function (or null).
 *   setTimeout/setInterval/setImmediate(x, ...), .call(t, x, ...),
 *   .bind(t, x) and .apply(t, [x, ...]): x must be a function; the timer
 *   used in any other way as a value (alias, callback, Reflect.apply) is
 *   rejected.
 *   Reflect.set(o, k, v), Reflect.defineProperty(o, k, d),
 *   Object.defineProperty(o, k, d): k must be provably a harmless property
 *   name (as for obj[key] below; a literal must not be a dangerous DOM
 *   property such as href, src, on* or textContent) unless o is provably a plain
 *   object; Object.defineProperties(o, p) / Object.assign(o, ...src) on such
 *   an o need object literals with harmless literal keys.
 *   CSS from data: X.style.<prop> = v, X.style.cssText = v, X.style = v,
 *   X.style[k] = v, X.style.setProperty(name, v) and Object.assign(X.style,
 *   {...}) follow the style-attribute rule (v a literal or a concatenation
 *   of literals and numeric expressions; setProperty's name a literal;
 *   Object.assign sources object literals); el.animate(keyframes, options)
 *   (Web Animations) needs keyframes traced to keyframe objects (or one
 *   property-indexed object) whose values follow the same rule, and options
 *   that are a number or an object literal of such values; a style sheet's
 *   replaceSync(x)/insertRule(x) needs constant CSS, or x must be the first
 *   parameter of a .then() callback on a chain that starts with
 *   fetch(L.resource('<literal>')) (a stylesheet shipped with the package,
 *   optionally versioned as LuCI versions its scripts: + '?v=' +
 *   L.env.resource_version; an options object of literals, such as
 *   { cache: 'no-cache' }, may follow).
 *   Selectors: querySelector/querySelectorAll/closest/matches/
 *   webkitMatchesSelector(sel) need a constant selector or a concatenation
 *   of literals and CSS.escape(...) (this./self.matches, the view's own
 *   filter method, is not a selector call). RegExp(p) / new RegExp(p) need
 *   a constant pattern (data would allow ReDoS). history.pushState/
 *   replaceState(state, title, url): url must be URL-safe or start with
 *   location.pathname.
 *   Always rejected as well: dynamic import(), Worker/SharedWorker,
 *   importScripts(), serviceWorker.register(), and execCommand() with a
 *   non-literal or insertHTML/insertImage command.
 *   obj[key] = v and obj[key](...) with a non-literal key: the key must be
 *   provably not a property name (numeric, or a concatenation containing a
 *   literal with a non-letter character such as 'chart-' + k) or obj must be
 *   provably a plain object ({}, [], Object.create(), new Map(), ...).
 *   Always rejected: .innerHTML/.outerHTML/.srcdoc assignments other than
 *   `= ''`; 'innerHTML'/'outerHTML'/'srcdoc'/'eval'/'Function' as a string
 *   (bracket access, Reflect, defineProperty) or innerHTML/outerHTML as an
 *   object-literal key; Object.assign( mentioning innerHTML/outerHTML;
 *   insertAdjacentHTML; createContextualFragment; document.write/writeln;
 *   any reference to eval (eval(), globalThis.eval, (0, eval)) or Function;
 *   x.constructor(...).
 *
 * Content-safe expressions
 *   absent, null, undefined, an array literal, E(...) or an alias,
 *   dom.create(...), document.createElement/createElementNS/createTextNode/
 *   createDocumentFragment/importNode/cloneNode(...), x.map/filter/flatMap(...),
 *   y.concat/slice/reverse/sort(...) where y is content-safe (an array),
 *   `c ? a : b` / `a || b` / `a ?? b` with safe branches, `c && a` with safe
 *   a, and anything traced (below) to those.
 *
 * URL-safe expressions
 *   string literals without a scheme or with http/https/mailto/tel (after
 *   removing the whitespace and control characters browsers ignore),
 *   L.url(...)/L.resource(...) (also via .apply/.call), a concatenation or
 *   template whose first part is a literal starting with '/x', '#', '?', './'
 *   or '../', or is L.url(...), and anything traced to those.
 *
 * Tracing
 *   A call to a function defined in the scanned files (bare name, this./self.
 *   method, or a 'require X as alias' module method) is traced through its
 *   return values. A local variable is traced through every assignment in
 *   its declaring function scope (and fails closed on destructuring,
 *   for-in/of, catch bindings, ++/--, and compound assignment). A parameter
 *   of a named function is traced through every call site (the function must
 *   not be referenced other than by direct calls); the element parameter of
 *   X.forEach/map/filter/some/every/find/findIndex/flatMap(fn) is traced as
 *   an element of X; destructured and defaulted parameters fail closed.
 *   A property read `base.p` is safe when base is traced to objects whose p
 *   is safe (object literals, `this` = every `p:` key in the file), EVERY
 *   `.p =` / `['p'] =` assignment anywhere in the file is safe (so a write
 *   in another method or through another alias is seen), and every computed
 *   write `x[k] = v` to a receiver with the same name as base, whose key is
 *   not provably different from p, is safe. Array/object elements (`X[i]`,
 *   the forEach element) are traced through the literal elements plus every
 *   push/unshift/splice/index/property write through the container's name;
 *   a container that escapes other than into a named variable or property
 *   fails closed.
 *
 * Constant markup (for parseFromString/dom.parse)
 *   string/number literals, templates without ${}, `+` of constants,
 *   .replace/.trim/... of constants with constant arguments, lookups into a
 *   constant table (an object literal whose values are all literals and whose
 *   members are never assigned, e.g. ICO.wifi, this.icons[name]), and
 *   anything traced to those.
 *
 * Escape hatch
 *   A comment `/* dom-safe: <reason> *\/` (non-empty reason) directly before
 *   an expression the analysis cannot trace (a content argument, an attribute
 *   value, a call-site argument feeding a traced parameter, an assignment
 *   right-hand side), or before the first token of the line holding a
 *   non-argument sink, accepts it. Every accepted annotation is listed in
 *   the output as `dom-safe`.
 *
 * Limits (all fail closed where noticed): alias analysis is name-based and
 * per file; writes performed by code in other files are not seen; getters,
 * Proxies and prototype tricks are not modelled; ${} substitutions are
 * scanned without scope information; ui.Table#update() and other LuCI
 * widgets that render strings are not modelled. Known gaps: a script/style
 * element obtained other than by creation (querySelector, cloneNode of a
 * live one, document.currentScript) is not tracked, so a later
 * .text/.textContent/.src write to it is not seen; attribute and tag names
 * are only checked when they are literals at the sink (a non-literal tag or
 * attribute name is itself a violation); Function.prototype.call/apply/
 * Reflect.apply on a DOM method obtained generically (e.g. through a
 * variable holding Element.prototype.setAttribute) is not modelled beyond
 * the by-name string rules; CSS-level injection through literal style is
 * checked as described above; a `new window.Worker` style member path is caught only by
 * the name rule; a style object held in a variable (`var s = el.style;
 * s.color = x`) and CSSStyleSheet#replace() (indistinguishable from
 * String#replace by name) are not tracked; selector and RegExp rules only
 * see direct calls. DOM_SINKS_DEBUG=1 prints every query that could not be
 * traced.
 *
 * Usage
 *   node check_dom_sinks.js [paths...]     default: luci-theme-vantage/htdocs
 *                                          and luci-app-vantage/htdocs
 *   node check_dom_sinks.js --self-test    runs security-tests/fixtures
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------ tokenizer */

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new',
	'delete', 'void', 'throw', 'instanceof', 'else', 'do', 'yield', 'await']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=',
	'||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++',
	'--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
	'**=', '<<=', '>>=', '>>>=', '&&=', '||=', '??=']);
const NUM_ASSIGN_OPS = new Set(['-=', '*=', '/=', '%=', '&=', '|=', '^=', '**=', '<<=', '>>=', '>>>=']);
const IDENT_START = /[A-Za-z_$\u0080-￿]/;
const IDENT_PART = /[\w$\u0080-￿]/;
const NUMBER = /^(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/;

class LexError extends Error {}

function lineOf(lineStarts, pos) {
	let lo = 0, hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
	}
	return lo + 1;
}

function regexAllowed(prev) {
	if (!prev) return true;
	if (prev.t === 'num' || prev.t === 'str' || prev.t === 'tmpl' || prev.t === 'regex') return false;
	if (prev.t === 'ident') return REGEX_AFTER_WORD.has(prev.v);
	return !(prev.v === ')' || prev.v === ']' || prev.v === '++' || prev.v === '--');
}

/* Decode the escape sequence at src[e] === '\\'; returns [text, next]. */
function unescape(src, e) {
	const c = src[e + 1];
	const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
	if (c in simple) return [simple[c], e + 2];
	if (c === '\r') return ['', src[e + 2] === '\n' ? e + 3 : e + 2];
	if (c === '\n' || c === '\u2028' || c === '\u2029') return ['', e + 2];
	if (c === 'x' && /^[\da-fA-F]{2}$/.test(src.slice(e + 2, e + 4))) return [String.fromCharCode(parseInt(src.slice(e + 2, e + 4), 16)), e + 4];
	if (c === 'u') {
		let m = /^\{([\da-fA-F]{1,6})\}/.exec(src.slice(e + 2, e + 12));
		if (m) return [String.fromCodePoint(Math.min(parseInt(m[1], 16), 0x10ffff)), e + 2 + m[0].length];
		m = /^[\da-fA-F]{4}/.exec(src.slice(e + 2, e + 6));
		if (m) return [String.fromCharCode(parseInt(m[0], 16)), e + 6];
	}
	const o = /^[0-7]{1,3}/.exec(src.slice(e + 1, e + 4));
	if (o) return [String.fromCharCode(parseInt(o[0], 8) & 0xff), e + 1 + o[0].length];
	return [c === undefined ? '' : c, e + 2];
}

/* Lex src from pos. With stopAtBrace, return at the '}' closing a ${...}. */
function lex(src, pos, stopAtBrace, lineStarts) {
	const tokens = [];
	let comments = [], depth = 0;
	const push = (t, v, start, extra) => {
		const tok = Object.assign({ t, v, pos: start, line: lineOf(lineStarts, start), comments }, extra || {});
		comments = [];
		tokens.push(tok);
		return tok;
	};
	while (pos < src.length) {
		const c = src[pos];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { pos++; continue; }
		if (c === '/' && src[pos + 1] === '/') {
			let e = src.indexOf('\n', pos); if (e < 0) e = src.length;
			comments.push(src.slice(pos, e)); pos = e; continue;
		}
		if (c === '/' && src[pos + 1] === '*') {
			const e = src.indexOf('*/', pos + 2);
			if (e < 0) throw new LexError(`unterminated comment at line ${lineOf(lineStarts, pos)}`);
			comments.push(src.slice(pos, e + 2)); pos = e + 2; continue;
		}
		if (IDENT_START.test(c)) {
			let e = pos + 1;
			while (e < src.length && IDENT_PART.test(src[e])) e++;
			push('ident', src.slice(pos, e), pos); pos = e; continue;
		}
		if (/\d/.test(c) || (c === '.' && /\d/.test(src[pos + 1] || ''))) {
			const m = NUMBER.exec(src.slice(pos, pos + 64));
			push('num', m[0], pos); pos += m[0].length; continue;
		}
		if (c === '"' || c === "'") {
			let e = pos + 1, v = '', esc = false;
			while (true) {
				if (e >= src.length || src[e] === '\n') throw new LexError(`unterminated string at line ${lineOf(lineStarts, pos)}`);
				if (src[e] === '\\') { const [x, n] = unescape(src, e); v += x; e = n; esc = true; continue; }
				if (src[e] === c) break;
				v += src[e++];
			}
			push('str', v, pos, { raw: src.slice(pos, e + 1), esc }); pos = e + 1; continue;
		}
		if (c === '`') {
			let e = pos + 1, v = '', esc = false;
			const subs = [];
			while (true) {
				if (e >= src.length) throw new LexError(`unterminated template at line ${lineOf(lineStarts, pos)}`);
				if (src[e] === '\\') { const [x, n] = unescape(src, e); v += x; e = n; esc = true; continue; }
				if (src[e] === '`') break;
				if (src[e] === '$' && src[e + 1] === '{') {
					const sub = lex(src, e + 2, true, lineStarts);
					subs.push(sub.tokens); e = sub.pos + 1; v += '${}'; continue;
				}
				v += src[e++];
			}
			push('tmpl', v, pos, { subs, esc }); pos = e + 1; continue;
		}
		if (c === '/' && regexAllowed(tokens[tokens.length - 1])) {
			let e = pos + 1, inClass = false;
			while (true) {
				if (e >= src.length || src[e] === '\n') throw new LexError(`unterminated regex at line ${lineOf(lineStarts, pos)}`);
				if (src[e] === '\\') { e += 2; continue; }
				if (src[e] === '[') inClass = true;
				else if (src[e] === ']') inClass = false;
				else if (src[e] === '/' && !inClass) break;
				e++;
			}
			e++;
			while (e < src.length && /[a-z]/i.test(src[e])) e++;
			push('regex', src.slice(pos, e), pos); pos = e; continue;
		}
		let p = PUNCT.find((x) => src.startsWith(x, pos));
		if (p === '?.' && /\d/.test(src[pos + 2] || '')) p = undefined;
		p = p || c;
		if (stopAtBrace) {
			if (p === '{') depth++;
			else if (p === '}') { if (depth === 0) return { tokens, pos }; depth--; }
		}
		push('punc', p, pos); pos += p.length;
	}
	if (stopAtBrace) throw new LexError('unterminated ${ in template');
	return { tokens, pos };
}

/* ------------------------------------------------------------ structure */

const OPEN = { '(': ')', '[': ']', '{': '}' };
const ITER = new Set(['forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'flatMap']);
const CLOSE = new Set([')', ']', '}']);
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return',
	'typeof', 'new', 'delete', 'void', 'throw', 'instanceof', 'in', 'of', 'else', 'do', 'yield',
	'await', 'case', 'var', 'let', 'const', 'class', 'super', 'import', 'export', 'default', 'try',
	'finally', 'extends']);

/* canonical sink name -> kind of check */
const SINKS = {
	'E': 'create', 'dom.create': 'create', 'dom.content': 'content', 'dom.append': 'content',
	'dom.parse': 'parse', 'dom.attr': 'attr',
	'ui.showModal': 'modal', 'ui.addNotification': 'modal', 'ui.addTimeLimitedNotification': 'modal',
	'ui.itemlist': 'itemlist', 'cbi_update_table': 'table'
};
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data',
	'codebase', 'cite', 'background', 'ping', 'manifest', 'icon', 'archive', 'longdesc', 'lowsrc',
	'dynsrc', 'xml:base', 'srcset', 'imagesrcset']);
/* elements that execute or load code / change document-wide behaviour; no
   attribute or content rule makes them safe, so their creation is rejected
   (compared case-insensitively, ignoring a namespace prefix) */
const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
	'applet', 'base', 'meta', 'link', 'portal']);
/* SVG animation elements can rewrite any attribute of their target (e.g.
   attributeName=href to=javascript:...), so all of their values must be
   literals and the to/from/values/by values must be URL-safe literals */
const ANIM_TAGS = new Set(['animate', 'set', 'animatetransform', 'animatemotion']);
const ANIM_VALUE_ATTRS = new Set(['to', 'from', 'values', 'by']);
function tagName(v) { return String(v).trim().toLowerCase().replace(/^[^:]*:/, ''); }
const URL_PROPS = new Set(['href', 'src', 'action', 'formAction', 'location', 'poster', 'codeBase', 'cite', 'background']);
const NUM_PROPS = new Set(['length', 'offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight',
	'clientWidth', 'clientHeight', 'clientTop', 'clientLeft', 'scrollTop', 'scrollLeft',
	'scrollWidth', 'scrollHeight', 'innerWidth', 'innerHeight', 'pageXOffset', 'pageYOffset',
	'devicePixelRatio', 'childElementCount', 'selectedIndex', 'valueAsNumber', 'timeStamp']);
const NUM_CALLS = new Set(['toFixed', 'toPrecision', 'indexOf', 'lastIndexOf', 'findIndex',
	'charCodeAt', 'codePointAt', 'localeCompare', 'search', 'getTime', 'valueOf']);
const PLAIN_CALLS = new Set(['map', 'filter', 'slice', 'concat', 'split', 'flatMap', 'flat',
	'keys', 'values', 'entries', 'sort', 'reverse', 'match', 'matchAll']);

function isP(tok, v) { return !!tok && tok.t === 'punc' && tok.v === v; }
function isId(tok, v) { return !!tok && tok.t === 'ident' && (v === undefined || tok.v === v); }
function isLit(tok) { return !!tok && (tok.t === 'str' || tok.t === 'num' || (tok.t === 'tmpl' && !tok.subs.length)); }

function parseKind(kind) {
	if (kind.startsWith('elems:')) return { base: 'elems', inner: kind.slice(6) };
	if (kind.startsWith('obj:')) {
		const k = kind.indexOf(':', 4);
		return { base: 'obj', prop: kind.slice(4, k), inner: kind.slice(k + 1) };
	}
	return { base: kind };
}
const NUMERIC = new Set(['num', 'key', 'style']);

function buildUnit(file, tokens, program, parentNames) {
	const u = { file, tokens, program, match: new Array(tokens.length).fill(-1), parent: new Array(tokens.length).fill(-1),
		functions: [], decls: [], aliases: {}, paramTok: new Set() };
	const stack = [];
	tokens.forEach((tok, i) => {
		u.parent[i] = stack.length ? stack[stack.length - 1] : -1;
		if (tok.t !== 'punc') return;
		if (OPEN[tok.v]) stack.push(i);
		else if (CLOSE.has(tok.v)) {
			const o = stack.pop();
			if (o === undefined || OPEN[tokens[o].v] !== tok.v)
				throw new LexError(`unbalanced '${tok.v}' at line ${tok.line}`);
			u.match[o] = i; u.match[i] = o;
		}
	});
	if (stack.length) throw new LexError(`unclosed '${tokens[stack[0]].v}' at line ${tokens[stack[0]].line}`);

	/* functions: declarations/expressions, arrows, and method shorthand */
	tokens.forEach((tok, i) => {
		let fn = null;
		if (isId(tok, 'function')) {
			let j = i + 1;
			if (isP(tokens[j], '*')) j++;
			let name = null, declared = false;
			if (isId(tokens[j])) {
				name = tokens[j].v; j++;
				const prev = tokens[i - 1];
				declared = !prev || isP(prev, ';') || isP(prev, '{') || isP(prev, '}');
			}
			if (!isP(tokens[j], '(')) return;
			const close = u.match[j];
			if (!isP(tokens[close + 1], '{')) return;
			fn = Object.assign({ start: i, name, declared, paramOpen: j, paramClose: close, bodyOpen: close + 1, bodyClose: u.match[close + 1] }, params(u, j, close));
		} else if (isP(tok, '=>')) {
			let start, ps, po, pc;
			if (isP(tokens[i - 1], ')')) { start = u.match[i - 1]; po = start; pc = i - 1; ps = params(u, start, i - 1); }
			else if (isId(tokens[i - 1])) { start = i - 1; po = pc = start; ps = { params: [tokens[i - 1].v], bound: [tokens[i - 1].v], unsafe: new Set() }; }
			else return;
			if (isId(tokens[start - 1], 'async')) start--;
			let bodyOpen = i, bodyClose;
			if (isP(tokens[i + 1], '{')) { bodyOpen = i + 1; bodyClose = u.match[i + 1]; }
			else bodyClose = exprEnd(u, i + 1, tokens.length);
			fn = Object.assign({ start, name: null, declared: false, paramOpen: po, paramClose: pc, bodyOpen, bodyClose, arrow: true }, ps);
		} else if (isId(tok) && !KEYWORDS.has(tok.v) && isP(tokens[i + 1], '(') && !isP(tokens[i - 1], '.') && !isP(tokens[i - 1], '?.')) {
			const close = u.match[i + 1], prev = tokens[i - 1];
			const okPrev = isP(prev, '{') || isP(prev, ',') || isP(prev, '}') || isP(prev, ';') || isP(prev, '*') ||
				isId(prev, 'get') || isId(prev, 'set') || isId(prev, 'static') || isId(prev, 'async');
			if (okPrev && isP(tokens[close + 1], '{') && u.parent[i] >= 0 && isP(tokens[u.parent[i]], '{'))
				fn = Object.assign({ start: i, name: tok.v, declared: false, method: true, shorthand: true,
					accessor: isId(prev, 'get') || isId(prev, 'set'),
					paramOpen: i + 1, paramClose: close, bodyOpen: close + 1, bodyClose: u.match[close + 1] }, params(u, i + 1, close));
		}
		if (!fn) return;
		if (!fn.name) {
			const a = tokens[fn.start - 1], b = tokens[fn.start - 2];
			if (isP(a, ':') && b && (b.t === 'ident' || b.t === 'str') && (isP(tokens[fn.start - 3], '{') || isP(tokens[fn.start - 3], ','))) fn.name = b.v, fn.method = true;
			else if (isP(a, '=') && isId(b)) fn.name = b.v, fn.method = isP(tokens[fn.start - 3], '.');
		}
		for (let k = fn.paramOpen; k <= fn.paramClose; k++) u.paramTok.add(k);
		u.functions.push(fn);
	});

	/* var/let/const declarators, owned by the innermost function; catch
	   bindings are recorded as untraceable declarations */
	tokens.forEach((tok, i) => {
		if (isId(tok, 'catch') && !isP(tokens[i - 1], '.') && isP(tokens[i + 1], '(')) {
			const owner = innermostFn(u, i);
			for (let j = i + 2; j < u.match[i + 1]; j++)
				if (isId(tokens[j])) { u.decls.push({ name: tokens[j].v, idx: j, owner, init: null, forInOf: false, unknown: true }); u.paramTok.add(j); }
			return;
		}
		if (!(isId(tok, 'var') || isId(tok, 'let') || isId(tok, 'const'))) return;
		const owner = innermostFn(u, i);
		let j = i + 1;
		while (isId(tokens[j])) {
			const d = { name: tokens[j].v, idx: j, owner, init: null, forInOf: false };
			j++;
			if (isP(tokens[j], '=')) { const e = exprEnd(u, j + 1, tokens.length); d.init = [j + 1, e]; j = e; }
			else if (isId(tokens[j], 'in') || isId(tokens[j], 'of')) d.forInOf = true;
			u.decls.push(d);
			if (d.forInOf || !isP(tokens[j], ',')) break;
			j++;
		}
	});

	/* 'require a.b as alias' module aliases */
	for (const tok of tokens) {
		if (tok.t !== 'str') continue;
		const m = /^require\s+([\w.]+)(?:\s+as\s+(\w+))?$/.exec(tok.v);
		if (m) u.aliases[m[2] || m[1].split('.').pop()] = m[1];
	}

	/* names that resolve to LuCI sinks: E, dom, ui, their module aliases and
	   simple `x = <sink path>` aliases (name-based, per file) */
	u.names = Object.assign({ E: 'E', dom: 'dom', ui: 'ui', L: 'L', window: 'global', globalThis: 'global',
		cbi_update_table: 'cbi_update_table' }, parentNames || {});
	for (const [alias, mod] of Object.entries(u.aliases))
		if (mod === 'dom' || mod === 'ui') u.names[alias] = mod;
	if (!parentNames) {
		for (let round = 0; round < 4; round++) {
			for (const d of u.decls) {
				if (!d.init) continue;
				const p = pathAt(u, d.init[0]);
				if (!p || p.end !== d.init[1]) continue;
				const c = canon(u, p.parts);
				if (c && (SINKS[c] || c === 'dom' || c === 'ui')) u.names[d.name] = c;
			}
			for (let j = 1; j < tokens.length; j++) {
				if (!(isP(tokens[j], '=') && isId(tokens[j - 1]) && !isP(tokens[j - 2], '.') && !isP(tokens[j - 2], '?.'))) continue;
				const p = pathAt(u, j + 1);
				if (!p || p.end !== exprEnd(u, j + 1, tokens.length)) continue;
				const c = canon(u, p.parts);
				if (c && (SINKS[c] || c === 'dom' || c === 'ui')) u.names[tokens[j - 1].v] = c;
			}
		}
	}
	return u;
}

function params(u, open, close) {
	const T = u.tokens, names = [], bound = [], unsafe = new Set();
	for (const [a, b] of splitTop(u, open + 1, close, ',')) {
		let k = a;
		if (isP(T[k], '...')) k++;
		if (isId(T[k]) && k + 1 === b) { names.push(T[k].v); bound.push(T[k].v); continue; }
		if (isId(T[k]) && isP(T[k + 1], '=')) { names.push(T[k].v); bound.push(T[k].v); unsafe.add(T[k].v); continue; }
		names.push(null);
		for (let j = k; j < b; j++)
			if (isId(T[j]) && !isP(T[j - 1], '.') && !isP(T[j + 1], ':')) { bound.push(T[j].v); unsafe.add(T[j].v); }
	}
	return { params: names, bound, unsafe };
}

/* ident(.ident)* starting at i (not itself a member), or null */
function pathAt(u, i) {
	const T = u.tokens;
	if (!isId(T[i]) || isP(T[i - 1], '.') || isP(T[i - 1], '?.')) return null;
	const parts = [T[i].v];
	let j = i + 1;
	while ((isP(T[j], '.') || isP(T[j], '?.')) && isId(T[j + 1])) { parts.push(T[j + 1].v); j += 2; }
	return { parts, end: j };
}

function canon(u, parts) {
	const root = u.names[parts[0]];
	if (!root) return null;
	let s = [root].concat(parts.slice(1)).join('.');
	if (s.startsWith('global.')) s = s.slice(7);
	s = s.replace(/^L\.dom(?=\.|$)/, 'dom').replace(/^L\.ui(?=\.|$)/, 'ui');
	s = s.replace(/^L\.(showModal|hideModal|itemlist)$/, 'ui.$1');
	return s;
}

/* End (exclusive) of the expression starting at i: next top-level , ; or closer. */
function exprEnd(u, i, limit) {
	let j = i;
	while (j < limit) {
		const t = u.tokens[j];
		if (t.t === 'punc') {
			if (OPEN[t.v]) { j = u.match[j] + 1; continue; }
			if (t.v === ',' || t.v === ';' || CLOSE.has(t.v)) break;
		}
		j++;
	}
	return j;
}

function splitTop(u, a, b, sep) {
	const out = [];
	let s = a;
	for (let j = a; j < b; j++) {
		const t = u.tokens[j];
		if (t.t === 'punc' && OPEN[t.v]) { j = u.match[j]; continue; }
		if (t.t === 'punc' && t.v === sep) { out.push([s, j]); s = j + 1; }
	}
	if (s < b) out.push([s, b]);
	return out;
}

function callArgs(u, open) { return splitTop(u, open + 1, u.match[open], ','); }

function innermostFn(u, i) {
	let best = null;
	for (const f of u.functions)
		if (f.bodyOpen < i && i < f.bodyClose && (!best || f.bodyOpen > best.bodyOpen)) best = f;
	return best;
}

function fnChain(u, i) {
	const out = [];
	for (let f = innermostFn(u, i); f; f = innermostFn(u, f.start)) out.push(f);
	return out;
}

/* '[' at i opens an index access (not an array literal / pattern) */
function isIndexOpen(u, i) {
	const p = u.tokens[i - 1];
	return !!p && ((p.t === 'ident' && !KEYWORDS.has(p.v)) || isP(p, ')') || isP(p, ']') || isP(p, '?.') || p.t === 'str' || p.t === 'tmpl');
}

/* Start of the member/call chain that ends just before `end`. */
function chainStart(u, end) {
	const T = u.tokens;
	let j = end - 1, start = end;
	while (j >= 0) {
		const t = T[j];
		if (isP(t, ')') || isP(t, ']')) {
			start = u.match[j]; j = start - 1;
			const p = T[j];
			if (isP(p, '?.')) { j--; continue; }
			if (p && ((isId(p) && !KEYWORDS.has(p.v)) || isP(p, ')') || isP(p, ']'))) continue;
			break;
		}
		if (isId(t) || t.t === 'str') {
			start = j; j--;
			if (isP(T[j], '.') || isP(T[j], '?.')) { j--; continue; }
			break;
		}
		break;
	}
	return start;
}

function isKeyPos(u, i) {
	const T = u.tokens;
	return isP(T[i + 1], ':') && (isP(T[i - 1], '{') || isP(T[i - 1], ',')) && u.parent[i] >= 0 && isP(T[u.parent[i]], '{');
}

/* ------------------------------------------------------------ analysis */

function urlLiteralSafe(v) {
	const s = String(v).replace(/[\u0000- \u007f]/g, '');
	const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
	return !m || /^(https?|mailto|tel)$/i.test(m[1]);
}
function urlAnchored(v) { return /^(\/[^/\\]|#|\?|\.\.?\/)/.test(String(v).replace(/^[\u0000- ]+/, '')); }
const DANGEROUS_PROP = /^(innerHTML|outerHTML|srcdoc|href|src|action|formAction|location|on\w+|textContent|innerText|outerText|data|value|text|nodeValue|cssText|style|constructor|__proto__|prototype)$/i;

class Program {
	constructor() {
		this.units = []; this.inflight = new Set(); this.maxDepth = 60; this.depth = 0;
		this.suppressed = []; this.notes = []; this.memo = new Map(); this.tainted = 0;
	}

	unitForModule(mod) {
		const rel = '/resources/' + mod.replace(/\./g, '/') + '.js';
		return this.units.find((x) => x.file.replace(/\\/g, '/').endsWith(rel)) || null;
	}

	/* Run fn(key) once per key at a time; a re-entrant query (a cycle such as
	   markup = markup.replace(...)) is answered optimistically, which is sound
	   because the non-cyclic sources are still all checked. Results that did
	   not depend on such an assumption (or the depth cut-off) are memoized. */
	guard(key, fn) {
		if (this.memo.has(key)) return this.memo.get(key);
		if (this.inflight.has(key)) { this.tainted++; return true; }
		if (this.depth > this.maxDepth) { this.tainted++; return false; }
		const before = this.tainted;
		this.inflight.add(key); this.depth++;
		try {
			const r = fn();
			if (!r && process.env.DOM_SINKS_DEBUG) console.error(`debug: not proven: ${key}`);
			if (this.tainted === before) this.memo.set(key, r);
			return r;
		} finally { this.inflight.delete(key); this.depth--; }
	}

	/* kind: 'content' (array/Node/null), 'const' (constant markup), 'table'
	   (object whose values are all literals), 'url', 'fn', 'style', 'num',
	   'key' (not a dangerous property name), 'plain' (plain object/array),
	   'elems:<k>' (container whose elements are <k>), 'obj:<p>:<k>' (object
	   whose property p is <k>). */
	classify(u, a, b, kind) {
		const T = u.tokens;
		const K = parseKind(kind);
		if (a >= b) return kind !== 'table' && kind !== 'plain';
		if (kind !== 'table' && hasDomSafe(T[a])) {
			this.suppressed.push({ file: u.file, line: T[a].line });
			return true;
		}
		while (isP(T[a], '(') && u.match[a] === b - 1) { a++; b--; }
		if (a >= b) return false;
		if (K.base === 'fn' && this.fnLiteral(u, a, b)) return true;

		/* top-level operator structure */
		const ops = [];
		for (let j = a; j < b; j++) {
			const t = T[j];
			if (t.t === 'punc' && OPEN[t.v]) { j = u.match[j]; continue; }
			if (t.t === 'punc' || isId(t, 'instanceof') || isId(t, 'in')) ops.push(j);
		}
		const opAt = (v) => ops.filter((j) => T[j].v === v);
		/* a sequence yields its last operand: (x * 0, x) is x, not a number */
		const comma = opAt(',');
		if (comma.length) return this.classify(u, comma[comma.length - 1] + 1, b, kind);
		const assign = ops.find((j) => ASSIGN_OPS.has(T[j].v));
		if (assign !== undefined)
			return T[assign].v === '=' ? this.classify(u, assign + 1, b, kind) : (NUMERIC.has(K.base) && NUM_ASSIGN_OPS.has(T[assign].v));
		if (ops.some((j) => T[j].v === '=>')) return false;
		const q = opAt('?')[0];
		if (q !== undefined) {
			let nest = 0, colon = -1;
			for (const j of ops) {
				if (j <= q) continue;
				if (T[j].v === '?') nest++;
				else if (T[j].v === ':') { if (nest === 0) { colon = j; break; } nest--; }
			}
			if (colon < 0) return false;
			return this.classify(u, q + 1, colon, kind) && this.classify(u, colon + 1, b, kind);
		}
		for (const op of ['||', '??']) {
			const at = opAt(op);
			if (at.length) return this.parts(u, a, b, at).every(([s, e]) => this.classify(u, s, e, kind));
		}
		const and = opAt('&&');
		if (and.length) return this.classify(u, and[and.length - 1] + 1, b, kind);
		const plus = opAt('+');
		if (plus.length) {
			const parts = this.parts(u, a, b, plus);
			if (parts[0][0] === parts[0][1]) {
				/* leading unary + (or +x + ...) */
				if (!NUMERIC.has(K.base)) return false;
				if (parts.length === 1) return true;
			}
			if (!parts.every(([s, e]) => s < e) && parts[0][0] !== parts[0][1]) return false;
			const real = parts.filter(([s, e]) => s < e);
			if (kind === 'const' || K.base === 'style' || K.base === 'num')
				return real.every(([s, e]) => this.classify(u, s, e, kind));
			if (K.base === 'key') {
				/* a literal part with a non-letter character can never be part of
				   a DOM property name; otherwise only a numeric sum is harmless
				   ('inner' + 'HTML' is not) */
				if (real.some(([s, e]) => e - s === 1 && isLit(T[s]) && /[^A-Za-z]/.test(T[s].v))) return true;
				return real.every(([s, e]) => this.classify(u, s, e, 'num'));
			}
			if (K.base === 'url') {
				const [s, e] = parts[0];
				return s < e && this.urlPrefix(u, s, e);
			}
			return false;
		}
		if (NUMERIC.has(K.base)) {
			/* arithmetic, comparison, unary operators: numbers or booleans */
			if (ops.some((j) => ['-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '<', '>', '<=', '>=',
				'==', '!=', '===', '!==', '!', '~', 'instanceof', 'in'].includes(T[j].v))) return true;
			if (isId(T[a], 'typeof')) return true;
		}
		if (isId(T[a], 'void') && kind !== 'table') return b - a === 2 && (T[a + 1].t === 'num' || T[a + 1].t === 'ident');
		if (ops.some((j) => !(['.', '?.'].includes(T[j].v)))) return false;

		/* primaries */
		const t0 = T[a];
		if (b - a === 1) {
			if (isId(t0, 'null') || isId(t0, 'undefined')) return kind !== 'table' && kind !== 'plain';
			if (isId(t0, 'true') || isId(t0, 'false')) return NUMERIC.has(K.base) || K.base === 'url';
			if (t0.t === 'num') return kind === 'const' || NUMERIC.has(K.base) || K.base === 'url';
			if (t0.t === 'str' || (t0.t === 'tmpl' && !t0.subs.length)) {
				if (kind === 'const' || K.base === 'style') return true;
				if (K.base === 'url') return urlLiteralSafe(t0.v);
				if (K.base === 'key') return !DANGEROUS_PROP.test(t0.v);
				return false;
			}
			if (t0.t === 'tmpl') {
				if (K.base === 'url') return urlAnchored(t0.v.split('${}')[0]);
				if (K.base === 'key') return /[^A-Za-z]/.test(t0.v.replace(/\$\{\}/g, ''));
				return false;
			}
			if (isId(t0, 'this')) return K.base === 'obj' ? this.propKeys(u, K.prop, K.inner) : false;
			if (t0.t === 'regex') return false;
		}
		if (isP(t0, '[') && u.match[a] === b - 1) {
			if (kind === 'content' || K.base === 'plain') return true;
			if (K.base === 'elems') return this.literalElems(u, a, b, K.inner, false);
			return false;
		}
		if (isP(t0, '{') && u.match[a] === b - 1) {
			if (kind === 'table') return this.literalTable(u, a, b);
			if (K.base === 'plain') return true;
			if (K.base === 'elems') return this.literalElems(u, a, b, K.inner, true);
			if (K.base === 'obj') return this.literalProp(u, a, b, K.prop, K.inner);
			return false;
		}
		if (isId(t0, 'new')) {
			if (K.base === 'plain') return isId(T[a + 1]) && ['Map', 'Set', 'WeakMap', 'WeakSet', 'Object', 'Array'].includes(T[a + 1].v);
			if (K.base === 'elems' || K.base === 'obj')
				return isId(T[a + 1]) && ['Map', 'Set', 'WeakMap', 'WeakSet', 'Object', 'Array'].includes(T[a + 1].v) &&
					(isP(T[a + 2], '(') && u.match[a + 2] === a + 3);
			return false;
		}
		if (!(isId(t0) || isP(t0, '(') || isP(t0, '['))) return false;
		if (isId(t0) && ['function', 'typeof', 'delete', 'class', 'await', 'yield'].includes(t0.v)) return false;
		return this.chain(u, a, b, kind);
	}

	/* `function ...{}` / arrow spanning exactly [a, b) */
	fnLiteral(u, a, b) {
		const T = u.tokens;
		let s = a;
		if (isId(T[s], 'async')) s++;
		for (const f of u.functions) {
			if (f.shorthand || (f.start !== a && f.start !== s)) continue;
			const end = (f.arrow && !isP(T[f.bodyOpen], '{')) ? f.bodyClose : f.bodyClose + 1;
			if (end === b) return true;
		}
		return false;
	}

	/* first part of a URL concatenation fixes the scheme */
	urlPrefix(u, s, e) {
		const T = u.tokens;
		if (e - s === 1 && T[s].t === 'str') return urlAnchored(T[s].v);
		if (e - s === 1 && T[s].t === 'tmpl') return urlAnchored(T[s].v.split('${}')[0]);
		while (isP(T[s], '(') && u.match[s] === e - 1) { s++; e--; }
		const p = pathAt(u, s);
		if (p && isP(T[p.end], '(') && u.match[p.end] === e - 1) {
			const c = canon(u, p.parts);
			if (c && /^L\.(url|resource)(\.apply|\.call)?$/.test(c)) return true;
		}
		return false;
	}

	parts(u, a, b, at) {
		const out = []; let s = a;
		for (const j of at) { out.push([s, j]); s = j + 1; }
		out.push([s, b]);
		return out;
	}

	literalTable(u, a, b) {
		const entries = splitTop(u, a + 1, b - 1, ',');
		if (!entries.length) return false;
		return entries.every(([s, e]) => {
			const k = u.tokens[s];
			if (!(k && (k.t === 'ident' || k.t === 'str' || k.t === 'num') && isP(u.tokens[s + 1], ':'))) return false;
			return this.literalOnly(u, s + 2, e);
		});
	}

	literalOnly(u, a, b) {
		if (a >= b) return false;
		for (let j = a; j < b; j++) {
			const t = u.tokens[j];
			if ((j - a) % 2 === 0) { if (!isLit(t)) return false; }
			else if (!isP(t, '+')) return false;
		}
		return (b - a) % 2 === 1;
	}

	/* entries of an object literal: [{key, vs, ve, kind: 'value'|'shorthand'|'method'|'spread'|'computed'|'accessor'}] */
	objEntries(u, a, b) {
		const T = u.tokens, out = [];
		for (const [s, e] of splitTop(u, a + 1, b - 1, ',')) {
			const k = T[s];
			if (isP(k, '...')) out.push({ kind: 'spread', vs: s + 1, ve: e, at: s });
			else if (isP(k, '[')) out.push({ kind: 'computed', vs: u.match[s] + 2, ve: e, at: s });
			else if ((k.t === 'ident' || k.t === 'str' || k.t === 'num') && isP(T[s + 1], ':')) out.push({ kind: 'value', key: k.v, vs: s + 2, ve: e, at: s });
			else if (isId(k) && e === s + 1) out.push({ kind: 'shorthand', key: k.v, vs: s, ve: e, at: s });
			else if ((isId(k, 'get') || isId(k, 'set')) && T[s + 1] && (T[s + 1].t === 'ident' || T[s + 1].t === 'str') && isP(T[s + 2], '('))
				out.push({ kind: 'accessor', key: T[s + 1].v, at: s });
			else {
				let j = s;
				if (isId(T[j], 'async')) j++;
				if (isP(T[j], '*')) j++;
				if (T[j] && (T[j].t === 'ident' || T[j].t === 'str') && isP(T[j + 1], '(')) out.push({ kind: 'method', key: T[j].v, at: s });
				else out.push({ kind: 'unknown', at: s });
			}
		}
		return out;
	}

	literalElems(u, a, b, inner, isObj) {
		const T = u.tokens;
		if (!isObj) {
			return splitTop(u, a + 1, b - 1, ',').every(([s, e]) => !isP(T[s], '...') && this.classify(u, s, e, inner));
		}
		return this.objEntries(u, a, b).every((en) => {
			if (en.kind === 'value' || en.kind === 'shorthand' || en.kind === 'computed') return this.classify(u, en.vs, en.ve, inner);
			if (en.kind === 'method') return inner === 'fn';
			return false;
		});
	}

	literalProp(u, a, b, p, inner) {
		let ok = true;
		for (const en of this.objEntries(u, a, b)) {
			if (en.kind === 'spread' || en.kind === 'computed' || en.kind === 'unknown') return false;
			if (en.key !== p) continue;
			if (en.kind === 'value' || en.kind === 'shorthand') ok = ok && this.classify(u, en.vs, en.ve, inner);
			else if (en.kind === 'method') ok = ok && inner === 'fn';
			else return false;
		}
		return ok;
	}

	/* every `p:` key / p() method in object literals of the file (for `this`) */
	propKeys(u, p, kind) {
		return this.guard(`keys:${u.file}:${p}:${kind}`, () => {
			const T = u.tokens;
			for (let j = 0; j < T.length; j++) {
				const t = T[j];
				if (!((t.t === 'ident' || t.t === 'str') && t.v === p)) continue;
				if (isKeyPos(u, j)) {
					if (!this.classify(u, j + 2, exprEnd(u, j + 2, T.length), kind)) return false;
				} else if (u.functions.some((f) => f.shorthand && f.start === j)) {
					const f = u.functions.find((g) => g.shorthand && g.start === j);
					if (f.accessor || kind !== 'fn') return false;
				}
			}
			return true;
		});
	}

	/* identifier / member / call chains */
	chain(u, a, b, kind) {
		const T = u.tokens;
		const segs = [];
		let j = a;
		if (isP(T[j], '(') || isP(T[j], '[')) { segs.push({ type: T[j].v === '(' ? 'group' : 'array', a: j, b: u.match[j] + 1 }); j = u.match[j] + 1; }
		else { segs.push({ type: 'id', v: T[j].v, a: j, b: j + 1 }); j++; }
		while (j < b) {
			const t = T[j];
			if ((isP(t, '.') || isP(t, '?.')) && isId(T[j + 1])) { segs.push({ type: 'prop', v: T[j + 1].v, a: j, b: j + 2 }); j += 2; }
			else if (isP(t, '?.') && (isP(T[j + 1], '(') || isP(T[j + 1], '['))) { j++; }
			else if (isP(t, '[')) {
				const m = u.match[j];
				if (m === j + 2 && T[j + 1].t === 'str') segs.push({ type: 'prop', v: T[j + 1].v, a: j, b: m + 1, lit: true });
				else segs.push({ type: 'index', a: j, b: m + 1 });
				j = m + 1;
			}
			else if (isP(t, '(')) { segs.push({ type: 'call', a: j, b: u.match[j] + 1 }); j = u.match[j] + 1; }
			else return false;
		}
		const last = segs[segs.length - 1];
		if (segs[0].type === 'group' && segs.length === 1) return this.classify(u, a + 1, b - 1, kind);
		if (last.type === 'call') return this.callResult(u, a, segs, kind);
		if (segs[0].type !== 'id') return false;
		if (segs.length === 1) return this.ident(u, segs[0].v, a, kind);
		return this.member(u, a, b, segs, kind);
	}

	callResult(u, a, segs, kind) {
		const T = u.tokens;
		const K = parseKind(kind);
		const call = segs[segs.length - 1];
		const callee = segs[segs.length - 2];
		const recv = segs.slice(0, -2);
		const recvEnd = callee ? callee.a : a;
		const args = callArgs(u, call.a);
		const name = callee && (callee.type === 'id' || callee.type === 'prop') ? callee.v : null;
		const recvText = recv.map((s) => T.slice(s.a, s.b).map((t) => t.v).join('')).join('');
		if (!name) return false;
		const plainPath = segs.slice(0, -1).every((s) => s.type === 'id' || (s.type === 'prop' && !s.lit));
		const cn = plainPath ? canon(u, segs.slice(0, -1).map((s) => s.v)) : null;

		if (kind === 'content') {
			if (cn === 'E' || cn === 'dom.create') return true;
			if (['map', 'filter', 'flatMap'].includes(name) && recv.length) return true;
			if (['concat', 'slice', 'reverse', 'sort'].includes(name) && recv.length)
				return this.classify(u, a, recvEnd, 'content');
			if (recvText === 'Array' && (name === 'from' || name === 'of')) return true;
			if (['createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment', 'importNode', 'cloneNode'].includes(name) && recv.length)
				return true;
		}
		if (kind === 'const') {
			if (['replace', 'replaceAll', 'trim', 'toLowerCase', 'toUpperCase', 'slice', 'substring', 'concat', 'padStart', 'padEnd'].includes(name) && recv.length)
				return this.classify(u, a, recvEnd, 'const') && args.every(([s, e]) => this.classify(u, s, e, 'const'));
			if (segs.length === 2 && name === 'String')
				return args.every(([s, e]) => this.classify(u, s, e, 'const'));
		}
		if (K.base === 'url') {
			if (cn && /^L\.(url|resource)(\.apply|\.call)?$/.test(cn)) return true;
		}
		if (K.base === 'fn') {
			if (cn === 'L.bind' || cn === 'ui.createHandlerFn') return true;
			if (name === 'bind' && recv.length) return true;
		}
		if (NUMERIC.has(K.base)) {
			if (NUM_CALLS.has(name) && recv.length) return true;
			if (recvText === 'Math' || (recvText === 'Date' && name === 'now')) return true;
			if (!recv.length && ['Number', 'parseInt', 'parseFloat', 'isNaN', 'isFinite'].includes(name)) return true;
		}
		if (K.base === 'plain') {
			if (PLAIN_CALLS.has(name) && recv.length) return true;
			if (recvText === 'Object' && ['create', 'assign', 'keys', 'values', 'entries', 'fromEntries'].includes(name)) return true;
			if ((recvText === 'JSON' && name === 'parse') || (recvText === 'Array' && (name === 'from' || name === 'of'))) return true;
		}
		if (K.base === 'elems' || K.base === 'obj') {
			if (recvText === 'Object' && name === 'create') return true;
		}
		if (K.base === 'elems') {
			if (['filter', 'slice', 'sort', 'reverse'].includes(name) && recv.length) return this.classify(u, a, recvEnd, kind);
			if (name === 'concat' && recv.length)
				return this.classify(u, a, recvEnd, kind) && args.every(([s, e]) => this.classify(u, s, e, kind) || this.classify(u, s, e, K.inner));
			if ((name === 'map' || name === 'flatMap') && recv.length && args.length) {
				const [s, e] = args[0];
				const f = u.functions.find((g) => (g.start === s || g.start === s + 1) && !g.method);
				if (f && this.fnLiteral(u, s, e)) return this.returns({ u, f }, name === 'flatMap' ? kind : K.inner);
				if (e - s === 1 && isId(T[s])) {
					const defs = this.resolveCallee(u, '', T[s].v, false);
					return defs.length > 0 && defs.every((d) => this.returns(d, K.inner));
				}
				return false;
			}
		}
		const defs = this.resolveCallee(u, recvText, name, recv.length);
		if (!defs.length) return false;
		return defs.every((d) => this.returns(d, kind));
	}

	/* Function definitions a callee can refer to; [] when unknown. */
	resolveCallee(u, recvText, name, hasRecv) {
		let target = null;
		if (!hasRecv || recvText === 'this' || recvText === 'self') target = u.program || u;
		else if (u.aliases[recvText] || (u.program && u.program.aliases[recvText]))
			target = this.unitForModule(u.aliases[recvText] || u.program.aliases[recvText]);
		if (!target) return [];
		return target.functions.filter((f) => f.name === name && !f.accessor && (!hasRecv ? !f.method : true)).map((f) => ({ u: target, f }));
	}

	returns(d, kind) {
		return this.guard(`ret:${d.u.file}:${d.f.start}:${kind}`, () => {
			const { u, f } = d, T = u.tokens;
			if (f.arrow && !isP(T[f.bodyOpen], '{'))
				return this.classify(u, f.bodyOpen + 1, f.bodyClose, kind);
			let ok = true;
			for (let j = f.bodyOpen + 1; j < f.bodyClose && ok; j++) {
				if (!isId(T[j], 'return') || innermostFn(u, j) !== f) continue;
				const e = exprEnd(u, j + 1, f.bodyClose);
				ok = e === j + 1 ? kind !== 'table' && kind !== 'plain' : this.classify(u, j + 1, e, kind);
			}
			return ok;
		});
	}

	declScope(u, name, idx) {
		for (const f of fnChain(u, idx)) {
			if (f.bound.includes(name)) return { f, param: f.params.indexOf(name), unsafe: f.unsafe.has(name) || f.params.indexOf(name) < 0 };
			if (u.decls.some((d) => d.name === name && d.owner === f)) return { f };
			if (u.functions.some((g) => g.declared && g.name === name && innermostFn(u, g.start) === f)) return { f, fnDecl: true };
		}
		if (u.decls.some((d) => d.name === name && d.owner === null)) return { f: null };
		if (u.functions.some((g) => g.declared && g.name === name && innermostFn(u, g.start) === null)) return { f: null, fnDecl: true };
		return null;
	}

	/* the name at j is written by a destructuring pattern or a bare for-in/of */
	patternWrite(u, j) {
		const T = u.tokens;
		let p = u.parent[j];
		if (isP(T[j + 1], ':') && !isP(T[j - 1], '?')) return false;   /* object key, not a binding */
		while (p >= 0 && (isP(T[p], '{') || isP(T[p], '['))) {
			if (isP(T[p], '[') && isIndexOpen(u, p)) return false;
			const after = T[u.match[p] + 1];
			if (isP(after, '=') || isId(after, 'of') || isId(after, 'in')) return true;
			if (!(isP(after, ',') || isP(after, '}') || isP(after, ']') || isP(after, ':'))) return false;
			p = u.parent[p];
		}
		if (isId(T[j + 1], 'of') || isId(T[j + 1], 'in')) {
			const q = u.parent[j];
			if (q >= 0 && isP(T[q], '(') && isId(T[q - 1], 'for') && u.parent[j] === q && (j === q + 1)) return true;
		}
		return false;
	}

	ident(u, name, idx, kind) {
		const K = parseKind(kind);
		if (name === 'undefined') return kind !== 'table' && kind !== 'plain';
		const scope = this.declScope(u, name, idx);
		if (!scope) return false;
		if (scope.fnDecl) return kind === 'fn';
		return this.guard(`id:${u.file}:${scope.f ? scope.f.start : -1}:${name}:${kind}`, () => {
			const T = u.tokens;
			const sites = [];
			const lo = scope.f ? scope.f.bodyOpen : 0, hi = scope.f ? scope.f.bodyClose : T.length;
			for (const d of u.decls) {
				if (d.name !== name || d.owner !== scope.f) continue;
				if (d.forInOf || d.unknown) return false;
				if (d.init) sites.push(d.init);
			}
			for (let j = lo; j < hi; j++) {
				if (!isId(T[j], name) || isP(T[j - 1], '.') || isP(T[j - 1], '?.')) continue;
				if (isId(T[j - 1], 'var') || isId(T[j - 1], 'let') || isId(T[j - 1], 'const') || isP(T[j - 1], ',') && u.decls.some((d) => d.idx === j)) continue;
				if (u.paramTok.has(j)) continue;
				const s0 = this.declScope(u, name, j);
				if (!s0 || s0.f !== scope.f) continue;
				if (this.patternWrite(u, j)) return false;
				const nx = T[j + 1];
				if (kind === 'table' && (isP(nx, '.') || isP(nx, '['))) {
					/* name.x = ... / name[x] = ... mutates the table */
					const k = isP(nx, '.') ? j + 3 : u.match[j + 1] + 1;
					if (T[k] && T[k].t === 'punc' && (ASSIGN_OPS.has(T[k].v) || T[k].v === '++' || T[k].v === '--')) return false;
				}
				const isAssign = nx && nx.t === 'punc' && ASSIGN_OPS.has(nx.v);
				const isUpd = (nx && (isP(nx, '++') || isP(nx, '--'))) || isP(T[j - 1], '++') || isP(T[j - 1], '--');
				if (!isAssign && !isUpd) continue;
				if (isUpd) { if (K.base === 'num' || K.base === 'key' || K.base === 'style') continue; return false; }
				if (nx.v !== '=') {
					if (NUMERIC.has(K.base) && NUM_ASSIGN_OPS.has(nx.v)) continue;
					return false;
				}
				sites.push([j + 2, exprEnd(u, j + 2, T.length)]);
			}
			if (scope.param !== undefined) {
				if (scope.unsafe) return false;
				const f = scope.f, s0 = f.start;
				/* element / index parameter of X.forEach(fn), X.map(fn), ... */
				if (isP(T[s0 - 1], '(') && isId(T[s0 - 2]) && ITER.has(T[s0 - 2].v) && (isP(T[s0 - 3], '.') || isP(T[s0 - 3], '?.'))) {
					if (scope.param === 1) return NUMERIC.has(K.base) || K.base === 'url' ? sites.every(([s, e]) => this.classify(u, s, e, kind)) : false;
					if (scope.param !== 0) return false;
					const rs = chainStart(u, s0 - 3);
					if (!this.classify(u, rs, s0 - 3, 'elems:' + kind)) return false;
				} else if (isP(T[s0 - 1], '(') && isId(T[s0 - 2], 'Promise') && isId(T[s0 - 3], 'new') && scope.param <= 1) {
					if (kind !== 'fn') return false;
				} else if (!this.paramSafe(u, scope.f, scope.param, kind)) return false;
			} else if (!sites.length) return false;
			if (!sites.every(([s, e]) => this.classify(u, s, e, kind))) return false;
			if (K.base === 'elems' && !this.containerWrites(u, name, K.inner)) return false;
			return true;
		});
	}

	/* Every call site of the (named) function passes a safe argument. */
	paramSafe(u, f, k, kind) {
		if (!f.name) return false;
		return this.guard(`param:${u.file}:${f.start}:${k}:${kind}`, () => {
			const sites = [];
			const scan = (unit, alias) => {
				const T = unit.tokens;
				for (let j = 0; j < T.length; j++) {
					if (!isId(T[j], f.name)) continue;
					if (alias) {
						if (!(isP(T[j - 1], '.') && isId(T[j - 2], alias) && !isP(T[j - 3], '.'))) continue;
					} else {
						if (isId(T[j - 1], 'function')) continue;
						if (unit.functions.some((g) => g.shorthand && g.start === j)) continue;
						if (isP(T[j + 1], ':') && (isP(T[j - 1], '{') || isP(T[j - 1], ',')) && isId(T[j + 2], 'function')) continue;
						if (isP(T[j + 1], '=') && isId(T[j + 2], 'function')) continue;
					}
					if (!isP(T[j + 1], '(')) { /* referenced, not called */
						this.notes.push(`${f.name} is referenced at ${path.basename(unit.file)}:${T[j].line} without a direct call`);
						return false;
					}
					const args = callArgs(unit, j + 1);
					sites.push(args[k] ? [unit, args[k][0], args[k][1]] : [unit, 0, 0]);
				}
				return true;
			};
			if (!scan(u, null)) return false;
			for (const other of this.units) {
				for (const [alias, mod] of Object.entries(other.aliases))
					if (this.unitForModule(mod) === u && !scan(other, alias)) return false;
			}
			if (!sites.length) { this.notes.push(`${f.name}() has no traceable call sites`); return false; }
			return sites.every(([unit, s, e]) => {
				const ok = s === e ? kind !== 'table' && kind !== 'plain' : this.classify(unit, s, e, kind);
				if (!ok) this.notes.push(`call site ${path.basename(unit.file)}:${unit.tokens[s].line} of ${f.name}()`);
				return ok;
			});
		});
	}

	member(u, a, b, segs, kind) {
		const T = u.tokens;
		const K = parseKind(kind);
		const last = segs[segs.length - 1];
		if (kind === 'table') return this.memberTable(u, a, b, segs, kind);
		return this.guard(`mem:${u.file}:${a}:${b}:${kind}`, () => {
			if (NUMERIC.has(K.base) && last.type === 'prop' && NUM_PROPS.has(last.v)) return true;
			/* constant-table lookup: T.k or T[...] */
			if (kind === 'const' && this.classify(u, a, last.a, 'table')) return true;
			if (last.type === 'index') return this.classify(u, a, last.a, 'elems:' + kind);
			const p = String(last.v);
			const baseName = T[last.a - 1] ? T[last.a - 1].v : '';
			if (!this.classify(u, a, last.a, `obj:${p}:${kind}`)) { this.notes.push(`${T.slice(a, last.a).map((t) => t.v).join('')} is not traceable`); return false; }
			if (!this.dotWrites(u, p, kind)) return false;
			if (!this.computedWrites(u, baseName, p, kind)) return false;
			if (K.base === 'elems' && !this.containerWrites(u, p, K.inner)) return false;
			return true;
		});
	}

	/* every `.p = v` / `['p'] = v` in the file yields kind */
	dotWrites(u, p, kind) {
		return this.guard(`dw:${u.file}:${p}:${kind}`, () => {
			const T = u.tokens, K = parseKind(kind);
			for (let j = 1; j < T.length; j++) {
				let op, vpos;
				if (isId(T[j], p) && (isP(T[j - 1], '.') || isP(T[j - 1], '?.'))) { op = T[j + 1]; vpos = j + 2; }
				else if ((T[j].t === 'str' || T[j].t === 'num') && String(T[j].v) === p && isP(T[j - 1], '[') && isP(T[j + 1], ']') && isIndexOpen(u, j - 1)) { op = T[j + 2]; vpos = j + 3; }
				else continue;
				if (!op || op.t !== 'punc') continue;
				if (op.v === '++' || op.v === '--') { if (!NUMERIC.has(K.base)) return false; continue; }
				if (!ASSIGN_OPS.has(op.v)) continue;
				if (op.v !== '=') { if (NUMERIC.has(K.base) && NUM_ASSIGN_OPS.has(op.v)) continue; this.notes.push(`compound write .${p} ${op.v} at line ${op.line}`); return false; }
				if (!this.classify(u, vpos, exprEnd(u, vpos, T.length), kind)) { this.notes.push(`write .${p} = at line ${op.line}`); return false; }
			}
			return true;
		});
	}

	/* key expression [a, b) can never evaluate to property name p */
	provablyNot(u, a, b, p) {
		const T = u.tokens;
		if (b - a === 1 && isLit(T[a])) return String(T[a].v) !== p;
		const plus = [];
		for (let j = a; j < b; j++) {
			if (isP(T[j], '(') || isP(T[j], '[') || isP(T[j], '{')) { j = u.match[j]; continue; }
			if (isP(T[j], '+')) plus.push(j);
		}
		if (plus.length) {
			for (const [s, e] of this.parts(u, a, b, plus))
				if (e - s === 1 && T[s].t === 'str' && !p.includes(T[s].v)) return true;
		}
		return !/^\d+$/.test(p) && this.classify(u, a, b, 'num');
	}

	/* computed writes name[k] = v (receiver named `name`) that may hit p */
	computedWrites(u, name, p, kind) {
		if (!name) return true;
		return this.guard(`cw:${u.file}:${name}:${p}:${kind}`, () => {
			const T = u.tokens;
			for (let j = 0; j < T.length - 1; j++) {
				if (!(T[j].t === 'ident' && T[j].v === name && isP(T[j + 1], '['))) continue;
				const c = u.match[j + 1], op = T[c + 1];
				if (!op || op.t !== 'punc' || !(ASSIGN_OPS.has(op.v) || op.v === '++' || op.v === '--')) continue;
				if (c === j + 3 && isLit(T[j + 2])) continue;   /* literal key: covered by dotWrites */
				if (this.provablyNot(u, j + 2, c, p)) continue;
				if (op.v !== '=') return false;
				if (!this.classify(u, c + 2, exprEnd(u, c + 2, T.length), kind)) { this.notes.push(`computed write ${name}[...] at line ${op.line}`); return false; }
			}
			return true;
		});
	}

	/* Writes into a container through its name: push/unshift/splice
	   arguments, index and property writes; escapes other than into a named
	   variable/property (or into a DOM sink or a non-mutating builtin) fail. */
	containerWrites(u, name, inner) {
		return this.guard(`cont:${u.file}:${name}:${inner}`, () => {
			const T = u.tokens;
			for (let j = 0; j < T.length; j++) {
				if (!(T[j].t === 'ident' && T[j].v === name)) continue;
				const member = isP(T[j - 1], '.') || isP(T[j - 1], '?.');
				if (u.paramTok.has(j) || isKeyPos(u, j) || isId(T[j - 1], 'var') || isId(T[j - 1], 'let') || isId(T[j - 1], 'const')) continue;
				if (u.functions.some((f) => f.start === j && f.shorthand)) continue;
				if (!member && u.decls.some((d) => d.idx === j)) continue;
				const nx = T[j + 1];
				if ((isP(nx, '.') || isP(nx, '?.')) && isId(T[j + 2])) {
					const m = T[j + 2].v, after = T[j + 3];
					if ((m === 'push' || m === 'unshift') && isP(after, '(')) {
						for (const [s, e] of callArgs(u, j + 3)) {
							if (isP(T[s], '...') ? !this.classify(u, s + 1, e, 'elems:' + inner) : !this.classify(u, s, e, inner)) { this.notes.push(`${name}.${m}() at line ${T[j].line}`); return false; }
						}
						continue;
					}
					if (m === 'splice' && isP(after, '(')) {
						const args = callArgs(u, j + 3);
						if (args.slice(2).some(([s, e]) => isP(T[s], '...') || !this.classify(u, s, e, inner))) return false;
						continue;
					}
					if ((m === 'fill' || m === 'copyWithin' || m === 'set') && isP(after, '(')) return false;
					if (after && after.t === 'punc' && ASSIGN_OPS.has(after.v) && m !== 'length') {
						if (after.v !== '=' || !this.classify(u, j + 4, exprEnd(u, j + 4, T.length), inner)) { this.notes.push(`${name}.${m} write at line ${T[j].line}`); return false; }
					}
					continue;
				}
				if (isP(nx, '[')) {
					const c = u.match[j + 1], op = T[c + 1];
					if (op && op.t === 'punc' && (ASSIGN_OPS.has(op.v) || op.v === '++' || op.v === '--')) {
						if (op.v !== '=' || !this.classify(u, c + 2, exprEnd(u, c + 2, T.length), inner)) { this.notes.push(`${name}[...] write at line ${T[j].line}`); return false; }
					}
					continue;
				}
				if (nx && nx.t === 'punc' && ASSIGN_OPS.has(nx.v)) continue;   /* reassigned: sites checked elsewhere */
				/* bare value use of the container */
				const s = member ? chainStart(u, j + 1) : j;
				const prev = T[s - 1];
				if (isId(prev, 'return') || isId(prev, 'of') || isId(prev, 'in') || isId(prev, 'typeof')) continue;
				if (isP(prev, '=') && exprEnd(u, s, T.length) === j + 1) {
					const lhs = T[s - 2];
					if (isId(lhs) && !isP(T[s - 3], '.') && !isP(T[s - 3], '?.') && !isP(T[s - 3], ']')) {
						if (!this.containerWrites(u, lhs.v, inner)) return false;
						continue;
					}
					if (isId(lhs) && (isP(T[s - 3], '.') || isP(T[s - 3], '?.'))) {
						if (!this.containerWrites(u, lhs.v, inner)) return false;
						continue;
					}
				}
				/* argument to a DOM sink or a non-mutating builtin (possibly as
				   an element of an array literal passed straight to a sink) */
				let par = u.parent[s];
				if (par >= 0 && isP(T[par], '[') && !isIndexOpen(u, par) && u.parent[par] >= 0 && isP(T[u.parent[par]], '(')) {
					const pp0 = pathAt(u, chainStart(u, u.parent[par]));
					if (pp0 && pp0.end === u.parent[par] && SINKS[canon(u, pp0.parts)]) continue;
				}
				if (par >= 0 && isP(T[par], '(') && u.parent[s] === par) {
					const cs = chainStart(u, par);
					const pp = pathAt(u, cs);
					const cn = pp && pp.end === par ? canon(u, pp.parts) : null;
					const callee = T[par - 1];
					if ((cn && SINKS[cn]) || (isId(callee) && ['isArray', 'concat', 'indexOf', 'includes', 'stringify', 'appendChild'].includes(callee.v))) continue;
				}
				if (isP(prev, '(') && isId(T[s - 2], 'if')) continue;
				if (isP(prev, '!') || isP(prev, '&&') || isP(prev, '||') || isP(T[j + 1], '&&') || isP(T[j + 1], '||') || isP(T[j + 1], '?')) continue;
				this.notes.push(`container ${name} escapes at line ${T[j].line}`);
				return false;
			}
			return true;
		});
	}

	/* old member logic for constant tables */
	memberTable(u, a, b, segs, kind) {
		const T = u.tokens;
		return this.guard(`memt:${u.file}:${a}:${kind}`, () => {
			const f = innermostFn(u, a);
			const lo = f ? f.bodyOpen : 0, hi = f ? f.bodyClose : T.length, n = b - a;
			const sites = [];
			for (let j = lo; j + n <= hi; j++) {
				if (isP(T[j - 1], '.') || isP(T[j - 1], '?.')) continue;
				let same = true;
				for (let k = 0; k < n && same; k++) same = T[j + k].t === T[a + k].t && T[j + k].v === T[a + k].v;
				if (!same) continue;
				const nx = T[j + n];
				if (nx && nx.t === 'punc' && ASSIGN_OPS.has(nx.v)) {
					if (nx.v !== '=') return false;
					sites.push([j + n + 1, exprEnd(u, j + n + 1, T.length)]);
				} else if (isP(nx, '++') || isP(nx, '--')) return false;
			}
			if (sites.length) return sites.every(([s, e]) => this.classify(u, s, e, kind));
			const lastSeg = segs[segs.length - 1];
			if (lastSeg.type === 'prop') return this.property(u, String(lastSeg.v), kind);
			return false;
		});
	}

	/* Every `p:` key and `.p =` assignment in the file yields a `kind` value,
	   and (for tables) the table's members are never assigned. */
	property(u, p, kind) {
		return this.guard(`prop:${u.file}:${p}:${kind}`, () => {
			const T = u.tokens, sites = [];
			for (let j = 0; j < T.length; j++) {
				const t = T[j];
				const keyTok = (t.t === 'ident' || t.t === 'str') && t.v === p;
				if (keyTok && isP(T[j + 1], ':') && (isP(T[j - 1], '{') || isP(T[j - 1], ',')) && u.parent[j] >= 0 && isP(T[u.parent[j]], '{')) {
					sites.push([j + 2, exprEnd(u, j + 2, T.length)]);
					continue;
				}
				if (isId(t, p) && (isP(T[j - 1], '.') || isP(T[j - 1], '?.'))) {
					const nx = T[j + 1];
					if (nx && nx.t === 'punc' && ASSIGN_OPS.has(nx.v)) {
						if (nx.v !== '=') return false;
						sites.push([j + 2, exprEnd(u, j + 2, T.length)]);
					} else if (isP(nx, '++') || isP(nx, '--')) return false;
					else if (kind === 'table' && (isP(nx, '.') || isP(nx, '['))) {
						/* p.x = ... / p[x] = ... mutates the table */
						let k = j + 1;
						if (isP(T[k], '.')) k += 2; else k = u.match[k] + 1;
						if (T[k] && T[k].t === 'punc' && (ASSIGN_OPS.has(T[k].v) || T[k].v === '++' || T[k].v === '--')) return false;
					}
				}
				if (t.t === 'str' && t.v === p && isP(T[j - 1], '[') && isP(T[j + 1], ']')) {
					const nx = T[j + 2];
					if (nx && nx.t === 'punc' && ASSIGN_OPS.has(nx.v)) {
						if (nx.v !== '=') return false;
						sites.push([j + 3, exprEnd(u, j + 3, T.length)]);
					}
				}
			}
			if (!sites.length) return false;
			return sites.every(([s, e]) => this.classify(u, s, e, kind));
		});
	}
}

/* ------------------------------------------------------------ scanner */

const DOM_SAFE = /^(?:\/\*\s*dom-safe:\s*\S[\s\S]*\*\/|\/\/\s*dom-safe:\s*\S.*)$/;

function hasDomSafe(tok) { return !!tok && tok.comments.some((c) => DOM_SAFE.test(c.trim())); }

function lineStartToken(u, i) {
	let j = i;
	while (j > 0 && u.tokens[j - 1].line === u.tokens[i].line) j--;
	return j;
}

function scanUnit(prog, u, report) {
	const T = u.tokens;
	const flag = (i, rule, msg, anchors) => {
		const cand = (anchors || []).concat([i, lineStartToken(u, i)]);
		const safe = cand.find((k) => hasDomSafe(T[k]));
		report({ file: u.file, line: T[i].line, rule, msg, suppressed: safe !== undefined });
	};
	const text = (a, b) => T.slice(a, b).map((t) => t.raw || t.v).join(' ');

	const why = () => {
		const n = [...new Set(prog.notes)];
		prog.notes = [];
		return n.length ? ` (untraced: ${n.slice(0, 4).join('; ')})` : '';
	};

	const check = (s, e, kind) => { prog.notes = []; return prog.classify(u, s, e, kind); };

	const content = (i, range, where) => {
		if (!range) return;
		const [s, e] = range;
		if (s === e) return;
		if (!check(s, e, 'content'))
			flag(T[s] ? s : i, 'dom-content', `${where}: content \`${text(s, e)}\` is not traceable to an array/Node (LuCI would assign it to innerHTML)${why()}`, [s]);
	};

	/* _('literal', ...) */
	const translated = (s, e) => isId(T[s], '_') && isP(T[s + 1], '(') && u.match[s + 1] === e - 1 &&
		callArgs(u, s + 1).every(([a, b]) => b - a === 1 && isLit(T[a]));

	const title = (i, range, where) => {
		if (!range) return;
		const [s, e] = range;
		if (s === e || translated(s, e) || check(s, e, 'content') || check(s, e, 'const')) return;
		flag(s, 'dom-content', `${where}: title \`${text(s, e)}\` is not a Node/array, constant or _('literal') (LuCI renders it with E('h4', {}, title), i.e. innerHTML)${why()}`, [s]);
	};

	/* concatenated value of a literal-only expression, or null */
	const literalValue = (vs, ve) => prog.literalOnly(u, vs, ve) ?
		T.slice(vs, ve).filter((t, k) => k % 2 === 0).map((t) => String(t.v)).join('') : null;
	const acceptAnnotated = (vs) => hasDomSafe(T[vs]) && (prog.suppressed.push({ file: u.file, line: T[vs].line }), true);

	/* anim: the attribute is set on an SVG animation element (E() tag), or
	   the element is unknown (setAttribute/dom.attr: viaSet) */
	const attrValue = (name, vs, ve, what, viaSet, anim) => {
		/* HTML attribute names are case-insensitive (setAttribute lowercases
		   them); setAttributeNS takes a qualified name 'prefix:local' */
		const n = String(name).toLowerCase(), local = n.replace(/^[^:]*:/, '');
		if (!/^on/.test(local) && ((anim && vs < ve) || (viaSet && (ANIM_VALUE_ATTRS.has(local) || local === 'attributename')))) {
			const lit = literalValue(vs, ve);
			const ok = (lit !== null && (!ANIM_VALUE_ATTRS.has(local) || lit.split(';').every(urlLiteralSafe))) ||
				(lit === null && anim && !ANIM_VALUE_ATTRS.has(local) && check(vs, ve, 'num')) || acceptAnnotated(vs);
			if (!ok) flag(vs, 'dom-attr', `${what}: '${name}' value \`${text(vs, ve)}\` must be a literal${ANIM_VALUE_ATTRS.has(local) ? ' safe URL' : ''} (SVG animation can rewrite href/on* of its target)${why()}`, [vs]);
			if (!ok || !URL_ATTRS.has(n) && !URL_ATTRS.has(local)) return;
		}
		let kind = null, desc = '';
		if (/^on/.test(local)) { kind = viaSet ? 'literal' : 'fn'; desc = viaSet ? 'a string literal (inline handler source)' : 'a function (a string becomes inline script)'; }
		else if (URL_ATTRS.has(n) || URL_ATTRS.has(local)) { kind = 'url'; desc = 'a safe URL (literal, L.url(), or anchored concatenation)'; }
		else if (local === 'srcdoc') { kind = 'const'; desc = 'constant markup'; }
		else if (local === 'style') { kind = 'style'; desc = 'a literal or literal/number concatenation'; }
		if (!kind) return;
		const ok = kind === 'literal' ? (prog.literalOnly(u, vs, ve) || acceptAnnotated(vs)) : check(vs, ve, kind);
		if (!ok) flag(vs, 'dom-attr', `${what}: '${name}' value \`${text(vs, ve)}\` is not traceable to ${desc}${why()}`, [vs]);
	};

	/* tag literal of E()/dom.create()/createElement(NS): returns the
	   normalised name, or null (already reported) */
	const tagCheck = (range, what) => {
		const [ts, te] = range;
		const tag = T[ts];
		if (!(te - ts === 1 && (tag.t === 'str' || (tag.t === 'tmpl' && !tag.subs.length)) && tag.v.length && tag.v[0] !== '<')) {
			flag(ts, 'dom-create', `${what} tag \`${text(ts, te)}\` must be a string literal not starting with '<'`, [ts]);
			return null;
		}
		const name = tagName(tag.v);
		if (BLOCKED_TAGS.has(name)) {
			flag(ts, 'dom-create', `${what} creates <${name}> (script/style/frame/plugin/base/meta/link elements are not allowed)`, [ts]);
			return null;
		}
		return name;
	};

	const attrObject = (as, ae, what, anim) => {
		for (const en of prog.objEntries(u, as, ae)) {
			if (en.kind === 'spread') flag(en.at, 'dom-attr', `${what}: attribute object uses spread (keys cannot be checked)`, [en.at]);
			else if (en.kind === 'computed') flag(en.at, 'dom-attr', `${what}: attribute object uses a computed key \`${text(en.at, u.match[en.at] + 1)}\``, [en.at]);
			else if (en.kind === 'accessor' || en.kind === 'unknown') flag(en.at, 'dom-attr', `${what}: attribute object entry cannot be checked`, [en.at]);
			else if (en.kind === 'value' || en.kind === 'shorthand') attrValue(en.key, en.vs, en.ve, what, false, anim);
			else if (en.kind === 'method' && !/^on/i.test(en.key) && (anim || URL_ATTRS.has(en.key.toLowerCase()) || en.key.toLowerCase() === 'style'))
				flag(en.at, 'dom-attr', `${what}: '${en.key}' is a method`, [en.at]);
		}
	};

	const create = (i, open, what) => {
		const args = callArgs(u, open);
		if (!args.length) { flag(i, 'dom-create', `${what} without a tag`); return; }
		const name = tagCheck(args[0], what);
		const anim = name !== null && ANIM_TAGS.has(name);
		if (args.length < 2) return;
		const [as, ae] = args[1];
		if (isP(T[as], '{') && u.match[as] === ae - 1) {
			attrObject(as, ae, what, anim);
			content(i, args[2], what);
		} else if (ae - as === 1 && isId(T[as], 'null')) {
			/* create() treats a null attrs as data=null and ignores the rest */
		} else {
			content(i, args[1], what);
			if (args[2]) content(i, args[2], what);
		}
	};

	const constArg = (i, range, what) => {
		if (!range) return;
		if (!check(range[0], range[1], 'const'))
			flag(i, 'dom-parse', `${what} argument \`${text(range[0], range[1])}\` is not constant markup${why()}`, [range[0]]);
	};

	const setAttr = (i, nameRange, valRange, what) => {
		if (!nameRange) return;
		const [ns, ne] = nameRange;
		if (!(ne - ns === 1 && isLit(T[ns]))) {
			flag(ns, 'dom-attr', `${what} with a non-literal attribute name \`${text(ns, ne)}\``, [ns]);
			return;
		}
		if (valRange) attrValue(T[ns].v, valRange[0], valRange[1], what, true);
	};

	const sinkCall = (i, open, sink) => {
		const kind = SINKS[sink], args = callArgs(u, open), what = `${sink}()`;
		if (kind === 'create') create(i, open, what);
		else if (kind === 'content') content(i, args[1], what);
		else if (kind === 'parse') constArg(i, args[0], what);
		else if (kind === 'attr') {
			const k = args[1];
			if (k && isP(T[k[0]], '{') && u.match[k[0]] === k[1] - 1) attrObject(k[0], k[1], what);
			else setAttr(i, k, args[2], what);
		} else if (kind === 'modal') { title(i, args[0], what); content(i, args[1], what); }
		else if (kind === 'itemlist') {
			const it = args[1];
			if (!it || !(isP(T[it[0]], '[') && u.match[it[0]] === it[1] - 1)) { flag(it ? it[0] : i, 'dom-content', `${what}: items must be an array literal (labels are rendered as HTML)`, it ? [it[0]] : []); return; }
			splitTop(u, it[0] + 1, it[1] - 1, ',').forEach(([s, e], n) => {
				if (n % 2 === 0 && !(translated(s, e) || check(s, e, 'const') || (e - s === 1 && isId(T[s], 'null'))))
					flag(s, 'dom-content', `${what}: label \`${text(s, e)}\` is not constant (rendered as HTML)`, [s]);
			});
			if (args[2]) { const [s, e] = args[2]; if (!(check(s, e, 'content') || check(s, e, 'const'))) flag(s, 'dom-content', `${what}: separator is not a Node or constant`, [s]); }
		} else if (kind === 'table') {
			const d = args[1];
			const cellOk = (s, e) => {
				if (isP(T[s], '[') && u.match[s] === e - 1) {
					const pair = splitTop(u, s + 1, e - 1, ',');
					return pair.length === 2 && cellOk(pair[1][0], pair[1][1]);
				}
				const p = pathAt(u, s);
				if (p && isP(T[p.end], '(') && u.match[p.end] === e - 1) { const c = canon(u, p.parts); if (c === 'E' || c === 'dom.create') return true; }
				return translated(s, e) || check(s, e, 'const') || (e - s === 1 && isId(T[s], 'null'));
			};
			const ok = d && isP(T[d[0]], '[') && u.match[d[0]] === d[1] - 1 &&
				splitTop(u, d[0] + 1, d[1] - 1, ',').every(([s, e]) => isP(T[s], '[') && u.match[s] === e - 1 &&
					splitTop(u, s + 1, e - 1, ',').every(([cs, ce]) => cellOk(cs, ce)));
			if (!ok) flag(d ? d[0] : i, 'dom-content', `${what}: rows must be an array literal of arrays of E() nodes or constants (cells are rendered with E(td, {}, cell))`, d ? [d[0]] : []);
			title(i, args[2], what);
		}
	};

	const isAliasRhs = (s, end) => isP(T[s - 1], '=') && isId(T[s - 2]) && !isP(T[s - 3], '.') && !isP(T[s - 3], '?.') &&
		exprEnd(u, s, T.length) === end;

	const propWrite = (i, prop, opIdx) => {
		const op = T[opIdx];
		if (!op || op.t !== 'punc' || !ASSIGN_OPS.has(op.v)) return;
		const e = exprEnd(u, opIdx + 1, T.length);
		const val = [opIdx + 1, e];
		if (URL_PROPS.has(prop)) {
			if (op.v !== '=' || !check(val[0], val[1], 'url'))
				flag(i, 'url-prop', `.${prop} ${op.v} \`${text(val[0], val[1])}\` is not traceable to a safe URL${why()}`, [val[0]]);
		} else if (/^on[a-z]+$/.test(prop)) {
			if (op.v !== '=' || !check(val[0], val[1], 'fn'))
				flag(i, 'dom-attr', `.${prop} ${op.v} \`${text(val[0], val[1])}\` is not a function (a string is inline script)${why()}`, [val[0]]);
		}
	};

	/* T[k] is `style` reached as a member (X.style) */
	const styleRecv = (k) => isId(T[k], 'style') && (isP(T[k - 1], '.') || isP(T[k - 1], '?.'));
	const styleValue = (i, vs, what) => {
		const ve = exprEnd(u, vs, T.length);
		if (!check(vs, ve, 'style'))
			flag(i, 'css-style', `${what} \`${text(vs, ve)}\` is not a literal or literal/number concatenation (CSS from data: url() beacons, overlays)${why()}`, [vs]);
	};
	/* [s, e) is the first parameter of a .then() callback on a chain that
	   starts with fetch(L.resource('<literal>')), optionally versioned
	   with + '?v=' + L.env.resource_version (LuCI's own, from its script
	   tag) and then optionally with an options object whose values are
	   all literals ({ cache: 'no-cache' }) */
	const fetchedResource = (i, s, e) => {
		if (e - s !== 1 || !isId(T[s])) return false;
		const f = innermostFn(u, i);
		if (!f || f.params[0] !== T[s].v || f.unsafe.has(T[s].v)) return false;
		for (let j = f.bodyOpen; j < f.bodyClose; j++)
			if (isId(T[j], T[s].v) && !isP(T[j - 1], '.') && T[j + 1] && T[j + 1].t === 'punc' && (ASSIGN_OPS.has(T[j + 1].v) || T[j + 1].v === '++' || T[j + 1].v === '--')) return false;
		if (!(isP(T[f.start - 1], '(') && isId(T[f.start - 2], 'then') && isP(T[f.start - 3], '.'))) return false;
		const c = chainStart(u, f.start - 3);
		if (!(isId(T[c], 'fetch') && isP(T[c + 1], '(') && isId(T[c + 2], 'L') && isP(T[c + 3], '.') && isId(T[c + 4], 'resource') &&
			isP(T[c + 5], '(') && isLit(T[c + 6]) && T[c + 6].t !== 'num' && isP(T[c + 7], ')'))) return false;
		let a = c + 8;
		if (isP(T[a], '+') && T[a + 1] && T[a + 1].t === 'str' && T[a + 1].v === '?v=' && isP(T[a + 2], '+') && isId(T[a + 3], 'L') &&
			isP(T[a + 4], '.') && isId(T[a + 5], 'env') && isP(T[a + 6], '.') && isId(T[a + 7], 'resource_version')) a += 8;
		if (isP(T[a], ')')) return u.match[c + 1] === a;
		if (!isP(T[a], ',') || !isP(T[a + 1], '{')) return false;
		const close = u.match[a + 1];
		if (close === undefined) return false;
		for (let j = a + 2; j < close; j += 4) {
			if (!((isId(T[j]) || (T[j] && T[j].t === 'str')) && isP(T[j + 1], ':') && isLit(T[j + 2]))) return false;
			if (j + 3 !== close && !isP(T[j + 3], ',')) return false;
		}
		return isP(T[close + 1], ')') && u.match[c + 1] === close + 1;
	};
	/* constant selector, or literals + CSS.escape(...) */
	const selectorSafe = (s, e) => {
		if (check(s, e, 'const')) return true;
		return splitTop(u, s, e, '+').every(([a, b]) => (b - a === 1 && isLit(T[a])) ||
			(isId(T[a], 'CSS') && isP(T[a + 1], '.') && isId(T[a + 2], 'escape') && isP(T[a + 3], '(') && u.match[a + 3] === b - 1));
	};
	/* location.pathname (+ anything): same origin, path-relative */
	const locationPath = (s, e) => {
		const [a] = splitTop(u, s, e, '+')[0] || [];
		if (a === undefined) return false;
		const p = pathAt(u, a);
		const parts = p ? p.parts.join('.') : '';
		return (parts === 'location.pathname' || parts === 'window.location.pathname') && p.end === splitTop(u, s, e, '+')[0][1];
	};

	for (let i = 0; i < T.length; i++) {
		const t = T[i], prev = T[i - 1], next = T[i + 1];
		const member = isP(prev, '.') || isP(prev, '?.');

		if (t.t === 'tmpl') {
			for (const sub of t.subs) {
				const su = buildUnit(u.file, sub, u.program || u, u.names);
				scanUnit(prog, su, report);
			}
			continue;
		}
		if ((t.t === 'str' || t.t === 'tmpl') && /^(innerHTML|outerHTML|srcdoc|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)$/.test(t.v)) {
			flag(i, 'html-prop', `'${t.v}' used by name (bracket access / reflection)`);
			continue;
		}
		if ((t.t === 'str' || t.t === 'tmpl') && /^(eval|Function|execScript|setTimeout|setInterval)$/.test(t.v)) {
			flag(i, 'code-eval', `'${t.v}' used by name (bracket access / reflection)`);
			continue;
		}

		/* computed member writes and calls */
		if (isP(t, '[') && isIndexOpen(u, i)) {
			const close = u.match[i], after = T[close + 1];
			const isWrite = after && after.t === 'punc' && (ASSIGN_OPS.has(after.v) || after.v === '++' || after.v === '--');
			const isCall = isP(after, '(');
			if (isWrite && styleRecv(i - 1) && ASSIGN_OPS.has(after.v)) styleValue(i, close + 2, `style[${text(i + 1, close)}] ${after.v}`);
			if (isWrite || isCall) {
				if (close === i + 2 && isLit(T[i + 1])) {
					if (isWrite) propWrite(i, String(T[i + 1].v), close + 1);
				} else if (!(check(i + 1, close, 'key') || check(chainStart(u, i), i, 'plain'))) {
					flag(i, 'computed-prop', `computed property ${isWrite ? 'write' : 'call'} \`${text(chainStart(u, i), close + 1)}\`: key is not provably a harmless name and the receiver is not provably a plain object${why()}`, [i + 1]);
				}
			}
			continue;
		}

		if (t.t !== 'ident') continue;

		/* LuCI sinks and their aliases */
		const p = member ? null : pathAt(u, i);
		if (p && !u.paramTok.has(i) && !isKeyPos(u, i) && !u.decls.some((d) => d.idx === i)) {
			let hit = 0, sink = null;
			for (let k = 1; k <= p.parts.length && !hit; k++) {
				const c = canon(u, p.parts.slice(0, k));
				if (c && SINKS[c]) { hit = k; sink = c; }
			}
			if (hit) {
				const end = i + 2 * hit - 1;
				if (hit === p.parts.length && isP(T[end], '(')) sinkCall(i, end, sink);
				else if (hit === p.parts.length && isAliasRhs(i, end)) { /* tracked alias */ }
				else if (!(isP(T[end], '=') && hit === p.parts.length && hit === 1))
					flag(i, 'dom-alias', `${sink} used as a value (\`${text(i, p.end)}\`); call it directly`);
			} else {
				const c = canon(u, p.parts);
				if ((c === 'dom' || c === 'ui') && isP(T[p.end], '['))
					flag(i, 'dom-alias', `computed access on ${c} (\`${text(i, p.end + 1)}\`)`);
				else if (c === 'dom' && !isAliasRhs(i, p.end) && !isP(T[p.end], '=') && !isP(T[p.end], '('))
					flag(i, 'dom-alias', `the dom module used as a value (\`${text(i, p.end)}\`)`);
			}
		}

		if (/^(innerHTML|outerHTML|srcdoc)$/.test(t.v)) {
			if (member && next && next.t === 'punc' && ASSIGN_OPS.has(next.v)) {
				const e = exprEnd(u, i + 2, T.length);
				const rhs = T[i + 2];
				const emptyClear = next.v === '=' && e === i + 3 && rhs && (rhs.t === 'str' || (rhs.t === 'tmpl' && !rhs.subs.length)) && rhs.v === '';
				if (!emptyClear) flag(i, 'html-prop', `${t.v} assignment \`${text(i, e)}\` (only = '' is allowed)`);
			} else if (!member && isP(next, ':') && (isP(prev, '{') || isP(prev, ','))) {
				flag(i, 'html-prop', `object literal sets ${t.v}`);
			}
		}

		if (member && next && next.t === 'punc' && ASSIGN_OPS.has(next.v)) propWrite(i, t.v, i + 1);
		if (!member && t.v === 'location' && next && next.t === 'punc' && ASSIGN_OPS.has(next.v)) propWrite(i, 'location', i + 1);

		if (member && isP(next, '(') && ((t.v === 'assign' || t.v === 'replace') && isId(T[i - 2], 'location') || t.v === 'open' && (isId(T[i - 2], 'window') || isId(T[i - 2], 'globalThis')) && !isP(T[i - 3], '.'))) {
			const a = callArgs(u, i + 1)[0];
			if (a && !check(a[0], a[1], 'url')) flag(i, 'url-prop', `${T[i - 2].v}.${t.v}(\`${text(a[0], a[1])}\`) is not traceable to a safe URL${why()}`, [a[0]]);
		}

		if (member && (t.v === 'setAttribute' || t.v === 'setAttributeNS') && isP(next, '(')) {
			const args = callArgs(u, i + 1);
			if (t.v === 'setAttribute') setAttr(i, args[0], args[1], 'setAttribute()');
			else setAttr(i, args[1], args[2], 'setAttributeNS()');
		}

		if (t.v === 'assign' && member && isId(T[i - 2], 'Object') && isP(next, '(')) {
			const close = u.match[i + 1];
			if (T.slice(i + 2, close).some((x) => /^(innerHTML|outerHTML)$/.test(x.v)))
				flag(i, 'html-prop', 'Object.assign() mentions innerHTML/outerHTML');
		}

		if (t.v === 'insertAdjacentHTML' || t.v === 'createContextualFragment')
			flag(i, 'html-api', `${t.v} parses HTML`);

		if ((t.v === 'write' || t.v === 'writeln') && member && isId(T[i - 2], 'document'))
			flag(i, 'html-api', `document.${t.v}`);

		if ((t.v === 'eval' || t.v === 'Function' || t.v === 'execScript') && !isKeyPos(u, i))
			flag(i, 'code-eval', `${t.v} referenced${isP(next, '(') ? ' (called)' : ''}`);

		if (t.v === 'constructor' && member && isP(next, '('))
			flag(i, 'code-eval', 'x.constructor(...) call (Function constructor)');

		if ((t.v === 'setTimeout' || t.v === 'setInterval' || t.v === 'setImmediate') && !isKeyPos(u, i)) {
			const fnArg = (a, how) => {
				if (!a || !check(a[0], a[1], 'fn'))
					flag(i, 'code-eval', `${t.v}${how} callback \`${a ? text(a[0], a[1]) : ''}\` is not traceable to a function${why()}`, a ? [a[0]] : []);
			};
			const via = (isP(next, '.') || isP(next, '?.')) && isId(T[i + 2]) && isP(T[i + 3], '(') ? T[i + 2].v : null;
			if (isP(next, '(')) {
				const a = callArgs(u, i + 1)[0];
				if (a) fnArg(a, '()');
			} else if (via === 'call' || via === 'bind') {
				/* setTimeout.call(thisArg, cb, ...); a bind() without the
				   callback lets a later call pass a string */
				fnArg(callArgs(u, i + 3)[1], `.${via}()`);
			} else if (via === 'apply') {
				const arr = callArgs(u, i + 3)[1];
				const first = arr && isP(T[arr[0]], '[') && u.match[arr[0]] === arr[1] - 1 ? splitTop(u, arr[0] + 1, arr[1] - 1, ',')[0] : null;
				if (!first || isP(T[first[0]], '...')) flag(i, 'code-eval', `${t.v}.apply() arguments must be an array literal starting with a function`, arr ? [arr[0]] : []);
				else fnArg(first, '.apply()');
			} else if (!isId(prev, 'typeof') && !isId(prev, 'function') && !u.functions.some((f) => f.shorthand && f.start === i)) {
				flag(i, 'code-eval', `${t.v} used as a value (a string callback is evaluated as code); call it directly`);
			}
		}

		if (t.v === 'parseFromString' && member && isP(next, '('))
			constArg(i, callArgs(u, i + 1)[0], 'parseFromString()');

		/* el.setHTMLUnsafe(html) / Document.parseHTMLUnsafe(html) parse
		   markup including declarative shadow roots and inline handlers */
		if ((t.v === 'setHTMLUnsafe' || t.v === 'parseHTMLUnsafe') && !isKeyPos(u, i)) {
			if (isP(next, '(')) constArg(i, callArgs(u, i + 1)[0], `${t.v}()`);
			else flag(i, 'html-api', `${t.v} used as a value; call it directly with constant markup`);
		}

		if (t.v === 'execCommand' && member && isP(next, '(')) {
			const a = callArgs(u, i + 1)[0];
			if (!a || !(a[1] - a[0] === 1 && isLit(T[a[0]])) || /^insert(HTML|Image)$/i.test(String(T[a[0]].v)))
				flag(i, 'html-api', 'execCommand() with a non-literal or HTML/URL-inserting command');
		}

		/* document.createElement(tag) / createElementNS(ns, tag) */
		if ((t.v === 'createElement' || t.v === 'createElementNS') && member && isP(next, '(')) {
			const args = callArgs(u, i + 1), tr = args[t.v === 'createElement' ? 0 : 1];
			if (!tr) flag(i, 'dom-create', `${t.v}() without a tag`);
			else tagCheck(tr, `${t.v}()`);
		}

		/* dynamic import() and worker scripts load code from a string */
		if (t.v === 'import' && !member && isP(next, '('))
			flag(i, 'code-eval', 'dynamic import() loads and runs code');
		if (((t.v === 'Worker' || t.v === 'SharedWorker') && !isKeyPos(u, i)) || (t.v === 'importScripts' && !member && isP(next, '(')) ||
			(t.v === 'register' && member && isId(T[i - 2], 'serviceWorker') && isP(next, '(')))
			flag(i, 'code-eval', `${t.v} loads and runs a script`);

		/* inline style through the CSSOM */
		if (member && next && next.t === 'punc' && ASSIGN_OPS.has(next.v) && (styleRecv(i - 2) || t.v === 'style'))
			styleValue(i, i + 2, `${t.v === 'style' ? '.style' : '.style.' + t.v} ${next.v}`);
		if (t.v === 'setProperty' && member && styleRecv(i - 2) && isP(next, '(')) {
			const [n, v] = callArgs(u, i + 1);
			if (!n || !(n[1] - n[0] === 1 && isLit(T[n[0]])))
				flag(i, 'css-style', `style.setProperty() with a non-literal property name \`${n ? text(n[0], n[1]) : ''}\``, n ? [n[0]] : []);
			if (v) styleValue(i, v[0], 'style.setProperty() value');
		}
		if (t.v === 'assign' && member && isId(T[i - 2], 'Object') && isP(next, '(')) {
			const args = callArgs(u, i + 1);
			if (args[0] && styleRecv(args[0][1] - 1)) {
				const ok = args.slice(1).every((r) => isP(T[r[0]], '{') && u.match[r[0]] === r[1] - 1 &&
					prog.objEntries(u, r[0], r[1]).every((en) => en.kind === 'value' && en.key !== undefined && check(en.vs, en.ve, 'style')));
				if (!ok) flag(i, 'css-style', `Object.assign() on a style object needs object literals with literal/number values${why()}`, [args[0][0]]);
			}
		}

		/* Web Animations: el.animate(keyframes, options) applies the
		   keyframes' values as CSS, so they follow the style rule: an array
		   of keyframe objects (or one property-indexed object of arrays)
		   whose values are literals or literal/number concatenations;
		   options are a number or an object literal of such values
		   (Infinity counts as a number) */
		if (t.v === 'animate' && member && isP(next, '(')) {
			const [k, o] = callArgs(u, i + 1);
			if (!k || !check(k[0], k[1], 'elems:elems:style'))
				flag(i, 'css-style', `animate() keyframes \`${k ? text(k[0], k[1]) : ''}\` are not literal or literal/number CSS values${why()}`, k ? [k[0]] : []);
			const optVal = (vs, ve) => (ve - vs === 1 && isId(T[vs], 'Infinity') && !u.decls.some((d) => d.name === 'Infinity')) || check(vs, ve, 'style');
			if (o && !((isP(T[o[0]], '{') && u.match[o[0]] === o[1] - 1)
				? prog.objEntries(u, o[0], o[1]).every((en) => en.kind === 'value' && en.key !== undefined && optVal(en.vs, en.ve))
				: check(o[0], o[1], 'num')))
				flag(i, 'css-style', `animate() options \`${text(o[0], o[1])}\` are not a number or an object literal of literal/number values${why()}`, [o[0]]);
		}

		/* style sheets from data */
		if ((t.v === 'replaceSync' || t.v === 'insertRule') && member && isP(next, '(')) {
			const a = callArgs(u, i + 1)[0];
			if (!a || !(check(a[0], a[1], 'const') || fetchedResource(i, a[0], a[1])))
				flag(i, 'css-sheet', `${t.v}(\`${a ? text(a[0], a[1]) : ''}\`) is not constant CSS or a stylesheet fetched from L.resource('<literal>')${why()}`, a ? [a[0]] : []);
		}

		/* selectors from data: injection or a SyntaxError */
		if (['querySelector', 'querySelectorAll', 'closest', 'matches', 'webkitMatchesSelector'].includes(t.v) && member && isP(next, '(') &&
			!((isId(T[i - 2], 'this') || isId(T[i - 2], 'self')) && !isP(T[i - 3], '.') && t.v === 'matches')) {
			const a = callArgs(u, i + 1)[0];
			if (!a || !selectorSafe(a[0], a[1]))
				flag(i, 'css-selector', `${t.v}(\`${a ? text(a[0], a[1]) : ''}\`): selector is not constant (use CSS.escape() for data)${why()}`, a ? [a[0]] : []);
		}

		/* regular expressions from data: ReDoS */
		if (t.v === 'RegExp' && !member && isP(next, '(') && !isKeyPos(u, i)) {
			const a = callArgs(u, i + 1)[0];
			if (!a || !check(a[0], a[1], 'const'))
				flag(i, 'regexp', `RegExp(\`${a ? text(a[0], a[1]) : ''}\`) with a pattern that is not constant${why()}`, a ? [a[0]] : []);
		}

		/* history URLs */
		if ((t.v === 'pushState' || t.v === 'replaceState') && member && isId(T[i - 2], 'history') && isP(next, '(')) {
			const a = callArgs(u, i + 1)[2];
			if (a && !(check(a[0], a[1], 'url') || locationPath(a[0], a[1])))
				flag(i, 'url-prop', `history.${t.v}() URL \`${text(a[0], a[1])}\` is not URL-safe or location.pathname-based${why()}`, [a[0]]);
		}

		/* Reflect.set / Reflect.defineProperty / Object.defineProperty(ies) /
		   Object.assign on a receiver that is not provably a plain object:
		   every key must be a literal that is not a dangerous DOM property */
		if (member && isP(next, '(') && (isId(T[i - 2], 'Reflect') || isId(T[i - 2], 'Object')) &&
			['set', 'defineProperty', 'defineProperties', 'assign'].includes(t.v) && !(t.v === 'set' && T[i - 2].v !== 'Reflect')) {
			const args = callArgs(u, i + 1), recv = args[0];
			const fn = `${T[i - 2].v}.${t.v}()`;
			if (recv && !check(recv[0], recv[1], 'plain')) {
				const keyOk = (s, e) => check(s, e, 'key');
				const objOk = (r) => r && isP(T[r[0]], '{') && u.match[r[0]] === r[1] - 1 &&
					prog.objEntries(u, r[0], r[1]).every((en) => en.key !== undefined && en.kind !== 'accessor' && !DANGEROUS_PROP.test(String(en.key)));
				if (t.v === 'set' || t.v === 'defineProperty') {
					const k = args[1];
					if (!k || !keyOk(k[0], k[1]))
						flag(i, 'computed-prop', `${fn} key \`${k ? text(k[0], k[1]) : ''}\` is not provably a harmless property name and the receiver is not provably a plain object${why()}`, k ? [k[0]] : []);
				} else {
					const srcs = t.v === 'assign' ? args.slice(1) : [args[1]];
					if (!srcs.every(objOk))
						flag(i, 'computed-prop', `${fn} on a receiver that is not provably a plain object needs object literals with harmless literal keys${why()}`, recv ? [recv[0]] : []);
				}
			}
		}
	}
}

/* ------------------------------------------------------------ driver */

function collect(p, out) {
	const st = fs.statSync(p);
	if (st.isDirectory()) {
		for (const n of fs.readdirSync(p).sort()) collect(path.join(p, n), out);
	} else if (p.endsWith('.js')) out.push(p);
}

function analyse(files) {
	const prog = new Program();
	const errors = [];
	for (const file of files) {
		const src = fs.readFileSync(file, 'utf8');
		const lineStarts = [0];
		for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
		try {
			const { tokens } = lex(src, 0, false, lineStarts);
			prog.units.push(buildUnit(file, tokens, null));
		} catch (e) {
			if (!(e instanceof LexError)) throw e;
			errors.push(`${file}: cannot tokenize: ${e.message}`);
		}
	}
	const findings = [];
	for (const u of prog.units) scanUnit(prog, u, (f) => findings.push(f));
	/* one finding per file:line:rule */
	const uniq = new Map();
	for (const f of findings) {
		const key = `${f.file}:${f.line}:${f.rule}:${f.suppressed}`;
		if (!uniq.has(key)) uniq.set(key, f);
	}
	const out = [...uniq.values()];
	const seen = new Set();
	for (const s of prog.suppressed) {
		const key = `${s.file}:${s.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ file: s.file, line: s.line, rule: 'annotated', msg: 'expression accepted by a dom-safe comment', suppressed: true });
	}
	return { findings: out, errors };
}

function print(res) {
	for (const e of res.errors) console.log(`ERROR ${e}`);
	for (const f of res.findings)
		console.log(`${f.suppressed ? 'dom-safe' : 'VIOLATION'} ${f.file}:${f.line}: [${f.rule}] ${f.msg}`);
}

function selfTest() {
	const dir = path.join(__dirname, 'fixtures');
	let ok = true;
	const bad = path.join(dir, 'dom_sinks_bad.js');
	const good = path.join(dir, 'dom_sinks_good.js');

	const expected = new Set();
	fs.readFileSync(bad, 'utf8').split('\n').forEach((l, k) => { if (/\/\/ expect-violation\s*$/.test(l)) expected.add(k + 1); });
	const rb = analyse([bad]);
	const got = new Set(rb.findings.filter((f) => !f.suppressed).map((f) => f.line));
	const missed = [...expected].filter((l) => !got.has(l));
	const extra = [...got].filter((l) => !expected.has(l));
	if (rb.errors.length || missed.length || extra.length) {
		ok = false;
		print(rb);
		console.log(`FAIL: bad fixture missed lines [${missed}] unexpected lines [${extra}]`);
	} else console.log(`PASS: bad fixture: all ${expected.size} unsafe patterns are flagged`);

	const rg = analyse([good]);
	const gv = rg.findings.filter((f) => !f.suppressed);
	if (rg.errors.length || gv.length) {
		ok = false;
		print(rg);
		console.log(`FAIL: good fixture produced ${gv.length} violation(s)`);
	} else console.log(`PASS: good fixture: safe patterns accepted (${rg.findings.length} dom-safe suppression(s))`);
	return ok;
}

function main(argv) {
	if (argv[0] === '--self-test') return selfTest() ? 0 : 1;
	const roots = argv.length ? argv : [ 'luci-theme-vantage', 'luci-app-vantage' ]
		.map((pkg) => path.join(__dirname, '..', pkg, 'htdocs')).filter((p) => fs.existsSync(p));
	const files = [];
	for (const r of roots) collect(r, files);
	if (!files.length) { console.log('ERROR no JavaScript files found'); return 2; }
	const res = analyse(files);
	print(res);
	const v = res.findings.filter((f) => !f.suppressed).length;
	const s = res.findings.length - v;
	console.log(`${files.length} file(s), ${v} violation(s), ${s} dom-safe suppression(s), ${res.errors.length} error(s)`);
	return res.errors.length ? 2 : v ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
