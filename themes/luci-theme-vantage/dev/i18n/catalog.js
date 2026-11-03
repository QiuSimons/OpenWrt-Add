'use strict';
/*
 * Translation catalogues the way LuCI reads them, for the tests and the
 * replay's --lang preview.
 *
 * - parsePo(text): a .po file as gettext reads it (for checks).
 * - sfh(bytes): the hash LuCI keys translations by (lmo.c sfh_hash, the
 *   same as cbi.js sfh() on the UTF-8 bytes of a string).
 * - lmoEntries(text): what po2lmo (luci-base/src/po2lmo.c) would put into
 *   an .lmo for this .po, as [ key hash, value ] pairs; the Plural-Forms
 *   header becomes key 0. It follows po2lmo's own line parser, including
 *   its quirks: only \" and \\ are unescaped (other escapes stay as
 *   written), fuzzy entries count, obsolete (#~) ones do not, and an entry
 *   whose translation hashes like its key is left out.
 * - translationsJs(pairs): the body of /admin/translations/<lang>
 *   (luci-base ucode/controller/admin/index.uc action_translations).
 */

/* ------------------------------------------------------------------- hash */

function sfh(input) {
	const d = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
	let len = d.length;
	if (len <= 0) return 0;
	let hash = len >>> 0, off = 0, tmp;
	const get16 = o => (d[o] | (d[o + 1] << 8)) >>> 0;
	const s8 = o => (d[o] << 24) >> 24;
	const rem = len & 3;
	for (len >>>= 2; len > 0; len--) {
		hash = (hash + get16(off)) >>> 0;
		tmp = ((get16(off + 2) << 11) ^ hash) >>> 0;
		hash = ((hash << 16) ^ tmp) >>> 0;
		off += 4;
		hash = (hash + (hash >>> 11)) >>> 0;
	}
	switch (rem) {
	case 3:
		hash = (hash + get16(off)) >>> 0;
		hash = (hash ^ (hash << 16)) >>> 0;
		hash = (hash ^ (s8(off + 2) << 18)) >>> 0;
		hash = (hash + (hash >>> 11)) >>> 0;
		break;
	case 2:
		hash = (hash + get16(off)) >>> 0;
		hash = (hash ^ (hash << 11)) >>> 0;
		hash = (hash + (hash >>> 17)) >>> 0;
		break;
	case 1:
		hash = (hash + s8(off)) >>> 0;
		hash = (hash ^ (hash << 10)) >>> 0;
		hash = (hash + (hash >>> 1)) >>> 0;
	}
	hash = (hash ^ (hash << 3)) >>> 0;
	hash = (hash + (hash >>> 5)) >>> 0;
	hash = (hash ^ (hash << 4)) >>> 0;
	hash = (hash + (hash >>> 17)) >>> 0;
	hash = (hash ^ (hash << 25)) >>> 0;
	hash = (hash + (hash >>> 6)) >>> 0;
	return hash;
}

const hex8 = n => (n >>> 0).toString(16).padStart(8, '0');

/* ----------------------------------------------------------------- po2lmo */

/* po2lmo.c extract_string(): the first quoted string on a line, with only
   \" and \\ unescaped; null for comment lines and lines without a quote */
function extractString(line) {
	if (line.startsWith('#')) return null;
	const start = line.indexOf('"');
	if (start < 0) return null;
	let out = '', esc = false;
	for (let i = start + 1; i < line.length; i++) {
		const c = line[i];
		if (esc) {
			if (c === '"' || c === '\\') out = out.slice(0, -1);
			out += c;
			esc = false;
		} else if (c === '\\') { out += c; esc = true; }
		else if (c !== '"') out += c;
		else break;
	}
	return out;
}

function lmoEntries(text) {
	const out = [];
	let msg = { ctxt: null, id: null, idPlural: null, val: [], plural: -1 }, cur = null;
	const flush = () => {
		if (msg.id && msg.val[0]) {
			for (let i = 0; i <= msg.plural; i++) {
				if (!msg.val[i]) continue;
				let key;
				if (msg.ctxt && msg.idPlural) key = `${msg.ctxt}\u0001${msg.id}\u0002${i}`;
				else if (msg.ctxt) key = `${msg.ctxt}\u0001${msg.id}`;
				else if (msg.idPlural) key = `${msg.id}\u0002${i}`;
				else key = msg.id;
				const k = sfh(key);
				if (k !== sfh(msg.val[i])) out.push([ k, msg.val[i] ]);
			}
		} else if (msg.val[0]) {
			/* header: fields end at a literal backslash-n */
			for (const field of msg.val[0].split('\\n'))
				if (/^plural-forms: /i.test(field)) { out.push([ 0, field.slice(14) ]); break; }
		}
		msg = { ctxt: null, id: null, idPlural: null, val: [], plural: -1 };
	};
	const lines = text.split('\n');
	for (let n = 0; n <= lines.length; n++) {
		const eof = n === lines.length, line = eof ? '' : lines[n];
		if (line.startsWith('msgctxt "')) {
			if (msg.id || msg.val[0]) flush(); else msg.ctxt = null;
			msg.ctxt = null; cur = 'ctxt';
		} else if (eof || line.startsWith('msgid "')) {
			if (msg.id || msg.val[0]) flush(); else msg.id = null;
			msg.id = null; cur = 'id';
		} else if (line.startsWith('msgid_plural "')) {
			msg.idPlural = null; cur = 'idPlural';
		} else if (line.startsWith('msgstr "') || line.startsWith('msgstr[')) {
			msg.plural = line[6] === '[' ? parseInt(line.slice(7), 10) || 0 : 0;
			if (msg.plural >= 10) throw new Error('Too many plural forms');
			msg.val[msg.plural] = null; cur = msg.plural;
		}
		if (eof) break;
		if (cur === null) continue;
		const s = extractString(line);
		if (s) {
			if (typeof cur === 'number') msg.val[cur] = (msg.val[cur] || '') + s;
			else msg[cur] = (msg[cur] || '') + s;
		}
	}
	return out;
}

