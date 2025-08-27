local fs = require "nixio.fs"
local sys = require "luci.sys"
local m, s

m = Map("dae", translate("Routing Settings"))
m.description = translate("Configure routing rules for DAE.")

m:section(SimpleSection).template = "dae/dae_status"

-- Create directory if not exists
if not fs.stat("/etc/dae/config.d") then
    fs.mkdirr("/etc/dae/config.d")
end

-- Check if route config file exists, create if not
local route_file = "/etc/dae/config.d/route.dae"
if not fs.access(route_file) then
    fs.writefile(route_file, [[routing {
    dip(geoip:private) && dport(53) && l4proto(tcp) -> block
    pname(dnsmasq, zerotier-one) -> must_direct
    dip(224.0.0.0/3, 'ff00::/8') -> direct
    dip(geoip:private) -> direct

    domain(keyword:synology, keyword:ddns) -> direct
    domain(geosite:category-ai-!cn) -> ai
    domain(geosite:category-entertainment) -> media
    dip(geoip:telegram) -> tg

    domain(geosite:gfw) -> proxy

    l4proto(udp) && dport(443) && !dip(geoip:cn) -> block

    dip(geoip:cn) -> direct
    fallback:proxy
}]]
)
end

s = m:section(TypedSection, "dae")
s.addremove = false
s.anonymous = true

o = s:option(Button, "_reload", translate("Reload Service"), translate("Reload service to apply configuration."))
o.inputstyle = "reload"
o.write = function()
    -- 使用luci.sys.call替代sys.exec，它不会阻塞界面
    luci.sys.call("/etc/init.d/dae hot_reload >/dev/null 2>&1 &")
    
    -- 立即显示操作成功的提示信息
    luci.http.redirect(luci.dispatcher.build_url("admin", "services", "dae", "route") .. "?reload=1")
end

-- Route configuration editor

o = s:option(TextValue, "routeconf", translate("Route Configuration"))
o.rows = 25
o.rmempty = true
o.wrap = "off"

-- Read route configuration
function o.cfgvalue(self, section)
    return fs.readfile(route_file) or ""
end

-- Write route configuration
function o.write(self, section, value)
    value = value:gsub("\r\n?", "\n")
    fs.writefile(route_file, value)
end

o = s:option(DummyValue, "")
o.template = "dae/dae_editor"

return m
