// Test double for ucode's rtnl module: the bridge forwarding database
// dump from global STUB.fdb (null: the request failed; 'no dump': a case
// where none may happen), and a route lookup's answer for a family from
// global STUB.lookup, keyed "2" (AF_INET) and "10" (AF_INET6): a route,
// false (the kernel's error: no route) or null (not sent); 'no lookup':
// a case where none may happen. Fails closed: any other request stops
// the run. Constants as the kernel's.
'use strict';

const C = {
	RTM_NEWNEIGH: 28, RTM_DELNEIGH: 29, RTM_GETNEIGH: 30,
	RTM_NEWROUTE: 24, RTM_GETROUTE: 26, RTM_F_FIB_MATCH: 0x2000,
	NLM_F_DUMP: 0x300, AF_INET: 2, AF_INET6: 10, AF_BRIDGE: 7,
	RT_TABLE_MAIN: 254, RTN_UNICAST: 1,
	NUD_REACHABLE: 0x02, NUD_STALE: 0x04, NUD_NOARP: 0x40, NUD_PERMANENT: 0x80,
	NTF_SELF: 0x02, NTF_MASTER: 0x04
};

function request(cmd, flags, msg) {
	if (cmd == C.RTM_GETROUTE && flags == 0 && type(msg) == 'object' && length(msg) == 3 && msg.flags == C.RTM_F_FIB_MATCH &&
	    ((msg.family == C.AF_INET && msg.dst == '198.51.100.1') || (msg.family == C.AF_INET6 && msg.dst == '2001:db8::1'))) {
		if (global.STUB.lookup === 'no lookup')
			die('rtnl stub: a lookup where none may happen');

		return global.STUB.lookup?.[sprintf('%d', msg.family)];
	}

	if (cmd != C.RTM_GETNEIGH || flags != C.NLM_F_DUMP || type(msg) != 'object' || msg.family != C.AF_BRIDGE || length(msg) != 1)
		die(sprintf('rtnl stub: request %J %J %J', cmd, flags, msg));

	if (global.STUB.fdb === 'no dump')
		die('rtnl stub: a dump where none may happen');

	return global.STUB.fdb;
}

export { request, C as 'const' };
