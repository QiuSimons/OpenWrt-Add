local i = require "luci.sys"
local t, e
t = Map("wolplus", translate("Wake on LAN"), translate("Wake on LAN is a mechanism to remotely boot computers in the local network."))
t.template = "wolplus/index"
e = t:section(TypedSection, "macclient", translate("Host list"))
e.template = "cbi/tblsection"
e.anonymous = true
e.addremove = true
a = e:option(Value, "name", translate("Name"))
a.optional = false
nolimit_mac = e:option(Value, "macaddr", translate("Mac Address"))
nolimit_mac.rmempty = false
i.net.mac_hints(function(e, t) nolimit_mac:value(e, "%s (%s)" % {e, t}) end)
nolimit_eth = e:option(Value, "maceth", translate("Network interface"))
nolimit_eth.rmempty = false
for t, e in ipairs(i.net.devices()) do if e ~= "lo" then nolimit_eth:value(e) end end
btn = e:option(Button, "_awake",translate("Wake up host"))
btn.inputtitle	= translate("Wake up host")
btn.inputstyle	= "apply"
btn.disabled	= false
btn.template = "wolplus/awake"
function gen_uuid(format)
    local uuid = i.exec("echo -n $(cat /proc/sys/kernel/random/uuid)")
    if format == nil then
        uuid = string.gsub(uuid, "-", "")
    end
    return uuid
end
function e.create(e, t)
    local uuid = gen_uuid()
    t = uuid
    TypedSection.create(e, t)
end

return t
