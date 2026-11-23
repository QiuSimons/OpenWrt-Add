'use strict';
/* A DSA switch (--dsa, with --wired): wired.js's ports lan1 and lan2 as
   the ports of a switch chip under DSA, to see the dashboard count them
   by the chip's own counters (#156).

     network.device status          lan1 and lan2 typed dsa, their kernel
                                    counters only a trickle (what passes
                                    the CPU), as on such a switch
     luci.vantage.ports counters    SYNTHETIC, in the plugin's own form:
                                    the chip's counters for lan1 and lan2,
                                    at the ports' full rates, from what the
                                    chip had counted before the replay began,
                                    each with the time it was read (at: ms
                                    since the replay started, as the
                                    device's monotonic clock counts)

   Without --dsa the object answers as the plugin does on a device without
   a DSA port (state 'none'), and the dashboard asks no more. */

const wired = require('./wired');

/* the share of a port's traffic that passes the CPU: the rest the chip forwards between its ports */
const VIA_CPU = 1 / 50;
/* bytes the chip had counted before (since its last reset) */
const BEFORE = 7e10;

const NONE = { v: 1, state: 'none', took: 0, more: false, ports: {} };
/* the replay's start, for the device's monotonic clock */
const T0 = Date.now() / 1000;

/* the plugin's answer at t s */
function counters(t) {
	const ports = {};
	wired.PORTS.forEach((p, i) => {
		const c = wired.counters(p.rate, 10 + i, t);
		ports[p.dev] = { rx_bytes: BEFORE + c.rx_bytes, tx_bytes: 2 * BEFORE + c.tx_bytes, at: Math.round((t - T0) * 1000) };
	});
	return { v: 1, state: 'ok', took: 7, more: false, ports };
}

/* reply: the reply after wired.js; returns the reply to send */
function transform(object, method, args, reply) {
	const res = reply && reply.result;
	if (!Array.isArray(res) || res[0] !== 0 || object !== 'network.device' || method !== 'status' || (args && args.name) || !res[1] || typeof res[1] !== 'object') return reply;
	const t = Date.now() / 1000, out = Object.assign({}, res[1]);
	wired.PORTS.forEach((p, i) => {
		if (!out[p.dev]) return;
		out[p.dev] = Object.assign({}, out[p.dev], { devtype: 'dsa', type: 'Network device', statistics: wired.counters(p.rate * VIA_CPU, 10 + i, t) });
	});
	return { result: [ 0, out ] };
}

module.exports = { transform, counters, NONE };
