'use strict';
/* dev/build/check-feeds.sh: the build stops on a feed that isn't pinned */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'dev/build/check-feeds.sh');
const SHA = 'e9ebca7598ce2f754b76267fd66bf2b85e6e4347';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-feeds-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const check = (lines, release) => {
	const file = path.join(dir, 'feeds.conf');
	fs.writeFileSync(file, lines.join('\n') + '\n');
	return spawnSync('bash', [ SCRIPT, file, release ], { encoding: 'utf8' });
};

test('feeds: commits pass, and the base feed may use the tag of this release', () => {
	const r2512 = check([
		`src-git --root=package base https://github.com/openwrt/openwrt.git^${SHA}`,
		`src-git packages https://github.com/openwrt/packages.git^${SHA}`,
		'src-link vantage /feed/'
	], '25.12.4');
	assert.equal(r2512.status, 0, r2512.stderr);
	const r2410 = check([
		'src-git-full base https://github.com/openwrt/openwrt.git;v24.10.8',
		`src-git luci https://github.com/openwrt/luci.git^${SHA}`
	], '24.10.8');
	assert.equal(r2410.status, 0, r2410.stderr);
});

test('feeds: a branch, a tag on another feed, another release or a short commit stop the build', () => {
	for (const [ line, release ] of [
		[ 'src-git luci https://github.com/openwrt/luci.git', '25.12.4' ],
		[ 'src-git luci https://github.com/openwrt/luci.git;openwrt-25.12', '25.12.4' ],
		[ 'src-git luci https://github.com/openwrt/luci.git;v24.10.8', '24.10.8' ],
		[ 'src-git-full base https://github.com/openwrt/openwrt.git;v24.10.7', '24.10.8' ],
		[ 'src-git base https://github.com/openwrt/openwrt.git;main', '25.12.4' ],
		[ 'src-git --root=package base https://github.com/openwrt/openwrt.git;v25.12.4', '25.12.4' ],
		[ `src-git luci https://github.com/openwrt/luci.git^${SHA.slice(0, 12)}`, '25.12.4' ],
		[ 'src-cpy extra /some/dir', '25.12.4' ]
	]) {
		const r = check([ line ], release);
		assert.equal(r.status, 1, line);
		assert.match(r.stderr, /not pinned/, line);
	}
});

test('feeds: a last line without a newline is checked too', () => {
	const file = path.join(dir, 'feeds-no-eol.conf');
	fs.writeFileSync(file, `src-git packages https://github.com/openwrt/packages.git^${SHA}\nsrc-git luci https://github.com/openwrt/luci.git`);
	const r = spawnSync('bash', [ SCRIPT, file, '25.12.4' ], { encoding: 'utf8' });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /not pinned to a commit: src-git luci /);
});

test('feeds: a missing or empty list stops the build', () => {
	assert.equal(spawnSync('bash', [ SCRIPT, path.join(dir, 'none'), '25.12.4' ], { encoding: 'utf8' }).status, 1);
	const empty = path.join(dir, 'empty');
	fs.writeFileSync(empty, '');
	assert.equal(spawnSync('bash', [ SCRIPT, empty, '25.12.4' ], { encoding: 'utf8' }).status, 1);
});
