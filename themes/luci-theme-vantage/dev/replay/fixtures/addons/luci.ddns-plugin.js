'use strict';
/* luci-app-ddns rpcd plugin (ddns.uc) stand-in */
exports.OBJECT = 'luci.ddns';
exports.POLICY = { get_services_log: { service_name: 'string' }, get_services_status: {}, get_ddns_state: {}, get_env: {} };
exports.call = (store, method, args) => {
	switch (method) {
	case 'get_services_status': {
		const res = {};
		for (const [ sid, s ] of Object.entries(store.uciGet('ddns') || {})) if (s['.type'] === 'service')
			res[sid] = s.enabled === '1'
				? { ip: sid.includes('6') ? '2001:db8:0:1::7' : '203.0.113.7', last_update: '2026-10-13 08:12', next_update: 'Verify', next_check: '2026-10-13 08:22', pid: 2817 }
				: { ip: null, last_update: null, next_update: 'Disabled', next_check: null, pid: null };
		return { result: [ 0, res ] };
	}
	case 'get_ddns_state':
		return { result: [ 0, { _version: '2.8.2-r72', _enabled: true, _curr_dateformat: '2026-10-13 08:40', _services_list: '2026-09-30 19:02' } ] };
	case 'get_env':
		return { result: [ 0, { has_wget: false, has_curl: false, has_ssl: true, has_proxy: true, has_forceip: true, has_bindnet: false, has_bindhost: false, has_dnsserver: true, has_cacerts: true, has_ipv6: true } ] };
	case 'get_services_log': {
		const name = String(args.service_name || '');
		let text = 'File not found or empty';
		const log = /^[A-Za-z0-9_]+$/.test(name) && store.fixtures && store.fixtures.read('/var/log/ddns/' + name + '.log');
		if (log) text = log.toString('utf8');
		return { result: [ 0, { result: text } ] };
	}
	}
	return { result: [ 3 ] };
};
