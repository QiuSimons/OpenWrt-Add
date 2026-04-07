local fs = require "nixio.fs"
local dae = require "luci.model.dae_tools"
local m, s

m = Map("dae", translate("Node Settings"), translate("Configure nodes and groups for DAE."))

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

s = dae.init_editor(m, "node")
dae.add_editor(s, node_file, "nodeconf", translate("Node Configuration"))

return m