local dae = require "luci.model.dae_tools"
local m, s

m = Map("dae", translate("Routing Settings"), translate("Configure routing rules for DAE."))

local route_file = "/etc/dae/config.d/route.dae"

s = dae.init_editor(m, "route")
dae.add_editor(s, route_file, "routeconf", translate("Route Configuration"))

return m
