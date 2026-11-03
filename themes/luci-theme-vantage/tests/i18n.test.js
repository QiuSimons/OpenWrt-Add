'use strict';
/* Translation catalogues (po/templates/*.pot, po/<lang>/*.po) and the
   LuCI catalogue model in dev/i18n/catalog.js. That the templates match
   the sources is checked by `dev/i18n/update.sh --check` (CI). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const C = require('../dev/i18n/catalog.js');
const { findings } = require('../security-tests/check_private_addresses.js');
const { parseLuciLanguages } = require('../security-tests/verify_built_apk.js');

/* package directory -> catalogue name (dev/i18n/update.sh CATALOGS) */
const CATALOGS = { 'luci-app-vantage': 'vantage', 'luci-theme-vantage': 'vantage-theme' };
const LANGS = parseLuciLanguages(fs.readFileSync(path.join(ROOT, 'dev/i18n/luci-languages.mk'), 'utf8'), 'luci-languages.mk');

/* every .pot and .po: [ repository-relative path, package, language or null ] */
function catalogFiles() {
	const out = [];
	for (const [ pkg, cat ] of Object.entries(CATALOGS)) {
		out.push([ `${pkg}/po/templates/${cat}.pot`, pkg, null ]);
		const po = path.join(ROOT, pkg, 'po');
		if (!fs.existsSync(po)) continue;
		for (const lang of fs.readdirSync(po).sort()) {
			if (lang === 'templates') continue;
			const dir = path.join(po, lang);
			if (!fs.statSync(dir).isDirectory()) continue;
			for (const f of fs.readdirSync(dir).sort()) out.push([ `${pkg}/po/${lang}/${f}`, pkg, lang ]);
		}
	}
	return out;
}

test('i18n: templates exist and every language directory holds exactly the package catalogue', () => {
	for (const [ pkg, cat ] of Object.entries(CATALOGS)) {
		const po = path.join(ROOT, pkg, 'po');
		assert.deepEqual(fs.readdirSync(path.join(po, 'templates')), [ `${cat}.pot` ], `${pkg}/po/templates`);
		for (const entry of fs.readdirSync(po)) {
			if (entry === 'templates') continue;
			const dir = path.join(po, entry);
			assert.ok(fs.lstatSync(dir).isDirectory(), `${pkg}/po/${entry}: only language directories belong in po/`);
			assert.ok(LANGS.has(entry), `${pkg}/po/${entry}: not a LuCI language code (luci.mk LUCI_LANG; see dev/i18n/luci-languages.mk)`);
			/* luci.mk turns every po/<lang>/*.po into i18n/<name>.<lang>.lmo;
			   one fixed name per package keeps the two packages' files apart */
			assert.deepEqual(fs.readdirSync(dir), [ `${cat}.po` ], `${pkg}/po/${entry}: the catalogue must be ${cat}.po and nothing else`);
			assert.ok(fs.lstatSync(path.join(dir, `${cat}.po`)).isFile(), `${pkg}/po/${entry}/${cat}.po: not a regular file`);
		}
	}
	assert.notEqual(CATALOGS['luci-app-vantage'], CATALOGS['luci-theme-vantage']);
});

