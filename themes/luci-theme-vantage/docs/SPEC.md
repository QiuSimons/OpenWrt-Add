# Vantage — v1 specification

Status: **implemented** (v1, released as 1.0.x). This is the contract
both packages are built and reviewed against; section 5 lists what is
not built yet.

Vantage is a LuCI theme plus a companion dashboard app for OpenWrt. It
takes its cues from the *functionality* of managed-network consoles —
seeing the whole network at a glance, drilling into any client, radio or
port in one click, finding anything by typing — not from their look.

## 1. Goals

1. Every stock LuCI page works and looks deliberate under Vantage: no
   unstyled widget, no broken dropdown, no stuck spinner (see
   `docs/luci-contract.md`).
2. Navigation is fast: any page is two clicks or one Ctrl+K away.
3. The dashboard answers "is my network OK, and if not, where?" within a
   glance, on real devices with real quirks (APs without DHCP, missing
   noise values, placeholder model strings).
4. Safe by construction: app in v1 writes only its own config, narrow ACLs, template and
   DOM security checks in CI.
5. Small and offline: no CDNs, no web fonts, no frameworks, works on a
   128 MB device, first paint under 1 s on the device's own web server.

### Non-goals (v1)

- Replacing LuCI's forms or views; Vantage styles and wraps them.
- Device-changing actions from the dashboard (v2, behind their own ACLs).
- History/graphs (v2 plugin), topology maps (later).

## 2. Packages

