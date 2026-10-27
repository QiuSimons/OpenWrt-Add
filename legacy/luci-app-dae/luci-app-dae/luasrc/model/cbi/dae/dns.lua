local dae = require "luci.model.dae_tools"
local m, s

m = Map("dae", translate("DNS Settings"), translate("Configure DNS settings for DAE."))

local dns_file = "/etc/dae/config.d/dns.dae"

s = dae.init_editor(m, "dns")
dae.add_editor(s, dns_file, "dnsconf", translate("DNS Configuration"))

return m
