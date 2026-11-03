# Changelog

User-visible changes per release, newest first. Dates are the tag dates.
Each release ships both packages, `luci-theme-vantage` and
`luci-app-vantage`, at the same version; the packages are listed at
<https://github.com/anothaDev/luci-theme-vantage/releases> and in the
[signed repositories](https://anothadev.github.io/luci-theme-vantage/).

## Unreleased

- **The spinner while changes are applied turns smoothly** (#71,
  [@HyperdrivzZ](https://github.com/HyperdrivzZ)). LuCI rebuilds the
  "Applying configuration changes… 89s" notice every second, and the
  spinner started over from the top each time.
- **Software on a phone** (#71). The Actions buttons wrap instead of
  running past the card, which made the page wider than the screen and
  pushed its dialogs off the right edge, and a package's dependency tree
  wraps inside its dialog instead of cutting off the status labels.
- **"Signal · 3 weak" lists all three** (#71). With more than one weak
  client, the dashboard's Signal check opens the clients list on its Weak
  signal filter instead of only the weakest client's details.
- **Wireless's Associated Stations stay in their card** (#74,
  [@kylesean](https://github.com/kylesean)). LuCI 25.12 now puts the list
  in a section of its own, and with names and addresses in Host it ran
  past the card's edge on narrower desktop windows. The rate lines wrap
  when space runs short, and on 25.12 the card scrolls if it still
  doesn't fit.
- **Dashboard: its stylesheet comes from the browser's cache** until a
  package changes, versioned the way LuCI versions its scripts, instead
  of being rechecked with the device on every page load.

## 1.0.13 - 2026-11-02

- **Dashboard: a port's traffic on its node** (#67,
  [@bakaranadnan-a11y](https://github.com/bakaranadnan-a11y)). Each port
  node in the network path's Wired branch shows the port's live traffic,
  and a device on a shared port (a switch or another access point behind
  it) shows the port's total in its details, under "Not counted per
  device". It stays the port's: no device gets a share of it.
- **Dashboard: the switch ports behind a swconfig VLAN** (#67). Where a
  port is a VLAN on a swconfig switch (`eth1.1` on routers with a
  hardware switch), a device's details list the VLAN's switch ports and
  their links, from LuCI's own switch port state, asked at most every
  30 seconds. Ports are named as swconfig numbers them ("Port 1") unless
  the board description numbers them per role ("LAN 2"). When only one of them has a link, the devices behind it get
  that port's speed instead of the switch's link to the CPU. Which port
  each device is on stays unknown otherwise. The app's read permission
  gains `luci getSwconfigPortState`.

## 1.0.12 - 2026-11-01

- **Dashboard: an animated network path.** The path's dot grid carries
  packets now, the login page's "Grid packets": downloads run from the
  gateway's side, uploads back, more and faster with the live uplink
  rate. Under Customize, "Network path background" switches to the
  login page's starfield, streaming out of the device's node, or turns
  it off. It runs at 20 frames a second on a quiet uplink and up to 30
  on a busy one, pauses while another window has the focus, the tab is
  hidden or the tile is out of view, and stands still with reduced
  motion.
- **Dashboard: a jump from the network path stops below the top bar.**
  Clicking an SSID, Wired or port node scrolled the Clients tile's head
  under the sticky top bar.
- **Dashboard: the numbers under the network path stay in their cells**
  on a phone; a long line such as the clients per band ends with "…"
  instead of running into the next cell.
- **Dashboard: wired devices** (#62,
  [@HyperdrivzZ](https://github.com/HyperdrivzZ)). The Clients tile now
  lists the devices on Ethernet ports too, with a Wi-Fi/Wired switch
  where a device has both: name, address, vendor, port, link speed and
  live traffic for a device alone on its port, and when each was last
  heard. Routers without Wi-Fi get the Clients tile for them, and the
  network path shows a Wired branch with a node per port. The quick
  filters moved into a menu at the end of the search box, so the tile
  fits on a phone. Wired devices get reverse DNS names and vendors like
  Wi-Fi clients, and those on a bridge VLAN their network and address;
  devices reached through the uplink port are tagged Upstream. At most
  128 are listed per port, and none when the bridges have learned 4,096
  addresses or more, so a flood of made-up addresses cannot exhaust the
  device's memory.
- **Dashboard: the right uplink port on a bridge with several.** An
  access point whose LAN bridge has more than one Ethernet port took the
  first one as its uplink, for the uplink's traffic, link speed and
  "No link" check. It now takes the port the bridge learned the gateway
  on (also over IPv6, and through a VLAN on the bridge), else one with a
  link.
- **Dashboard: Wi-Fi on firmware without netifd's wireless status** (#60,
  [@bakaranadnan-a11y](https://github.com/bakaranadnan-a11y)). Vendor
  drivers that bypass netifd, such as MediaTek's mtkwifi on GL.iNet
  firmware, left the Wi-Fi section empty. The radios and networks now
  come from the wireless configuration there, with run state from
  iwinfo, and a configured Wi-Fi 7 (EHT) mode is shown even when the
  driver reports Wi-Fi 6, also where netifd answers but lists no radio.
  OpenWrt's own drivers are read as before.
- **Firmware upload: the progress bar fills its dialog** (#59,
  [@VIKINGYFY](https://github.com/VIKINGYFY)), and the upload dialog's
  Cancel and Upload buttons sit on the line with Browse….
- **Realtime Graphs on a phone:** the current, average and peak values
  of each line get a row each instead of running into each other.

## 1.0.11 - 2026-10-30

- **Dashboard: the uplink in use when there are several** (#56,
  [@wolvth](https://github.com/wolvth)). With two WANs the dashboard
  showed the one named wan, even when traffic left through the other,
  preferred by its lower metric. It now picks as the kernel does for
  ordinary traffic: a default route in the main table, IPv4 before IPv6,
  then the lowest metric; the name only breaks a tie. With DS-Lite or
  MAP-E it shows the IPv6 line, not the tunnel.
- **Dashboard: temperature** (#56). The CPU check and the System tile
  show the hottest temperature sensor, and the tile's tooltip lists each
  one. A new read-only plugin method, `luci.vantage thermal`, reads the
  thermal zones in `/sys/class/thermal` and nothing else; LuCI grants it
  at login, so the reading appears after your next login. A device
  without thermal zones shows none.
- **Theme: login page backgrounds and an Appearance menu.** Behind the
  login form, lime packets run along the grid lines (the default) or a
  starfield flies past, and logging in speeds them up. One canvas and no
  libraries; it pauses while the window is in the background and stays
  still with reduced motion. The colour-scheme button in the header now
  opens an Appearance menu: colour (auto, light or dark) and login
  background (grid packets, starfield or none), kept per browser; the
  command palette (Ctrl+K) offers both.
- **Theme: field help.** Descriptions use the full width of the form
  (#51, [@VIKINGYFY](https://github.com/VIKINGYFY)). Help that needs
  more than one line folds to its first line, ending after the first
  sentence where that fits, and the ⓘ beside it opens the whole text.
- **Theme: dropdowns.** In Chrome, Edge and other Chromium browsers,
  plain dropdowns such as Language and Design open a themed list; on
  them ↓ opens the list instead of stepping to the next value, as
  Chromium handles styled lists, and Escape in a dialog closes only the
  list. Firefox and Safari keep their own list, now with readable
  colours. LuCI's dropdowns in a card that scrolls sideways open at full
  height below the field (DHCP and DNS → Log facility, Firewall →
  offloading), Save & Apply's menu reaches "Apply unchecked" by
  keyboard, and lists on touch screens stay on screen. The Network →
  Diagnostics dropdowns open past their card and no longer jump while
  they open (#55, [@VIKINGYFY](https://github.com/VIKINGYFY)).
- **Theme: phones.** The bottom bar brings a clipped active entry into
  view after every page load (#47, #48,
  [@LianXia233](https://github.com/LianXia233)).
- **Theme: layout fixes** ([@VIKINGYFY](https://github.com/VIKINGYFY)):
  no extra gap under a status card header above a table (#49);
  multi-line editors such as Scheduled Tasks fill their form column
  (#50); progress bar labels stay clear of the heading above at larger
  font sizes (#52); read-only log dialogs widen to 1080 px (#53); wide
  tables such as DHCP leases scroll inside their card instead of being
  cut off (#54).

## 1.0.10 - 2026-10-28

- **Simplified Chinese for the theme**, shipped as
  `luci-i18n-vantage-theme-zh-cn`, and a reworked, complete dashboard
  catalogue (#40, [@ntbowen](https://github.com/ntbowen)). Words another
  package translates differently, such as luci-app-oaf's "Free" (a free
  tier), have a context of their own, so the dashboard keeps its own
  wording; words LuCI itself translates still come from LuCI in every
  language. The Status → Firewall flow chart's labels can now be
  translated; before, none of them could.
- **Larger text no longer breaks a few layouts** (#39), as with
  Firefox's minimum font size, common for Chinese:
  - Status → Overview, Port status: the boxes fill their column and
    share one height, so a counter no longer wraps and pushes its box
    above the others on ImmortalWrt.
  - Folded field help and page intros show their whole first line;
    the bottom was cut off.
  - A table card that scrolls sideways no longer scrolls up and down by
    a few pixels, and a table in a nested section (HomeProxy's
    subscriptions) keeps the bottom of its last row (#43,
    [@VIKINGYFY](https://github.com/VIKINGYFY)).
- **Theme: a card ending in a paragraph** (HomeProxy's status) has the
  same space below the text as above it (#44,
  [@VIKINGYFY](https://github.com/VIKINGYFY)).
- **Theme: buttons and tabs** (#42, [@VIKINGYFY](https://github.com/VIKINGYFY)).
  LuCI's plain action, reload, edit, find, link and download buttons
  (Open, Restart and Refresh in add-ons such as AxonHub) are outlined in
  the accent, as Bootstrap outlines them; in table rows only Edit is, so
  rows of buttons (System → Startup) stay plain. The selected tab
  carries the accent in its text and ring.
- **Theme: Status → Overview, Port status.** Each port shows a link dot
  by its name and its speed as the figure; a port without link is
  muted. The ▲ sent and ▼ received arrows take the dashboard's upload
  and download colours, the zone is a plain bar, and LuCI's port
  picture, which only repeated the link state, is hidden. A PoE port's
  power line is readable in dark mode; it was black on black.

## 1.0.9 - 2026-10-20

- **Status → Firewall as a flow chart.** A Flow / Rules table switch over
  LuCI's page; LuCI's tables are one click away. One chart shows the way
  a packet takes (prerouting, then input, this device and output, or
  forward, then postrouting), which steps drop unmatched packets or have
  rules that drop some, and ingress, bridge and egress chains where a
  packet meets them. A second row shows traffic bridged between ports,
  such as Wi-Fi and LAN on an access point, which never reaches the
  forward chain, and says when no bridge chain filters it; a note says
  when flow offloading lets established connections skip the chains.
  Below, each chain lists its rules as steps: fw4's rule name, the
  conditions as LuCI words them, the verdict and the traffic matched; a
  jump opens the chain it jumps to in place, and a return or the end of
  a chain names where the packet goes next. It reads the ruleset with
  the command and permission LuCI's page already uses.
- **Dashboard: Top talkers keeps its height.** It shows the top three,
  always three rows tall, names on one line; before, it grew with every
  extra talker or long name and took long to shrink back.
- **Dashboard: the throughput chart picker's open list** is drawn like
  the theme's dropdowns in Chromium (rounded, themed, current choice
  marked) and keeps one width whatever is chosen.
- **Dashboard: the uplink is the interface carrying the default route.**
  Interfaces named `wan`, `wan6` or `*wan*` still win among those, so
  routers are unchanged. An access point whose WAN port was bridged into
  LAN and kept an up, unmanaged `wan` interface no longer shows "No
  default route" and keeps its gateway, DNS and management address. A
  router whose WAN has no default route of its own, with all traffic
  routed through a VPN tunnel, now shows the tunnel as the uplink, with
  its counters and addresses, labelled Gateway instead of Internet.
  (#32, [@ronger-x](https://github.com/ronger-x))
- **Tooling:** the device recorder is no longer part of the repository.
  The replay's README describes the recording format instead; the request
  policy it shared with the replay moved to `dev/replay/policy.js`.

## 1.0.8 - 2026-10-15

- **OpenWrt 24.10.** Signed `.ipk` packages and an opkg repository next
  to the 25.12 apk one, built with the pinned 24.10.8 SDK. The 24.10
  signing key is in `keys/vantage-24.10.usign.pub`; its fingerprint is in
  the [install guide](docs/INSTALL.md#openwrt-2410). Tested on a 24.10.8
  router without Wi-Fi: install, upgrade, removal, tampered index refused.
- **Theme:** an opkg upgrade keeps Vantage selected; before, the theme's
  removal script could switch LuCI back to Bootstrap during the upgrade.
- **Security:** fixes for the Low findings of the 1.0.7 review. The
  dashboard prunes per-client signal history and reverse-DNS results it
  no longer needs and caps the addresses kept per host hint; the name
  plugin's `set_alias` reverts its staged change after a failed commit;
  the spec states that DHCP, mDNS and WPS names are self-reported by the
  client and that an alias always wins.
- **Release signing** runs only in the approved `release-signing`
  environment and only for `v*` tags.

## 1.0.7 - 2026-10-15

- **Firewall overview reads the config the way firewall4 does.** Zones
  match on devices, not network names (a modem's dynamic `wan_4` is no
  longer "in no zone"); a redirect to any of the router's own addresses
  is local; an ipset restricts the source only when it matches the
  source; every zone option fw4 parses is validated and a value fw4
  refuses skips the zone; disabled zones do not exist; IKE/ESP/AH to the
  router is an opening; a ubus error is a failed read, never "Nothing is
  open". When a setup is beyond what the page checks (shared internet
  devices, covered subnets, sets a service defines) it says so and lists
  the settings to check instead of guessing (#28).
- **Theme, row action menus:** a row folds its buttons into a ⋯ menu
  only when it has a main action (Edit, else the highlighted one) and at
  least two others; Add, highlighted and an app's own buttons stay
  visible, so Wake on LAN, Startup, Processes and radio rows are back to
  their 1.0.5 layout. The menu shows LuCI's busy state, closes on Escape
  and Tab, follows label and disabled changes, and never covers its own
  button.
- **Theme, firewall pages:** badge text keeps 4.5:1 contrast on hovered
  rows; switched-off rules are greyed instead of faded; the zones table
  fits down to about 880 px and wide tables show a scroll shade; the
  rule on/off box has a 44 px target on phones; port status tooltips are
  no longer clipped (#26).
- **Theme, other LuCI versions:** Status → Firewall (nftables) and the
  log filters of LuCI 26.x are styled; OpenWrt 24.10's Status overview
  and its firewall tables (which render no name cell) display correctly;
  fixes from a sweep of OpenWrt 25.12.5 (Interfaces tooltip, crumb caret,
  phone cards, Diagnostics, Software, Connections, Repo Public Keys,
  forms).
- **Dashboard:** lane charts label each lane at its top; the chart
  picker spans the bar on phones; links to pages the router lacks are
  hidden; narrow tiles get a one-row handle bar; the CPU sparkline moves
  under the numbers when narrow; restored history is bounded to the
  rate ceiling.
- **Docs:** the install guide and security policy describe 24.10. The
  Simplified Chinese catalogue covers the new strings.

## 1.0.6 - 2026-10-14

- **Dashboard: five throughput chart styles** under Customize: overlaid,
  log scale, mirrored, separate lanes and the previous one (the chart
  part of #7).
- **New Network → Firewall → Overview tab** (`luci-app-vantage`): what is
  open from the internet, which zone reaches which, what is switched off
  or ignored, and warnings for the risky cases, each item linking to the
  LuCI page that changes it. Read-only; shown only to sessions that hold
  LuCI's `luci-app-firewall` group. The app grants nothing new.
- **Theme, firewall pages:** verdicts and policies are coloured badges,
  with a warning colour where the internet-facing zone accepts traffic;
  rules that are off are dimmed; table rows with three or more actions
  put the extra ones under a ⋯ menu.

## 1.0.5 - 2026-10-13

- **Theme: one tab style at every level** (a segmented control that
  wraps instead of scrolling tabs out of sight); page tabs sit at the top
  of the content and the current breadcrumb becomes a page switcher, a
  dropdown or the bottom sheet on phones (#21).
- **Theme, phones and add-ons:** the bottom bar reaches every category
  and keeps its layout; phone cards keep their names and grow with their
  content; modal tables become cards; adblock and banIP follow the theme
  toggle; Save & Apply opens upwards; wide tables no longer scroll the
  page; visible focus on fields; log viewers take the full width;
  contrast fixes; tabs, crumbs and top-bar buttons meet 36/44 px (#22).
- **Lighter polling:** the "Refreshing" and "Live" pulses animate on the
  compositor; the dashboard updates in place and no longer forces a
  layout per poll (idle frames per 11 s: 637 → 12).
- **Dev tooling:** `dev/replay/addons.sh` renders 15 official LuCI
  add-ons with fixture data; `check_dom_sinks.js` also checks
  `el.animate()` keyframes.

## 1.0.4 - 2026-10-12

- **Theme: calmer forms.** One control height for fields, buttons, tabs
  and chips, 36 px with a mouse and 44 px on touch, with 16 px text in
  touch fields; a 180 px label column and fields up to 360 px; one look
  per tab level; a type scale shared with the dashboard. Field help and
  long page or section intros fold to their first line with an (i)
  button; a heading that only repeats the breadcrumb is hidden visually
  and kept for screen readers (#18).
- **Theme, Channel Analysis:** the device's own network is drawn in the
  accent colour.
- **Fixes:** "Generate QR" was a blank tile; tables in nested sections
  had a stray scrollbar.
- Screenshots retaken for the new sizes and tabs.

## 1.0.3 - 2026-10-12

- **Fix stale dashboard styles after an upgrade:** the app stylesheet is
  revalidated on every load, so a browser no longer keeps the 1.0.1
  sheet after upgrading (broken layout controls, overlapping scale
  labels).
- **Throughput chart:** download and upload in their own colours in
  every row, a legend, coloured arrows in the readouts and a tooltip
  with one row per direction (#14).
- Simplified Chinese: "Uplink" translated as the link, not as upload.
- Install guide: reload with Ctrl+Shift+R after an upgrade.

## 1.0.2 - 2026-10-11

- **Wired-only layout** for devices without radios: no empty Radios
  tile or Wi-Fi checks; the device's other interfaces show in the
  network path with live rates (#9, from #7). The replay gets `--wired`.
- **Mirrored throughput chart:** download above the middle line, upload
  below, each with its own scale, instead of a Download/Upload toggle
  (#10). The network path spans the row; System heads the right column.
- **Arrange the dashboard:** a Layout button lets you drag tiles, change
  their width or hide them; saved in the browser per screen size, with a
  reset to the default. Nothing is written to the device (#11).

## 1.0.1-r3 - 2026-10-01

- **Simplified Chinese** translation of the dashboard, shipped as
  `luci-i18n-vantage-zh-cn` (#1, [@ntbowen](https://github.com/ntbowen)).
- **Translation support:** each `po/<lang>/` becomes a language package
  (`luci-i18n-vantage-<lang>`, `luci-i18n-vantage-theme-<lang>`);
  `dev/i18n/update.sh` maintains the templates and catalogues with
  LuCI's own tools; CI checks they are current; the replay previews a
  language with `--lang` (#2).

## 1.0.1-r2 - 2026-09-28

- **Signed apk repository** published from CI to GitHub Pages, so the
  packages install and upgrade with `apk` without `--allow-untrusted`.
  Releases also carry `packages.adb`. The install guide documents the
  repository, the key fingerprint and upgrades; `docs/ROADMAP.md` added.

## 1.0.1 - 2026-09-28

First public release.

- **`luci-theme-vantage`:** icon rail with flyouts, bottom bar on phones,
  breadcrumb and page tabs, Ctrl+K command palette, light, dark and auto
  modes without a flash, host chip and indicator pills, its own login
  page, restyled stock pages, forms, tables, charts and status icons;
  system fonts and self-drawn icons, no CDNs.
- **`luci-app-vantage`:** the dashboard at `admin/dashboard` with health
  checks, the network path, live throughput, radio cards, clients with
  human names and an experience score, the client inspector, top
  talkers, wireless networks and the system tile. Read-only rpcd ACL;
  wireless data comes from the app's own rpcd plugin without keys; device
  names are the one write, through the plugin, into
  `/etc/config/vantage`.
- **Tooling:** read-only recorder, offline replay with a pseudonymising
  demo mode, reproducible SDK builds verified against the source, the
  test suite and the four security checks, GitHub Actions CI publishing
  releases only when the build matches the committed manifest.
