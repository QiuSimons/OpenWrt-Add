// Test double for ucode's nl80211 module: a channel survey dump of one
// interface from global STUB.survey, keyed by the interface's name, as
// nl80211.request returns it (an array of messages; null for a dump
// without any or a failed one, false for one cut short). 'no survey': a
// case where none may happen, the default. Fails closed: any other
// request stops the run. Constants as the kernel's.
'use strict';

const C = {
	NL80211_CMD_GET_SURVEY: 50,
	NLM_F_DUMP: 0x300
};

function request(cmd, flags, msg) {
	if (cmd != C.NL80211_CMD_GET_SURVEY || flags != C.NLM_F_DUMP || type(msg) != 'object' || length(msg) != 1 || type(msg.dev) != 'string')
		die(sprintf('nl80211 stub: request %J %J %J', cmd, flags, msg));

	if (global.STUB.survey === 'no survey')
		die(sprintf('nl80211 stub: a survey of %s where none may happen', msg.dev));

	return global.STUB.survey?.[msg.dev];
}

export { request, C as 'const' };
