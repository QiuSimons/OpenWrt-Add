'use strict';
'require baseclass';
'require vantage.fmt as fmt';

/* Client naming. An access point that is not the DHCP server knows almost
   nothing about its stations: no hostnames, often not even an address, and
   most phones use randomised ("private") MAC addresses. This module turns
   whatever is available into one human label plus the source it came
   from, in a fixed order of trust:

     alias   the user's own name (uci vantage, section type client)
     dns     reverse DNS of the station's address (network.rrdns)
     mdns    mDNS host announcement (umdns hosts)
     dhcp    a hostname in LuCI's host hints (DHCP lease on routers)
     wps     the device name the station sends in its WPS element
     vendor  manufacturer from the OUI of a globally unique MAC
     private "Private device" for a locally administered MAC
     mac     "Device" as the last resort

   Pure functions; names are untrusted and only ever rendered as text. */

var NAME_MAX = 48;

var SOURCES = {
	alias: 'Alias', dns: 'DNS', mdns: 'mDNS', dhcp: 'DHCP', wps: 'WPS',
	vendor: 'Vendor', 'private': 'Private', mac: 'MAC'
};

/* device icons the user can pick; also guessed from names */
var ICONS = [ 'phone', 'laptop', 'tablet', 'desktop', 'tv', 'speaker', 'printer', 'camera', 'console', 'watch', 'iot', 'router', 'device' ];

var GUESS = [
	[ /\b(print|printer|envy|officejet|deskjet|laserjet|pixma|ecotank|mfc-|hl-|brother|epson|canon)/i, 'printer' ],
	[ /\b(iphone|pixel|galaxy|android|phone|redmi|oneplus|xperia|moto)/i, 'phone' ],
	[ /\b(ipad|tablet|tab\b|kindle|fire hd)/i, 'tablet' ],
	[ /\b(macbook|laptop|notebook|thinkpad|surface|chromebook|xps|zenbook|ideapad)/i, 'laptop' ],
	[ /\b(imac|desktop|workstation|\bpc\b|mac mini|nuc)/i, 'desktop' ],
	[ /\b(tv|bravia|roku|chromecast|fire ?tv|shield|apple ?tv|webos|tizen)/i, 'tv' ],
	[ /\b(echo|sonos|homepod|speaker|nest mini|google home)/i, 'speaker' ],
	[ /\b(cam|camera|doorbell|ring|arlo|wyze|eufy)/i, 'camera' ],
	[ /\b(playstation|ps[345]|xbox|nintendo|switch|steam ?deck)/i, 'console' ],
	[ /\b(watch)/i, 'watch' ],
	[ /\b(esp[-_]?\d|shelly|tasmota|sonoff|tuya|hue|plug|bulb|thermostat|sensor)/i, 'iot' ],
	[ /\b(router|access point|\bap\b|openwrt|fritz|repeater|mesh)/i, 'router' ]
];

function str(v) { return typeof v === 'string' ? v : ''; }

