'use strict';
/* Package wiring of luci-app-vantage: the rpcd ACL policy
   (security-tests/test_acl_policy.js, run here as part of the suite), the
   menu entry, the view's lack of HTML sinks and save buttons, and the
   default config. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('../security-tests/test_acl_policy.js');

const APP = path.join(__dirname, '..', 'luci-app-vantage');
const view = fs.readFileSync(path.join(APP, 'htdocs/luci-static/resources/view/vantage/overview.js'), 'utf8');
const menu = JSON.parse(fs.readFileSync(path.join(APP, 'root/usr/share/luci/menu.d/luci-app-vantage.json'), 'utf8'));
const makefile = fs.readFileSync(path.join(APP, 'Makefile'), 'utf8');
const config = fs.readFileSync(path.join(APP, 'root/etc/config/vantage'), 'utf8');

test('menu: top-level dashboard, first by order, gated by the app ACL', () => {
	const d = menu['admin/dashboard'];
	assert.equal(d.order, 1);
	assert.deepEqual(d.action, { type: 'view', path: 'vantage/overview' });
	assert.deepEqual(d.depends.acl, [ 'luci-app-vantage' ]);
});

test('view: no HTML sinks and no save/apply buttons', () => {
	assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(view));
	for (const k of [ 'handleSave', 'handleSaveApply', 'handleReset' ]) assert.match(view, new RegExp(k + ': null'));
});

test('view: aliases are checked by names.aliasOp and written only through luci.vantage set_alias', () => {
	assert.match(view, /names\.aliasOp\(/);
	assert.doesNotMatch(view, /object: 'uci', method: '(add|set|delete|commit|rename|order|apply|revert)'/, 'no uci write declare');
	assert.doesNotMatch(view, /callUci(Add|Set|Delete|Commit)\b/);
	const calls = [ ...view.matchAll(/callSetAlias\(([^)]*)\)/g) ].map(m => m[1]);
	assert.deepEqual(calls, [ 'key, value, icon' ]);
	/* the aliases are reloaded after every attempt, failed or not */
	assert.match(view, /callSetAlias\(key, value, icon\)\)\.then\([\s\S]*?\}\)\.then\(function\(res\) \{\n\t\t\treturn self\.loadAliases\(\)/);
});

test('view: wireless data comes from luci.vantage wireless, reverse DNS only with its group', () => {
	assert.match(view, /rpc\.declare\(\{ object: 'luci\.vantage', method: 'wireless'/);
	assert.doesNotMatch(view, /getWirelessDevices/);
	assert.match(view, /rdnsOff: !data\.canRdns/);
});

test('Makefile: feed-buildable LuCI app, config is a conffile', () => {
	assert.match(makefile, /^include \$\(TOPDIR\)\/rules\.mk$/m);
	assert.match(makefile, /^include \$\(TOPDIR\)\/feeds\/luci\/luci\.mk$/m);
	assert.match(makefile, /^# call BuildPackage - OpenWrt buildroot signature$/m);
	assert.match(makefile, /^PKG_VERSION:=[0-9]+\.[0-9]+\.[0-9]+$/m);
	assert.match(makefile, /^PKG_RELEASE:=[1-9][0-9]*$/m);
	assert.match(makefile, /^PKG_LICENSE:=GPL-3\.0-or-later$/m);
	assert.match(makefile, /^LUCI_TITLE:=Vantage dashboard$/m);
	assert.match(makefile, /^LUCI_DEPENDS:=\+luci-base \+rpcd( |$)/m);
	assert.match(makefile, /^LUCI_DEPENDS:=.* \+rpcd-mod-ucode( |$)/m, 'the plugin needs rpcd-mod-ucode');
	assert.doesNotMatch(makefile, /rrdns[^\n]*DEPENDS|DEPENDS[^\n]*rrdns|DEPENDS[^\n]*umdns/, 'reverse DNS and mDNS stay optional');
	assert.match(makefile, /^LUCI_MINIFY_CSS:=0$/m);
	assert.match(makefile, /define Package\/luci-app-vantage\/conffiles\n\/etc\/config\/vantage\nendef/);
	assert.ok(!fs.existsSync(path.join(APP, 'luasrc')), 'no Lua (would pull luci-lua-runtime)');
	/* rpcd ignores a world-writable plugin; luci.mk copies modes as they are */
	const mode = fs.statSync(path.join(APP, 'root/usr/share/rpcd/ucode/luci.vantage')).mode;
	assert.equal(mode & 0o002, 0, 'plugin is not world-writable');
});

test('default config: one named main section, no client entries', () => {
	const live = config.split('\n').filter(l => l.trim() && !/^\s*#/.test(l));
	assert.deepEqual(live, [ "config vantage 'main'" ]);
});
