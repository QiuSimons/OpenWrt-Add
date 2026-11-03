'use strict';
/* Demo mode (--demo): pseudonymise the recorded device data.

   The replay normally serves the mirror as recorded: real MAC addresses,
   LAN addresses, hostname, SSIDs, client names. With --demo every recorded
   reply is rewritten once, when the mirror is loaded and before anything
   (ubus JSON-RPC, cgi-exec text, server-side templates, the synthetic data
   derived from recorded series) can read it. The mapping is deterministic
   for a given mirror and consistent within a run: the same real value
   always becomes the same demo value, in JSON values, JSON keys and free
   text.

   Limits: identifiers are found by shape (addresses, MACs and what is
   derived from them) and by where they are recorded (the keys and log
   lines below). uci values are default-deny: a string under an option that
   is not known to be technical is replaced unless it looks technical
   itself. Free text elsewhere (logs, command output) is only rewritten for
   the shapes listed here, so look at a screenshot before you share it.

     MAC / BSSID    universal  -> 00:00:5E:00:53:xx (RFC 7042 documentation
                                  range; 04:/08:/0C: first octets after 256)
                    local      -> 02:00:5E:00:53:xx (U/L bit kept, so
                                  randomised client MACs stay "private";
                                  06:/0A:/0E: after 256)
                    group      -> 01:00:5E:90:10:xx (documentation multicast)
                    00:00:00:00:00:00 and FF:FF:FF:FF:FF:FF are kept; the
                    bare 12-digit form of a known MAC (bridge ids, DUIDs) is
                    rewritten too, as are a bridge id's MAC even when not
                    seen elsewhere, bare 12 digits after "mac"/"bssid" on
                    a line, a known MAC's last three bytes after "_" or "-"
                    (ESP_xxxxxx), its EUI-64 (a65e60fffe112233 and the
                    colon form) and solicited-node multicast groups
    IPv4           private/CGNAT/link-local, per /24: the first two
                    networks -> 192.0.2.0/24, 198.51.100.0/24 keeping the
                    last octet (the gateway stays .1); other networks and
                    public addresses -> 203.0.113.x
    IPv6           global -> 2001:db8:<n>::/48 (per real /48, subnet id
                    kept); unique-local -> 2001:db8:fd<n>::/48; long
                    interface identifiers (EUI-64, random) -> ::<n>, so
                    link-local addresses become short fe80::<n> forms
    AP hostname    -> vantage-ap
    SSIDs          by band, in wireless config order: 2.4 GHz Harbor,
                    Harbor-IoT, Harbor-Guest; 5 GHz Harbor-5G; 6 GHz
                    Harbor-6E (others Harbor-<n>)
    client names   hostnames, WPS device names and names in DHCP log lines
                    (DHCPACK, "not giving name") -> generic names by
                    device type ("office-printer" / "Office printer",
                    otherwise device-<n> / "Wireless device <n>")
    domains        -> home.arpa
    DUIDs          -> 0004 00005e0053xx... (per DUID; also after "DUID",
                    "duid=" or "client-id" in text)
    country        -> US (wifi country codes; iwinfo countrylist marks US
                    active). Channel and power data stay as recorded.
    time zone      -> UTC (zonename), UTC0 (timezone); getTimezones marks
                    UTC active
    SSH key fingerprints (SHA256:/MD5: in logs) -> a fixed placeholder
    serial numbers (serial, serial_number, sn keys) are removed; "Serial :"
    lines, SerialNumber: and serial=/sn= pairs in text are zeroed
    uci free text   (default-deny) every string under an option that is not
                    on the structural list below and does not look
                    technical (number, boolean, address, path, interface
                    or section name, a demo value) -> "<option>-<n>", or
                    host<n>.example.net for DNS-like names; NTP servers
                    other than *.pool.ntp.org / *.openwrt.org included. The
                    same original is replaced wherever else it appears
                    (nft comments, logs). OpenWrt's default firewall rule
                    names and the luci/ucitrack configs are kept.

   Names are found the way security-tests/check_private_addresses.js finds
   mirror identifiers (its list is merged in), plus names with spaces and
   WPS names from hostapd client signatures. Kept as is: the device model
   and board name (that is the product), interface names, firmware
   versions, counters, rates and signal values. */

const checker = require('../../security-tests/check_private_addresses');

const REDACTED = '<redacted>';
const AP_HOSTNAME = 'vantage-ap';
const DEMO_COUNTRY = 'US';
const DEMO_ZONENAME = 'UTC', DEMO_TIMEZONE = 'UTC0';
const DEMO_DOMAIN = 'home.arpa';
const FINGERPRINT = 'SHA256:demo0demo0demo0demo0demo0demo0demo0demo0dem';
const SSIDS = {
	'2g': [ 'Harbor', 'Harbor-IoT', 'Harbor-Guest' ],
	'5g': [ 'Harbor-5G', 'Harbor-5G-IoT' ],
	'6g': [ 'Harbor-6E' ],
	'60g': [ 'Harbor-60G' ]
};
/* device-type guesses for client names: [ test, host name, device name ] */
const KINDS = [
	[ /print|envy|officejet|laserjet|deskjet|epson|brother|canon|pixma|kyocera|xerox/i, 'office-printer', 'Office printer' ],
	[ /(^|[^a-z])tv([^a-z]|$)|bravia|roku|chromecast|firetv|fire-tv|appletv|apple-tv|webos|tizen|shield/i, 'living-room-tv', 'Living room TV' ],
	[ /iphone|android|pixel|galaxy|phone|redmi|oneplus|xiaomi|motorola/i, 'phone', 'Phone' ],
	[ /ipad|tablet|kindle/i, 'tablet', 'Tablet' ],
	[ /macbook|laptop|thinkpad|notebook|surface|xps|zenbook|latitude/i, 'laptop', 'Laptop' ],
	[ /echo|sonos|homepod|nest|alexa|speaker/i, 'kitchen-speaker', 'Kitchen speaker' ],
	[ /cam|doorbell/i, 'doorbell-camera', 'Doorbell camera' ],
	[ /nas|synology|qnap|diskstation/i, 'nas', 'NAS' ],
	[ /desktop|workstation|imac/i, 'desktop', 'Desktop' ]
];

