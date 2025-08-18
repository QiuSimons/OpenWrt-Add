local fs = require "nixio.fs"
local sys = require "luci.sys"
local m, s

m = Map("dae", translate("DNS Settings"))
m.description = translate("Configure DNS settings for DAE.")

m:section(SimpleSection).template = "dae/dae_status"

-- Create directory if not exists
if not fs.stat("/etc/dae/config.d") then
    fs.mkdirr("/etc/dae/config.d")
end

-- Check if dns config file exists, create if not
local dns_file = "/etc/dae/config.d/dns.dae"
if not fs.access(dns_file) then
    fs.writefile(dns_file, [[dns {
    upstream {
        alidns: 'udp://dns.alidns.com:53'
        googledns: 'tcp+udp://dns.google:53'
    }

    routing {
        request {
            qname(geosite:category-ads) -> reject
            qname(geosite:category-ads-all) -> reject
            fallback: alidns
        }
        response {
            upstream(googledns) -> accept
            !qname(geosite:cn) && ip(geoip:private) -> googledns
            fallback: accept
        }
    }
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

-- DNS configuration editor

o = s:option(TextValue, "dnsconf", translate("DNS Configuration"))
o.rows = 25
o.rmempty = true
o.wrap = "off"

-- Read DNS configuration
function o.cfgvalue(self, section)
    return fs.readfile(dns_file) or ""
end

-- Write DNS configuration
function o.write(self, section, value)
    value = value:gsub("\r\n?", "\n")
    fs.writefile(dns_file, value)
end

o = s:option(DummyValue, "")
o.template = "dae/dae_editor"

return m