mp = Map("DNSProxy", translate("DNSProxy"))
mp.description = translate("DNSProxy is a Simple DNS proxy with DoH, DoT, DoQ and DNSCrypt support.")
mp:section(SimpleSection).template  = "DNSProxy/DNSProxy_status"

s = mp:section(TypedSection, "DNSProxy")
s.anonymous=true
s.addremove=false

enabled = s:option(Flag, "enabled", translate("Enable"))
enabled.default = 0
enabled.rmempty = false

node5335 = s:option(DynamicList, "node5335", translate("Node 5335"))
node5335.description = translate("Upsteam DNS Server For 5335 (Support DoT/DoH)")
node5335.rmempty = true

noipv6 = s:option(Flag, "noipv6", translate("Filter AAAA"))
noipv6.default = 1
noipv6.rmempty = false
noipv6.description = translate("DNSProxy Port 5335 Filter AAAA Result")

node6050 = s:option(DynamicList, "node6050", translate("Node 6050"))
node6050.description = translate("Upsteam DNS Server For 6050 (Support DoT/DoH)")
node6050.rmempty = true

return mp