/* uci options with technical values (enumerations, numbers, device and
   interface names, paths, addresses): kept after the address/name mapping.
   Everything else in a uci reply is free text (see uciValue). */
const UCI_STRUCTURAL = new Set([
	/* network */
	'proto', 'device', 'ifname', 'type', 'ports', 'auto', 'enabled', 'disabled', 'ipaddr', 'netmask', 'gateway', 'broadcast',
	'ip6addr', 'ip6gw', 'ip6assign', 'ip6hint', 'ip6class', 'ip6prefix', 'ip6ifaceid', 'ip4table', 'ip6table', 'dns', 'dns_metric',
	'metric', 'mtu', 'peerdns', 'defaultroute', 'delegate', 'force_link', 'vid', 'vlan', 'stp', 'igmp_snooping', 'multicast_querier',
	'bridge_empty', 'packet_steering', 'steering_flows', 'ula_prefix', 'dhcp_default_duid', 'macaddr', 'interface', 'target', 'table',
	'reqaddress', 'reqprefix', 'norelease', 'sourcefilter', 'ipv6', 'keepalive', 'demand', 'lookup', 'priority', 'mark',
	/* wireless */
	'band', 'channel', 'channels', 'htmode', 'hwmode', 'country', 'cell_density', 'txpower', 'path', 'ifname_prefix',
	'he_6ghz_reg_pwr_type', 'macaddr_base', 'mode', 'network', 'encryption', 'cipher', 'ieee80211w', 'ieee80211r', 'ieee80211k',
	'ieee80211v', 'ocv', 'mlo', 'ppe_vp', 'ttlm_enable', 'bssid', 'isolate', 'wds', 'hidden', 'multi_ap', 'disassoc_low_ack',
	'beacon_int', 'dtim_period', 'legacy_rates', 'noscan', 'distance', 'frag', 'rts', 'macfilter', 'wmm', 'uapsd', 'short_preamble',
	'ft_over_ds', 'ft_psk_generate_local', 'mobility_domain', 'wpa_disable_eapol_key_retries', 'enable_color', 'enable_smp_affinity',
	'radio', 'sae_pwe', 'max_inactivity', 'skip_inactivity_poll', 'bss_transition', 'time_advertisement', 'wnm_sleep_mode', 'proxy_arp',
	/* firewall */
	'input', 'output', 'forward', 'masq', 'mtu_fix', 'synflood_protect', 'src', 'dest', 'src_ip', 'dest_ip', 'src_port', 'dest_port',
	'src_dport', 'src_mac', 'family', 'icmp_type', 'limit', 'limit_burst', 'set_mark', 'set_xmark', 'reflection', 'flow_offloading',
	'flow_offloading_hw', 'drop_invalid', 'log', 'log_limit', 'helper', 'subnet', 'masq_src', 'masq_dest', 'zone', 'fullcone',
	/* dhcp */
	'start', 'leasetime', 'dhcpv4', 'dhcpv6', 'ra', 'ra_flags', 'ra_management', 'ra_default', 'ra_slaac', 'ndp', 'master', 'ignore',
	'force', 'dynamicdhcp', 'authoritative', 'boguspriv', 'cachesize', 'domainneeded', 'ednspacket_max', 'expandhosts', 'filter_a',
	'filter_aaaa', 'filterwin2k', 'leasefile', 'local', 'localise_queries', 'localservice', 'nonegcache', 'nonwildcard', 'readethers',
	'rebind_localhost', 'rebind_protection', 'resolvfile', 'localuse', 'port', 'noresolv', 'strictorder', 'allservers',
	'sequential_ip', 'dnssec', 'dnsseccheckunsigned', 'logqueries', 'quietdhcp', 'confdir', 'maindhcp', 'piofolder', 'loglevel', 'mac',
	'duid', 'hostid', 'tag', 'networkid',
	/* system, dropbear, uhttpd */
	'compat_version', 'conloglevel', 'cronloglevel', 'klogconloglevel', 'log_proto', 'log_size', 'log_ip', 'log_port', 'log_file',
	'log_remote', 'log_buffer_size', 'timezone', 'zonename', 'ttylogin', 'urandom_seed', 'buffersize', 'enable_server', 'use_dhcp',
	'enable', 'Interface', 'Port', 'PasswordAuth', 'RootPasswordAuth', 'RootLogin', 'GatewayPorts', 'LocalPortForward',
	'RemotePortForward', 'BannerFile', 'IdleTimeout', 'MaxAuthTries', 'SSHKeepAlive', 'DirectInterface',
	'cert', 'key', 'ca', 'cgi_prefix', 'lua_prefix', 'ubus_prefix', 'home', 'http_keepalive', 'listen_http', 'listen_https',
	'max_connections', 'max_requests', 'network_timeout', 'rfc1918_filter', 'script_timeout', 'tcp_keepalive', 'redirect_https',
	'no_symlinks', 'no_dirlists', 'no_ubusauth', 'ubus_cors', 'index_page', 'error_page', 'bits', 'days', 'ec_curve', 'key_type',
	/* leds, misc */
	'sysfs', 'trigger', 'dev', 'delayon', 'delayoff', 'default', 'inverted', 'interval', 'rx', 'tx', 'link'
]);
/* per section type, options that name structure there (a zone's or a
   device's name; elsewhere "name" is free text, e.g. a firewall rule) */
