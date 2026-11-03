'use strict';
/* luci-app-wol rpcd plugin stand-in */
exports.OBJECT = 'luci.wol';
exports.POLICY = { stat: {}, exec: { name: 'string', args: 'array' } };
exports.call = (store, method) => {
	if (method === 'stat') return { result: [ 0, { etherwake: true, wakeonlan: true } ] };
	if (method === 'exec') return { result: [ 0, { code: 0, stdout: 'Sending magic packet to 255.255.255.255:9 with 00:00:5e:00:53:11\n' } ] };
	return { result: [ 3 ] };
};
