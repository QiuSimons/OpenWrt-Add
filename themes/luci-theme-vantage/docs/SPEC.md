# Vantage — v1 specification

Status: **implemented** (v1, released as 1.x). This is the contract
the packages are built and reviewed against; section 5 lists what is
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
| `luci-app-vantage` | dashboard + inspector views under `admin/dashboard` (landing page), its rpcd ACL (reads + its own config only), its rpcd ucode plugin `luci.vantage` (key-free wireless status, temperatures, the bridges' wired hosts, the radios' channel survey, validated alias writes), its executable rpcd plugin `luci.vantage.ports` (a DSA switch's own port counters, read with `ethtool -S`), `/etc/config/vantage` | `+luci-base +rpcd +rpcd-mod-iwinfo +rpcd-mod-ucode +ucode-mod-uci +ucode-mod-ubus +ucode-mod-fs +ucode-mod-rtnl +ucode-mod-nl80211` (rpcd-mod-iwinfo, ucode-mod-fs, ucode-mod-rtnl and ucode-mod-nl80211 beyond luci-base; Wi-Fi images already have rtnl and nl80211, as wifi-scripts needs them); reverse DNS (`rpcd-mod-rrdns`), mDNS (`umdns`), `ethtool` (a DSA switch's own counters) and hostapd's ubus objects are optional and degrade |
| `luci-app-vantage-aps` (optional) | the access points a router's dashboard shows, over SSH (section "Other access points"): the Network → Access points page, its rpcd ACL and ucode plugin `luci.vantage.pair` (pairing), the collector service (router) and the report command (access point) | `+luci-app-vantage +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-uloop`; Dropbear at run time (server on the access points, `dbclient` on the router), not as a dependency |
| `luci-app-vantage-traffic` (optional, experimental) | per-device traffic for hosts that share a port of the router, from its connection tracking (section "Per-device traffic"): its rpcd ACL and an executable rpcd plugin, `luci.vantage.traffic`, which rpcd runs as a process of its own | `+luci-app-vantage +rpcd +ucode +ucode-mod-fs +ucode-mod-rtnl +ucode-mod-uci`; `kmod-nf-conntrack` with accounting at run time (a router's default), not as a dependency |

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
  (Ctrl+K or `/`): fuzzy search over every menu page, recent pages first.
  It also lists what a provider has. When it opens and each time the
  query changes it sends `vantage:palette` on `window`, detail
  `{ query, add }`, and a listener (the dashboard, while its page is
  open) hands `add()`, there and then, a list of entries
  `{ kind, title, detail, words, run }`: `kind` is `client`, `radio`,
  `ssid` or `interface` and picks the header; `title` is matched as a
  page's title is, `detail` (the row's second text) and `words` (never
  shown) as a page's path is; `run` is a function, called on Enter or a
  click. The palette looks at the first 64 entries, takes the first
  eight of a kind and drops any that is not of this form (a known kind,
  a function, strings of at most 128 characters, 512 for `words`); their
  text reaches the page as text nodes only, and nothing of them goes
  into a URL. Without a query they follow the pages and actions; with
  one, each kind is ranked on its own under its header and the part that
  holds the best match comes first (the pages on a tie, which then need
  no header). On a phone such a row has its second text under its name.
  With no listener (any other page, the theme without the dashboard) it
  lists pages only.
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
- **Page title**: "Page · hostname". While the dashboard reports that
  something needs attention it starts with how many checks do, "(2)
  Dashboard · hostname", so a tab left in the background shows it; the
  mark is in front because a narrow tab cuts the title's end. The
  dashboard sets `data-vt-alert` (`warn` or `err`, as for the refresh
  dot) and `data-vt-alert-count` on `<html>` at every paint; the theme
  watches those two attributes, takes the count only as a number from 1
  to 999 ("(!)" for a level without one, as an older dashboard sets it)
  and writes the title as text, in the one place that sets it
  (`updateTitle`), only when it changes. The mark goes when the
  dashboard reports no problem or another page loads; without the
  dashboard nothing sets it. The dashboard does not poll in a hidden
  tab (section 4), so such a tab keeps the title it was left with until
  it is shown again.