const UCI_STRUCTURAL_BY_TYPE = { zone: [ 'name' ], device: [ 'name' ], 'wifi-iface': [ 'ifname' ], 'bridge-vlan': [ 'ports' ] };
/* configs that carry no personal free text */
const UCI_STRUCTURAL_CONFIGS = new Set([ 'luci', 'ucitrack' ]);
/* fw4's default rule names are OpenWrt's, not the user's */
const FW_DEFAULTS = new Set([ 'Allow-DHCP-Renew', 'Allow-Ping', 'Allow-IGMP', 'Allow-DHCPv6', 'Allow-MLD', 'Allow-ICMPv6-Input',
	'Allow-ICMPv6-Forward', 'Allow-IPSec-ESP', 'Allow-ISAKMP', 'Support-UDP-Traceroute' ]);

const HEX2 = n => n.toString(16).padStart(2, '0');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* RFC 5952 text form of 8 x 16-bit groups */
function v6text(g) {
	let best = -1, bestLen = 1;
	for (let i = 0; i < 8; i++) {
		if (g[i]) continue;
		let j = i;
		while (j < 8 && !g[j]) j++;
		if (j - i > bestLen) { best = i; bestLen = j - i; }
		i = j;
	}
	const h = g.map(x => x.toString(16));
	if (best < 0) return h.join(':');
	return h.slice(0, best).join(':') + '::' + h.slice(best + bestLen).join(':');
}

class Pseudonymiser {
	constructor() {
		this.macs = new Map();       /* 12 lowercase hex -> 12 lowercase hex */
		this.macCount = { u: 0, l: 0, g: 0 };
		this.v4nets = new Map();     /* 'a.b.c' -> 'x.y.z' */
		this.v4other = new Map();    /* 'a.b.c.d' -> '203.0.113.n' */
		this.v6nets = new Map();     /* '2a02:...:...' -> [ g0, g1, g2 ] */
		this.iids = new Map();       /* 'g4:g5:g6:g7' -> n */
		this.names = new Map();      /* lowercase real -> demo */
		this.kindCount = new Map();
		this.countries = new Set();
		this.duids = 0;
		this.literalRe = null;
		this.bareRe = null;
		this.suffixRe = null;
		this.euiRe = null;
		this.structNames = new Set();    /* uci section / interface names */
		this.sectionTypes = new Map();   /* 'config\0sid' -> type */
		this.freeform = new Map();       /* real free text (uci) -> placeholder */
		this.freeCount = new Map();
	}

	/* every value this pseudonymiser produces (kept as is when seen again) */
	isDemo(v) {
		if (!this.demoValues) this.demoValues = new Set();
		if (this.demoValuesAt !== this.names.size + this.freeform.size) {
			this.demoValues = new Set([ ...this.names.values(), ...this.freeform.values(), AP_HOSTNAME, DEMO_DOMAIN ]);
			for (const list of Object.values(SSIDS)) for (const v2 of list) this.demoValues.add(v2);
			this.demoValuesAt = this.names.size + this.freeform.size;
		}
		return this.demoValues.has(v);
	}

	/* ------------------------------------------------------------ learning */

	/* every MAC in a string, so the bare hex form is known before use; and
	   client names that only DHCP log lines carry */
	learnText(s) {
		for (const m of s.matchAll(checker.MAC_SEP)) this.mac(m[1].replace(/[^0-9a-f]/gi, ''));
		for (const m of s.matchAll(checker.MAC_DOT)) this.mac(m[1].replace(/[^0-9a-f]/gi, ''));
		for (const m of s.matchAll(BRIDGE_ID)) this.mac(m[2]);
		for (const m of s.matchAll(EUI_BARE)) if (/^[0-9a-f]{6}fffe[0-9a-f]{6}$/i.test(m[1])) this.mac(euiToMac(m[1]));
		if (/mac|bssid/i.test(s)) for (const line of s.split('\n')) for (const m of line.matchAll(checker.MAC_BARE))
			if (checker.MAC_CONTEXT.test(line.slice(0, m.index))) this.mac(m[1]);
		for (const n of checker.logHostnames(s)) this.name(n, 'host');
	}

