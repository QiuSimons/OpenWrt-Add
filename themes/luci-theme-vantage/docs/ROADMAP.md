# Roadmap

Ideas and planned work, roughly in priority order. Nothing here is
promised; issues and pull requests for any of it are welcome.

## Next

What 1.1 and 1.2 shipped and left open.

### Other access points

Since 1.1 the optional `luci-app-vantage-aps` shows the radios, SSIDs
and clients of paired OpenWrt access points on the router's dashboard
(ideas from [#5](https://github.com/anothaDev/luci-theme-vantage/pull/5)
by @nhAsif and [#127](https://github.com/anothaDev/luci-theme-vantage/pull/127)
by @Vikk20; see the spec, "Other access points"). Still open: access
points without Dropbear; the collector under a user of its own instead
of root; finding a moved access point over IPv6.

### Per-device traffic (experimental)

Since 1.2.0 the optional `luci-app-vantage-traffic` counts the traffic
through a router of each device that shares a port, from connection
tracking, without firewall rules
([#110](https://github.com/anothaDev/luci-theme-vantage/issues/110) by
@MohdMusab; see the spec, "Per-device traffic"). It reads in a process
of its own, so rpcd and LuCI are never held up by a read. Still open:
what a read costs small routers with large connection tables (a tenth
of one core at most, by design); flows offloaded to hardware; whether
Top talkers should rank these devices; living beside nlbwmon, which
resets the same counters.

### WireGuard tile

Since 1.1, from LuCI's own `luci.wireguard getWgInstances`
([#129](https://github.com/anothaDev/luci-theme-vantage/issues/129);
see the spec, "WireGuard tile"). Still open: what the call costs a
router with many peers, or with peers configured by host name, which
LuCI's plugin looks up on every call.

### Search on other pages

Since 1.1 the dashboard answers the command palette (Ctrl+K) with its
clients, radios, Wi-Fi networks and interfaces (see the spec, "Entity
search"). Other pages can answer the same way; none does yet.

### Provider tiles (experimental)

Since 1.2.0 another package can put a read-only tile on the dashboard
([#129](https://github.com/anothaDev/luci-theme-vantage/issues/129);
for authors [`docs/TILES.md`](TILES.md), see also the spec, "Provider
tiles"). Experimental: the contract may change in any release. Still
open: a provider of the project's own, before the contract is called
stable; what reading the session's ACL costs a router with many LuCI
apps (once a page); more than three such tiles or longer ids, which
need the theme's stored-layout form widened in its script and its
template together; letting that one ACL read answer the dashboard's
four group probes too.

## Later

- **Proxies in the network path:** a full-tunnel VPN already shows on its
  line; name known proxy suites (OpenClash,
  PassWall, Mihomo, sing-box) with their running state, from a small
  table of service names. Needs one read-only ACL addition (the list of
  running services). Suite internals (nodes, rules) stay in their own
  pages for now; reading them would mean API secrets and HTTP calls from
  rpcd ([#7](https://github.com/anothaDev/luci-theme-vantage/issues/7)).
- **One-click actions (v2):** restart a radio, disconnect or block a
  client, enable or disable an SSID. Each action gets its own narrow ACL
  group and a confirmation; the read-only dashboard stays the default.
- **Client names from DHCP:** a small service on the device that watches
  DHCP requests crossing the bridge and records the hostnames clients
  send. This is the only automatic name source that works on an access
  point that is not the DHCP server.
- **History and alerts:** an optional rpcd plugin that keeps a small ring
  buffer (signal, throughput, client counts) so charts survive a page
  reload, plus simple alerts (uplink down, client with weak signal for
  minutes).
- **Topology view:** gateway, access points and switches from LLDP and
  neighbour tables, not just the local path.
- **luci-app-statistics integration:** show collectd history in the
  dashboard when it is installed.
- **OpenWrt 24.10 Wi-Fi pages:** 1.0.8 ships signed 24.10 packages,
  tested on a router without Wi-Fi. Still to check: the Wi-Fi pages and the
  dashboard's radio and client tiles on a 24.10 router with a radio.
- **Firewall overview from the live ruleset:** read what fw4 actually
  loaded (`nft -j list ruleset`, through a read-only rpcd call) instead of
  predicting it from the config. It ends the "can't tell" cases and the
  1.0.7 known limit on sets that services define (`docs/SPEC.md`), and the
  page no longer has to follow fw4's matching rules. Plan: one new method on
  the `luci.vantage` rpcd plugin, read-only and without arguments, that
  returns a summary (zones, their devices, what is open), never the raw
  ruleset. First try loading fw4 in the plugin (`require("fw4")`), which
  spawns nothing; `nft -j` only if fw4's internals change too much between
  releases. The browser gets no `file exec`: the ACL adds that one method to
  the app's read section, beside the firewall config it already reads, and
  `test_acl_policy.js` checks it stays read-only and argument-free.
  Alternative since the Status → Firewall flow chart: it reads the live
  ruleset with the `nft --terse --json list ruleset` call LuCI's own page
  makes, under luci-mod-status's ACL, with no new rpcd method and no change
  to the app's ACL. The overview could do the same: an admin login has that
  grant; a user without it keeps today's config-only view. That relaxes
  `test_acl_policy.js` for this one call, and the app needs its own copy of
  the model (`vantage-theme/nftmodel.js`), since theme and app stay
  independent. Decide this before building the rpcd method.

## Upstream

- **LuCI core `L.env` on anonymous 404 pages:** LuCI's core `header.ut`
  prints the whole menu tree for visitors who are not logged in (see
  `SECURITY.md` and `docs/luci-contract.md`). A small patch to print only
  the fields `luci.js` uses would fix it for every theme.
