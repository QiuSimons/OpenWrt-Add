local dae = require "luci.model.dae_tools"
local m, s

m = Map("dae", translate("Node Settings"), translate("Configure nodes and groups for DAE."))

local node_file = "/etc/dae/config.d/node.dae"

s = dae.init_editor(m, "node")
dae.add_editor(s, node_file, "nodeconf", translate("Node Configuration"))

return m