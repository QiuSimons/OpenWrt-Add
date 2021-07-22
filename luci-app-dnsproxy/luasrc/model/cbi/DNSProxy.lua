mp = Map("DNSProxy", translate("DNSProxy"))
mp.description = translate("DNSProxy is a Simple DNS proxy with DoH, DoT, DoQ and DNSCrypt support.")
mp:section(SimpleSection).template  = "DNSProxy/DNSProxy_status"

s = mp:section(TypedSection, "DNSProxy")
s.anonymous=true
s.addremove=false

enabled = s:option(Flag, "enabled", translate("Enable"))
enabled.default = 0
enabled.rmempty = false

oversea_port = s:option(Value, "oversea_port", translate("DNSProxy Port1"))
oversea_port.default = "5335"
oversea_port.datatype = "port"
oversea_port.rmempty = false

oversea_dns = s:option(DynamicList, "oversea_dns", translate("Upsteam DNS"))
oversea_dns.description = translate("Upsteam DNS Server For DNSProxy Port1 (Support DoT/DoH)")
oversea_dns.rmempty = true

oversea_noipv6 = s:option(Flag, "oversea_noipv6", translate("Filter AAAA"))
oversea_noipv6.default = 1
oversea_noipv6.rmempty = false
oversea_noipv6.description = translate("DNSProxy Port1 Filter AAAA Result")

mainland_port = s:option(Value, "mainland_port", translate("DNSProxy Port2"))
mainland_port.default = "6050"
mainland_port.datatype = "port"
mainland_port.rmempty = false

mainland_dns = s:option(DynamicList, "mainland_dns", translate("Upsteam DNS"))
mainland_dns.description = translate("Upsteam DNS Server For DNSProxy Port2 (Support DoT/DoH)")
mainland_dns.rmempty = true

return mp
