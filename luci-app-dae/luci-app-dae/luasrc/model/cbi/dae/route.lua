local fs = require "nixio.fs"
local dae = require "luci.model.dae_tools"
local m, s

m = Map("dae", translate("Routing Settings"), translate("Configure routing rules for DAE."))

-- Check if route config file exists, create if not
local route_file = "/etc/dae/config.d/route.dae"
if not fs.access(route_file) then
    fs.writefile(route_file, [[routing {
    pname(dnsmasq, zerotier-one) -> must_direct
    dip(224.0.0.0/3, 'ff00::/8', geoip:private) -> direct

    domain(geosite:category-bank-cn, geosite:boc@!cn, geosite:synology) -> direct

    domain(geosite:category-ai-!cn, geosite:google, geosite:category-entertainment, geosite:gfw, geosite:github, geosite:spotify) && l4proto(udp) && dport(443) -> block

    domain(geosite:spotify) -> proxy
    domain(geosite:category-entertainment) -> proxy
    domain(geosite:category-ai-!cn, geosite:google, geosite:github) -> proxy
    domain(geosite:gfw) -> proxy

    dip(geoip:telegram) -> proxy

    dip(geoip:cn) -> direct

    l4proto(udp) && dport(443) -> block

    fallback: proxy
}]]
)
end

s = dae.init_editor(m, "route")
dae.add_editor(s, route_file, "routeconf", translate("Route Configuration"))

return m
