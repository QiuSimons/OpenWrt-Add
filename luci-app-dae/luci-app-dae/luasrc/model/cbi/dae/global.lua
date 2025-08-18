local fs = require "nixio.fs"
local sys = require "luci.sys"
local m, s

m = Map("dae", translate("Global Settings"))
m.description = translate("Configure global settings for DAE.")

m:section(SimpleSection).template = "dae/dae_status"

-- Create directory if not exists
if not fs.stat("/etc/dae/config.d") then
    fs.mkdirr("/etc/dae/config.d")
end

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
    check_tolerance:"5ms"
    lan_interface:"br-lan"
    wan_interface:"auto"
    enable_local_tcp_fast_redirect:"true"
    auto_config_kernel_parameter:"true"
    sniffing_timeout:"300ms"
}]])
end

s = m:section(TypedSection, "dae")
s.addremove = false
s.anonymous = true

o = s:option(Flag, "enabled", translate("Enabled"))
o.rmempty = false

o = s:option(Button, "_reload", translate("Reload Service"), translate("Reload service to apply configuration."))
o.write = function()
    sys.exec("/etc/init.d/dae hot_reload")
end

-- Auto update settings
enable = s:option(Flag, "subscribe_auto_update", translate("Enable Auto Subscribe Update"))
enable.rmempty = false

-- Update cycle
weekly = s:option(ListValue, "subscribe_update_week_time", translate("Update Cycle"))
weekly:value("*", translate("Every Day"))
weekly:value("1", translate("Every Monday"))
weekly:value("2", translate("Every Tuesday"))
weekly:value("3", translate("Every Wednesday"))
weekly:value("4", translate("Every Thursday"))
weekly:value("5", translate("Every Friday"))
weekly:value("6", translate("Every Saturday"))
weekly:value("7", translate("Every Sunday"))
weekly.default = "*"
weekly:depends('subscribe_auto_update', '1')

-- Update time
daily = s:option(ListValue, "subscribe_update_day_time", translate("Update Time (Every Day)"))
for t = 0, 23 do
  daily:value(t, t..":00")
end
daily.default = 0
daily:depends('subscribe_auto_update', '1')

-- Global configuration editor
o = s:option(TextValue, "globalconf", translate("Global Configuration"), translate("Correctly configure the include field for separate-config to work, or enter complete configuration here (other sub-pages won't need configuration and won't take effect)."))
o.rmempty = true
o.wrap = "off"

-- Read global configuration
function o.cfgvalue(self, section)
    return fs.readfile(config_file) or ""
end

-- Write global configuration
function o.write(self, section, value)
    value = value:gsub("\r\n?", "\n")
    fs.writefile(config_file, value)
end

o = s:option(DummyValue, "")
o.template = "dae/dae_editor"

return m