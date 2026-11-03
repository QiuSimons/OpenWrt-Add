'use strict';
/* rpcd's rpc-sys object (attendedsysupgrade): package list only */
exports.OBJECT = 'rpc-sys';
exports.POLICY = { packagelist: { all: 'boolean' }, upgrade_start: { keep: 'boolean' } };
exports.call = (store, method) => {
	if (method === 'packagelist') return { result: [ 0, { packages: { 'base-files': '1700', 'busybox': '1.37.0-r5', 'luci': '26.124', 'luci-app-adblock': '4.5.2-r1', 'luci-app-sqm': '26.124', 'luci-theme-vantage': '1.0.4-r1', 'luci-app-vantage': '1.0.4-r1', 'wpad-basic-mbedtls': '2025.08.26-r1' } } ] };
	return { result: [ 3 ] };
};