	name(real, kind) {
		if (typeof real !== 'string') return;
		let v = real.trim().replace(/\.$/, '');
		if (v.length < 3 || v.length > 100 || /^[\d.:]+$/.test(v) || checker.GENERIC.has(v.toLowerCase())) return;
		if (/^<redacted>$/.test(v)) return;
		const key = v.toLowerCase();
		if (this.names.has(key)) return;
		let demo;
		if (kind === 'ap') demo = AP_HOSTNAME;
		else if (kind === 'domain') demo = DEMO_DOMAIN;
		else if (kind === 'ssid') demo = this.next('ssid', n => 'Harbor-' + (n + 1));
		else if (kind === 'fqdn' && v.includes('.')) {
			this.name(v.split('.')[0], 'host');
			demo = (this.names.get(v.split('.')[0].toLowerCase()) || 'device') + '.' + DEMO_DOMAIN;
		}
		else {
			const device = kind === 'device', k = KINDS.find(x => x[0].test(v));
			const base = k ? (device ? k[2] : k[1]) : (device ? 'Wireless device' : 'device');
			const n = this.next((device ? 'D ' : 'H ') + base, n => n);
			demo = (k && n === 0) ? base : base + (device ? ' ' : '-') + (n + 1);
			/* hostapd writes WPS names with '_' for ' ' */
			if (device && /_/.test(v) && !/ /.test(v)) demo = demo.replace(/ /g, '_');
		}
		this.names.set(key, demo);
		if (kind === 'device') {
			/* the other spelling of a WPS name */
			const alt = /_/.test(v) ? v.replace(/_/g, ' ') : v.replace(/ /g, '_');
			if (!this.names.has(alt.toLowerCase())) this.names.set(alt.toLowerCase(), /_/.test(v) ? demo.replace(/_/g, ' ') : demo.replace(/ /g, '_'));
		}
		this.literalRe = null;
	}

	next(kind, fmt) {
		const n = this.kindCount.get(kind) || 0;
		this.kindCount.set(kind, n + 1);
		return fmt(n);
	}

