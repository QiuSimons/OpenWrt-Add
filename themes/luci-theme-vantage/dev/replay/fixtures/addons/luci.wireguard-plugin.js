'use strict';
/* luci-proto-wireguard rpcd plugin stand-in; keys are fixed dummy values */
exports.OBJECT = 'luci.wireguard';
exports.POLICY = { getWgInstances: {}, generateKeyPair: {}, getPublicAndPrivateKeyFromPrivate: { privkey: 'string' }, generatePsk: {} };
const key = c => c.repeat(43) + '=';
exports.call = (store, method) => {
	const now = Math.floor(Date.now() / 1000);
	switch (method) {
	case 'getWgInstances':
		return { result: [ 0, { wg0: { name: 'wg0', public_key: key('A'), listen_port: 51820, fwmark: 'off', peers: [
			{ name: 'phone', public_key: key('B'), endpoint: '198.51.100.20:40321', allowed_ips: [ '192.0.2.200/32', '2001:db8:2::200/128' ], latest_handshake: now - 47, transfer_rx: 18734221, transfer_tx: 203338410, persistent_keepalive: 'off' },
			{ name: 'laptop-with-a-long-peer-name', public_key: key('C'), endpoint: '(none)', allowed_ips: [ '192.0.2.201/32' ], latest_handshake: 0, transfer_rx: 0, transfer_tx: 0, persistent_keepalive: '25' }
		] } } ] };
	case 'generateKeyPair':
		return { result: [ 0, { keys: { priv: key('D'), pub: key('E') } } ] };
	case 'getPublicAndPrivateKeyFromPrivate':
		return { result: [ 0, { keys: { priv: key('D'), pub: key('E') } } ] };
	case 'generatePsk':
		return { result: [ 0, { psk: key('F') } ] };
	}
	return { result: [ 3 ] };
};
