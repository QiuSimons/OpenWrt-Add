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
    fs.writefile(dns_file, [[# dns.dae
dns {
    upstream {
        localdns: 'udp://127.0.0.1:53'
        overseadns: 'tcp+udp://one.one.one.one:53'
    }
    routing {
        request {
            qtype(https) -> reject
            qname(geosite:gfw) -> overseadns
            fallback: localdns
        }
        response {
            qname(geosite:private) -> accept
            upstream(overseadns) -> accept
            ip(geoip:private) -> accept
            !ip(geoip:cn) -> overseadns
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
o.inputstyle = "reload"
o.write = function()
    -- 使用luci.sys.call替代sys.exec，它不会阻塞界面
    luci.sys.call("/etc/init.d/dae hot_reload >/dev/null 2>&1 &")
    
    -- 立即显示操作成功的提示信息
    luci.http.redirect(luci.dispatcher.build_url("admin", "services", "dae", "dns") .. "?reload=1")
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