	ssids(wireless) {
		/* uci wireless (or network.wireless status): SSIDs by band, in
		   section order */
		if (!wireless || typeof wireless !== 'object') return;
		const bands = {}, ifaces = [];
		for (const [ sid, s ] of Object.entries(wireless)) {
			if (!s || typeof s !== 'object') continue;
			if (s['.type'] === 'wifi-device') bands[sid] = s.band;
			else if (s['.type'] === 'wifi-iface' && typeof s.ssid === 'string') ifaces.push(s);
			else if (s.config && Array.isArray(s.interfaces)) {      /* network.wireless status */
				bands[sid] = s.config.band;
				for (const i of s.interfaces) if (i.config && typeof i.config.ssid === 'string') ifaces.push({ device: sid, ssid: i.config.ssid, '.index': ifaces.length });
			}
		}
		ifaces.sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));
		const used = {};
		for (const i of ifaces) {
			const key = i.ssid.trim().toLowerCase();
			if (!key || this.names.has(key)) continue;
			const band = bands[i.device] || '?';
			const list = SSIDS[band] || [];
			const n = used[band] = (used[band] || 0) + 1;
			const demo = list[n - 1] || (list[0] ? list[0] + '-' + n : null);
			if (demo) { this.names.set(key, demo); this.literalRe = null; }
		}
	}

	/* walk a recorded reply for names, countries, DUIDs and MACs */
	learn(x, key, ctx) {
		if (Array.isArray(x)) { for (const v of x) this.learn(v, key, ctx); return; }
		if (x && typeof x === 'object') {
			if (ctx && ctx.startsWith('uci ') && typeof x['.type'] === 'string' && typeof x['.name'] === 'string') {
				const config = ctx.slice(4);
				this.sectionTypes.set(config + '\0' + x['.name'], x['.type']);
				if (!x['.anonymous'] && /^(network|wireless|firewall|dhcp)$/.test(config) && /^(interface|device|wifi-device|wifi-iface|zone|dhcp|dnsmasq|odhcpd)$/.test(x['.type']))
					this.structNames.add(x['.name']);
				if (config === 'network' && x['.type'] === 'device' && typeof x.name === 'string') this.structNames.add(x.name);
			}
			for (const [ k, v ] of Object.entries(x)) {
				this.learnText(k);
				if (ctx === 'umdns hosts' && v && typeof v === 'object') this.name(k, 'host');
				if (ctx === 'luci-rpc getDUIDHints') this.duid(k);
				this.learn(v, k, ctx);
			}
			return;
		}
		if (typeof x !== 'string') return;
		this.learnText(x);
		if (key === 'hostname') this.name(x, /^system (board|info)$/.test(ctx) || ctx === 'uci system' ? 'ap' : 'host');
		else if (key === 'ssid' || key === 'mesh_id') this.name(x, 'ssid');
		else if (key === 'domain' || key === 'dns_search' || key === 'dns-search') this.name(x, 'domain');
		else if (key === 'fqdn') this.name(x, 'fqdn');
		else if (key === 'wps_device_name' || key === 'device_name') this.name(x, 'device');
		else if (key === 'name' && /^(luci-rpc (getHostHints|getDHCPLeases)|dhcp ipv[46]leases|uci dhcp)$/.test(ctx)) this.name(x, 'host');
		else if ((key === 'ifname' || key === 'device' || key === 'l3_device') && /^[A-Za-z0-9_.@-]{1,32}$/.test(x)) this.structNames.add(x);
		else if (ctx === 'network.rrdns lookup') this.name(x, 'fqdn');
		else if (key === 'signature') {
			const m = /(?:^|[|,:])wps:([^|,]{1,64})/.exec(x);
			if (m) this.name(m[1], 'device');
		}
		else if (/duid/i.test(key || '') && /^[0-9a-f]{8,}$/i.test(x)) this.duid(x);
		else if (key === 'country' && /^[A-Z]{2}$/.test(x) && x !== '00' && x !== 'ZZ' && x !== DEMO_COUNTRY) this.countries.add(x);
		else if (key === 'data' && ctx === 'file read /proc/sys/kernel/hostname') this.name(x, 'ap');
	}

	/* uci free text found by learnFreeform(): one placeholder per original,
	   also used for the same text anywhere else */
	learnFreeform(values, config) {
		if (!values || typeof values !== 'object' || UCI_STRUCTURAL_CONFIGS.has(config)) return;
		for (const s of Object.values(values)) {
			if (!s || typeof s !== 'object') continue;
			for (const [ k, v ] of Object.entries(s)) {
				if (k.startsWith('.') || this.uciStructural(config, s['.type'], k, v)) continue;
				for (const x of Array.isArray(v) ? v : [ v ]) if (typeof x === 'string') this.placeholder(k, x);
			}
		}
	}

	uciStructural(config, type, key, value) {
		if (UCI_STRUCTURAL.has(key)) return true;
		if ((UCI_STRUCTURAL_BY_TYPE[type] || []).includes(key)) return true;
		if (config === 'firewall' && key === 'name' && typeof value === 'string' && FW_DEFAULTS.has(value)) return true;
		return false;
	}

	/* after the address/name mapping: does v look technical rather than
	   like something a person typed? */
	technical(v) {
		if (v === '' || v === REDACTED || this.isDemo(v)) return true;
		if (/^[-+]?\d+(\.\d+)?$|^0x[0-9a-f]+$/i.test(v)) return true;
		if (/^(on|off|yes|no|true|false|enabled|disabled|auto|none|any|all|default|\*)$/i.test(v)) return true;
		if (v.startsWith('/') && !/\s/.test(v)) return true;
		if (/^#[0-9a-f]{3,8}$/i.test(v)) return true;
		/* addresses, prefixes, ranges, times, lists of them (already mapped) */
		const tokens = v.split(/[\s,]+/).filter(Boolean);
		if (tokens.length && tokens.every(t => /^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){1,7}(\/\d{1,3})?|\d+([-:.]\d+)*)$/i.test(t))) return true;
		if (checker.GENERIC.has(v.toLowerCase()) || this.structNames.has(v)) return true;
		if (/^(br-[\w.-]+|(eth|wlan|phy|radio|wl|bond|veth|tun|tap|wg|gre|sit|usb|wwan|ifb|mld|lan|wan)\d[\w.@-]*|lo|phy\d+-(ap|sta|mesh|mld)\d+)$/i.test(v)) return true;
		if (/^([a-z0-9-]+\.)*(pool\.ntp\.org|openwrt\.org)$/i.test(v)) return true;
		return false;
	}

	placeholder(key, real) {
		if (this.freeform.has(real)) return this.freeform.get(real);
		const mapped = this.text(real);
		if (this.technical(mapped)) return null;
		const k = String(key).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'value';
		const dns = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(real);
		const kind = dns ? 'dns' : k;
		const n = (this.freeCount.get(kind) || 0) + 1;
		this.freeCount.set(kind, n);
		const out = dns ? `host${n}.example.net` : `${k}-${n}`;
		this.freeform.set(real, out);
		/* the same text elsewhere (nft comments, logs): long enough not to
		   hit ordinary words */
		const t = real.trim();
		if (t.length >= 4 && !checker.GENERIC.has(t.toLowerCase()) && !this.names.has(t.toLowerCase())) {
			this.names.set(t.toLowerCase(), out);
			this.literalRe = null;
		}
		return out;
	}

	/* a uci option value (default-deny for free text) */
	uciValue(config, type, key, x) {
		if (Array.isArray(x)) return x.map(v => this.uciValue(config, type, key, v));
		if (typeof x !== 'string') return this.value(x, key, 'uci ' + config);
		const mapped = this.value(x, key, 'uci ' + config);
		if (UCI_STRUCTURAL_CONFIGS.has(config) || this.uciStructural(config, type, key, x) || this.technical(mapped)) return mapped;
		return this.placeholder(key, x) || mapped;
	}

	/* a uci get/state reply: { values: { sid: section } } | { values: section } | { value } */
	uciReply(r, config, args) {
		if (!r || typeof r !== 'object' || Array.isArray(r)) return this.value(r, undefined, 'uci ' + config);
		const section = s => {
			const out = {};
			for (const [ k, v ] of Object.entries(s)) {
				if (/^(serial|serial_?number|sn)$/i.test(k)) continue;
				out[this.text(k)] = k.startsWith('.') ? this.value(v, k, 'uci ' + config) : this.uciValue(config, s['.type'], k, v);
			}
			return out;
		};
		const out = {};
		for (const [ k, v ] of Object.entries(r)) {
			if (k === 'values' && v && typeof v === 'object' && !Array.isArray(v)) {
				if (typeof v['.type'] === 'string') out.values = section(v);
				else {
					out.values = {};
					for (const [ sid, s ] of Object.entries(v)) out.values[this.text(sid)] = (s && typeof s === 'object' && !Array.isArray(s)) ? section(s) : this.value(s, sid, 'uci ' + config);
				}
			}
			else if (k === 'value' && args && typeof args.option === 'string') {
				const type = this.sectionTypes.get(config + '\0' + args.section);
				out.value = this.uciValue(config, type, args.option, v);
			}
			else out[k] = this.value(v, k, 'uci ' + config);
		}
		return out;
	}

	duid(real) {
		if (typeof real !== 'string' || !/^[0-9a-f]{8,}$/i.test(real) || this.names.has(real.toLowerCase())) return;
		const n = ++this.duids;
		this.names.set(real.toLowerCase(), '0004' + ('00005e0053' + HEX2(n & 255)).padEnd(32, '0'));
		this.literalRe = null;
	}

	/* ------------------------------------------------------------- mapping */

	/* 12 hex digits -> 12 hex digits */
	mac(hex) {
		const h = hex.toLowerCase();
		if (/^0{12}$|^f{12}$/.test(h) || checker.MAC_ALLOWED.test(h.match(/../g).join(':'))) return h;
		let out = this.macs.get(h);
		if (out) return out;
		const o0 = parseInt(h.slice(0, 2), 16);
		if (o0 & 1) {
			const n = this.macCount.g++;
			out = '01005e9010' + HEX2(n & 255);
		}
		else {
			const local = !!(o0 & 2), c = local ? 'l' : 'u';
			const n = this.macCount[c]++;
			if (n < 1024) out = HEX2((local ? 0x02 : 0x00) | ((n >> 8) << 2)) + '005e0053' + HEX2(n & 255);
			else out = '02005e' + (0x010000 + n).toString(16).padStart(6, '0');   /* allowed local space */
		}
		this.macs.set(h, out);
		this.bareRe = null;
		return out;
	}

	v4(o) {
		const s = o.join('.');
		if (o.some(x => x > 255)) return s;
		const n = checker.v4int(o);
		const priv = !!checker.v4finding(o);
		if (!priv && (checker.PUBLIC_EXEMPT_V4.some(r => checker.inV4(n, r)) || n === 0xffffffff)) return s;
		if (priv) {
			const net24 = o.slice(0, 3).join('.');
			if (!this.v4nets.has(net24)) {
				const k = this.v4nets.size;
				this.v4nets.set(net24, [ '192.0.2', '198.51.100' ][k] || null);
			}
			const to = this.v4nets.get(net24);
			if (to) return to + '.' + o[3];
		}
		if (!this.v4other.has(s)) this.v4other.set(s, '203.0.113.' + (10 + this.v4other.size % 240));
		return this.v4other.get(s);
	}

	iid(g) {
		const k = g.slice(4).join(':');
		if (!this.iids.has(k)) this.iids.set(k, 0x10 + this.iids.size);
		return [ 0, 0, 0, this.iids.get(k) ];
	}

	v6(text) {
		const g = checker.v6groups(text);
		if (!g) return text;
		const lc = text.toLowerCase();
		if (lc === 'fd00::' || lc === 'fe80::') return text;
		const bigIid = !!(g[4] || g[5] || g[6]);
		let out = null;
		if ((g[0] & 0xe000) === 0x2000 && !(g[0] === 0x2001 && g[1] === 0x0db8)) {
			const k = g.slice(0, 3).join(':');
			if (!this.v6nets.has(k)) this.v6nets.set(k, [ 0x2001, 0x0db8, 1 + [ ...this.v6nets.values() ].filter(p => p[2] < 0xfd00).length ]);
			out = this.v6nets.get(k).concat(g[3], bigIid ? this.iid(g) : g.slice(4));
		}
		else if ((g[0] & 0xfe00) === 0xfc00) {
			const k = g.slice(0, 3).join(':');
			if (!this.v6nets.has(k)) this.v6nets.set(k, [ 0x2001, 0x0db8, 0xfd01 + [ ...this.v6nets.values() ].filter(p => p[2] >= 0xfd00).length ]);
			out = this.v6nets.get(k).concat(g[3], bigIid ? this.iid(g) : g.slice(4));
		}
		else if ((g[0] & 0xffc0) === 0xfe80 && bigIid) out = [ 0xfe80, 0, 0, 0 ].concat(this.iid(g));
		else if (g[0] === 0xff02 && g[5] === 1 && (g[6] >> 8) === 0xff) {
			/* solicited-node group: the low 24 bits of an address, often a MAC's */
			const low = ((g[6] & 0xff).toString(16).padStart(2, '0') + g[7].toString(16).padStart(4, '0'));
			this.suffixes();
			const demo = this.suffixMap.get(low) || (0x5300 + (this.iids.size & 0xff)).toString(16).padStart(6, '0');
			out = [ 0xff02, 0, 0, 0, 0, 1, 0xff00 | parseInt(demo.slice(0, 2), 16), parseInt(demo.slice(2), 16) ];
		}
		return out ? v6text(out) : text;
	}

	literals() {
		if (!this.literalRe) {
			const keys = [ ...this.names.keys() ].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
			this.literalRe = keys.length ? new RegExp('(?<![A-Za-z0-9])(' + keys.map(esc).join('|') + ')(?![A-Za-z0-9])', 'gi') : null;
		}
		return this.literalRe;
	}

	bare() {
		if (!this.bareRe) {
			const keys = [ ...this.macs.keys() ].filter(k => this.macs.get(k) !== k);
			this.bareRe = keys.length ? new RegExp('(' + keys.join('|') + ')', 'gi') : null;
		}
		return this.bareRe;
	}

	/* last three bytes of known unicast MACs after "_" or "-" (ESP_112233) */
	suffixes() {
		if (!this.suffixRe) {
			this.suffixMap = new Map();
			for (const [ real, demo ] of this.macs) if (real !== demo && !(parseInt(real.slice(0, 2), 16) & 1)) this.suffixMap.set(real.slice(6), demo.slice(6));
			const keys = [ ...this.suffixMap.keys() ];
			this.suffixRe = keys.length ? new RegExp('(?<=[_-])(' + keys.join('|') + ')(?![0-9a-f])', 'gi') : null;
		}
		return this.suffixRe;
	}

	/* free text: logs, command output, any JSON string */
	text(s) {
		if (typeof s !== 'string' || !s) return s;
		s = s.replace(/\b(SHA256:[A-Za-z0-9+/=]{16,}|MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2})/gi, FINGERPRINT);
		/* serial numbers in text */
		s = s.replace(/^([ \t]*Serial(?:[ \t]*Number)?[ \t]*:[ \t]*)\S.*$/gmi, '$10000000000000000');
		s = s.replace(/\b(serial(?:_?(?:number|no))?|SerialNumber|iSerial|sn)([ \t]*[=:][ \t]*)("?)([^\s",;]+)\3/gi, (m, k, sep, q) => `${k}${sep}${q}0000000000${q}`);
		/* DUIDs named in text */
		s = s.replace(/\b(duid|client-?id)([ \t]*[:=]?[ \t]*)((?:[0-9a-f]{2}:){7,}[0-9a-f]{2}|[0-9a-f]{16,})(?![0-9a-f:])/gi, (m, k, sep, d) => {
			const hex = d.replace(/:/g, '').toLowerCase();
			this.duid(hex);
			const out = this.names.get(hex) || hex;
			return k + sep + (d.includes(':') ? out.match(/../g).join(':') : out);
		});
		const lit = this.literals();
		if (lit) s = s.replace(lit, m => this.names.get(m.toLowerCase()) ?? m);
		const up = m => /[A-F]/.test(m) ? v => v.toUpperCase() : v => v;
		/* bridge ids (8000.<mac>) and bare MACs after "mac"/"bssid", known or not */
		s = s.replace(BRIDGE_ID, (m, prio, hex) => prio + '.' + up(hex)(this.mac(hex)));
		if (/mac|bssid/i.test(s)) s = s.split('\n').map(line => line.replace(checker.MAC_BARE, (m, hex, off) =>
			checker.MAC_CONTEXT.test(line.slice(0, off)) ? up(m)(this.mac(hex)) : m)).join('\n');
		/* EUI-64 interface identifiers written out (a65e60fffe112233, a65e:60ff:fe11:2233) */
		s = s.replace(EUI_BARE, (m, hex) => /^[0-9a-f]{6}fffe[0-9a-f]{6}$/i.test(hex) ? up(m)(macToEui(this.mac(euiToMac(hex)))) : m);
		s = s.replace(EUI_GROUPS, (m, a, b, c, d) => {
			const hex = [ a, b, c, d ].map(g => g.padStart(4, '0')).join('').toLowerCase();
			if (!/^[0-9a-f]{6}fffe[0-9a-f]{6}$/.test(hex)) return m;
			return up(m)(macToEui(this.mac(euiToMac(hex))).match(/.{4}/g).map(g => g.replace(/^0+(?=.)/, '')).join(':'));
		});
		s = s.replace(checker.MAC_SEP, (m, mac, sep) => {
			const out = this.mac(m.replace(/[^0-9a-f]/gi, ''));
			return up(m)(out.match(/../g).join(sep));
		});
		s = s.replace(checker.MAC_DOT, m => up(m)(this.mac(m.replace(/\./g, '')).match(/.{4}/g).join('.')));
		const bare = this.bare();
		if (bare) s = s.replace(bare, m => up(m)(this.macs.get(m.toLowerCase())));
		const suf = this.suffixes();
		if (suf) s = s.replace(suf, m => up(m)(this.suffixMap.get(m.toLowerCase())));
		s = s.replace(checker.IPV4, (m, a, b, c, d) => this.v4([ a, b, c, d ].map(Number)));
		s = s.replace(checker.IPV6, (m, addr, zone) => this.v6(addr) + (zone || ''));
		return s;
	}

	/* a JSON value; ctx is "object method" of the call it came from */
	value(x, key, ctx) {
		if (Array.isArray(x)) return x.map(v => this.value(v, key, ctx));
		if (x && typeof x === 'object') {
			const out = {};
			for (const [ k, v ] of Object.entries(x)) {
				if (/^(serial|serial_?(number|no)|sn|serialnumber)$/i.test(k)) continue;
				out[this.text(k)] = this.value(v, k, ctx);
			}
			if (ctx === 'iwinfo countrylist' && typeof out.code === 'string' && typeof out.active === 'boolean')
				out.active = (out.code === DEMO_COUNTRY);
			if (ctx === 'luci getTimezones' && key === undefined)
				for (const [ zone, z ] of Object.entries(out)) if (z && typeof z === 'object' && 'tzstring' in z) {
					if (zone === DEMO_ZONENAME) z.active = true; else delete z.active;
				}
			return out;
		}
		if (typeof x !== 'string') return x;
		if (key === 'country' && this.countries.has(x)) return DEMO_COUNTRY;
		if (key === 'zonename') return DEMO_ZONENAME;
		if (key === 'timezone') return DEMO_TIMEZONE;
		return this.text(x);
	}
}

