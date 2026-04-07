local fs = require "nixio.fs"
local dae = require "luci.model.dae_tools"
local m, s

m = Map("dae", translate("DNS Settings"), translate("Configure DNS settings for DAE."))

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

s = dae.init_editor(m, "dns")
dae.add_editor(s, dns_file, "dnsconf", translate("DNS Configuration"))

return m
