// Test double for ucode's rtnl module (tests/traffic.test.js): the IPv4
// and IPv6 neighbour table dumps from global STUB.neigh, keyed "2"
// (AF_INET) and "10" (AF_INET6), an array of entries, or null for a dump
// that failed; each dump is counted in STUB.dumps. Fails closed: any
// other request stops the run. Constants as the kernel's.
'use strict';

const C = {
	RTM_NEWNEIGH: 28, RTM_DELNEIGH: 29, RTM_GETNEIGH: 30, NLM_F_DUMP: 0x300,
	AF_INET: 2, AF_INET6: 10, AF_BRIDGE: 7,
	NUD_INCOMPLETE: 0x01, NUD_REACHABLE: 0x02, NUD_STALE: 0x04, NUD_FAILED: 0x20, NUD_NOARP: 0x40, NUD_PERMANENT: 0x80
};

function request(cmd, flags, msg) {
	if (cmd != C.RTM_GETNEIGH || flags != C.NLM_F_DUMP || type(msg) != 'object' || length(msg) != 1 ||
	    (msg.family != C.AF_INET && msg.family != C.AF_INET6))
		die(sprintf('rtnl stub: request %J %J %J', cmd, flags, msg));

	global.STUB.dumps++;

	return global.STUB.neigh?.[sprintf('%d', msg.family)];
}

export { request, C as 'const' };
