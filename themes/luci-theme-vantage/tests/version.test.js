'use strict';
/* The version each package shows (the dashboard's System tile, the theme's
   Appearance) is its Makefile's PKG_VERSION: a release bumps all of them. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const pkgVersion = pkg => /^PKG_VERSION:=(\S+)$/m.exec(read(pkg + '/Makefile'))[1];

test('version: what the dashboard and the theme show is their Makefile\'s', () => {
	assert.equal(/^var VERSION = '([^']+)';/m.exec(read('luci-app-vantage/htdocs/luci-static/resources/view/vantage/overview.js'))[1],
		pkgVersion('luci-app-vantage'), 'overview.js');
	assert.equal(/^const VERSION = '([^']+)';/m.exec(read('luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js'))[1],
		pkgVersion('luci-theme-vantage'), 'menu-vantage.js');
});