/* 8000.b827eb123456 (bridge priority . MAC) */
const BRIDGE_ID = /(?<![0-9A-Fa-f.])([0-9A-Fa-f]{4})\.([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/g;
/* 16 hex digits / four colon groups: an EUI-64 interface identifier when
   ff:fe sits in the middle */
const EUI_BARE = /(?<![0-9A-Fa-f])([0-9A-Fa-f]{16})(?![0-9A-Fa-f])/g;
const EUI_GROUPS = /(?<![0-9A-Fa-f:.])([0-9A-Fa-f]{1,4}):([0-9A-Fa-f]{1,4}):([0-9A-Fa-f]{1,4}):([0-9A-Fa-f]{1,4})(?![0-9A-Fa-f:])/g;
function euiToMac(hex) {
	const h = hex.toLowerCase();
	return HEX2(parseInt(h.slice(0, 2), 16) ^ 2) + h.slice(2, 6) + h.slice(10, 16);
}
function macToEui(mac) {
	return HEX2(parseInt(mac.slice(0, 2), 16) ^ 2) + mac.slice(2, 6) + 'fffe' + mac.slice(6, 12);
}

/* Rewrite a loaded Store in place. `mirror` (optional) adds the identifier
   list of check_private_addresses.js. Returns the pseudonymiser. */
function pseudonymiseStore(store, mirror, argsKey) {
	const p = new Pseudonymiser();
	const ctxOf = key => { const [ o, m, a ] = key.split('\0'); return o === 'file' ? `${o} ${m} ${JSON.parse(a || '{}').path || ''}` : `${o} ${m}`; };
	const uciCtx = key => { const [ o, m, a ] = key.split('\0'); return (o === 'uci' && (m === 'get' || m === 'state')) ? 'uci ' + (JSON.parse(a || '{}').config || '') : null; };
	const replyData = r => r && Array.isArray(r.result) ? r.result[1] : undefined;

	/* SSIDs first, so they get the band-ordered names */
	for (const [ key, reply ] of store.exact) if (uciCtx(key) === 'uci wireless') p.ssids((replyData(reply) || {}).values);
	for (const [ key, rows ] of store.series) if (key.startsWith('network.wireless\0status\0')) p.ssids(rows[rows.length - 1]);
	/* uci system hostname is the AP's */
	for (const [ key, reply ] of store.exact) if (uciCtx(key) === 'uci system') for (const s of Object.values((replyData(reply) || {}).values || {})) if (s && s['.type'] === 'system') p.name(s.hostname, 'ap');
	for (const [ key, reply ] of store.exact) p.learn(replyData(reply), undefined, uciCtx(key) || ctxOf(key));
	for (const [ key, rows ] of store.series) for (const r of rows) p.learn(r, undefined, ctxOf(key));
	for (const body of store.http.values()) typeof body === 'string' ? p.learnText(body) : p.learn(body, undefined, 'http');
	for (const out of store.exec.values()) p.learnText(out);
	if (mirror) {
		let ids = new Map();
		try { ids = checker.mirrorIdentifiers(mirror); } catch (e) {}
		for (const [ v, kind ] of ids) if (kind !== 'public IPv4') p.name(v, kind === 'SSID' ? 'ssid' : kind === 'WPS device name' ? 'device' : 'host');
	}
	/* uci free text, once every name is known */
	for (const [ key, reply ] of store.exact) {
		const c = uciCtx(key);
		if (c) p.learnFreeform((replyData(reply) || {}).values, c.slice(4));
	}

	const rekey = key => {
		const [ o, m, a ] = key.split('\0');
		let args;
		try { args = JSON.parse(a); } catch (e) { return key; }
		return `${o}\0${m}\0${argsKey(p.value(args, undefined, 'args'))}`;
	};
	const reply = (r, ctx) => r && r.result !== undefined ? { result: p.value(r.result, undefined, ctx) } : r;
	const uciReply = (r, key) => {
		if (!r || !Array.isArray(r.result)) return reply(r, ctxOf(key));
		const [ , , a ] = key.split('\0');
		let args = {};
		try { args = JSON.parse(a || '{}'); } catch (e) {}
		return { result: [ r.result[0] ].concat(r.result.length > 1 ? [ p.uciReply(r.result[1], String(args.config || ''), args) ] : []) };
	};

	const exact = new Map();
	for (const [ key, r ] of store.exact) exact.set(rekey(key), uciCtx(key) ? uciReply(r, key) : reply(r, ctxOf(key)));
	store.exact = exact;
	/* loose (same object/method) replies: the rewritten exact reply they came from */
	const byOrig = new Map();
	for (const [ key, r ] of store.exact) byOrig.set(r, key);
	for (const [ lk, r ] of store.loose) {
		const k = byOrig.get(r);
		store.loose.set(lk, k ? exact.get(rekey(k)) : reply(r, lk.replace('\0', ' ')));
	}
	const series = new Map(), seriesLoose = new Map();
	for (const [ key, rows ] of store.series) series.set(rekey(key), rows.map(r => p.value(r, undefined, ctxOf(key))));
	for (const [ lk, key ] of store.seriesLoose) seriesLoose.set(lk, rekey(key));
	store.series = series; store.seriesLoose = seriesLoose;
	for (const [ url, body ] of store.http) store.http.set(url, typeof body === 'string' ? p.text(body) : p.value(body, undefined, 'http'));
	const exec = new Map();
	for (const [ argv, out ] of store.exec) exec.set(p.text(argv), p.text(out));
	store.exec = exec;
	return p;
}

module.exports = { Pseudonymiser, pseudonymiseStore, v6text, euiToMac, macToEui, AP_HOSTNAME, DEMO_COUNTRY, SSIDS, UCI_STRUCTURAL };
