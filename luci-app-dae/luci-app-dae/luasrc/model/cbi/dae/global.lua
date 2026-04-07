local fs = require "nixio.fs"
local dae = require "luci.model.dae_tools"
local m, s, o

m = Map("dae", translate("Global Settings"), translate("Configure global settings for DAE."))

-- Check if config file exists, create if not
local config_file = "/etc/dae/config.dae"
if not fs.access(config_file) then
    fs.writefile(config_file, [[# config.dae
# load all dae files placed in ./config.d/
include {
    config.d/*.dae
}
global {
    log_level:"error"
    check_interval:"600s"
    check_tolerance:"20ms"
    lan_interface:"br-lan"
    wan_interface:"auto"
    auto_config_kernel_parameter:"true"
    sniffing_timeout:"300ms"
    udp_check_dns: "dns.google:53,8.8.8.8,2001:4860:4860::8888"
    tcp_check_url: "http://cp.cloudflare.com,1.1.1.1,2606:4700:4700::1111"
    dial_mode: "domain"
}]])
end

s = dae.init_editor(m, "global")

s:option(Flag, "enabled", translate("Enabled")).rmempty = false

-- Auto update settings
o = s:option(Flag, "subscribe_auto_update", translate("Enable Auto Subscribe Update"))
o.rmempty = false

o = s:option(ListValue, "subscribe_update_week_time", translate("Update Cycle"))
for i, v in ipairs({ translate("Every Day"), translate("Every Monday"), translate("Every Tuesday"), translate("Every Wednesday"), translate("Every Thursday"), translate("Every Friday"), translate("Every Saturday"), translate("Every Sunday") }) do
    o:value(i == 1 and "*" or tostring(i - 1), v)
end
o.default = "*"
o:depends('subscribe_auto_update', '1')

o = s:option(ListValue, "subscribe_update_day_time", translate("Update Time (Every Day)"))
for t = 0, 23 do o:value(t, t..":00") end
o.default = 0
o:depends('subscribe_auto_update', '1')

dae.add_editor(s, config_file, "globalconf", translate("Global Configuration"), translate("Correctly configure the include field for separate-config to work, or enter complete configuration here."))

return m