- **Theme toggle**: auto / light / dark, applied in `<head>` before CSS
  (no flash), exposed as `html[data-darkmode]`. The top bar's switch
  shows the pick (auto, sun, moon) and cycles auto → the look the system
  doesn't have → the one it has → auto, so the first click always
  changes the page; it saves as Appearance does. Appearance sits under
  the gear next to it. Appearance (this mode, what
  shows next to the logo after login, the login and network path
  backgrounds, Motion when not in focus and, with the dashboard, Speed
  units and Low-power router) is saved on the router for every
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
  counts until the router has one. The dashboard's chart style, network
  path form and layouts go the same way, in options `chart`, `path` and
  `layout_<class>[_wired]`: Done
  under Customize saves what it changed and the router doesn't have yet
  (`vantage.view.unsaved`, kept across a failed save or a reload; until
  then this browser's copy stands), by handing it to the theme (`vantage:view-save`), which writes it once. If
  that fails Customize stays open with a note: Done tries again, and Esc
  or the Customize button leaves without saving.
  The template passes them on as `data-vt-look-chart`,
  `data-vt-look-path` and `data-vt-look-layout`, logged in only and in
  their form only (`path`: `full` or `compact`), and
  `vantage.layout` validates them again. The router's come first for a
  login that may save; any other keeps this browser's, and sees the
  router's where it has none. Without the theme they stay in the browser.
- **Updates**: Appearance ends with the installed version and **Check
  for updates** (#102). On that click the browser reads the project's
  24.10 package list on GitHub Pages (the same release as 25.12's),
  without cookies or a referrer. `menu-vantage.js` has one request and
  one place that knows the URL (`askLatest`, `UPDATE_INDEX`). Only a
  version number passes: two to four dotted numbers, compared part by
  part as numbers (1.0.9 < 1.0.10 < 1.1), the package release (`-r1`)
  left out; anything else is no answer. The link shown is a constant, to
  the latest release. The theme never calls out on its own unless
  **Daily update check** (#133) is on. That is an Appearance option, off
  by default and this browser's alone: kept in `localStorage`
  (`vantage.update.auto`), never saved in `/etc/config/vantage_theme`,
  not handed over by the templates, and the login page neither reads it
  nor acts on it. Where it is picked it says what it costs: once a day
  the browser asks the list, which shows the list's host (GitHub Pages)
  the computer's IP address and the address the page was opened at (a
  browser sends it as the request's Origin, referrer or not). With it on, a page of the theme makes that
  same check once the page is idle, when the last try is 24 hours old or
  older, and only from a logged-in page in a tab that is in view; a page
  left open, or loaded out of view, makes it when its tab comes into
  view. The
  time of the try and the version the list had are kept in that browser
  (`vantage.update.last`); the try is written before the answer comes,
  so the pages and tabs of one browser ask once a day, and a check that
  fails counts as that day's, says nothing and leaves what was known. A
  list its host says is larger than 256 KiB is not read, and no more
  than that of one is looked at; where the browser's storage cannot keep
  the try, the daily check asks nothing (every page would ask again). A
  manual check made with the option on counts and is kept the same way.
  While the list's version is newer than the running one, the gear
  carries a small dot, said in its label, and Appearance shows the
  manual check's line ("Version 1.1.0 is available." with the constant
  link). Both go once the running version is that one or a later one,
  or the option is switched off, which also forgets the last try. There
  is no update button: updating stays with the package manager.
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
  Opened over HTTP it moves to HTTPS where the browser already accepts
  the router's certificate (a probe image on each `listen_https` port,
  as LuCI's base login page has it; Bootstrap's has none), unless an
  administrator set `luci.main.vantage_https` to `stay` (#137). That
  option is not in the theme's config, which a login holding only the
  theme's group can write: turning the move off is not an Appearance
  pick. The theme's removal deletes it.
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
  the search box, the one in force shown as a tag in the box. Both lists
  are in name order until a column's header is clicked; that pick is
  kept per browser (`localStorage`), each list its own (#132: in order
  of live traffic the rows changed places at every poll). The cards of
  the narrow layout have no header and keep that order. One more quick
  filter, Offline, lists the devices the administrator has named (the
  aliases) that are in neither list now, and shows only while there is
  one: by name, at most as many as there may be names (512), each with
  the name, icon and MAC of its alias, the address the host hints still
  give it (a lease that has not run out; else the one it had when this
  page last listed it) and when this page last listed it (a wired host:
  when its bridge last heard it), both only where known. What the page
  saw is kept while it is open and stored nowhere. They count nowhere
  else: not as Wi-Fi or wired clients, not in the header, the health
  checks or Top talkers. A row opens details with what is known (the
  vendor of the MAC where the built-in table has it) and the rename
  control of a connected client, which also removes the name. "In
  neither list" is all this device can tell: a wired device drops out
  of its list once the bridge forgets it (about five minutes without
  traffic), which the details say; and while a bridge holds too many
  entries to list, nobody is said to be offline. A wired
  host alone on its port gets the port's link speed and traffic as its
  own; hosts sharing a port (a switch or another access point behind it)
  show the port as shared, with no speed or traffic of their own (but for
  one a paired access point has alone on a port of its own: see Other
  access points); their
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
- **Inspectors** (drawers, deep-linkable):
  client (MAC, host hint, IP, radio/SSID, signal history for the session,
  rates, inactive time), radio (channel, width, noise when real, clients),
  a line to the internet (link, proto, addresses, counters, rates) and
  the device (model, firmware, uptime, load). The device's other
  interfaces (its own networks, a VPN) have no inspector.
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
  source tag is the only hint. An alias always wins. A named device
  that is not connected is not lost from view: the Clients tile lists it
  under Offline, where its name can be changed or removed too.
- **Insight over decoration**: per-client experience score with a reason,
  Wi-Fi generation badges and legacy-client flags, top talkers by live
  throughput, new/recently-gone clients, busiest radio; each insight links
  to the LuCI page that fixes it. Top talkers ranks this device's Wi-Fi
  stations and, by the same measure, the wired hosts with traffic of
  their own (#129): one alone on its port, with the rate the Clients list
  shows for it. A host on a shared port has none and stays out (the row
  would name a port, not a device), and so do the gateway and whoever
  else is on a line's port, whose traffic is the line's. A paired access
  point's clients are not ranked, its stations and its wired hosts
  alike: they push none of this device's own out. Nor is the access
  point itself, which is alone on its port once its stations are
  listed as its own: that port's traffic is theirs.
  Every row reads the same way round: a port counts like a radio, so
  what this device sent is the device's download. A wired host's row
  opens its details. The tile exists without Wi-Fi too, which gives a
  wired-only device five tiles (network path, throughput, system,
  clients, top talkers); where every host there shares its port, the
  tile says that none can be measured.
- **Entity search**: under the Vantage theme the command palette (Ctrl+K
  or `/`) also finds, while the dashboard is open: the clients (Wi-Fi
  stations and wired hosts, a paired access point's with its name, and
  the named devices that are offline) by name, MAC or address; the radios by band, channel or name; the Wi-Fi
  networks by name (this device's and the paired access points', one
  entry a name; not while the layout hides the Clients tile); the
  interfaces (the lines to the internet and the other networks). Enter
  does what a click on the dashboard does: the client's or the radio's
  details, the Clients list filtered to the network (open details
  close), LuCI's Interfaces page (where this login has it). The
  dashboard answers the palette's `vantage:palette` event (see the
  theme's Shell) with at most eight entries a kind, those whose name
  holds the query first, then in name order, so a network of hundreds of
  clients costs the palette no more than a small one. Nothing is asked
  of the device for it. Under another theme no one asks, and the
  dashboard is as before.
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
  under the earlier tiles in its columns. A tile that ends above the
  next tile grows down to meet it when that tile spans all of its
  columns, so a short column leaves no hole above a wide tile (#173);
  its content stays at its top, and a tile with another already under
  part of it does not grow. Growing there moves no other tile and
  leaves the page as long as it was. A tile only partly under the next
  one, and a column's last tile at the page's end, grow only to close a
  gap of up to 48 px (the chart and the radio cards, any gap): a short
  column at the end just ends. "Customize" lets the viewer drag
  tiles, move them with buttons or arrow keys, change their width within
  a per-tile minimum and hide them. Saved per screen class (and
  separately for wired devices) and validated on read: under the Vantage
  theme with the chart style on the router (see the theme toggle), else
  in `localStorage`, which also keeps this browser's copy. A layout on
  the router names at most twelve tiles (nine exist: seven, and the
  WireGuard and Ports tiles where the device has a tunnel or ports); the
  theme and its template refuse a longer one. A stored
  layout that leaves a tile out (a wired device's saved before it had
  Top talkers) gets it after the tile it follows by default, shown. A
  tile whose content shrinks keeps its height for 30 s,
  then the layout settles on its own; while arranging, each tile's
  content starts below its handle bar.
- **What's new**: once after an upgrade, one line above the dashboard's
  head, "Vantage 1.1.0: what's new", in the look of the details' notes,
  with a close button. The browser keeps the dashboard's version as it
  last saw it (`localStorage`, `vantage.seen.v1`; a version number is
  nothing private). A first visit keeps it and shows nothing; a later
  one that finds another version kept shows the line at every load until
  it is closed or its link is followed (a click or a middle click),
  either of which keeps this version. A version is two to four dotted
  numbers, the running one and the kept one alike: anything else kept
  counts as nothing kept, and a browser without storage never shows the
  line. Nothing is requested for it. The link is a constant and opens in
  a new tab without a referrer: the changelog as tagged for this version
  (`blob/v<version>/CHANGELOG.md`, where its section is the first; the
  heading's own anchor has the release date in it). It is written out
  in `overview.js` (`NEWS_URL`), since no URL is put together from parts
  (`check_dom_sinks.js`), and bumped with `VERSION` at a release;
  `tests/view.test.js` holds the two together. The line is outside the
  grid, which is all the layout measures, so showing or closing it moves
  the page as a whole and no tile.
- **Lines to the internet**: every up interface with a default route in
  the main table is a line, the main one first and at most four beside it.
  Lines rank by lowest metric; on a tie the kernel's own answer
  (`luci.vantage routes`) decides, then the name. wan6 on wan's device and
  IPv6 on the port under PPPoE are part of their line, and so is 6rd, 6in4
  or 6to4 IPv6 when there's only one line. A softwire (DS-Lite, MAP-E, 464XLAT) carries the line's IPv4. A VPN
  that holds the route ordinary traffic takes is a full tunnel, drawn as a
  pipe on the line it leaves by, and is not a line of its own. PPPoE counts
  on the port under the session, since flow offloading takes downloads past
  the session's own counters; lines sharing a port keep their own. A
  line counted on a device that also carries VLANs of this device's own
  networks (an untagged WAN on `eth0` beside `eth0.3`: a switch's CPU
  port, or one port for everything) has those VLANs' rates taken off its
  own (#166): the kernel counts their traffic on the device too, so each
  direction read download plus upload. Only a VLAN with an interface up
  on it that has a protocol, itself or through its bridge, and never
  for a line on a bridge (an access point's uplink, counted on the
  bridge's port): what that port carries for the access point's other
  networks is bridged on and counted once. The result reads a little high (the kernel counts a few bytes
  less a packet on the VLAN's device), and the counters since boot in
  the line's details stay the device's. Known limit: with software flow
  offloading the kernel does not count on a VLAN's device what an
  offloaded connection brings in on it, only what it sends out there
  (measured on 24.10's kernel, a bridge over the VLAN's device): the
  line's upload is right, and its download still includes the upload.
  Hardware offloading was not measured.
- **WireGuard tile** (#129): where the device has a WireGuard tunnel, a
  tile lists each tunnel (interface, UDP listen port, number of peers)
  with its peers: the peer's description from the configuration, else
  its public key shortened as LuCI shortens it (a key is never on the
  page whole), its endpoint, the time since its last handshake, and its
  traffic between two answers, ↓ what this device received from the peer
  and ↑ what it sent to it, as the tunnel's own counters run and the
  network path shows a tunnel. A handshake at most 180 s old is a
  session now, marked with a dot: WireGuard makes a new one two minutes
  after the last while traffic flows (Rekey-After-Time, 120 s) and uses
  no session key older than three (Reject-After-Time, 180 s). A peer
  past that, or without a handshake, is shown quieter and never as a
  warning: a peer that is away is no fault. Peers with a session come
  first, in name order (not by the second of their handshake: each
  makes a new one every two minutes, and the rows would change places
  as they do, see #132), then the others, the latest handshake first,
  then those without one; a tunnel lists five and folds the rest behind
  "+n more". The age is counted by the browser's clock, as LuCI's own
  page counts it. The data is LuCI's own `luci.wireguard getWgInstances`
  (`luci-proto-wireguard`: `wg show all dump` by interface, without
  private or preshared keys), checked again by the view: types and
  ranges, at most 8 tunnels with 128 peers and 8 allowed IPs each, text
  made safe. The dashboard's ACL grants nothing for it. The view asks
  rpcd once a page whether the login holds LuCI's group
  `luci-proto-wireguard`, and only then calls, with the slow part of the
  poll (every poll; every 30 s on a Low-power router). Any other login
  (one limited to the dashboard's read group), and a device without the
  package, makes no call and has no tile. Where the first answer says
  the call is not there (no such object, access denied) it is not asked
  again on that page; an object that goes away later is asked for once
  a minute. LuCI's plugin runs `wg`, and looks up the host name of each
  peer configured by name, on every call and inside rpcd: after an
  answer that took over a second the next call waits ten times as long,
  four minutes at most (none after a call that was out over 30 s: the
  computer slept), with the last answer shown until then. A call that fails otherwise
  (a timeout, rpcd busy) is not "no tunnel": the last answer stands
  while it is under a minute old. The tile
  exists once a tunnel was seen and then stays for the session (an
  interface restarted is gone for a poll), saying so when none is
  reported. Its layout is the others': the same stored layouts as
  before, and one that does not mention the tile gets it where the
  default has it (two columns wide under Clients on a wide screen); a
  layout arranged while no tunnel is reported keeps the tile's stored
  entry, hidden or not, where it was. A handshake dated ahead of the
  browser's clock counts as now.
- **Ports tile**: on a device with two Ethernet ports or more, a tile
  with a cell for each: its name, its link (a dot in the status colours,
  grey without a link and never a warning, and the negotiated speed,
  with "half duplex" where it is), its traffic, the number of wired
  hosts learned on it, and a mark on the port a line to the internet
  leaves through ("Uplink", or the line's name where there are several).
  ↓ is what goes to the devices on the port and ↑ what comes from them,
  as the path's port nodes and the wired list count; on a line's port ↓
  is what comes from the internet, as the line shows it. Error, drop and
  collision counters since boot show only where they are not zero, a
  line each in the cell and the same words in its tooltip, which also
  gives the duplex and what the port itself received and sent. A port
  with hosts opens the Clients tile's wired list on them, as its node on
  the path does. An access point with one port has no tile: that port
  is on the path already, as the uplink's.
  The ports are read from `network.device status`, which the poll has
  anyway; the one call added is for a DSA switch's own counters (below).
  A port is a device netifd reports with `devtype` `dsa` (a
  switch's port under DSA), or with `devtype` `ethernet` (netifd's word
  for an Ethernet device the kernel gives no other type, so never a
  bridge, a VLAN, a bond, a tunnel or a WireGuard device) whose driver
  names at least one link mode in `link-supported`: a veth pair, a tap
  and a virtual machine's paravirtual adapter name none, and nothing
  else in that reply tells them from a port, so they are left out. Not
  a wireless device, not a conduit (the CPU's side of a DSA switch,
  which its ports name in `conduit`), not the CPU's side of a swconfig
  switch, and not a device netifd reports a `parent` for: a macvlan has
  no type of its own in the kernel and answers with its parent's link
  modes, and a line on one is marked on the port it is on. The mark is
  for a line with a default route: the network the uplink falls back to
  while every line is down marks no port. A swconfig switch's ports come from the map `luci.vantage
  wired` already returns for the wired hosts (`switches`), each once
  whatever VLANs it is in, with the link LuCI's `getSwconfigPortState`
  reports; that call is made as before, only for a switch with hosts
  behind it, so until then such a port's link is shown as not known
  ("—"). A switch port has no counters here, so no traffic and no
  errors; the hosts and the line of a switch VLAN are one port's only
  where the VLAN has one port, or one with a link (a port tagged in
  several such VLANs is each one's: a line on any is marked on it, and
  its hosts are those of the first). Limits of what the
  dashboard can read: netifd lists the devices the configuration uses,
  so a port no interface or bridge names is missing; the roles
  `/etc/board.json` gives a device's own ports ("lan", "wan") are not
  read, which would take a grant, so such a port goes by its device's
  name (a swconfig port keeps the label the wired hosts show, "LAN 2");
  hosts on a VLAN device over a port (`eth1.10`) are listed under that
  device, not counted on the port; and a port's
  counters are the kernel's, so what a switch chip forwards on its own
  (between two of its ports, or with hardware flow offloading) is not in
  them, but where the chip's own counters are read (below). Two ports seen once keep the tile for the session, saying so
  when a poll lists none. Its layout is the others': the same stored
  layouts, and one that does not mention the tile gets it where the
  default has it, after every other tile: as wide as Clients on a wide
  screen with Wi-Fi, the full width otherwise.
- **A DSA switch's own counters** (#156): the kernel counts on a DSA
  port only what passes the CPU. Every poll the dashboard asks
  `luci.vantage.ports counters` (below) in a request of its own, waits
  2 s for it at most and makes no second call while one is out, and
  takes a port's traffic from its chip's counters where that poll has
  them: the Ports tile, the Wired branch and the wired hosts that have
  the port to themselves. Not for a line's own device, whose rate the
  line, the throughput chart and the fast lane take from the kernel's.
  A chip's counters are rated by when the device read them (each port's
  time on its monotonic clock), never by when the answer came in: it
  comes in a request of its own, up to 2 s after the poll's; a clock
  that went back (the device started again) starts the port over, and a
  reading without its time is none.
  A rate is only ever of two readings of one source: a port whose
  chip's counters stayed out of a poll has no rate for that step, nor
  for the step back. An answer that another call was reading (`busy`)
  is none for that poll, and the page asks again. The first answer
  that says there is nothing to
  get (no DSA port, no `ethtool`, or every port read with names the
  plugin does not know) or that there is no such object ends the asking
  for the page, so a device without such a switch starts no process for
  it every poll. Only the first: once it has answered, a later answer of
  any kind (rpcd's objects are gone for a moment while it reloads, at
  every package install) is that poll's alone. Nothing is shown about traffic the counters miss.
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
- **Network path, compact** (#157): under "Customize", beside the chart
  style, "Network path" picks Full (the default: the path's cards as
  they are) or "Compact, one line each", saved as the chart style
  is. Compact makes every node of the branches one line, in the same
  places on the same wires: a radio (its band and channel), the Wired
  node, a network of a device without Wi-Fi (its address), a paired
  access point (its pairing name, and why while it is not reporting),
  and under them each Wi-Fi network (its lock where the security is
  open or weak), each port and each access point's networks and Wired
  node. A line shows its name, how many it has (a port with one host:
  that host's link speed; an access point: its stations and wired hosts
  in one count) and its rate, ↓ what went towards its devices and ↑
  what came back, as the cards count them (an access point's network or
  Wired node: what its rows would have added up to, idle with none
  there). A red dot before the count marks a client of that network
  whose signal is weak, as the Signal check counts it (below −75 dBm,
  not one set quiet), its name and signal in the dot's tooltip; an off
  radio or an access point not reporting is dimmed and dashed, an idle
  network flat, as their cards are; the wires carry traffic as before. A
  line is the card's control, with its click and tooltip, named for a
  screen reader with all it shows and both rates; its tooltip starts
  with its full name, which the line may cut, unless what the card's
  tooltip says names it already (an access point that is not reporting:
  its name, then why). Left out: the client rows and "+n more", a dot
  per client, a radio's generation, a network's protocol, an access
  point's address and uptime (in its tooltip, with its stations and
  wired hosts counted apart). The lines are stacked at every width, a
  radio, the Wired node or an access point above what it leads to, and
  share their columns (subgrid), each as wide as its widest text; a line
  without a count (a radio, a network, an access point not reporting)
  gives its name the count's cell too. The tree is as wide as its
  longest name needs, a name 36em at most (about 60 characters), so the
  rates stay readable across from the names; on the wide layout the
  path gives it the room it gives access points' branches, and below
  it takes the phone's single column. With less than 500 px for the
  tree it shows ↓ only; with less than 400 px, in the client rows'
  short form (62.2k), set in 26 px instead of 34 and with less padding.
  Switching builds the path again, and its tile takes its new height at
  once, not after the 30 s a shrinking tile is held.
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
  window has the focus (unless Motion when not in focus is on), the tab
  is hidden, the tile is out of view or folded; with
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
  `luci.vantage survey` (1.5-2.5 ms a radio), its entry for the radio's
  channel (0 for none), falling back to `iwinfo info`'s. Not from
  `iwinfo survey`, which 1.0.19 used: rpcd calls a function libiwinfo
  has only for its nl80211 backend, so on any other (MediaTek's mtwifi
  in the mt798x builds) it kills rpcd (#124), and no group grants it. The
  host hints (DHCP leases, ARP) every 30 s, and on each of the three
  polls after a station or wired host first appears.
- **Speed units**, under the theme's Appearance with the dashboard, bits
  by default: the dashboard reads its traffic (the live rates, the charts'
  axes, the client rows and the cards) in bytes instead — the same numbers
  ÷8, in decimal B/s steps. Link and PHY rates stay bitrates: they are
  negotiated speeds, not traffic. Saved like the other picks. A pick
  paints the page again at once (details held still by selected text or
  an open rename follow when that ends, as after a poll), and a rate
  axis is round in the unit
  its labels show (`series.chartGeom`'s unit, 8 for bytes: 200 kB/s
  where 1.5 Mbit/s would read 188).
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
  still update. **Motion when not in focus** (#131), under the theme's
  Appearance and off by default, lets it all go on, for a dashboard kept
  in view beside other work; the login page's particles follow it too. A
  hidden tab, reduced motion and Low-power router stop motion as before.
  Saved like the other picks.
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
  info/assoclist`, `hostapd.* get_status/get_clients`, `luci-rpc
  getHostHints`, `luci.vantage wireless/thermal/wired/routes/survey`,
  `luci.vantage.ports counters` (it starts `ethtool`, below), `umdns hosts`, `file read` of
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
  nothing for it. Likewise the WireGuard tile's `luci.wireguard
  getWgInstances`: LuCI's `luci-proto-wireguard` group grants it, the
  app's groups do not, and the view declares that one method of the
  object, without parameters.
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
  no radios at all, `wireless` reads the configuration too. Either way
  an interface in AP mode also names the interfaces hostapd made for its
  VLANs, where a password or RADIUS gives a station its VLAN (`vlans`,
  #164): the AP_VLAN interfaces with its address on its wiphy, 32 in
  all, from one read-only NL80211 dump of the wireless interfaces
  (NL80211_CMD_GET_INTERFACE, no message); not a WDS station's
  interface, and none where two networks of a wiphy share an address.
  netifd lists only the ones it made itself, and iwinfo lists the
  stations on one under it alone: the view asks each for its station
  list every poll (1.2 ms each on a four-core access point, nothing
  else of it) and counts those stations as the network's clients, with
  the interface in their details. Their traffic is added to the
  network's and the radio's from the stations' own counters, since
  such an interface's counters are netifd's to give only where it made
  the interface. The stations of a mesh interface are the mesh's other
  nodes (#167): listed with the Wi-Fi clients under a "Mesh peer" tag,
  and counted as peers on the mesh's own node in the network path and
  in search. They are no clients: not in the device's or the radio's
  client count, not among the radio's clients on its card and in its
  details, not ranked in Top talkers (a peer's traffic is its node's),
  and not in the client counts of the Signal check, where a weak one
  still warns as any weak link does. An older one still counts among
  the radio's older devices: it slows the radio as a client would.
  `survey({device})` returns the channel survey of one Wi-Fi interface,
  for the noise floor: `{ mhz, noise }` for each channel the driver gives
  a noise value (dBm, a signed byte), at most 256, from one read-only
  NL80211 survey dump (`ucode-mod-nl80211`, NL80211_CMD_GET_SURVEY), and
  only for an interface that cfg80211 drives (`/sys/class/net/<if>/phy80211`);
  any other device gets no channels without the kernel being asked.
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
  It imports rtnl and nl80211 before uci, ubus and fs, the modules
  LuCI's own rpcd script loads too (#134): rpcd frees a script that
  fails to load, and ucode before late 2024 (OpenWrt 23.05 and vendor
  firmware built on it) keeps those modules' types in variables the last
  script to load them sets, so a plugin that loaded them and then failed
  on a module that cannot load (from another distribution's feed) would
  leave LuCI's script on freed memory, which can crash rpcd and with it
  every login (the likely cause of #134). Failing first leaves them
  untouched; `tests/plugin.test.js` keeps the order.
- Executable rpcd plugin `luci.vantage.ports`
  (`/usr/libexec/rpcd/luci.vantage.ports`, #156), the one file of the
  dashboard and the theme that starts a program. rpcd runs it as a
  process of its own for each call (and once with `list` when rpcd
  starts), kills it after its own timeout (30 s as OpenWrt sets it) and
  answers others meanwhile. Its one method, `counters`, takes nothing:
  the call's arguments are not read. One call reads at a time: it first
  locks its own file, opened for reading, without waiting, and where
  another holds the lock it answers `busy` at once and starts nothing
  (rpcd and uhttpd start as many calls as come, and each `ethtool -S`
  holds the kernel's rtnl lock while it reads the chip). The shell and
  `ethtool` it starts hold the lock too, so after rpcd kills a call
  whose `ethtool` hangs, no other starts until that one has ended. It
  lists the device's DSA ports,
  the entries of `/sys/class/net` whose `uevent` says `DEVTYPE=dsa`, by
  a name of letters, digits, `_` and `-` (not first, 15 at most), 32 at
  most in name order; where there is none, or no `/usr/sbin/ethtool`
  (not a dependency), it starts nothing and says so (`state` `none`,
  `no-ethtool`). Otherwise it runs `ethtool -S <port>` for each, none
  after its first second (`time`), reads 32 KiB of each run at most,
  gives each port the time its `ethtool` started (`at`, ms on the
  device's monotonic clock), and keeps a run only when it exits 0 and starts with `NIC
  statistics:`; ucode reads a program's output only through `popen`,
  which hands the line to `/bin/sh`, so the name rule keeps the line to
  three plain words. A port's counters are the first pair of a fixed
  table of switch drivers' names found once each (`RxBytes`/`TxBytes`
  of mt7530, `RxGoodByte`/`TxByte` of qca8k, `in_good_octets`/
  `out_octets` of mv88e6xxx, `RxOctets`/`TxOctets` of b53 and bcm_sf2,
  `RxGoodBytes`/`TxGoodBytes` of lantiq_gswip, `IfInOctets`/`IfOutOctets`
  of rtl8366rb), never the four of the CPU's path the DSA core puts
  first (`rx_bytes`, ...); none of them is `unknown`, a run that failed
  `failed`. `test_acl_policy.js` pins the program, its path, its option,
  the name rule and the caps.

### Provider tiles (experimental)

Since 1.2.0 (#129) another package (a provider) can put a read-only
tile on the dashboard: it answers one ubus call with data, and the
dashboard checks the answer and draws it as text in its own look.
**Experimental**: the object and group names, the method, the fields
and their limits, the `x` layout ids and the cap may change in any
release until the project says otherwise here and in the changelog.
The dashboard's own tiles (ids, sizes, order, defaults) are no part of
the contract. For provider authors: [`docs/TILES.md`](TILES.md).

- **Contract.** A provider is a ubus object `vantage.tile.<id>` (`<id>`
  1 to 7 letters a-z) with one method, `status`, which takes no
  arguments, changes nothing and answers `{ v: 1, title, icon?, state?,
  note?, every?, page?, items: [ { label, value | text, unit?, rate?,
  max?, level?, trend? } ] }`; its package ships an rpcd ACL group,
  `vantage-tile-<id>`, granting that call to read and nothing else. The
  view's `model.tile` reads an answer field by field and keeps nothing
  else: `v` must be 1 and `title` 1-32 characters, else the answer is
  unreadable ("Sent a report that could not be read"); `icon` one of
  eleven of the dashboard's own icon names (else the first); `state`
  and `level` `ok`/`warn`/`err`/`off`; `note` up to 64 characters,
  `text` up to 48, `label` 1-32 (one item a label, compared without
  case); `every` a whole 5-300 s; `page` `admin` and 1-4 steps of
  `[A-Za-z0-9_-]{1,32}`; `value` a finite number under 10^15 either way,
  written out by `unit` (`''`, `%`, `ms`, `s`, `dBm`, `dB`, `MHz`, `B`,
  `bit/s`, else the item is left out) in the dashboard's own formats;
  `rate` only on a counter of `''` or `B` that is not negative; `max`
  above 0 and not with `rate`; `trend` values only. At most 8 items of
  the first 32; unknown keys are ignored, an item not of the form is
  left out alone. Text goes through `fmt.safeText` (control and
  bidirectional characters and a list of zero-width ones replaced, not
  every character that shows nothing: U+200C, U+200D, U+FE0E, U+FE0F and
  U+E0100-E01EF stay; cut with an ellipsis), and a text with nothing to
  see is none: `TILE_VISIBLE`, one character outside `\p{Z}`, `\p{C}`,
  `\p{M}` and U+2800.
- **Discovery.** Once a page the view calls `session access` without an
  object and a function: rpcd then answers the session's own ACL,
  `{ scope: { object: [ method ] } }` (`session.c`,
  `rpc_session_dump_acls`), and grants the call to every session
  (`unauthenticated` group), as for the group probes. The view takes the
  `ubus` entries named exactly `vantage.tile.<id>` with `status` granted
  by name, the first three by id, and reads nothing else of the answer;
  a grant by pattern names no provider. Without a provider package, or
  for a login without its group, that is the only call: no provider is
  asked and the page is as before (the dump rides the first poll's
  batch: one call more, no request more). A read that fails is made
  again at the next slow poll, and a provider found then gets its tile;
  an answer, with providers or without, is not read again on that page.
- **The call.** One helper, `tileCall(id)`, makes the object from the
  fixed prefix and the id, checks it again against
  `^vantage\.tile\.[a-z]{1,7}$`, and declares only `status`, without
  parameters, so no argument can be sent; `nobatch` (a request of its
  own: a slow provider holds back no other reply) and `reject`. It is
  called in one place, for ids from the session's ACL. No group of the
  dashboard or the add-on grants a `vantage.tile.` object.
- **Cost.** A provider is asked with the slow part of the poll (every
  poll; every 30 s on a Low-power router), never sooner than its
  `every` after the last question (at the first slow poll after that),
  and not while its call is out; the poll waits for it 2 s at
  most (also at page load, so a slow provider delays the first paint by
  up to 2 s), and a late answer is the next poll's. After an answer
  that took over 500 ms the next call waits ten times as long, four
  minutes at most (none after a call that was out over 30 s: the
  computer slept). A first
  answer that says the call is not there (no object or method, access
  denied) means no tile and no further call on that page; an object
  that goes away later is asked once a minute, its last answer shown
  for that minute, then "Did not answer in time" (also after any other
  failure, which makes the next call wait 10 s, twice as long after each
  further one, four minutes at most). A tile hidden under Customize is
  not asked after its first answer.
- **Drawing.** The view draws the tile from its own parts: the icon
  and title, then the provider's id in a source tag (`vt-src`, the
  look of a client's name source), so that no provider passes for a
  tile of the dashboard's own: none of those has one, and the id comes
  from the object's name, never from the answer. Customize, its hidden
  tiles' list, its announcements and the tile's `aria-label` say
  "title (id)"; the controls are not rebuilt for a new title while
  Customize is open. Then the state's dot (never a health check, never
  the page title's mark), a link to `page` where this login's menu has
  that node satisfied, named with LuCI's own title of it (`L.url` from
  the checked steps), the note, and the items in a grid: a label over
  its value, a counter as its rate between two answers, a meter for
  `max`, the page's own five minutes of a `trend` value as a bare line
  from its lowest to its highest value (90 points at most an item). Title, note and labels are looked up in
  LuCI's catalogues (`_()`), so a provider's own catalogue translates
  them (fixed words: LuCI matches a text by a 32-bit hash of it, and a
  label keys its item's rate and line); a `text` value is shown as it
  came. An answer that cannot be
  read keeps the tile's last title, icon and link. The page keeps
  `model.tile`'s reading of the last answer, never the answer itself.
- **Layouts.** A provider tile is `x<id>` in a layout (`xdns`), which
  fits the theme's stored form (`[a-z]{1,8}`); no tile of the
  dashboard's own starts with `x`. At most three, so that nine of the
  dashboard's own and three stay within the twelve entries the theme
  keeps. Like the WireGuard tile they make no layouts of their own: a
  stored layout that does not mention one gets it where the default has
  it (one column wide at the end of the right-hand column), and a
  layout arranged while a provider is not answering keeps its stored
  entry, hidden or not, while there is room among the three. A page
  without providers lays out exactly as before (`tests/tiles.test.js`
  over every screen class, wired or not, with and without a tunnel and
  ports).
- **What the tests pin.** `security-tests/test_acl_policy.js`: the
  helper's exact text and its `TILE_OBJ` line, in the dashboard only and
  once; `TILE_OBJ` only tested, never changed (named only in its line
  and in `TILE_OBJ.test(obj)`); the helper's declares its own; `tileCall`
  called once, in `askTile`, with an id; the ACL dump declared once
  without parameters and called once, where it feeds `tileIds`;
  `tileIds`' exact text, defined once, its ids handed as they are to
  `askTile`, its one caller, whose head hands its id to the call
  unchanged; no other declare naming `vantage.tile`, no other `session`
  method; the call granted by no group of the dashboard or the add-on,
  and no `vantage-tile-` group there. Beside the declares, the browser
  files of the dashboard and the add-ons use `rpc` only as
  `rpc.declare({`, fetch only their own CSS and the theme's script, and
  make no XMLHttpRequest, beacon, socket or LuCI request; none of them,
  nor the theme's, assigns a prototype's member or defines a property;
  49 mutations, each caught.
  `tests/tiles.test.js`: the contract's bounds, the polling rules, the
  drawing as text against hostile answers, provenance, the layouts, and
  the example provider (`dev/replay/tiles/`) run under ucode.
  `check_dom_sinks.js` passes the view as it is, with no suppression.
- **Known limits.** A slow `status` blocks rpcd for every caller while
  it runs (rpcd runs a ucode method in its own process): the dashboard
  backs off, but cannot stop other callers. The dashboard cannot verify
  that `status` has no side effects; it is called with the session of
  whoever has the dashboard open, so installing a provider is trusting
  it, like any LuCI package (which could also replace the dashboard, or
  retranslate its strings through its catalogue). The browser parses a
  whole answer before the view sees it (up to ubus' message size). A
  fourth provider has no tile, without a word. A provider installed or
  granted while the dashboard is open shows after a reload.

### Other access points (`luci-app-vantage-aps`)

An optional package shows the network's other OpenWrt access points on a
router's dashboard: in the network path a branch each with a node per
SSID and band and one for its wired hosts, the hosts at each node, and
their clients in the Clients list with a filter per access point. Both
the router and each access point run Vantage with the add-on; the
dashboard package itself stays read-only.

- **Pairing, two pastes, no trust on first use.** On the router, Network
  → Access points shows its code, `vantage-router 1 ssh-ed25519 <key>
  <name>` (an Ed25519 key made on first use with `dropbearkey`, kept in
  `/etc/vantage/id_ed25519`). Pasted on the access point, the add-on adds
  that key to `/etc/dropbear/authorized_keys` as
  `command="/usr/libexec/vantage/report",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding
  ssh-ed25519 <key> vantage-router@<name>+<key id>` (the id: the first 8
  of the key's 32 bytes in hex; the line is made and known again in one
  place, `aps.uc`, and a blank or carriage return an editor left after
  it does not hide it; a tab does, since Dropbear then names no comment
  to the report) and answers with
  `vantage-ap 1 ssh-ed25519 <host key> <address> <port> <mac> <name>`:
  its Ed25519 host key, LAN address, SSH port and LAN MAC. Pasted back on the router,
  that answer is the access point's record in `/etc/vantage/aps.json`
  (address editable), and with it the name of the router's network that
  address is on (`net`: the netifd interface, `lan`), when it is on one;
  the page shows the name beside the address, as text. A reply with the
  device's own host key is refused (`self`): a device does not read
  itself. At most 16 access points per router and 8 routers
  per access point; codes, keys, names and addresses are checked by
  `/usr/share/ucode/vantage/aps.uc`, the same code on both ends (no
  string with a NUL byte passes: ucode matches a pattern only up to
  one). `authorized_keys` and the list are replaced whole, through a
  file written beside them and checked to be complete first, so a full
  flash cannot leave the administrator's own keys cut short. Neither is
  written when it is there and cannot be read whole (256 KiB of keys,
  64 KiB of list), nor grown past that: what it holds would be lost, or
  could no longer be listed and revoked. The list is not written either
  when it holds anything that is no entry of the add-on's (a hand edit
  gone wrong would lose the rest). An access point whose key file
  cannot be read says so (`keys-unreadable`) and pairs with no one; the
  status also marks either list as unread, whatever else is wrong, so
  the page never shows "none" for a list it could not read. The
  answer to a router is made before its line is written.
- **Transport.** The collector (`/usr/libexec/vantage/collector`, procd
  service `vantage-collector`, started only while an access point is
  paired) logs in to each one with `dbclient` as root with the router's
  key, in batch mode, without passwords and with
  `StrictHostKeyChecking=yes` against a `known_hosts` holding only the host
  key from pairing, so another device at that address is refused. It
  fetches only while someone looks: each `vantage.collector report` call
  (the dashboard's slow poll, the pairing page) keeps it fetching for
  60 s, at most every 10 s per access point, each fetch killed after 15 s
  and its output capped by the shell (`ulimit -f`, just above the 256 KiB
  a report may have: the files are in RAM). That is twice what the
  fullest report takes now (about 130,500 bytes), so that a field an
  access point adds later is not refused; a router of 1.1.0 or 1.1.1
  refuses a report over 131,072 bytes, so what an access point sends
  must stay under that while such routers are about. The call takes nothing from
  its caller: the method names one field, the session rpcd adds to a
  request that comes from a browser (ucode's ubus turns away a call that
  carries a field its method does not name), and never reads it.
  When an access point is not found at its address (or another device
  answers there), the collector looks its MAC up in the router's DHCP
  leases and neighbour table and tries the address it has now; the
  pinned host key decides, so a DHCP address change does not unpair it.
  It looks on the network the access point was paired on only (one
  interface, its device and IPv4 subnets): any device gets a row under any
  MAC and address into the neighbour table of a network it is on, and
  the router would open a connection to wherever such a row says. The
  lease comes first, then the neighbour table, four addresses at most,
  counted after those already tried are left out, so made-up leases
  and rows can delay the search and not end it; the leases are read
  only as a plain file of root's (a FIFO under that name would hold the
  daemon). Which network that is, the record says by name: at pairing
  the plugin asks netifd (`network.interface dump`) for the interface
  whose subnet holds the pairing address most narrowly, among those
  that are up, and keeps its name when it is one a uci section can have
  (letters, digits and `_`, 64 at most; a record whose `net` is
  anything else is no record, like one with a bad address). The
  collector looks on the interface of that name as it is by then, with
  the subnets it has by then. So after the router's own subnet was
  changed (`192.0.2.0/24` to `198.51.100.0/24`) the access point is
  found again, at its new lease on the same network. Its pairing
  address is then not asked at all: while the named network exists and
  that address is on none of its subnets, whoever holds the address
  today (another network's device, a host beyond the WAN) gets no
  connection, and the search starts at once. When no interface
  has that name any more (the network was renamed or removed), or it
  is down, nothing is searched, and never the network the pairing
  address would be on in its place: the access point is read where it
  answered last or shows as offline, and has to be paired again. A
  record without a name (the pairing address was on none of the
  router's networks, netifd did not answer, or an earlier version made
  it) is looked for as before there were names, on the interface whose
  subnet holds its pairing address now: after that subnet was changed,
  nowhere, until it is paired again. The address it answers at
  is kept in memory, `/etc/vantage` stays as paired; an answer of its
  own from a new address that is no report (`denied`, `missing`,
  `invalid`) moves it there too, with that error. States: `ok` (a report to
  show), `offline` (`unreachable`, `timeout`), `error` (`hostkey`,
  `denied`, `invalid`, or `missing`: no report command there, the add-on
  is not installed) and `waiting` (nothing fetched yet, or nothing since
  a pause in looking that began with a failure). `denied`,
  `missing` and `invalid` end the search, so only an access point that
  showed its pinned key can cause them: `denied` is `dbclient`'s one
  reason that comes after the key check, word for word, `missing` a line
  of the access point's own shell, `invalid` bytes on its standard
  output. `hostkey` is `dbclient`'s own reason or its own line about a
  mismatch, from the line's start. What a device says before any key is
  checked (its version line is quoted in `dbclient`'s error text; a
  disconnect ends `dbclient` with 0) reads as `unreachable`. A report's
  text is counted before it is
  parsed (at most 2048 objects and arrays and 8192 commas): `json()`
  builds every value before a check can drop one, and 128 KiB of empty
  objects took 66 MB. The fullest report has 949 and 6676 since each
  station carries its link and each port the switch's counters, and its
  free text can add 639 to either; routers of 1.1.0 and 1.1.1 refuse
  more than 1280 and 4096, so an access point with more than about 150
  stations has its reports refused by them. After a pause in looking, the last report stands
  until the next fetch has ended or could not be started; an access
  point whose fetch before the pause had failed waits for that fetch.
  An upgrade restarts the collector: the init script
  names its program files (`file`), procd compares their checksums each
  time `start` runs, and `start` is all an apk upgrade runs (opkg stops
  the service first).
- **What an access point tells.** Dropbear runs the report command
  whatever the router asks for (the key's forced command): the
  hostname, model, uptime and LAN MAC, with every other address of its
  own (#167, at most 64); its access-point interfaces
  (SSID, BSSID, frequency, channel); their stations (MAC, signal, link
  rates, byte counts, time connected; iwinfo, as the dashboard reads its
  own), those on the interface of a network's VLAN under that network
  (#164: the one with the interface's BSSID); and the wired hosts behind its ports other than the ones towards
  its gateway or the router (none when those are not found) and the
  rest of such a port's wire, the device a VLAN is on and its other
  VLANs (#167: where each VLAN is a device of its own, `eth0.3` beside
  `eth0.1`; it knows the gateway in its own network only, and the
  kernel says which device a VLAN is on, whatever the names; not in a
  bridge that hears the gateway or the router itself, where two VLANs of
  one device are two wires, as a switch's WAN port joined to its LAN.
  Known limit: a swconfig switch's ports all
  arrive through one device, so a host plugged into such an access point
  is heard on the uplink's port or wire like the rest of its VLAN, and is
  not listed as its wired host), with the
  ports' speed and byte counts: the kernel's, and on a DSA switch its
  chip's own beside them (#156), as the access point's own
  `luci.vantage.ports` reads them; the report asks it, as it asks
  `luci.vantage wired`, and runs nothing itself. Nothing from configuration, no keys; it
  takes no input and changes nothing, and runs one at a time (a lock on
  its own file, so many sessions of one key cannot pile up). The router checks every field
  again (types, ranges, MAC form, UTF-8 without control characters; at
  most 16 SSIDs, 256 stations, 128 wired hosts and 32 ports an access
  point, 1024 stations in a reply) and turns byte counts into rates: a
  port's from its chip's counters where both reports carry them, from
  the kernel's where neither does, and none across the two (an access
  point of an earlier version sends the kernel's only, and a router of
  an earlier version reads only those). The
  MAC it places the access point by is the one from pairing, never the
  one in the report.
- **Its place on the dashboard.** What an access point reports adds
  entries, marked as its; it never renames or re-addresses one (except
  that the entries it adds count when deciding whether an mDNS name is
  uncontested: an address the host hints give to one of them and to an
  entry of this device names neither), and a
  station on this device's own Wi-Fi, the gateway and this device's own
  addresses stay as they are. One case moves an entry: a host this
  device hears on the wire it hears the access point's own MAC on
  (a MAC no other paired access point claims, neither the gateway's nor
  one of this device's) and that the access point lists as its station
  is shown as that access point's Wi-Fi client, not as a wired host of
  this device. The wire is that port, or another VLAN of the port's
  device (`eth0.3` beside `eth0.1`): where each VLAN is a device of its
  own here, an access point's networks arrive on several (since 1.2.1;
  before, the very port only). Not across to a port a line to the
  internet leaves by, or from one: a bridged WAN on `eth0.2` is
  upstream, and no access point on the LAN's VLAN has its hosts. A host the access point lists as wired behind it gets a
  note saying so, and one it lists as an address of its own (the bridge
  of another of its networks, #167) is that access point once more:
  left out of the wired hosts and named on the access point's own entry
  there (a tag with their number in its row, the addresses in its
  details), so that none is taken unseen. Not the MAC of a paired access
  point, and not an address another of them reports too, as its own or
  its station: a contested claim takes nothing. Another's wired host it
  may be (since 1.2.2): an access point hears the others' addresses on
  its ports as it hears any host's, so the bridges of an access point
  plugged into another paired one are that access point's too. Where the access point has it alone on that port (its
  report counts one wired host there), the port's traffic the access
  point reports is the host's in the Clients list (Live, its sort) and
  in its details, said to be counted by the access point on its port;
  one that shares that port there stays without traffic of its own, as
  on a shared port of this device. Top talkers does not rank it. An
  access point plugged into another paired one is
  drawn under it: its branch further in (three steps at most), its wire
  from that one, the port in its tooltip. For that this device must
  hear both MACs on one port of its own, and the other must list this
  one's among its wired hosts: a claim alone moves no access point of
  another port. Of several that list it (a chain), the nearest has it,
  the one all the others list too; two that list each other, several
  with no nearest one and a ring of claims stay branches of this
  device, as do all while one of the two is not reporting. Between two
  access points on one port of this device the claim is all there is:
  one of them can place itself above the other. Where this device hears
  the access point's MAC is decided against its own host hints,
  addresses compared by value (an
  IPv6 address has many spellings). The gateway is a host the hints
  give the next hop's address. Any device gets its MAC listed under any
  address with one ARP request, so among several such hosts this
  device's bridge entries decide: one heard on the line's own bridge
  (in the line's VLAN, where the entries name one) before one heard on
  no bridge, and that one before one heard only elsewhere; two of one
  kind are none, unknown rather than the one listed last. Never a
  station of one of this device's access point interfaces (the far end
  of its own client, mesh or WDS link may be), a host heard only in
  other VLANs of the line's bridge, or a host heard only elsewhere when
  the line's far end has no MAC (PPP, a modem, a tunnel). A lone holder
  heard elsewhere is believed otherwise, since the bridges of a wire's
  other VLANs hear a real gateway in just that way. This tells apart a
  claim made from another of this device's networks. It does not tell
  apart one made on the uplink's own network: a host there that
  replaces the gateway's entry in this device's neighbour table (ARP
  spoofing) is the one holder and is taken for the gateway, as it is
  when the gateway is in no hint at all. The uplink's port is that of
  the gateway's entry on the line.
  While it is unknown and the uplink has a next hop, no
  host the uplink's bridge has learned is moved or noted, since any of
  them may be the gateway; and no host that holds the gateway's address
  is ever an access point's to add. A client two access points report stays where
  it was placed (the stronger signal; a station before a wired host);
  the others are named in its details ("Also reported by"), so no report
  is dropped unseen, and nothing changes in the list or the path. An
  access point is named as at pairing; its address is text, never a link
  to its LuCI. Its stations stay out of this device's health checks and
  weak-signal warnings. The report is asked for in a request of its own
  and waited for at most 4 s a poll, so a collector that does not answer
  holds up nothing else. Only a login with `luci-app-vantage-aps-view`
  asks at all (the dashboard looks that up once a page; without the
  add-on there is no such group, and no request is made); where no
  collector answers because nothing is paired, it asks once a minute.
  An answer older than two slow polls is not shown: no access points
  rather than old ones as if current. Without the add-on, or with
  nothing paired, the dashboard is as before.
- **Unpairing.** Removing an access point on the router deletes its
  record and what the collector kept for it (and stops the collector
  with the last one); revoking a router on the access point deletes its
  key line, which takes effect at the next fetch. A router that keeps a
  connection open from before gets nothing either: Dropbear checks a key
  when a connection logs in, not for each session on it, but it names
  the line that let the caller in to the command it runs
  (`SSH_PUBKEYINFO`, the line's comment), and says when a key line's
  command replaced the caller's (`SSH_ORIGINAL_COMMAND`). A caller let
  in that way gets a report only while `authorized_keys` holds a line
  of the add-on's with that comment: not once the line is gone, and not
  when Dropbear names no comment (a line of the administrator's own
  with this command, a Dropbear older than 2022.82). A login without a
  key line's command (the administrator's shell) is not judged.
  Removing the add-on leaves the key lines, which can then only run a
  command that is gone: revoke routers first.
- **Requirements and limits.** Dropbear on the access point, running and
  reachable from the router, built with key options (OpenWrt's default;
  the add-on looks for Dropbear's option parser and refuses to pair
  without it, since such a build would give the key a root shell), with
  an Ed25519 host key of its own and settings that let root in by key
  with the key's own command (no `RootLogin` off, `ForceCommand` or
  `keyfile` list in the first section that is on, whose first port the
  reply names); `dbclient` on the router. The report needs a Dropbear
  that sets `SSH_PUBKEYINFO` (2022.82 and later; OpenWrt 24.10 and
  25.12 have it): an older one gets no report at all. On OpenWrt 24.10's Dropbear the
  key's `no-port-forwarding` is also what keeps it from forwarding to a
  local socket such as ubus's: it must stay. The collector runs as root
  for now (a user of its own is on the roadmap); what it reads from the
  network before the host key is checked is Dropbear's client's to
  parse. On an access point
  still without a root password Dropbear lets root in without the key,
  so the report runs then too, asked for by name; the host key is pinned
  either way.

### Per-device traffic (`luci-app-vantage-traffic`, experimental)

An optional package gives the dashboard a rate for wired hosts that
share one of the router's ports (a switch, or an access point that is
not paired or not OpenWrt, behind it), which the port's counters cannot
split per device (#110). It counts from the kernel's connection
tracking, which a router accounts already (`kmod-nf-conntrack` installs
`/etc/sysctl.d/11-nf-conntrack.conf` with
`net.netfilter.nf_conntrack_acct=1`): no firewall rule, no sysctl
change, no daemon, init script, cron job or config file. Its counters'
state is in `/var/run/vantage-traffic` (RAM). Installing it is its files
and an rpcd reload; removing it is the same, and its removal script
deletes that directory. Experimental: what it costs a router is
measured on few devices so far.

- **What is counted.** The plugin reads `/proc/net/nf_conntrack` line by
  line, with both directions' bytes of each entry: split once at its
  spaces and taken apart by a table of where each protocol's fields are
  (five builtin calls a line, against about thirty before 1.2.0), a line
  that does not fit the table searched as before. A host is the MAC the
  router's IPv4 or IPv6 neighbour table gives an address: the one that
  opened the connection, and the one it was opened to (a port forward,
  a host of another of the router's networks; a connection between two
  of them counts for both). Routed traffic and traffic to the router
  itself count; the router's own connections to the internet do not
  (its address is in no neighbour table). The counters, by MAC, only
  grow: each read adds what each entry carried since the read before.
  An entry is known again by its protocol and original addresses and
  ports, whatever its timeout and state; a new one counts whole; one
  whose counters went down (another reader reset them) counts from 0.
  An address the neighbour table does not give a host yet is followed
  all the same, so it does not count whole once it does. A host nothing
  was counted for in 10 minutes is dropped, and counts from 0 when it
  comes back. As for ports and stations, rx is from the host and tx to
  it, and the browser takes the rate from two answers.
- **What is not counted.** Traffic a bridge or a switch passes between
  hosts of one network: it never reaches connection tracking, so this
  is traffic through the router, never all of a host's. Hosts behind
  another router (their addresses are in no neighbour table here). An
  IPv6 address the neighbour table does not hold when a read runs (an
  expired privacy address). What a connection carried after the last
  read before it ended, and one that began and ended between two reads.
  Flows offloaded to hardware, whose counters move only where the
  driver reports flow statistics (the answer counts such entries, `hw`;
  fw4's software offload keeps counting, its flowtable has a `counter`).
  Where nlbwmon runs, what passed between a read and nlbwmon's reset: it
  zeroes the counters at every refresh, 30 s by default (the answer
  counts the resets it saw, `zeroed`). A paired access point's clients
  behind it: their rate is the one the access point reports, where it
  reports one.
- **The answer.** `luci.vantage.traffic hosts`, no argument:
  `{ v, at, took, every, slow, low, acct, entries, partial, offloaded,
  hw, zeroed, dropped, hosts: [ { mac, rx, tx } ] }`. `at`: when the read
  began, ms on the router's monotonic clock, the same in every answer
  until the next read; `took`: how long it took; `every`: when the next
  one is due. `acct` false: accounting is switched off (the sysctl, or
  no entry carries byte counts), nothing is counted and `hosts` is
  empty; the plugin never switches it on. null: there is no connection
  table. `partial`: false, or why the read stopped early (`time`,
  `entries`). `{}` when there is no answer to give: no read has finished
  yet and one is running, the state directory is not the plugin's, or
  the read's state could not be written (a full `/tmp`).
  No remote address, port or destination ever leaves the router: a MAC
  and two numbers a host.
- **Out of rpcd.** The plugin is an executable rpcd plugin
  (`/usr/libexec/rpcd/luci.vantage.traffic`, a ucode script): rpcd runs
  it as a process of its own for each call and goes on answering
  everyone else meanwhile, so no read, whatever the table's size, holds
  LuCI up; it kills a call after its own timeout (30 s as OpenWrt sets
  it). Nothing runs while nobody asks. Between calls the plugin keeps its
  state in `/var/run/vantage-traffic`, which it makes 0700 and refuses
  when it is anything else (a link, a file, another account's, open to
  others): `state.json` (`{ v, at, flows: { key: [ orig bytes, reply
  bytes, read at ] }, totals: { mac: [ rx, tx, counted at ] } }`, `at`
  when the read that wrote it began; about 100 bytes an entry, 1.5 MiB
  at 16,384 entries), `answer.json` (the last answer) and a lock file,
  0600 too. Both files are written 0600 beside the one they replace,
  then put in its place, so a call rpcd kills leaves the last whole one;
  a write that fails leaves nothing beside it, and the answer is written
  only after the state it comes from (without it the call gets `{}`, and
  the next read counts from the state the last answer came from). The
  largest state the plugin can write is its bound for reading one back,
  `MAX_STATE`, about 7.4 MiB: 2 × 16,384 entries with keys of 160
  characters (the table's are 115 at most; a longer one is not counted)
  and every number 20 characters, 512 hosts. A state larger than that,
  or with anything the plugin does not write (an entry that is not three
  numbers of at least 0, a key longer than 160 characters, a host that
  is not a MAC, more than 512 hosts), is not used: the counting starts
  over. Nothing in them is readable by any account but root's. A reboot
  clears them; the package's removal script deletes the directory and
  has rpcd let go of the plugin. A call already running then can make
  the directory again after the script deleted it: RAM, until the next
  reboot.
- **Costs and bounds.** One read serves every caller: for 5 s, or 30 s
  where the theme's Low-power router is on for every browser (a browser
  that picked it for itself asks every 30 s, with its slow poll), less
  500 ms so that a dashboard polling every 5 s gets a new read each
  time; a call in between gets the last answer from `answer.json`. One
  read runs at a time (the lock): a call while one runs gets the last
  answer, never waits. Each read is timed, the state's load and save
  included: the next waits ten times as long as it took when that is
  longer (2 minutes at most), so reading takes about a tenth of one core at
  most, and the answer says so (`took`, `every`, `slow`). The table is
  read for 2 s and 16,384 entries at most. At most 512 hosts
  (`dropped`: the rest) and 4,096 neighbour entries.
- **Entries a read does not see.** A read may not see an entry that is
  still there: it stops short (`partial`), and even a whole read misses
  some, since the kernel lists the table by position, from the start
  again at each read() of about a page, so that an entry removed behind
  that place hides the next one. Forgotten, such an entry would count
  whole again when a read sees it. So an entry a read did not see is
  kept: every one the read before saw, whatever its size and however
  long ago that was (no read runs while nobody looks), which covers a
  single miss; past that read, one that carried 64 KiB or more, both
  ways together, or any after a partial read (what it did not reach is
  many entries, mostly still there), while it was seen less than 150 s
  ago (longer than the 2-minute wait after a slow read); 16,384 at
  most, those the read before saw first, so all of them. What remains:
  a smaller entry missed by two whole reads running counts twice when a
  read sees it again, by what it had carried: less than 64 KiB, so a
  host's rate is too high for one step by about 100 kbit/s at most
  (17 kbit/s at 30 s). A whole read misses about one entry for every
  two that end while it runs: with 80 connections ending a second,
  about one a read where a read takes 25 ms (a desktop, 2,000 entries),
  a dozen where it takes 0.3 s (an ARM access point); the same entry
  twice running, about once a minute there and once in hours on the
  desktop, most of them lookups of a few hundred bytes. An entry
  missed by two reads more than 150 s apart, or pushed out by
  16,384 others, counts whole when it is seen again. A new connection
  with the protocol, addresses and ports of a kept one that ended less
  than 150 s before is taken for the old one: with smaller counters it
  counts from 0, as it should (`zeroed`, the resets the dashboard
  points out, counts only entries the read before saw), with larger
  ones the old one's last counts are left out of it; that takes a
  client reusing its source port to the same server and port after a
  connection of 64 KiB or more, seldom (clients pick ports at random).
  The price is a larger state where connections come and go: it holds
  those that ended since the read before, and the large ones that
  ended in the last 150 s, 16,384 at most.
- **Measured** with `dev/traffic/bench.uc`, a read that finds every
  entry again (state loaded and checked, table counted, state saved): on
  a desktop's ucode 7 ms at 500 entries, 25 ms at 2,000, 94 ms at 8,000,
  190 ms at 16,384, about 11 µs an entry, the state's load and save 45
  ms of it at 16,384 (checking the state, about 1.7 µs an entry); the
  process's memory about 19 MiB at 16,384 entries, 5 MiB at 2,000 (a
  router's table is sized by its RAM: 2,048 to 4,096 entries at
  128 MiB). With churn (`bench.uc <dir> churn <entries> <percent>
  [reads] [large]`: that share of the table ends and as many new
  entries begin between reads 5 s apart, a tenth of them of 64 KiB or
  more), 2,000 entries: 5 % (20 a second) keeps 2,380 entries in the
  state, 217 KiB, a read 26 ms; 20 % (80 a second) 3,520 entries,
  322 KiB, 30 ms, the process's memory 9 MiB; 50 % 5,800 entries,
  533 KiB, 41 ms, 13 MiB. 8,000 entries at 20 %: 14,080 entries,
  1.3 MiB, 121 ms, 24 MiB; 16,384 at 20 %: 24,094 entries, 2.1 MiB,
  234 ms, 41 MiB. Kept whatever their size, the same tables held
  4,900, 13,600 and 18,384 entries at 2,000 (20 %: 1.2 MiB, 70 ms,
  24 MiB) and 32,768 at 16,384 (2.9 MiB, 279 ms, 53 MiB); kept only
  after a partial read, 2,000 entries at 20 % took 22 ms and 6 MiB. On
  a quad-core ARM access point (25.12), before the state was checked
  and entries kept after a whole read: 106 ms at 500 entries, 383 ms at
  2,000, 1,511 ms at 8,000, about 190 µs an entry, and the 2 s limit
  ends a read near 12,500 entries.
  On an x86 VM (24.10): 6 ms, 22 ms, 90 ms and 179 ms at 16,384, about
  11 µs an entry. Before the read left rpcd's process, the same ARM
  device took 139 ms at 500 entries and 515 ms at 2,000, during which
  rpcd answered no one.
- **On the dashboard.** In the Clients list (Live, its sort and bars)
  and in the host's details, for a wired host on a shared port of this
  device whose traffic this device routes: not the gateway, not a host
  on a line's port or on a line's own network (a dumb access point's
  hosts reach the gateway past it, bridged: it shows no such rate). It
  says where the number comes from: "Through this router, from its
  connection tracking (read every 5 s)", and in the details that
  traffic with devices on the same network is not counted, and what may
  make it low (a partial read, connections offloaded to hardware,
  counters another program resets) or why there is none (accounting
  off). A port of the host's own comes first (its counters count all of
  its traffic), then the rate a paired access point reports where it
  has the host alone on a port (it counts traffic within the network
  too), then this. Top talkers does not rank these hosts; whether it
  should is open. The dashboard asks rpcd once a page, in the batch it
  sends when it loads, whether the login holds the package's group, and
  calls only then, with the slow part of each poll, in a request of its
  own that no poll waits for: its answer is the next poll's (one call at
  a time). The last rates stand two slow polls without an answer (a
  failed call, or none made), then go, and so do they for a read given
  again for longer than twice its `every` (or twice the page's slow
  poll, where that is longer): the plugin reads no more; two new reads
  give a rate again, not one over the gap. A call that says the plugin
  is not there (the package removed under the page, or rpcd reloading
  at a package install) is made again a minute later, whether the
  plugin had answered before or not; its empty answer (`{}`, no read
  yet) and other failures at the next slow poll. The rates are taken on
  the router's monotonic clock, and start over where it went back (the
  router started again under the page): the second read after it gives
  a rate. Without the package, or for a login without its group, the
  dashboard makes that one check and nothing else, and looks as before.
- **Permission.** Its own group, `luci-app-vantage-traffic` (read
  `luci.vantage.traffic hosts`). It shows how much each device sends and
  receives, so no group of the dashboard grants it. `test_acl_policy.js`
  pins the group and its one read, that no group of the dashboard or the
  access points add-on grants it, the dashboard's one declare (no
  parameters, a request of its own) and its one call behind the check,
  and the plugin's reads and writes: rtnl, uci's cursor and fs's chmod,
  lstat, mkdir, open, readfile, rename, unlink (of its own file beside,
  only) and writefile only, its two answers to rpcd ("list": the one
  method, no arguments; "call hosts") and no input read, the table
  opened for reading, the accounting switch and its own files read
  bounded, the two neighbour dumps, the one theme option, writes to its
  own directory only, root's, 0700 and 0600, through a file beside, the
  lock, 0600, and an answer of MACs and counts; altered copies of the
  plugin are refused. `tests/traffic.test.js` runs the plugin as rpcd
  does, a process a call, under a host ucode (both parses on every kind
  of line, counting from call to call, caps, the shared read and the
  lock, the time budget, entries a read did not see, the largest state,
  states it did not write, a write that fails, the state directory, its
  owner and its modes), `tests/package.test.js` its removal script and
  `tests/traffic-view.test.js` the dashboard's side.

## 5. Later

- **v2**: one-click actions (restart radio, kick/ban client, toggle SSID)
  each behind a separate narrow write ACL and a confirmation;
  optional rpcd plugin keeping a small ring buffer for history, alerts.
- **v3**: topology view, luci-app-statistics integration.
- **Wired hosts on DSA switches** (#101): the bridge's forwarding dump
  may make a switch such as the MT7531 walk its hardware table on every
  poll; measure on such a router before changing `wired`.
- **Live per-device traffic for wired and mesh clients** (#110): since
  1.2.0 the experimental `luci-app-vantage-traffic` (section 4,
  "Per-device traffic"), from connection tracking, without firewall
  rules. Open: what a read costs small routers, whether Top talkers
  ranks these hosts, and the names of a router's clients on an access
  point's own dashboard.

## 6. Security requirements

- Templates escape everything request-derived; never echo `fuser`; the
  theme's own markup for unauthenticated renders (login, 404, CSRF) adds
  nothing about the device but the login page's hostname and the HTTPS
  ports its script may move to (none with `luci.main.vantage_https`
  `stay`), and of the
  Appearance only the colour mode, the login background, whether
  Low-power router is on and Motion when not in focus. Not in the theme's control: LuCI's core
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
- One request leaves for the internet, from the theme: the update check
  (section 3, Updates), to a constant URL, without cookies or a
  referrer, on a click, or once a day in a browser whose user switched
  Daily update check on. Nothing from the answer but a version number
  reaches the page, as text. `tests/theme.test.js` holds the script to
  that one `fetch`, the option to the browser and off by default, and
  the login page to reading none of it.
- ACL test: the app's ACL grants only the listed read methods and every
  `rpc.declare` in the app is covered, nothing unused is granted
  (`security-tests/test_acl_policy.js`, also run by `node --test tests/`).
  The one object glob is `hostapd.*` (hostapd's ubus objects are named per
  interface), limited to `get_clients`/`get_status`. No group of the app
  grants a uci write or reads Wi-Fi keys (LuCI's own groups can, such as
  `luci-base-network-status`); the only writes are the plugin's
  `set_alias` and `set_quiet`, whose validation `tests/plugin.test.js`
  checks against the view's and the replay's.
- Provider tiles (experimental, above): the dashboard calls only
  `vantage.tile.<id> status`, without arguments, for ids its session's
  own ACL grants by name, and draws the answer as text after checking
  it; no group of the dashboard or the add-on grants such a call
  (`test_acl_policy.js`). A provider tile always shows its provider's
  id.
- No private addresses or MACs in committed files
  (`security-tests/check_private_addresses.js`, which also looks for the
  hostnames/SSIDs recorded in the mirror when it is present); fixtures are
  pseudonymised from the mirror (MAC → 00:00:5E:00:53:xx, IPv4 →
  192.0.2.x/198.51.100.x, IPv6 → 2001:db8::/32, hostnames → client-NN).
  Invented locally administered MACs use the 02:00:5E:xx:xx:xx prefix
  (IANA OUI with the U/L bit set; e.g. the replay's synthetic BSSIDs);
  no other MACs pass.
- The dashboard starts one program, from its executable rpcd plugin
  `luci.vantage.ports` (#156), in a process of rpcd's: `/usr/sbin/ethtool
  -S` and the name of one of the device's own DSA ports, which the plugin
  finds in `/sys/class/net` and holds to letters, digits, `_` and `-`
  (never first), at most 32 ports, none after its first second and 32
  KiB of each run read, one call at a time (a lock on its own file,
  opened for reading); nothing the caller sends reaches the command,
  and without a DSA port or `ethtool` nothing is started. Its read group
  grants the call and no other group of a Vantage package names it;
  `luci.vantage` starts nothing. `test_acl_policy.js` pins all of it.
- Apart from that, `luci-app-vantage-aps` (optional) is the only Vantage
  package that runs programs, and the only one that writes outside its own
  config: its pairing plugin runs
  `dropbearkey` once and the collector's init script with fixed words,
  writes `/etc/vantage/aps.json` and its own lines of
  `/etc/dropbear/authorized_keys`, each limited to the report command;
  its collector runs `dbclient` with the pinned host key and nothing
  else. Its ACL group for pairing (`luci-app-vantage-aps`) is for
  administrators only. Seeing the access points is a group of its own,
  `luci-app-vantage-aps-view` (read `vantage.collector report`): a call
  makes the router log in to every paired access point and shows their
  clients, so the dashboard's groups do not grant it, and a login with
  the dashboard alone sees the dashboard without the access points.
  `test_acl_policy.js` holds each of these to that list, and
  `tests/aps.test.js` runs them against hostile codes and reports.
- `luci-app-vantage-traffic` (optional, experimental) changes nothing on
  the device: its plugin, a process rpcd runs, reads the connection
  table, the accounting switch, the neighbour tables and the theme's
  Low-power option, keeps its counters in `/var/run/vantage-traffic`
  (0700, files 0600: root's alone), and answers MACs and byte counts,
  never an address. Its group (`luci-app-vantage-traffic`) is the only one
  that grants the call; `test_acl_policy.js` holds the plugin to those
  reads and writes and the dashboard to one call behind the check.
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
2. ~~Mobile nav: bottom bar vs drawer~~ — decided: bottom bar (section 3,
   Mobile).
3. Anything to add or cut from theme v1 / app v1 above.
