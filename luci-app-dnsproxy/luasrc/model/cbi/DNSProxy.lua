require("luci.sys")
require("luci.util")
require("luci.http")
require("luci.dispatcher")
require("nixio.fs")
local fs=require"nixio.fs"
local port=require"luci.model.uci".cursor()
local port=port:get("DNSProxy","DNSProxy","port")

mp = Map("DNSProxy", translate("DNSProxy"))
mp.description = translate("DNSProxy is a Simple DNS proxy with DoH, DoT, DoQ and DNSCrypt support.")
mp:section(SimpleSection).template  = "DNSProxy/DNSProxy_status"

s = mp:section(TypedSection, "DNSProxy")
s.anonymous=true
s.addremove=false

enabled = s:option(Flag, "enabled", translate("Enable"))
enabled.default = 0
enabled.rmempty = false

node5335 = s:option(Value, "node5335", translate("Node 5335"))
node5335.default = "-u tls://8.8.4.4:853 -u tls://1.1.1.1:853 --cache --cache-min-ttl=3600 --fastest-addr --ipv6-disabled"
node5335.placeholder = "-u tls://8.8.4.4:853 -u tls://1.1.1.1:853 --cache --cache-min-ttl=3600 --fastest-addr --ipv6-disabled"
node5335.datatype = "string"

node6050 = s:option(Value, "node6050", translate("Node 6050"))
node6050.default = "-u 119.29.29.29 -u 223.5.5.5 -u 180.76.76.76 --cache --cache-min-ttl=3600 --fastest-addr"
node6050.placeholder = "-u 119.29.29.29 -u 223.5.5.5 -u 180.76.76.76 --cache --cache-min-ttl=3600 --fastest-addr"
node6050.datatype = "string"

-- manual-config
addr = s:option(Value, "manual-config", translate("Manual Configuration"),
translate("------------------------------------------------------------------------------------------------------------"))

addr.template = "cbi/tvalue"
addr.rows = 25

function addr.cfgvalue(self, section)
	return nixio.fs.readfile("/etc/init.d/DNSProxy")
end

function addr.write(self, section, value)
	value = value:gsub("\r\n?", "\n")
	nixio.fs.writefile("/etc/init.d/DNSProxy", value)
end

local apply = luci.http.formvalue("cbi.apply")
 if apply then
     io.popen("/etc/init.d/DNSProxy reload")
end

io.popen("/etc/init.d/DNSProxy reload")

return mp
