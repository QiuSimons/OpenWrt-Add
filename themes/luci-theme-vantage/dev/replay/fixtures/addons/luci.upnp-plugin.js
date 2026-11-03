'use strict';
/* luci-app-upnp rpcd plugin stand-in */
exports.OBJECT = 'luci.upnp';
exports.POLICY = { get_status: {}, delete_rule: { token: 'string' } };
exports.call = (store, method) => {
	if (method === 'get_status') return { result: [ 0, { rules: [
		{ num: '1', proto: 'UDP', extport: 3074, intaddr: '192.0.2.41', intport: 3074, descr: 'Game console (UDP 3074)', expires: 3480, host_hint: 'console' },
		{ num: '2', proto: 'TCP', extport: 51413, intaddr: '192.0.2.23', intport: 51413, descr: 'Transmission at 51413', expires: 0, host_hint: 'laptop' },
		{ num: '3', proto: 'UDP', extport: 41641, intaddr: '192.0.2.102', intport: 41641, descr: 'a-rather-long-application-description-without-spaces-to-test-wrapping', expires: 86100 }
	] } ] };
	if (method === 'delete_rule') return { result: [ 0, { result: 'OK' } ] };
	return { result: [ 3 ] };
};
