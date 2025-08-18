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
    pname(NetworkManager) -> direct
    dip(224.0.0.0/3, 'ff00::/8') -> direct
    dip(geoip:private) -> direct
    dip(1.14.5.14) -> direct
    domain(geosite:openai) -> local_group
    dip(geoip:cn) -> direct
    domain(geosite:cn) -> direct
    domain(geosite:category-scholar-cn) -> direct
    domain(geosite:geolocation-cn) -> direct
    fallback: my_group
}]]
)
end

s = m:section(TypedSection, "dae")
s.addremove = false
s.anonymous = true

o = s:option(Button, "_reload", translate("Reload Service"), translate("Reload service to apply configuration."))
o.write = function()
    sys.exec("/etc/init.d/dae hot_reload")
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