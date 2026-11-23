'use strict';
/* Provider tiles (--tiles): two providers of dashboard tiles another
   package would install (#129), answered as their rpcd plugins would, to
   develop the dashboard's side of the hook. Without --tiles no session
   holds a grant for them and the objects are absent, as on a router
   without such a package, so the dashboard asks for nothing.

     vantage.tile.dns status     the example provider in tiles/ (its rpcd
                                 ucode plugin and ACL group), over
                                 SYNTHETIC dnsmasq metrics: counters that
                                 grow with the clock, about 40 queries a
                                 second, most from the cache
     vantage.tile.modem status   SYNTHETIC, no plugin behind it: a mobile
                                 backup line's signal (dBm and dB with
                                 levels), its band and operator as text,
                                 and the bytes it moved

   ACL: the groups the session holds with --tiles, as rpcd grants them to
   root: the example's own file, and one for the modem in the same form.
   Numbers and names are invented. */

const fs = require('fs');
const path = require('path');

const ACL_DIR = path.join(__dirname, 'tiles/root/usr/share/rpcd/acl.d');

/* the example's ACL group from its file, and the modem's */
function acl() {
	const out = {};
	for (const f of fs.readdirSync(ACL_DIR).filter(f => /^[a-z0-9-]+\.json$/.test(f)))
		Object.assign(out, JSON.parse(fs.readFileSync(path.join(ACL_DIR, f), 'utf8')));
	out['vantage-tile-modem'] = { description: 'replay stand-in', read: { ubus: { 'vantage.tile.modem': [ 'status' ] } } };
	return out;
}

/* what the example plugin answers for dnsmasq's metrics (m: its reply,
   or anything else when dnsmasq does not answer); the same rules, kept
   alike by tests/tiles.test.js */
function dnsStatus(m) {
	if (!m || typeof m !== 'object' || Array.isArray(m))
		return { v: 1, title: 'DNS', icon: 'globe', state: 'off', note: 'dnsmasq does not answer', page: 'admin/network/dhcp', items: [] };
	const n = k => Number.isInteger(m[k]) && m[k] >= 0 ? m[k] : 0;
	const cached = n('dns_local_answered'), forwarded = n('dns_queries_forwarded');
	const asked = cached + forwarded + n('dns_auth_answered') + n('dns_stale_answered');
	return {
		v: 1, title: 'DNS', icon: 'globe', state: 'ok', every: 10, page: 'admin/network/dhcp',
		note: 'dnsmasq, since it started',
		items: [
			{ label: 'Queries', value: asked, rate: true, trend: true },
			{ label: 'Forwarded', value: forwarded, rate: true },
			{ label: 'From cache', value: cached + forwarded ? Math.trunc(cached * 1000 / (cached + forwarded)) / 10 : 0, unit: '%', max: 100 },
			{ label: 'Unanswered', value: n('dns_unanswered') }
		]
	};
}

/* dnsmasq's counters, `t` seconds after it started: about 40 queries a
   second, a little more by day, 85 % of them from the cache */
const T0 = Date.now() / 1000 - 3 * 86400;
function metrics(now) {
	const t = Math.max(0, now - T0), q = Math.round(40 * t + 400 * Math.sin(t / 900)), fw = Math.round(q * 0.15);
	return { dns_cache_inserted: fw, dns_cache_live_freed: 0, dns_queries_forwarded: fw, dns_auth_answered: 0, dns_local_answered: q - fw,
		dns_stale_answered: 0, dns_unanswered: Math.round(t / 3600), dhcp_ack: Math.round(t / 600) };
}

/* the backup line: its signal moves slowly, the bytes grow */
function modemStatus(now) {
	const t = now - T0, rsrp = Math.round(-97 + 6 * Math.sin(t / 300)), sinr = Math.round(10 * (6 + 5 * Math.sin(t / 240))) / 10;
	return {
		v: 1, title: 'Mobile backup', icon: 'signal', state: rsrp < -100 ? 'warn' : 'ok', every: 15,
		note: 'Standby: the main line is up',
		items: [
			{ label: 'RSRP', value: rsrp, unit: 'dBm', level: rsrp < -100 ? 'warn' : null, trend: true },
			{ label: 'SINR', value: sinr, unit: 'dB' },
			{ label: 'Band', text: 'B3 · 1800 MHz' },
			{ label: 'Operator', text: 'Example Mobile' },
			{ label: 'Traffic', value: Math.round(2e5 * t), unit: 'B', rate: true }
		]
	};
}

/* reply for the replay's ubusReply: { result } or { error } */
function transform(object, method, args) {
	const now = Date.now() / 1000;
	if (method !== 'status') return { result: [ 3 ] };
	if (object === 'vantage.tile.dns') return { result: [ 0, dnsStatus(metrics(now)) ] };
	if (object === 'vantage.tile.modem') return { result: [ 0, modemStatus(now) ] };
	return { error: { code: -32000, message: 'Object not found' } };
}

module.exports = { acl, dnsStatus, metrics, modemStatus, transform, ACL_DIR };
