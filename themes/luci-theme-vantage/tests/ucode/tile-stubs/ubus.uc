// Test double for ucode's ubus module, for the example provider tile
// (tests/tiles.test.js): dnsmasq's metrics from global STUB.metrics (none:
// dnsmasq does not answer). Fails closed: any other call stops the run.
'use strict';

function connect() {
	return {
		call: function(obj, method, args) {
			if (obj != 'dnsmasq' || method != 'metrics' || args != null)
				die(sprintf('ubus stub: call %J %J %J', obj, method, args));

			return global.STUB.metrics;
		}
	};
}

export { connect };
