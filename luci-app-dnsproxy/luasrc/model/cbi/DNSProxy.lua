require("luci.sys")
require("luci.util")
require("luci.http")
require("luci.dispatcher")
require("nixio.fs")
local fs=require"nixio.fs"

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

local apply = luci.http.formvalue("cbi.apply")
if apply then
    io.popen("/etc/init.d/DNSProxy reload &")
end

return mp