/* window.TR as action_translations writes it: "%08x":%J per entry */
function translationsJs(pairs) {
	return 'window.TR={' + pairs.map(([ k, v ]) => `"${hex8(k)}":${JSON.stringify(v)},`).join('') + '};';
}

/* the entries of a recorded /admin/translations body, [ key, value ] */
function parseTranslationsJs(body) {
	const m = /^\s*window\.TR\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(String(body || ''));
	if (!m) return [];
	try {
		const obj = JSON.parse(m[1].replace(/,\s*\}$/, '}'));
		return Object.entries(obj).filter(([ k, v ]) => /^[0-9a-f]{8}$/.test(k) && typeof v === 'string').map(([ k, v ]) => [ parseInt(k, 16), v ]);
	} catch (e) { return []; }
}

/* luci.mk's language table (dev/i18n/luci-languages.mk): code -> { name, lc },
   lc being the package and catalogue suffix ($(firstword LUCI_LC_ALIAS lang)) */
function languages(text) {
	const names = new Map(), alias = new Map();
	for (const line of String(text).split('\n')) {
		let m = /^LUCI_LANG\.([A-Za-z_]+)=(.+)$/.exec(line);
		if (m) names.set(m[1], m[2]);
		else if ((m = /^LUCI_LC_ALIAS\.([A-Za-z_]+)=(\S+)/.exec(line))) alias.set(m[1], m[2]);
	}
	return new Map([ ...names ].map(([ code, name ]) => [ code, { name, lc: alias.get(code) || code } ]));
}

/* ---------------------------------------------------------------- gettext */

/* full C-style unescaping, as gettext reads a .po string */
function unescapePo(s, where) {
	return s.replace(/\\(.)/g, (m, c) => {
		const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
		if (!(c in map)) throw new Error(`${where}: unsupported escape \\${c}`);
		return map[c];
	});
}

/*
 * Entries: { ctxt, id, idPlural, str: [ ... ], refs: [ 'file:line', ... ],
 * flags: [ ... ], obsolete, line }. The header is the entry with id ''.
 */
function parsePo(text, file = 'po') {
	const entries = [];
	let e = null, field = null;
	const start = n => { e = { ctxt: null, id: null, idPlural: null, str: [], refs: [], flags: [], obsolete: false, line: n + 1 }; field = null; };
	const done = () => { if (e && e.id !== null) entries.push(e); e = null; field = null; };
	const lines = text.split('\n');
	start(0);
	for (let n = 0; n < lines.length; n++) {
		let line = lines[n];
		const where = `${file}:${n + 1}`;
		if (/^\s*$/.test(line)) { if (e && e.id !== null) done(); if (!e) start(n + 1); continue; }
		if (!e) start(n);
		let obsolete = false;
		if (line.startsWith('#~')) { obsolete = true; line = line.replace(/^#~\s?/, ''); }
		else if (line.startsWith('#')) {
			if (e.id !== null && field && field.startsWith('str')) { done(); start(n); }
			if (line.startsWith('#:')) e.refs.push(...line.slice(2).trim().split(/\s+/).filter(Boolean));
			else if (line.startsWith('#,')) e.flags.push(...line.slice(2).split(',').map(s => s.trim()).filter(Boolean));
			continue;
		}
		if (obsolete) e.obsolete = true;
		let m = /^(msgctxt|msgid|msgid_plural|msgstr(?:\[(\d+)\])?)\s+"(.*)"\s*$/.exec(line);
		if (m) {
			const kw = m[1].replace(/\[.*/, '');
			if ((kw === 'msgctxt' || kw === 'msgid') && e.id !== null && field && field.startsWith('str')) {
				done(); start(n); e.obsolete = obsolete;
			}
			const val = unescapePo(m[3], where);
			if (kw === 'msgctxt') { e.ctxt = val; field = 'ctxt'; }
			else if (kw === 'msgid') { e.id = val; field = 'id'; }
			else if (kw === 'msgid_plural') { e.idPlural = val; field = 'idPlural'; }
			else { const i = m[2] !== undefined ? parseInt(m[2], 10) : 0; e.str[i] = val; field = `str${i}`; }
			continue;
		}
		m = /^"(.*)"\s*$/.exec(line);
		if (m && field) {
			const val = unescapePo(m[1], where);
			if (field === 'ctxt') e.ctxt += val;
			else if (field === 'id') e.id += val;
			else if (field === 'idPlural') e.idPlural += val;
			else { const i = parseInt(field.slice(3), 10); e.str[i] += val; }
			continue;
		}
		throw new Error(`${where}: cannot parse: ${line}`);
	}
	done();
	return entries;
}

module.exports = { sfh, hex8, extractString, lmoEntries, translationsJs, parseTranslationsJs, languages, parsePo, unescapePo };
