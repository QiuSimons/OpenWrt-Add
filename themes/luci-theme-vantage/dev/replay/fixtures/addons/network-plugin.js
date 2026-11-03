'use strict';
/* Answers 'network' as the recording does (next()), adding the protocol
   handlers of the luci-proto-* packages under test to get_proto_handlers. */
exports.OBJECT = 'network';
const EXTRA = { wireguard: { no_device: true, available: true } };
exports.call = (store, method, args, next) => {
	const r = next();
	if (method === 'get_proto_handlers' && r.result && r.result[0] === 0 && r.result[1] && typeof r.result[1] === 'object')
		Object.assign(r.result[1], EXTRA);
	return r;
};
