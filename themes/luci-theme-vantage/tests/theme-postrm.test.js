'use strict';
/* The theme's postrm, run as the package managers run it, with a stub uci
   that logs what it is asked to change. */

const mkTmp = require('./tmpdir');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const V = require('../security-tests/verify_built_apk.js');
const ROOT = path.join(__dirname, '..');
const theme = V.parseMakefile(fs.readFileSync(path.join(ROOT, 'luci-theme-vantage', 'Makefile'), 'utf8'), 'theme');
const POSTRM = theme.script.postrm;

/* uci answers the current theme and Bootstrap's entry; changes are logged */
const UCI = `#!/bin/sh
[ "$1" = -q ] && shift
case "$1 $2" in
	"get luci.main.mediaurlbase") echo /luci-static/vantage ;;
	"get luci.themes.Bootstrap") echo /luci-static/bootstrap ;;
	get*|show*) ;;
	*) echo "$*" >> "$UCI_LOG" ;;
esac
`;

const run = (args, extra = {}) => {
	const dir = mkTmp('vantage-postrm-');
	fs.mkdirSync(path.join(dir, 'bin'));
	fs.writeFileSync(path.join(dir, 'bin', 'uci'), UCI, { mode: 0o755 });
	fs.writeFileSync(path.join(dir, 'postrm'), POSTRM + '\n', { mode: 0o755 });
	const log = path.join(dir, 'uci.log');
	const r = spawnSync('sh', [ path.join(dir, 'postrm'), ...args ], {
		env: Object.assign({ PATH: path.join(dir, 'bin') + ':' + process.env.PATH, UCI_LOG: log }, extra), encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
};

test('theme postrm: an opkg upgrade keeps the theme LuCI uses', () => {
	assert.deepEqual(run([ 'upgrade', '1.0.9-r1' ]), []);
	assert.deepEqual(run([ '1.0.8-r1' ], { PKG_UPGRADE: '1' }), []);
});

test('theme postrm: removal falls back to Bootstrap and drops the theme entry', () => {
	const want = [ 'set luci.main.mediaurlbase=/luci-static/bootstrap', 'delete luci.themes.Vantage', 'delete luci.main.vantage_https', 'commit luci' ];
	/* opkg passes "remove"; apk's post-deinstall gets the old version */
	assert.deepEqual(run([ 'remove' ], { PKG_UPGRADE: '0' }), want);
	assert.deepEqual(run([ '1.0.8-r1' ]), want);
});

/* The theme's uci-defaults script, sourced in a subshell from its own
   directory as the package's postinst and the boot script run it: a script
   that ends with an error is kept and run again at the next boot. uci is a
   stub that keeps what is set (staged) apart from what is committed
   (saved), one "option=value" a line, logs what it is asked to change and
   fails the one command $UCI_FAIL names; rm only logs (the script's paths
   are the device's). */
const DEFAULTS = fs.readFileSync(path.join(ROOT, 'luci-theme-vantage/root/etc/uci-defaults/30_luci-theme-vantage'), 'utf8');
const UCI_DEFAULTS = `#!/bin/sh
[ "$1" = -q ] && shift
[ "$1" = get ] || echo "$*" >> "$UCI_DIR/log"
[ "$*" != "$UCI_FAIL" ] || exit 1
case "$1" in
	get) v=$(cat "$UCI_DIR/saved" "$UCI_DIR/staged" | grep -F "$2=" | tail -n 1); [ -n "$v" ] && echo "\${v#*=}" ;;
	set) echo "$2" >> "$UCI_DIR/staged" ;;
	revert) grep -v -F "$2=" "$UCI_DIR/staged" > "$UCI_DIR/staged.new"; cat "$UCI_DIR/staged.new" > "$UCI_DIR/staged" ;;
	commit) cat "$UCI_DIR/staged" >> "$UCI_DIR/saved"; : > "$UCI_DIR/staged" ;;
esac
`;
const BOOTSTRAP = 'luci.main.mediaurlbase=/luci-static/bootstrap';
/* a device: its saved config, and what is set and not yet committed */
const device = (saved = [ BOOTSTRAP ], staged = []) => {
	const dir = mkTmp('vantage-defaults-');
	fs.mkdirSync(path.join(dir, 'bin'));
	fs.mkdirSync(path.join(dir, 'uci-defaults'));
	fs.writeFileSync(path.join(dir, 'bin', 'uci'), UCI_DEFAULTS, { mode: 0o755 });
	fs.writeFileSync(path.join(dir, 'bin', 'rm'), '#!/bin/sh\necho "rm $*" >> "$UCI_DIR/log"\n', { mode: 0o755 });
	fs.writeFileSync(path.join(dir, 'uci-defaults', '30_luci-theme-vantage'), DEFAULTS, { mode: 0o755 });
	const file = n => path.join(dir, n), lines = n => fs.readFileSync(file(n), 'utf8').split('\n').filter(Boolean);
	fs.writeFileSync(file('saved'), saved.map(l => l + '\n').join(''));
	fs.writeFileSync(file('staged'), staged.map(l => l + '\n').join(''));
	fs.writeFileSync(file('log'), '');
	const sh = (code, env) => spawnSync('sh', [ '-c', code, 'sh', path.join(dir, 'uci-defaults') ], {
		env: Object.assign({ PATH: path.join(dir, 'bin') + ':' + process.env.PATH, UCI_DIR: dir, UCI_FAIL: '' }, env), encoding: 'utf8' });
	return {
		/* the script as the system runs it: its status, and what it asked uci and rm for */
		install(env) { fs.writeFileSync(file('log'), ''); const r = sh('cd "$1" && ( . ./30_luci-theme-vantage )', env); return { status: r.status, log: lines('log') }; },
		/* the postinst's own commit, after its scripts */
		commit() { assert.equal(sh('uci commit').status, 0); },
		/* a reboot: what was set and not committed is gone with /tmp */
		boot() { fs.writeFileSync(file('staged'), ''); },
		staged: () => lines('staged'),
		/* the saved config, the last value of each option */
		saved: () => Object.fromEntries(lines('saved').map(l => [ l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1) ]))
	};
};
const ENTRY = 'luci.themes.Vantage', THEME = 'luci.main.mediaurlbase', VANTAGE = '/luci-static/vantage';
const REGISTER = `set ${ENTRY}=${VANTAGE}`, SELECT = `set ${THEME}=${VANTAGE}`;
const CLEAN = 'rm -f /etc/config/vantage_theme-opkg /etc/config/vantage_theme.apk-new';

test('theme uci-defaults: a fresh install registers and selects the theme; an upgrade or a known entry only registers', () => {
	let d = device();
	assert.deepEqual(d.install(), { status: 0, log: [ REGISTER, SELECT, 'commit luci', CLEAN ] });
	assert.deepEqual([ d.saved(), d.staged() ], [ { [ENTRY]: VANTAGE, [THEME]: VANTAGE }, [] ]);
	d = device();
	assert.deepEqual(d.install({ PKG_UPGRADE: '1' }), { status: 0, log: [ REGISTER, 'commit luci', CLEAN ] });
	assert.deepEqual(d.saved(), { [ENTRY]: VANTAGE, [THEME]: '/luci-static/bootstrap' });
	d = device([ BOOTSTRAP, ENTRY + '=' + VANTAGE ]);
	assert.deepEqual(d.install(), { status: 0, log: [ REGISTER, 'commit luci', CLEAN ] });
	assert.equal(d.saved()[THEME], '/luci-static/bootstrap', 'a reinstall keeps the theme in use');
});

test('theme uci-defaults: a step that fails ends it with an error, takes back what it set and nothing else, and cleans nothing up', () => {
	/* registering, selecting and committing, each failing alone; beside it, a change someone else has set */
	const other = 'luci.main.lang=de';
	let d = device([ BOOTSTRAP ], [ other ]);
	assert.deepEqual(d.install({ UCI_FAIL: REGISTER }), { status: 1, log: [ REGISTER ] }, 'nothing of its own to take back');
	assert.deepEqual(d.staged(), [ other ]);
	d = device([ BOOTSTRAP ], [ other ]);
	assert.deepEqual(d.install({ UCI_FAIL: SELECT }), { status: 1, log: [ REGISTER, SELECT, 'revert ' + ENTRY ] }, 'the entry, not the selection it never set');
	assert.deepEqual(d.staged(), [ other ]);
	d = device([ BOOTSTRAP ], [ other ]);
	assert.deepEqual(d.install({ UCI_FAIL: 'commit luci' }), { status: 1, log: [ REGISTER, SELECT, 'commit luci', 'revert ' + ENTRY, 'revert ' + THEME ] });
	assert.deepEqual(d.staged(), [ other ], 'the packaged copies stay until a commit holds, and so does the other change');
	d = device([ BOOTSTRAP, ENTRY + '=' + VANTAGE ], [ other ]);
	assert.deepEqual(d.install({ UCI_FAIL: 'commit luci', PKG_UPGRADE: '1' }), { status: 1, log: [ REGISTER, 'commit luci', 'revert ' + ENTRY ] });
	assert.deepEqual([ d.staged(), d.saved()[ENTRY] ], [ [ other ], VANTAGE ], 'the entry saved before stays');
});

test('theme uci-defaults: after a step that failed, the postinst\'s own commit keeps nothing of it, and the retry at the next boot still selects the theme', () => {
	/* the postinst commits whatever is left set right after its scripts (default_postinst in
	   /lib/functions.sh): an entry left set there was saved alone, read as known at the next
	   boot, and the theme was never selected */
	for (const fails of [ SELECT, 'commit luci', REGISTER ]) {
		const d = device();
		assert.equal(d.install({ UCI_FAIL: fails }).status, 1, fails);
		d.commit();
		assert.deepEqual(d.saved(), { [THEME]: '/luci-static/bootstrap' }, 'nothing of the failed run is saved: ' + fails);
		d.boot();
		assert.deepEqual(d.install(), { status: 0, log: [ REGISTER, SELECT, 'commit luci', CLEAN ] }, 'the entry is new again: ' + fails);
		assert.deepEqual(d.saved(), { [ENTRY]: VANTAGE, [THEME]: VANTAGE }, fails);
	}
	/* an upgrade that failed is no fresh install at the next boot either: the entry it found is still there */
	const d = device([ BOOTSTRAP, ENTRY + '=' + VANTAGE ]);
	assert.equal(d.install({ UCI_FAIL: 'commit luci', PKG_UPGRADE: '1' }).status, 1);
	d.commit(); d.boot();
	assert.equal(d.install().status, 0);
	assert.equal(d.saved()[THEME], '/luci-static/bootstrap');
});
