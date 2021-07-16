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
