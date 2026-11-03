// Test double for ucode's rtnl module: the bridge forwarding database
// dump from global STUB.fdb (null: the request failed; 'no dump': a case
// where none may happen). Fails closed: any other request stops the run.
// Constants as the kernel's.
'use strict';

const C = {
	RTM_NEWNEIGH: 28, RTM_DELNEIGH: 29, RTM_GETNEIGH: 30,
	NLM_F_DUMP: 0x300, AF_BRIDGE: 7,
	NUD_REACHABLE: 0x02, NUD_STALE: 0x04, NUD_NOARP: 0x40, NUD_PERMANENT: 0x80,
	NTF_SELF: 0x02, NTF_MASTER: 0x04
};

function request(cmd, flags, msg) {
	if (cmd != C.RTM_GETNEIGH || flags != C.NLM_F_DUMP || type(msg) != 'object' || msg.family != C.AF_BRIDGE || length(msg) != 1)
		die(sprintf('rtnl stub: request %J %J %J', cmd, flags, msg));

	if (global.STUB.fdb === 'no dump')
		die('rtnl stub: a dump where none may happen');

	return global.STUB.fdb;
}

export { request, C as 'const' };
