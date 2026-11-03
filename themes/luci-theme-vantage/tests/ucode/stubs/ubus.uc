// Test double for ucode's ubus module: replies from global STUB.ubus,
// keyed 'object method'. Fails closed: any call but network.wireless
// status stops the run.
'use strict';

function connect() {
	return {
		call: function(obj, method, args) {
			if (obj != 'network.wireless' || method != 'status')
				die(sprintf('ubus stub: call %J %J', obj, method));

			return global.STUB.ubus?.[`${obj} ${method}`];
		}
	};
}

export { connect };
