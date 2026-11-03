'use strict';
/* luci-app-https-dns-proxy rpcd script stand-in; the provider list is the
   package's own (/usr/share/https-dns-proxy/providers, which
   dev/replay/addons.sh copies into its fixture directory) */
exports.OBJECT = 'luci.https-dns-proxy';
exports.POLICY = { getInitList: { name: 'string' }, getInitStatus: { name: 'string' }, getPlatformSupport: { name: 'string' }, getProviders: { name: 'string' }, setInitAction: { name: 'string', action: 'string' } };
const DIR = '/usr/share/https-dns-proxy/providers';
const N = 'https-dns-proxy';
exports.call = (store, method) => {
	switch (method) {
	case 'getInitList': return { result: [ 0, { [N]: { enabled: true, running: true } } ] };
	case 'getInitStatus': return { result: [ 0, { [N]: { enabled: true, running: true, force_dns_active: true, force_dns_ports: [ 53, 853 ], version: '2025.12.29-r1' } } ] };
	case 'getPlatformSupport': return { result: [ 0, { [N]: { http2_support: true, http3_support: false } } ] };
	case 'getProviders': {
		const list = [];
		for (const e of (store.fixtures && store.fixtures.list(DIR)) || []) {
			if (e.type !== 'file' || !/\.json$/.test(e.name)) continue;
			try { list.push(JSON.parse(store.fixtures.read(DIR + '/' + e.name).toString('utf8'))); } catch (err) {}
		}
		return { result: [ 0, { [N]: list } ] };
	}
	case 'setInitAction': return { result: [ 0, { result: true } ] };
	}
	return { result: [ 3 ] };
};
