# Roadmap

Ideas and planned work, roughly in priority order. Nothing here is
promised; issues and pull requests for any of it are welcome.

## Next

### Multiple access points (planned for 1.1)

Show the radios, SSIDs and clients of other OpenWrt access points on the
main dashboard, so a router without Wi-Fi still shows the whole network
(idea from [#5](https://github.com/anothaDev/luci-theme-vantage/pull/5)
by @nhAsif). Design: each peer runs `luci-app-vantage` with a dedicated
rpcd login limited to one read-only method; peer credentials live in a
config the dashboard can't read; a background poller on the main router
fetches peers over HTTPS with a pinned certificate and caches the result,
so an offline peer never slows down LuCI.

### Search for clients, radios and networks (Ctrl+K)

The command palette searches pages only. The dashboard already knows every
client, radio, SSID and interface; it should register them with the
palette so that typing a name, MAC, IP or SSID jumps straight to it:

- clients by alias, resolved name, MAC or IP, opening the client inspector
  (`#client=<mac>`);
- radios by band, channel or name, opening the radio inspector
  (`#radio=<name>`);
- SSIDs, opening the dashboard filtered to that network;
- interfaces, opening their LuCI page.

The theme must keep working without the app, so the palette needs a small,
optional provider API (the app registers a provider if the theme is
present) and results must be built as text nodes like everything else.

## Later

- **Tunnels and proxies in the network path:** show active tunnel
  interfaces (TUN, WireGuard, OpenVPN) between the device and the
  internet with their live rates, and name known proxy suites (OpenClash,
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