| Package | Contents | Depends |
|---|---|---|
| `luci-theme-vantage` | ucode templates, CSS, icons, `menu-vantage.js` (shell: rail, top bar, palette, tabs, indicators), login page, its rpcd ACL (`/etc/config/vantage_theme` only), that config | `+luci-base` |
| `luci-app-vantage` | dashboard + inspector views under `admin/dashboard` (landing page), its rpcd ACL (reads + its own config only), its rpcd ucode plugin `luci.vantage` (key-free wireless status, temperatures, the bridges' wired hosts, validated alias writes), `/etc/config/vantage` | `+luci-base +rpcd +rpcd-mod-iwinfo +rpcd-mod-ucode +ucode-mod-uci +ucode-mod-ubus +ucode-mod-fs +ucode-mod-rtnl` (rpcd-mod-iwinfo, ucode-mod-fs and ucode-mod-rtnl beyond luci-base; Wi-Fi images already have rtnl, as wifi-scripts needs it); reverse DNS (`rpcd-mod-rrdns`), mDNS (`umdns`) and hostapd's ubus objects are optional and degrade |

The theme is useful alone; the app alone works under any theme but is
designed for Vantage. With both installed and another theme selected, the
dashboard steps aside: `admin/dashboard` opens LuCI's own landing page
instead (`luci-mod-dashboard`'s Status → Dashboard, else Status →
Overview). The view decides this in the browser, because LuCI caches the
menu tree across theme switches; a HEAD request for the theme's
`menu-vantage.js` tells whether the theme is installed. Names used
everywhere: theme dir `vantage`, media URL `/luci-static/vantage`, uci
`luci.themes.Vantage`, config `/etc/config/vantage`.

## 3. Theme v1

### Shell

- **Icon rail** (left, 56 px) with the top-level categories from
  `ui.menu`; hover/click opens a **flyout** of that category's pages;
  the rail can be pinned open with labels (remembered per browser).
- **Top bar**: breadcrumb (Category › Page › Tab; a crumb that only
  repeats the one before it, "System › System", is shown once, with the
  deeper link), **command palette**
  (Ctrl+K or `/`): fuzzy search over every menu page, recent pages first;
  later the app registers entities (clients, interfaces, radios) into it.
- **Indicators** as pills; the unsaved-changes count is prominent and
  opens the changes dialog. When the bar runs short of room the host
  chip gives way first, and at 900 px and below the pills shrink (the
  auto-refresh pill to a pause or play sign, the changes pill to its
  count), so the breadcrumb is cut last. The auto-refresh dot is the only
  thing in the shell that pulses: a slow, soft ring while refreshing, still
  while paused, and fast while the dashboard reports a problem: amber while
  it reconnects or warns, red for an error.
- **Host chip**: hostname · model (board name when the model string is a
  placeholder), from `system board` via rpc in the menu script; a name
  the other contains (compared without case and punctuation) is left
  out. The chip links to Status → Overview, which has the rest of the
  system details.
- **Theme toggle**: auto / light / dark, applied in `<head>` before CSS
  (no flash), exposed as `html[data-darkmode]`. The top bar's switch
  shows the pick (auto, sun, moon) and cycles auto → the look the system
  doesn't have → the one it has → auto, so the first click always
  changes the page; it saves as Appearance does. Appearance sits under
  the gear next to it. Appearance (this mode, what
  shows next to the logo after login, the login and network path
  backgrounds and, with the dashboard, Low-power router) is saved on the router for every
  browser, in `/etc/config/vantage_theme` (section `appearance`), by
  sessions holding the theme's rpcd group `luci-theme-vantage` (uci `set`,
  `commit` and `revert` on that config only; rpcd refuses commit and
  revert alike while a rollback is pending, so a save starts with a
  revert and stops there, leaving nothing in the session); the
  templates pass only known values on, as `data-vt-look-*`, and
  `data-vt-look-save` says whether this login may save: `yes`, `relogin`
  (rpcd would grant the group at a new login, and no reload of rpcd has
  given it to this one yet; the install's reload reaches open logins) or
  `no`. Saves queue and only the latest pick is written. A
  pick made without the group stays in that browser (`localStorage`,
  `vantage.<name>.own`) and wins there, but not for a login that may save
  (those keys are dropped); Appearance says when picks stay in the
  browser. This browser's last pick (`vantage.theme`, `vantage.login`,
  `vantage.backdrop.v1`, what the dashboard reads under another theme)
  counts until the router has one. The dashboard's chart style and layouts
  go the same way, in options `chart` and `layout_<class>[_wired]`: Done
  under Customize saves what it changed and the router doesn't have yet
  (`vantage.view.unsaved`, kept across a failed save or a reload; until
  then this browser's copy stands), by handing it to the theme (`vantage:view-save`), which writes it once. If
  that fails Customize stays open with a note: Done tries again, and Esc
  or the Customize button leaves without saving.
  The template passes them on as `data-vt-look-chart` and
  `data-vt-look-layout`, logged in only and in their form only, and
  `vantage.layout` validates them again. The router's come first for a
  login that may save; any other keeps this browser's, and sees the
  router's where it has none. Without the theme they stay in the browser.
- **Tabs**: one segmented control for every level: the menu's page tabs
  (depth ≥ 3, at the top of the content column), tabs at page level, in a
  form or modal, and tabs inside a tab. Nesting shows by where a control
  sits, not by a different look. A control wraps its segments instead of
  hiding them; on phones the segments share each row's width. Each
  segment is a whole control high to click or tap (the gap between the
  track's edge and the drawn segment is part of the segment), so a
  one-row track is one control high too. The page tabs carry their own
  class (`vt-pagetabs`): the theme styles no class the app uses.
- **Page switcher**: page tabs scroll with the page; on such a page the
  current crumb in the top bar is a switcher that lists them (a dropdown
  under the crumb, a bottom sheet on phones). It is a disclosure
  (`aria-expanded` + `aria-controls`, a region of links, no
  `aria-haspopup`). ArrowDown or ArrowUp on the crumb opens it at the
  current page; Tab from the open crumb enters the list, Tab from its
  last link closes it and goes on to the next top-bar control, Shift+Tab
  from its first link returns to the crumb, Escape closes it, and focus
  moving anywhere else closes it. It shares the panel with the rail's
  flyouts: hovering the rail while it is open leaves it open (a click on
  a category replaces it), and rail hover timers never close it.
- **Hit targets**: everything clickable in the shell is at least the
  control height (36 px with a mouse, 44 px on touch): tab segments, the
  crumb switch and its links, crumb links, and on touch the top bar's
  search, theme and log-out buttons.
- **Mobile** (≤ 720 px; the desktop side is written `width > 720px` so
  fractional widths fall on one side): the rail becomes a bottom bar
  (centred, scrolling from its first item when the categories do not
  fit) with a bottom sheet for flyouts; forms stack; the page's action
  bar keeps one row (labels wrap inside their buttons) and its Save &
  Apply menu opens upwards. Tables become cards using `td[data-title]`,
  in pages and in modals alike: header rows are hidden (not a named grid
  section's per-row name cell, which heads its card) and cells lose the
  fixed row height. Between 721 and 1180 px wide tables scroll inside
  their card, never the page.
- **Wide screens**: the content column is 1320 px wide, centred; on
  windows past about 1920 px it grows with them, keeping about 200 px
  clear on each side, up to 2400 px, so a 2K or 4K screen at 100 %
  scaling is not mostly margin.

### Pages

- Own **login** (`sysauth.ut`): the mark and the router's hostname as the
  heading ("Authorization Required" without one), as LuCI's Bootstrap
  shows it too; generic error, contract-correct form. No other system
  information (no model or version) for unauthenticated visitors. With
  LuCI's authentication plugins (luci-plugin-2fa, after 25.12) it shows
  their fields and guidance (an error once a wrong code was sent), their
  own HTML as Bootstrap prints it, and their scripts as plain script tags
  (the login page has no LuCI runtime; luci-plugin-2fa needs none).
- All core widgets per contract §5 (dropdown state machine, tabs, modals
  incl. apply countdown, tooltips, dynlist, progress bars, file browser,
  notifications with real fade-out transition, changes dialog).
- **Forms**: one control height for inputs, selects, dropdowns, buttons
  and tabs, chosen by pointer type, not screen width (36 px with a mouse,
  44 px on touch, 16 px text in touch fields); a 180 px label column and
  fields up to 360 px (a select grows to fit a long choice). Field help,
  and page and section intros, show their first line and an (i) button
  unfolds the rest, so the start of a warning is always visible; text
  that fits one line gets no button. A page or card heading that only
  repeats the breadcrumb, the map title or its tab is hidden visually and
  kept for screen readers. LuCI's text and the order of LuCI's nodes are
  never changed: the menu script adds the (i) buttons (after a field
  row's field, or first inside an intro) and sets classes, `data-v-help`
  and (where missing) a description `id` for `aria-controls`.
- **Stock pages** without form chrome get the same cards: Status →
  Firewall (nftables) shows each chain as a card with its rules edge to
  edge and matches as wrapping text; the System and Kernel Log filters
  are wrapping rows, and the log (a read-only viewer) keeps its own text
  size on touch and wraps on phones. Phone cards use one inset for every
  cell, hide empty cells, and give LuCI's wide columns (descriptions,
  addresses) the card's width. A tooltip is never clipped by the box
  that holds it and is sized to its text.
- **LuCI 24.10** markup is supported where it differs, detected by
  markup, never by version: Status → Overview's bare section headings
  (header row, memory and storage meters) and named table sections whose
  name is only the row's `data-title` (drawn as the name cell, the card
  title on phones). These rules match nothing on 25.12.
- 404 / CSRF pages render in the theme without leaking anything. A
  logged-in 404 is titled "Not found", in the crumbs and the page title.
- Focused fields show a 2 px `--focus` outline (border plus ring, at
  least 3:1 against field and card in both modes); text on coloured
  fills (danger buttons, error and info tooltips) uses an ink colour that
  keeps 4.5:1 in both modes.
- Add-ons: adblock and banIP pick their status palettes from the OS
  colour scheme; the theme sets their own light or dark palette from
  `html[data-darkmode]` instead, so they follow the theme toggle.
- **Row actions**: a table row with a main action (Edit, else LuCI's
  "important" button) and at least two others shows the main one and a ⋯
  menu with those, at one width so rows line up. Add, "important" and
  plain action buttons (an app's own, such as Wake on LAN's Wake) stay
  visible; rows of peer actions with no main one (Startup, Processes)
  stay as LuCI drew them; no menu holds a single item. LuCI's buttons
  stay in place, hidden, and a menu item clicks the original (its
  handler, confirmation, label, tooltip and disabled state are LuCI's,
  and an open menu follows them); while an original is busy, ⋯ shows
  the spinner. A menu: arrows, Home/End, Escape back to ⋯ (after a
  mouse or tap open too), Tab goes on from ⋯; it opens above the button
  when the screen or the phone bar leaves no room below, and on the
  roomier side, scrolling, when neither side fits.
- **Firewall**: a rule's or forward's verdict is a coloured badge (accept
  green, reject and drop red, forward and NAT blue), keyed on LuCI's raw
  target values, never on the translated labels; badge and warning text
  keeps 4.5:1 on a hovered row too. Zone and default policies stay plain
  (reject and drop are the safe values, accept between your own zones is
  normal), except the one that is a risk: the masquerading
  (internet-facing) zone accepting input, in the error colours, as on
  the Overview tab; a forwarding from it into another zone is outlined
  in the warning colour. A
  rule that is switched off is greyed (not faded, so its name and match
  keep 4.5:1) from the moment it is unticked. The match reads From/To
  first, the family/protocol line quieter. The zones table's long
  headers wrap, and a table wider than its card shows a shade on the
  side that scrolls. On phones a rule card carries its on/off switch in
  the corner, with a 44 px tap target, and no column labels.

### Visual identity

**Chosen: Graphite** (2026-09-26). Paper stays in `prototypes/paper` as a
reference only.

- **Graphite** — dark-first technical console, graphite neutrals,
  signal-lime accent, monospace tabular values, compact.
- **Paper** — light-first editorial, warm paper neutrals, vermilion
  accent, typography-led, softer.

Either way: one accent colour only, status colours distinct from it,
system font stacks, self-drawn SVG icons, WCAG AA contrast in both modes,
visible focus, reduced-motion respected.

One type scale for the theme and the dashboard: 10.5 / 12 / 13 / 14 /
16 / 20 / 24 px (`--fs-*`, shared as `--v-fs-*`). Every font size comes
from it, except the 16 px of fields on touch screens (iOS zooms into
anything smaller); monospace text is set a few percent smaller than the
text around it so it looks the same size.

## 4. App v1 (`luci-app-vantage`)

- **Overview**: device card (model, firmware, uptime, CPU, memory, temp
  if available), uplink card (the main line's interface, address, rate),
  radios card (band, channel, width, tx power, utilisation, client count),
  clients card (count by band, weakest signals), health score. The
  Clients tile lists Wi-Fi stations or wired hosts, switched in its head
  where a device has both, and folds its quick filters (bands, active,
  weak signal, new; per port for wired hosts) into a menu at the end of
  the search box, the one in force shown as a tag in the box. A wired
  host alone on its port gets the port's link speed and traffic as its
  own; hosts sharing a port (a switch or another access point behind it)
  show the port as shared, with no speed or traffic of their own; their
  details give the port's total, labelled as the port's. A port that is
  a VLAN on a swconfig switch (`eth1.1`; the plugin maps it from
  `/etc/board.json` and the `switch_vlan` sections, or board.json's roles
  for a switch those give no VLAN) lists the VLAN's switch ports with
  their links ("LAN 2" where board.json numbers them, else swconfig's
  "Port 1"); with one of them linked, its hosts get
  that port's speed instead of the CPU port's. The network
  path adds a Wired branch, a node per port with the port's traffic, for
  hosts downstream of the device (not those on the uplink's port), with
  or without Wi-Fi.
- **Inspectors** (drawer or page, deep-linkable):
  client (MAC, host hint, IP, radio/SSID, signal history for the session,
  rates, inactive time), radio (channel, width, noise when real, clients),
  interface (proto, addresses, counters, rates).
- **Client names**: every client gets a human label, resolved in order:
  user alias (rename in the inspector, stored in `/etc/config/vantage`),
  reverse DNS (`network.rrdns`, optional grant), DHCP host name from host
  hints, mDNS (`umdns`, when running; unauthenticated, so only below DNS
  and DHCP and only when uncontested: an address claimed by two names, or
  a name that would land on two stations, is not used), WPS device name,
  vendor from a small built-in OUI table, or "Private Wi-Fi address" for
  randomised MACs. Never "?". The source is shown. DHCP, mDNS and WPS
  names are what devices say about themselves: a device on the network can
  give another a misleading name when that one has no better name, and the
  source tag is the only hint. An alias always wins.
- **Insight over decoration**: per-client experience score with a reason,
  Wi-Fi generation badges and legacy-client flags, top talkers by live
  throughput, new/recently-gone clients, busiest radio; each insight links
  to the LuCI page that fixes it.
- **Entity search**: clients, interfaces, radios, SSIDs injected into the
  command palette.
- **Health**: simple, explainable scores (e.g. signal < −75 dBm, uplink
  down, memory > 90 %, a radio enabled but not up) each with a one-line
  reason and a link to the page that fixes it. A radio switched off in
  the configuration is a choice: the Wi-Fi card says so, plain, and it
  never counts as needing attention. Each card carries its own icon (port,
  CPU, memory, Wi-Fi, signal, storage), plain while all is well and in
  the level's colour when it needs attention, and a small picture on its
  bottom edge: the last five minutes of uplink traffic and CPU, how full
  memory (in use, then cache) and storage are, each radio's airtime where
  the driver reports it, and the clients by signal class. A client far
  away on purpose can be set not to warn about its signal (#110), from
  its details, by a login that may name stations: it stays in the
  lists, and the Signal card leaves it out, of the warning and of the
  weakest. Kept on the router, beside the names.
- **Layout**: tiles are packed into columns (four, two or one by width);
  each tile has a column, a width and a place in the order, and stacks
  under the earlier tiles in its columns. "Customize" lets the viewer drag
  tiles, move them with buttons or arrow keys, change their width within
  a per-tile minimum and hide them. Saved per screen class (and
  separately for wired devices) and validated on read: under the Vantage
  theme with the chart style on the router (see the theme toggle), else
  in `localStorage`, which also keeps this browser's copy. A tile whose
  content shrinks keeps its height for 30 s,
  then the layout settles on its own; while arranging, each tile's
  content starts below its handle bar.
- **Lines to the internet**: every up interface with a default route in
  the main table is a line, the main one first and at most four beside it.
  Lines rank by lowest metric; on a tie the kernel's own answer
  (`luci.vantage routes`) decides, then the name. wan6 on wan's device and
  IPv6 on the port under PPPoE are part of their line, and so is 6rd, 6in4
  or 6to4 IPv6 when there's only one line. A softwire (DS-Lite, MAP-E, 464XLAT) carries the line's IPv4. A VPN
  that holds the route ordinary traffic takes is a full tunnel, drawn as a
  pipe on the line it leaves by, and is not a line of its own. PPPoE counts
  on the port under the session, since flow offloading takes downloads past
  the session's own counters; lines sharing a port keep their own.
- **Throughput chart**: one row per line, then each radio, each
  with its own scale. Under "Customize", the viewer picks how download and
  upload share a row: overlaid on one scale (the default), overlaid on a
  log scale (a grid line per ×10 from 1 kbit/s to at least 1 Mbit/s),
  mirrored on one scale, mirrored with a scale per direction, or in
  separate lanes. Linear scales never go below 10 kbit/s, so an idle link
  stays flat. Lines are smoothed without overshooting a sample; a stretch
  without samples (page hidden, failed polls) is hatched as "no data".
  The pick is saved with the layout and validated on read; the tile's
  size and place don't change with it.
- **Network path background**: behind the path, on its dot grid, one
  canvas in the style picked under the theme's Appearance (or under
  "Customize" when the dashboard runs without the Vantage theme), the
  login page's two:
  grid packets (the default; downloads run from the gateway's side,
  uploads back, more and faster with the uplink's live rate, from a
  couple at idle to 36 at 1 Gbit/s) or a starfield streaming out of this
  device's node (faster with the rate), or none (the dot grid alone). It
  draws over the path's height only, 20 frames a second up to
  100 kbit/s and up to 30 from 10 Mbit/s (each frame is asked for when
  it is drawn, not on every display refresh), and stops while another
  window has the focus, the tab is hidden, the tile is out of view or
  folded; with
  reduced motion it is one still frame. Under the Vantage theme it is
  saved with the theme's Appearance (on the router for every browser);
  otherwise in `localStorage` like the chart style.
- **Firewall overview** (Network → Firewall → Overview, first tab):
  read-only, from uci `firewall`, read the way firewall4 (fw4, as 25.12
  ships it) reads it: its boolean spellings (1/on/true/yes, 0/off/false/
  no), policies and targets by prefix, sections it skips (a value it
  refuses, a switched-off zone and the rules naming it, a port forward
  from `*`) listed as not in effect, zone policies falling back to the
  `defaults` section and then to DROP. A zone faces the internet when it
  masquerades (`masq` or `masq6`), holds the uplink (an interface with the
  IPv4 default route and a public address, from `network.interface dump`,
  by network, device or the interface's own zone; public means outside
  the IANA special-purpose blocks that are not globally reachable:
  routers with public addresses run without NAT; an access point's
  default route runs over a private address and does not count), or, by
  OpenWrt's naming, is called wan/wan6 or holds the wan/wan6 network. An
  uplink in no zone, the networks of a switched-off internet zone and the
  family an internet zone leaves out meet the `defaults` policies, and
  are shown as such. It lists what is open on the router (accepting
  rules, and port forwards without a target address or to the router's
  own) and what reaches the network (accepting rules into a zone, port
  forwards with their target and port); protocols, ports and sources as
  fw4 matches them ('all' ignores ports, numeric and `tcpudp` spellings,
  `0.0.0.0/0` and negated sources are no restriction), with the address
  family when the item has only one. Ping, multicast, DHCP renewals and
  IPsec passed on to the network are kept apart as standard housekeeping;
  IKE or ESP to the router itself is an opening. It maps each zone's
  input policy and forwardings (with a forwarding from `*` in every zone,
  and an accepting default forward policy as "any zone"), and warns when
  an internet-facing zone or uplink accepts input, the internet is
  forwarded into another zone (by a forwarding, also from `*`, by an
  accepting rule for every port and address, or by the default forward
  policy), or a rule or port forward opens the router's SSH, telnet or
  web ports to any address. Every item links to the LuCI tab that changes
  it. When no zone or uplink qualifies it says it found none (expected on
  an access point), with a neutral marker, and shows the zones only; a
  config it cannot read is an error, not that. It covers only what the
  config says, and says so: with nothing open the headline is "Nothing is
  open in your firewall rules"; ports UPnP opens at run time get a note
  when luci-app-upnp is installed (its menu entry exists), custom rule
  files when the config names any (said to be configured: fw4 ignores a
  script include without `fw4_compatible`, shown as not in effect), and
  otherwise a footnote names both. Some setups depend on how fw4
  dispatches traffic in ways the overview does not follow: covered
  subnets on an internet zone (or on a zone that names no device, which
  takes them on every one), another zone that does or, without the
  interface dump, may take traffic on an internet zone's device (the
  first in config order wins; device names compare as patterns, a zone
  that names no device takes every one it does not exclude, and a named
  device counts even when the dump does not list it), and rules or port
  forwards from the internet that use a set the config does not define
  and enable (its definition may come from a service the overview cannot
  see; a service that defines a set under the same name as the config
  goes unnoticed, since fw4 uses the first definition). For those
  it gives no verdict: a neutral "This setup is beyond what this
  overview checks", naming what it does not follow, with the zones, and
  the warnings it would give shown in amber as settings to check (they
  apply if traffic reaches them as configured), except for a rule whose
  set it cannot find.
- **Controls** (buttons, filter, chips, sort headers, icon buttons) take
  the theme's control height through `--v-ctl-h` (36 px, 44 px on
  touch) and the theme's control radius (`--v-r`); under another theme
  the app falls back to the same 36/44 px by pointer type. Text sizes come
  from the theme's type scale (`--v-fs-*`). The layout itself stays the
  app's own: container queries on its own width, one column below
  700 px. On a 721–803 px screen the dashboard is therefore still one
  column while theme forms already sit beside their labels; that is
  intended, since the dashboard only gets about 600–700 px there and its
  two-column tiles clip below that (measured).
- Polling via `poll.add` with sane intervals; pauses when the tab is hidden.
  The full poll runs every 5 s; uplink traffic and CPU have a lane of
  their own every 2 s (`/proc/stat` and the uplink device's counters,
  about 3 KB a reply), with their own previous samples. While that lane
  answers, the full poll leaves both to it; if it stops, the full poll
  samples them again. The page's own load is not a reading (#101): the
  2 s lane is registered first, so the poll loop does not run the full
  poll again right after the page fetched it, and two CPU samples under
  a second apart give none. The first reading's second sample is asked
  1.1 s after the first, not at the lane's next tick; until then the
  CPU tile shows this browser's last reading of the router (local
  storage, every tab, saved at most every 10 s) when under ten minutes
  old, else 0 %, once the first sample is in; a dash only while the
  router has given none. `iwinfo info` is asked once a radio (its
  first interface: channel, power, noise); another network's BSSID and
  SSID come from hostapd's `get_status`, which the poll asks anyway.
  `iwinfo info` (15-22 ms an interface on the NWA50BE) is asked again
  after 30 s, or at the next poll when the interface's state moves (its
  radio up, down, pending or reconfigured; its channel, frequency, BSSID
  or SSID in hostapd's status); the noise floor comes every poll from
  `iwinfo survey` (1.5-2 ms a radio), its entry for the radio's channel,
  read as a signed byte (ath12k sends 146 for -110 dBm, 0 for none),
  falling back to `iwinfo info`'s. The
  host hints (DHCP leases, ARP) every 30 s, and on each of the three
  polls after a station or wired host first appears.
- **Low-power router** (#101), under the theme's Appearance with the
  dashboard, off by default: the live numbers as always (the 2 s lane and
  the 5 s poll); Wi-Fi state, the radios' `iwinfo`, client capabilities,
  temperatures and wired hosts once every 30 s, their last answers in
  between. Nothing moves, and nothing stands still mid-move: no backdrop
  (the dot grid stays; the pick is kept for when it is off), no flow dots
  (busy wires as the still dotted line of reduced motion), no particles on
  the login page, no pulse on the theme's refresh dot. After 5 minutes
  without input (a page left open on a screen nobody touches) the full
  poll runs every 30 s and the 2 s lane waits; the next input (pointer,
  key, wheel, touch, the window's focus) is live at once. Saved like the
  other picks; the login page reads it as it reads its background.
- Motion stops while another window has the focus (the status circle's
  ring, the Live beat, the flow dots, the backdrop and the theme's refresh
  dot): a moving part keeps the browser drawing every frame. The numbers
  still update.
  A poll updates only what changed and lays nothing out unless a tile
  changes size. Idle animations (the status circle's ring, the Live beat,
  the flow on busy wires)
  use transform and opacity only, so the compositor runs them; with
  reduced motion they stop and busy wires show a static dotted line. The
  ring, the Live beat and the backdrop move on one clock of the
  dashboard's, 20 frames a second (the backdrop's own rate, up to 30,
  while it draws), and the theme's refresh dot on its own 15 a second
  (the dashboard's frames while it runs): left to the compositor, a
  five-second pulse would have the browser draw sixty frames a second.
- ACL: three groups for the app, and the theme's own, below. `luci-app-vantage` (read): `system info/board`,
  `network.interface dump`, `network.device status`, `iwinfo
  info/assoclist/survey`, `hostapd.* get_status/get_clients`, `luci-rpc
  getHostHints`, `luci.vantage wireless/thermal/wired/routes`, `umdns hosts`, `file read` of
  `/proc/stat`, `uci get` for `vantage`, and LuCI's own `luci
  getSwconfigPortState` (the link state of a swconfig switch's ports: LuCI
  runs `swconfig dev <switch> show`, the switch name quoted; the view asks
  at most every 30 s, and only for a switch with hosts behind it); no
  `file.exec`.
  `luci-app-vantage-rdns` (read, optional): `network.rrdns lookup`, kept
  apart because its caller chooses the DNS server and port; the view
  checks the grant and skips reverse DNS without it.
  `luci-app-vantage-names` (write): `luci.vantage set_alias` and
  `set_quiet` only; no group of the app grants uci writes. `luci-theme-vantage` (write): uci
  `set`, `commit` and `revert` on `/etc/config/vantage_theme`. The firewall overview's menu entry depends on
  LuCI's `luci-app-firewall` group, whose holder already reads and
  changes `firewall`; it reads that config with `uci get` (and the
  interfaces with `network.interface dump`, which LuCI's
  luci-base-network-status group grants) and the app's groups grant
  nothing for it.
- rpcd ucode plugin `luci.vantage` (`/usr/share/rpcd/ucode/luci.vantage`):
  `wireless` returns `network.wireless status` reduced to the fields the
  view reads (no `key`, `sae_password`, RADIUS or 802.11r secrets, no EAP
  credentials; `encryption` only as the mode string); per-interface BSSID
  and SSID come from `iwinfo info`. Where there is no `network.wireless`
  object (vendor drivers that bypass netifd, such as MediaTek's mtkwifi),
  it reads the same fields from config `wireless` instead: enabled
  interfaces that name their `ifname`, no run state and no `txpower`;
  the view then takes the radio as up when iwinfo answers for one of its
  interfaces, and trusts a configured EHT mode over iwinfo's.
  `wired` returns the hosts the Linux bridges have learned on their ports
  (MAC, port, bridge, VLAN, seconds since last heard), from one
  read-only netlink dump of the forwarding database (`ucode-mod-rtnl`,
  RTM_GETNEIGH for AF_BRIDGE): not the bridges' own addresses, the switch
  drivers' copies or group addresses, at most 128 per port and 512 in
  all, so the uplink's port cannot take every slot. It first counts the
  bridges' entries through `/sys/class/net/<bridge>/brforward`, reading
  no more than 4,096 records in all, and dumps nothing (`crowded: true`)
  when they hold that many between them: a flood of made-up addresses
  must not make rpcd build the whole table. The dump also has a switch
  driver read its chip's own table, which the plugin leaves out (29 ms a
  dump on a MediaTek MT7981 router, #101), so it is taken again only
  when brforward, read every call (MAC, port, time since heard), shows
  a host arrive, leave or change port, or after 30 s; in between the
  last dump's hosts with brforward's times. It dumps every call, as
  before, when the bridges hold more than 512 entries between them (they
  are then only counted, so a host making up addresses cannot make every
  call parse thousands) or one MAC sits on two ports of a bridge (each
  row's time since heard is the dump's own). brforward's byte order is
  the host's, learned from the first dump. The bridge forgets a host
  after about five minutes without traffic.
  `routes` returns the default route the kernel takes to the internet,
  for IPv4 and IPv6 (family, device and metric; no gateways): one
  read-only lookup a family (RTM_GETROUTE with RTM_F_FIB_MATCH, as `ip
  route get fibmatch`) of a documentation address no network uses, kept
  when the answer is a unicast default route in the main table; the work
  does not grow with the routing table. `routes` is null when a lookup
  could not be sent. netifd's interface dump lists the routes it asked
  for; of two with the same metric the kernel keeps the one added last,
  and a VPN daemon may add its own: the network path needs the kernel's
  answer to tell whether a full-tunnel VPN or its line carries ordinary
  traffic. Where `network.wireless status` answers with
  no radios at all, `wireless` reads the configuration too.
  `set_alias({mac, name, icon})`
  re-applies the view's rules on the device (unicast MAC, name of at most
  48 code points without control, bidi or invisible characters, icon from
  the fixed list), keeps one section per MAC, refuses a new name past 512,
  and writes and commits config `vantage` only. `set_quiet({mac, quiet})`
  (#110) keeps one `quiet` section per unicast MAC while `quiet` is true
  and none when false, refuses a new one past 512, and likewise writes
  and commits config `vantage` only. The plugin's regular expressions
  are module constants: ucode compiles a literal each time it is
  reached, and a counted repeat costs milliseconds on a router.

## 5. Later

- **v2**: one-click actions (restart radio, kick/ban client, toggle SSID)
  each behind a separate narrow write ACL and a confirmation;
  optional rpcd plugin keeping a small ring buffer for history, alerts.
- **v3**: topology view, luci-app-statistics integration.
- **Wired hosts on DSA switches** (#101): the bridge's forwarding dump
  may make a switch such as the MT7531 walk its hardware table on every
  poll; measure on such a router before changing `wired`.
- **Live per-device traffic for wired and mesh clients** (#110): a router
  has no per-host counters for hosts behind a shared port; getting them
  means counting rules in the firewall. If ever, as a separate opt-in
  package, never in the read-only dashboard; how to package it is open.

## 6. Security requirements

- Templates escape everything request-derived; never echo `fuser`; the
  theme's own markup for unauthenticated renders (login, 404, CSRF) adds
  nothing about the device but the login page's hostname, and of the
  Appearance only the colour mode, the login background and whether
  Low-power router is on. Not in the theme's control: LuCI's core
  `header.ut` prints `L = new LuCI({...})` after the theme header on every
  page, with the LuCI build and package-database time in the `luci.js`
  URL and `nodespec: dispatched`, which on an anonymous 404 is the whole
  menu tree (modules, view paths, ACL group names, `depends`). Only a
  luci-base change can fix that (see `docs/luci-contract.md` section 2);
  `test_templates.js` renders the core 404 around the theme and tracks it
  as a known upstream failure.
- No `innerHTML`/`insertAdjacentHTML`/string-built DOM with data; `E()`
  and text nodes only; style, selectors, dynamic regular expressions and
  history URLs from data are rejected too (checked by
  `security-tests/check_dom_sinks.js`, on the theme and the app, with no
  `dom-safe` suppressions). Web Animations keyframes count as CSS from
  data.
- ACL test: the app's ACL grants only the listed read methods and every
  `rpc.declare` in the app is covered, nothing unused is granted
  (`security-tests/test_acl_policy.js`, also run by `node --test tests/`).
  The one object glob is `hostapd.*` (hostapd's ubus objects are named per
  interface), limited to `get_clients`/`get_status`. No group of the app
  grants a uci write or reads Wi-Fi keys (LuCI's own groups can, such as
  `luci-base-network-status`); the only writes are the plugin's
  `set_alias` and `set_quiet`, whose validation `tests/plugin.test.js`
  checks against the view's and the replay's.
- No private addresses or MACs in committed files
  (`security-tests/check_private_addresses.js`, which also looks for the
  hostnames/SSIDs recorded in the mirror when it is present); fixtures are
  pseudonymised from the mirror (MAC → 00:00:5E:00:53:xx, IPv4 →
  192.0.2.x/198.51.100.x, IPv6 → 2001:db8::/32, hostnames → client-NN).
  Invented locally administered MACs use the 02:00:5E:xx:xx:xx prefix
  (IANA OUI with the U/L bit set; e.g. the replay's synthetic BSSIDs);
  no other MACs pass.
- Built-package verification (`security-tests/verify_built_apk.js`, run by
  `dev/build/sdk-build.sh` before anything reaches `dist/`) and a
  reproducible release manifest (`dist/<release>/BUILDINFO`: commit, SDK
  image digest, SDK tarball hash, entrypoint hash, feed commits).

## 7. Development workflow

- Recordings of the device (browser session + SSH snapshots) are made
  with a private read-only tool that is not part of the repository.
  Private data stays in `~/Work/vantage-mirror` (mode 0700), never in the
  repo.
- `dev/replay/`: offline LuCI served from the mirror (format in its
  README); `--theme-dir` loads the theme from the working tree, reload to
  see edits.
- Tests: node unit tests for data logic, headless screenshot suite over a
  fixed page list (light/dark/mobile) for visual review.
- Build: OpenWrt SDK 25.12 in podman, same reproducible pipeline as before.
- Deploy to the AP only when explicitly asked; the AP stays on its current
  theme until Vantage is approved.

## 8. Decisions needed

1. ~~Visual direction~~ — decided: Graphite.
2. Mobile nav: bottom bar vs drawer (prototypes may show both).
3. Anything to add or cut from theme v1 / app v1 above.
