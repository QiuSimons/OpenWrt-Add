local fs = require "nixio.fs"
local sys = require "luci.sys"
local m, s

m = Map("dae", translate("Node Settings"))
m.description = translate("Configure nodes and groups for DAE.")

m:section(SimpleSection).template = "dae/dae_status"

-- Create directory if not exists
if not fs.stat("/etc/dae/config.d") then
    fs.mkdirr("/etc/dae/config.d")
end

-- Check if node config file exists, create if not
local node_file = "/etc/dae/config.d/node.dae"
if not fs.access(node_file) then
    fs.writefile(node_file, [[node {
    node1: 'xxx'
    node2: 'xxx'
}
subscription {
    my_sub: 'https://www.example.com/subscription/link'
}
group {
    my_group {
        filter: subtag(my_sub) && !name(keyword: 'ExpireAt:')
        filter: subtag(my_sub2)
        policy: min_moving_avg
    }
    local_group {
        filter: name(node1, node2)
        policy: fixed(0)
    }
}]]
)
end

s = m:section(TypedSection, "dae")
s.addremove = false
s.anonymous = true

o = s:option(Button, "_reload", translate("Reload Service"), translate("Reload service to apply configuration."))
o.inputstyle = "reload"
o.write = function()
    -- 使用luci.sys.call替代sys.exec，它不会阻塞界面
    luci.sys.call("/etc/init.d/dae hot_reload >/dev/null 2>&1 &")
    
    -- 立即显示操作成功的提示信息
    luci.http.redirect(luci.dispatcher.build_url("admin", "services", "dae", "node") .. "?reload=1")
end

-- Node configuration editor

o = s:option(TextValue, "nodeconf", translate("Node Configuration"))
o.rows = 25
o.rmempty = true
o.wrap = "off"

-- Read node configuration
function o.cfgvalue(self, section)
    return fs.readfile(node_file) or ""
end

-- Write node configuration
function o.write(self, section, value)
    value = value:gsub("\r\n?", "\n")
    fs.writefile(node_file, value)
end

o = s:option(DummyValue, "")
o.template = "dae/dae_editor"

return m