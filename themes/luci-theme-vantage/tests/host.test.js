'use strict';
/* Theme host chip: product name from `system board` (vantage-theme.host). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/* same evaluation as tests/luci-stub.js, for a theme resource */
function loadThemeModule(rel) {
	const file = path.join(__dirname, '..', 'luci-theme-vantage', 'htdocs', 'luci-static', 'resources', rel);
	const src = fs.readFileSync(file, 'utf8');
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		if (m[1] !== 'baseclass') throw new Error('unexpected dependency ' + m[1]);
		params.push(m[2] || m[1]);
		values.push({ extend: proto => proto });
	}
	return new Function(...params, src)(...values);
}

const host = loadThemeModule('vantage-theme/host.js');

test('reference-design model strings fall back to board_name', () => {
	assert.equal(host.productName({ model: 'Qualcomm Technologies, Inc. IPQ5332/RDP442/AP-MI01.3', board_name: 'zyxel,nwa50be' }), 'Zyxel NWA50BE');
	assert.equal(host.productName({ model: 'MediaTek MT7981 RFB', board_name: 'cudy,wr3000-v1' }), 'Cudy WR3000-V1');
	assert.equal(host.productName({ model: 'Qualcomm Atheros IPQ807x RDP', board_name: 'tplink,archer-ax80' }), 'TP-Link ARCHER-AX80');
	assert.equal(host.productName({ model: 'MT7621 reference board', board_name: 'glinet,gl-mt1300' }), 'GL.iNet GL-MT1300');
	assert.equal(host.productName({ model: 'Default string', board_name: 'asus,rt-ax53u' }), 'ASUS RT-AX53U');
});

test('a real product model is kept as is', () => {
	assert.equal(host.productName({ model: 'Zyxel NWA50BE', board_name: 'zyxel,nwa50be' }), 'Zyxel NWA50BE');
	assert.equal(host.productName({ model: 'Linksys E8450 (UBI)', board_name: 'linksys,e8450-ubi' }), 'Linksys E8450 (UBI)');
	assert.equal(host.productName({ model: 'GL.iNet GL-MT6000', board_name: 'glinet,gl-mt6000' }), 'GL.iNet GL-MT6000');
	assert.equal(host.productName({ model: '  Netgear   WAX202 ' }), 'Netgear WAX202');
});

test('missing model uses board_name; nothing usable gives an empty string', () => {
	assert.equal(host.productName({ board_name: 'zyxel,nwa50be' }), 'Zyxel NWA50BE');
	assert.equal(host.productName({ model: '', board_name: 'ubnt,unifi-6-lite' }), 'Ubiquiti UNIFI-6-LITE');
	assert.equal(host.productName({ model: null, board_name: 'some-vendor,box' }), 'Some Vendor BOX');
	assert.equal(host.productName({ model: 'Qualcomm Technologies, Inc. IPQ5332/RDP442' }), '');
	assert.equal(host.productName({ model: 'Qualcomm IPQ5332 RDP', board_name: 'qemu-standard-pc' }), 'qemu-standard-pc');
	assert.equal(host.productName({}), '');
	assert.equal(host.productName(null), '');
	assert.equal(host.productName('zyxel,nwa50be'), '');
});

test('board_name parsing is strict', () => {
	assert.equal(host.fromBoardName('zyxel,nwa50be'), 'Zyxel NWA50BE');
	assert.equal(host.fromBoardName('ZyXEL,NWA50BE'), 'Zyxel NWA50BE');
	assert.equal(host.fromBoardName('openwrt,one'), 'OpenWrt ONE');
	assert.equal(host.fromBoardName('nocomma'), null);
	assert.equal(host.fromBoardName(',model'), null);
	assert.equal(host.fromBoardName('vendor,'), null);
	assert.equal(host.fromBoardName('ven dor,<b>x</b>'), null);
	assert.equal(host.fromBoardName(42), null);
});

test('reference detection', () => {
	for (const m of [ 'Qualcomm Technologies, Inc. IPQ5332/RDP442/AP-MI01.3', 'MediaTek MT7986a RFB', 'IPQ8074/AP-HK01', 'Generic', 'Broadcom BCM4908 reference', '' ])
		assert.equal(host.looksLikeReference(m), true, m);
	for (const m of [ 'Zyxel NWA50BE', 'TP-Link Archer C7 v5', 'Raspberry Pi 4 Model B Rev 1.4', 'GL.iNet GL-MT3000' ])
		assert.equal(host.looksLikeReference(m), false, m);
});