test('i18n: templates and catalogues have their headers', () => {
	for (const [ rel, , lang ] of catalogFiles()) {
		const entries = C.parsePo(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
		const header = entries.find(e => e.id === '' && !e.ctxt);
		assert.ok(header, `${rel}: no header entry`);
		assert.match(header.str[0], /^Content-Type: text\/plain; charset=UTF-8$/m, `${rel}: header must declare UTF-8`);
		if (lang) {
			const l = /^Language: (.*)$/m.exec(header.str[0]);
			if (l) assert.equal(l[1], lang, `${rel}: Language header says ${l[1]}`);
		}
	}
});

test('i18n: every catalogue compiles (msgfmt -c)', t => {
	const have = spawnSync('msgfmt', [ '--version' ]).status === 0;
	if (!have) {
		if (process.env.VANTAGE_REQUIRE_GETTEXT) assert.fail('msgfmt not found and VANTAGE_REQUIRE_GETTEXT is set');
		t.skip('msgfmt (GNU gettext) not installed; CI runs this check');
		return;
	}
	for (const [ rel, , lang ] of catalogFiles()) {
		const args = lang ? [ '-c', '-o', '/dev/null', rel ] : [ '-o', '/dev/null', rel ];
		const r = spawnSync('msgfmt', args, { cwd: ROOT, encoding: 'utf8' });
		assert.equal(r.status, 0, `msgfmt ${args.join(' ')}:\n${r.stderr}`);
		if (lang) assert.equal(r.stderr.trim(), '', `msgfmt -c ${rel} warns:\n${r.stderr}`);
	}
});

test('i18n: #: references are repository-relative paths inside the package', () => {
	let refs = 0;
	for (const [ rel, pkg ] of catalogFiles()) {
		for (const e of C.parsePo(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel)) for (const ref of e.refs) {
			refs++;
			const m = /^(.+):(\d+)$/.exec(ref);
			assert.ok(m, `${rel}: reference ${ref} is not <path>:<line>`);
			const file = m[1];
			assert.ok(!file.startsWith('/') && !/^[A-Za-z]:/.test(file) && !file.includes('\\'), `${rel}: absolute reference ${ref}`);
			assert.ok(!file.split('/').includes('..') && !file.split('/').includes('.'), `${rel}: reference ${ref} leaves the tree`);
			assert.ok(file.startsWith(`${pkg}/`), `${rel}: reference ${ref} is outside ${pkg}/`);
			/* obsolete (#~) entries keep no references, so every one must exist */
			const abs = path.join(ROOT, file);
			assert.ok(fs.existsSync(abs), `${rel}: reference ${ref}: no such file (run dev/i18n/update.sh)`);
			assert.ok(parseInt(m[2], 10) <= fs.readFileSync(abs, 'utf8').split('\n').length, `${rel}: reference ${ref}: no such line`);
		}
	}
	assert.ok(refs > 0);
});

test('i18n: catalogues carry no private addresses, recorded identifiers or local paths', () => {
	for (const [ rel ] of catalogFiles()) {
		const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		assert.deepEqual(findings(text, null), [], `${rel}: private address`);
		text.split('\n').forEach((line, i) => {
			assert.doesNotMatch(line, /(^|[\s"'(=:])(\/home\/|\/Users\/|\/root\/|\/tmp\/|\/var\/folders\/|~\/|[A-Za-z]:\\)/,
				`${rel}:${i + 1}: a local path`);
		});
	}
});

/* LuCI's String.prototype.format placeholders, in order */
const placeholders = s => (s.match(/%(?:%|[-+ 0#]*\d*(?:\.\d+)?[a-zA-Z])/g) || []).filter(p => p !== '%%');

test('i18n: translations keep the placeholders and add no markup', () => {
	for (const [ rel, , lang ] of catalogFiles()) {
		if (!lang) continue;
		for (const e of C.parsePo(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel)) {
			if (e.id === '' || e.obsolete) continue;
			e.str.forEach((str, i) => {
				if (!str) return;
				const where = `${rel}:${e.line}: ${JSON.stringify(e.id)}`;
				/* String.format() fills placeholders by position: a translation
				   changes the words, never the values or their order */
				const want = [ placeholders(e.id), e.idPlural != null ? placeholders(e.idPlural) : null ].filter(Boolean).map(p => p.join(' '));
				assert.ok(want.includes(placeholders(str).join(' ')),
					`${where}: translation has placeholders [${placeholders(str).join(' ')}], the source [${want[0]}]`);
				for (const ch of [ '<', '>' ])
					if (!e.id.includes(ch)) assert.ok(!str.includes(ch), `${where}: translation adds "${ch}"`);
			});
		}
	}
});

/* ------------------------------------------------------ catalog.js model */

/* A catalogue and what LuCI's po2lmo (OpenWrt 25.12.4 SDK, luci-base at
   e9ebca7598ce) writes for it: key hashes and values read back from the
   .lmo. Covers every length remainder of the hash, bytes >= 0x80 in the
   remainder, context, plurals, \" and \n escapes, fuzzy, obsolete,
   untranslated and identical entries. */
const SAMPLE_PO = `msgid ""
msgstr ""
"Language: de\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Plural-Forms: nplurals=2; plural=n != 1;\\n"

msgid "Save"
msgstr "Speichern"

msgid "Radio"
msgstr "Funk"

msgid "Kanal"
msgstr "Kanal"

msgid "%d MHz (%d–%d MHz)"
msgstr "%d MHz (%d–%d MHz) breit"

msgid "Größe"
msgstr "Grö"

msgid "a \\"quoted\\" word\\n"
msgstr "ein \\"zitiertes\\" Wort\\n"

#, fuzzy
msgid "Fuzzy"
msgstr "Unscharf"

msgctxt "Menu"
msgid "Status"
msgstr "Zustand"

msgid "%d station"
msgid_plural "%d stations"
msgstr[0] "%d Station"
msgstr[1] "%d Stationen"

msgctxt "Radio"
msgid "%d band"
msgid_plural "%d bands"
msgstr[0] "%d Band"
msgstr[1] "%d Bänder"

msgid "Untranslated"
msgstr ""

#~ msgid "Old"
#~ msgstr "Alt"
msgid "Aü"
msgstr "Bü"

msgid "abcü"
msgstr "xyzü"
`;
const SAMPLE_LMO = [ [ '00000000', 'nplurals=2; plural=n != 1;' ], [ '015f3e71', '%d Stationen' ], [ '0607f8cc', 'Zustand' ],
	[ '219966c7', 'Speichern' ], [ '4c5310aa', 'xyzü' ], [ '547b2aea', 'Funk' ], [ '6189bee2', '%d Band' ],
	[ '7b80b910', '%d Station' ], [ '7e3b4ff0', 'Unscharf' ], [ '9cecaa5e', 'ein "zitiertes" Wort\\n' ], [ 'ad758169', 'Bü' ],
	[ 'b72330dd', '%d MHz (%d–%d MHz) breit' ], [ 'dbdc4cea', '%d Bänder' ], [ 'f057b2cf', 'Grö' ] ];

test('i18n: catalog.js hashes and compiles catalogues like LuCI', () => {
	/* keys of a real build's .lmo files (luci-i18n-vantage-zh-cn, -theme-zh-cn) */
	assert.equal(C.hex8(C.sfh('Dashboard')), '36ec1dcb');
	assert.equal(C.hex8(C.sfh('Log out')), 'f5cd233a');
	assert.equal(C.hex8(C.sfh('Log in')), '3008cc84');
	assert.equal(C.hex8(C.sfh('Download (to clients)')), '5b4da473');
	assert.equal(C.sfh(''), 0);
	assert.equal(C.sfh(Buffer.from('Save')), C.sfh('Save'));
	const got = C.lmoEntries(SAMPLE_PO).map(([ k, v ]) => [ C.hex8(k), v ]).sort((a, b) => a[0] < b[0] ? -1 : 1);
	assert.deepEqual(got, SAMPLE_LMO);
	/* cbi.js looks keys up as sfh(ctxt \x01 msgid) and sfh(msgid \x02 n) */
	assert.equal(C.hex8(C.sfh('Menu\u0001Status')), '0607f8cc');
	assert.equal(C.hex8(C.sfh('%d station\u00021')), '015f3e71');
});

test('i18n: translations body in the format of luci-base\'s action_translations', () => {
	const js = C.translationsJs([ [ 0x36ec1dcb, '仪表盘' ], [ 0, 'nplurals=1; plural=0;' ], [ 0x0000abcd, 'a "b"\n' ] ]);
	assert.equal(js, 'window.TR={"36ec1dcb":"仪表盘","00000000":"nplurals=1; plural=0;","0000abcd":"a \\"b\\"\\n",};');
	assert.deepEqual(C.parseTranslationsJs(js), [ [ 0x36ec1dcb, '仪表盘' ], [ 0, 'nplurals=1; plural=0;' ], [ 0xabcd, 'a "b"\n' ] ]);
	assert.deepEqual(C.parseTranslationsJs('window.TR={};'), []);
	assert.deepEqual(C.parseTranslationsJs('alert(1)'), []);
	/* the browser runs it */
	const w = {};
	new Function('window', js)(w);
	assert.equal(w.TR['36ec1dcb'], '仪表盘');
});

test('i18n: parsePo reads what gettext reads', () => {
	const e = C.parsePo(SAMPLE_PO, 'sample.po');
	const by = id => e.find(x => x.id === id && !x.obsolete);
	assert.equal(by('a "quoted" word\n').str[0], 'ein "zitiertes" Wort\n');
	assert.deepEqual(by('%d station').str, [ '%d Station', '%d Stationen' ]);
	assert.equal(by('Status').ctxt, 'Menu');
	assert.deepEqual(by('Fuzzy').flags, [ 'fuzzy' ]);
	assert.ok(e.find(x => x.id === 'Old').obsolete);
	assert.throws(() => C.parsePo('msgid "x"\nmsgstr "\\q"\n', 'bad.po'), /unsupported escape/);
});