return baseclass.extend({
	NAME_MAX: NAME_MAX,
	SOURCES: SOURCES,
	ICONS: ICONS,

	/* '02-00-5E-00-53-0F' / '0200.5e00.530f' -> '02:00:5e:00:53:0f', else null */
	normMac: function(mac) {
		var hex = str(mac).trim().toLowerCase();
		if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/.test(hex)) return hex.replace(/-/g, ':');
		if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(hex) || /^[0-9a-f]{12}$/.test(hex)) {
			hex = hex.replace(/\./g, '');
			return hex.match(/../g).join(':');
		}
		return null;
	},

	/* locally administered (U/L bit set): randomised / private address */
	isPrivateMac: function(mac) {
		var m = this.normMac(mac);
		return !!m && (parseInt(m.slice(0, 2), 16) & 2) === 2;
	},

	/* group bit set: not a station address */
	isMulticastMac: function(mac) {
		var m = this.normMac(mac);
		return !!m && (parseInt(m.slice(0, 2), 16) & 1) === 1;
	},

	/* 'AA:BB:CC' key for the vendor table, or null for private/multicast */
	ouiKey: function(mac) {
		var m = this.normMac(mac);
		if (!m || this.isPrivateMac(m) || this.isMulticastMac(m)) return null;
		return m.slice(0, 8).toUpperCase();
	},

	/* hostapd client signature "wifi4|probe:...,wps:Model_Name|assoc:..."
	   -> 'Model Name' (hostapd replaces spaces with '_') */
	wpsName: function(signature) {
		var m = str(signature).match(/(?:^|[|,:])wps:([^|,]{1,64})/);
		if (!m) return null;
		var name = m[1].replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
		return /[A-Za-z0-9]/.test(name) ? fmt.safeText(name, NAME_MAX) : null;
	},

	/* 'phone.lan.' -> 'phone'; keeps names that are not below a local
	   search domain as they are */
	cleanHostname: function(name) {
		var n = str(name).trim().replace(/\.$/, '');
		if (!n || /^[\d.]+$/.test(n) || /:/.test(n)) return null;   /* an address, not a name */
		n = n.replace(/\.(lan|local|home|localdomain|home\.arpa|internal|fritz\.box|station)$/i, '');
		return n ? fmt.safeText(n, NAME_MAX) : null;
	},

	/* User alias from the inspector: trimmed, inner whitespace collapsed,
	   control/bidi characters rejected, at most NAME_MAX code points.
	   -> { ok, value } or { ok: false, error } ; '' clears. */
	validateAlias: function(name) {
		var s = str(name).replace(/\s+/g, ' ').trim();
		if (!s) return { ok: true, value: '' };
		if (fmt.safeText(s, 1000) !== s) return { ok: false, error: _('Name contains invisible or control characters') };
		if (Array.from(s).length > NAME_MAX) return { ok: false, error: _('Name is longer than %d characters').format(NAME_MAX) };
		return { ok: true, value: s };
	},

	validIcon: function(icon) { return ICONS.indexOf(icon) >= 0 ? icon : null; },

	guessIcon: function(name) {
		var n = str(name);
		for (var i = 0; i < GUESS.length; i++) if (GUESS[i][0].test(n)) return GUESS[i][1];
		return null;
	},

	/* uci vantage -> { 'aa:bb:..': { sid, name, icon } }; invalid MACs and
	   empty names are skipped, the first section for a MAC wins */
	aliasMap: function(sections) {
		var out = Object.create(null), self = this;
		(Array.isArray(sections) ? sections : []).forEach(function(s) {
			if (!s || s['.type'] !== 'client') return;
			var mac = self.normMac(s.mac), v = self.validateAlias(s.name);
			if (!mac || out[mac] || !v.ok || !v.value) return;
			out[mac] = { sid: str(s['.name']), name: v.value, icon: self.validIcon(s.icon) };
		});
		return out;
	},

	/* umdns hosts reply { 'name.local': { ipv4: '...', ipv6: '...' } }
	   -> { ip: name } */
	mdnsMap: function(hosts) {
		var out = Object.create(null), self = this;
		if (!hosts || typeof hosts !== 'object') return out;
		Object.keys(hosts).forEach(function(host) {
			var h = hosts[host], name = self.cleanHostname(host);
			if (!name || !h || typeof h !== 'object') return;
			[ 'ipv4', 'ipv6' ].forEach(function(k) {
				var v = h[k];
				(Array.isArray(v) ? v : [ v ]).forEach(function(ip) { if (typeof ip === 'string' && ip && !out[ip]) out[ip] = name; });
			});
		});
		return out;
	},

	/* Resolve the display name of one station.
	   s: { mac, alias: { name, icon }, ips: [..], rdns: { ip: name },
	        mdns: { ip: name }, hint: { name }, wps, vendor }
	   -> { name, source, sourceLabel, icon, secondary, isPrivate } */
	resolve: function(s) {
		s = s || {};
		var self = this, mac = this.normMac(s.mac) || str(s.mac);
		var ips = Array.isArray(s.ips) ? s.ips.filter(function(ip) { return typeof ip === 'string' && ip; }) : [];
		var priv = this.isPrivateMac(mac), name = null, source = null;

		function fromIps(map) {
			if (!map) return null;
			for (var i = 0; i < ips.length; i++) {
				var n = Object.prototype.hasOwnProperty.call(map, ips[i]) ? self.cleanHostname(map[ips[i]]) : null;
				if (n) return n;
			}
			return null;
		}

		var alias = s.alias && this.validateAlias(s.alias.name);
		if (alias && alias.ok && alias.value) { name = alias.value; source = 'alias'; }
		if (!name && (name = fromIps(s.rdns))) source = 'dns';
		if (!name && (name = fromIps(s.mdns))) source = 'mdns';
		if (!name && s.hint && (name = this.cleanHostname(s.hint.name))) source = 'dhcp';
		if (!name && s.wps && (name = fmt.safeText(str(s.wps).trim(), NAME_MAX) || null)) source = 'wps';

		var tail = fmt.macTail(mac);
		if (!name) {
			if (priv) { name = _('Private device') + ' · ' + tail; source = 'private'; }
			else if (s.vendor) { name = _('%s device').format(fmt.safeText(s.vendor, 32)) + ' · ' + tail; source = 'vendor'; }
			else { name = _('Device') + ' · ' + tail; source = 'mac'; }
		}

		var icon = (s.alias && this.validIcon(s.alias.icon)) || this.guessIcon(source === 'vendor' ? s.vendor : name) || 'device';
		return {
			name: name,
			source: source,
			sourceLabel: SOURCES[source],
			icon: icon,
			/* second line: the address when there is one, else the MAC */
			secondary: ips.length ? ips[0] : fmt.mac(mac),
			isPrivate: priv
		};
	}
});
