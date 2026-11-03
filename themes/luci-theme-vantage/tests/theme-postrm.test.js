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
	const want = [ 'set luci.main.mediaurlbase=/luci-static/bootstrap', 'delete luci.themes.Vantage', 'commit luci' ];
	/* opkg passes "remove"; apk's post-deinstall gets the old version */
	assert.deepEqual(run([ 'remove' ], { PKG_UPGRADE: '0' }), want);
	assert.deepEqual(run([ '1.0.8-r1' ]), want);
});
