local sys = require "luci.sys"
local http = require "luci.http"
local nixio = require "nixio"

module("luci.controller.dae", package.seeall)

function index()
	if not nixio.fs.access("/etc/config/dae") then
		return
	end

	-- Main page
	local page = entry({"admin", "services", "dae"}, firstchild(), _("DAE"), -1)
	page.dependent = true
	page.acl_depends = { "luci-app-dae" }

	-- Status entry
	entry({"admin", "services", "dae", "status"}, call("act_status")).leaf = true

	-- Configuration pages
	entry({"admin", "services", "dae", "global"}, cbi("dae/global"), _("Global Settings"), 1)
	entry({"admin", "services", "dae", "dns"}, cbi("dae/dns"), _("DNS Settings"), 2)
	entry({"admin", "services", "dae", "node"}, cbi("dae/node"), _("Node Settings"), 3)
	entry({"admin", "services", "dae", "route"}, cbi("dae/route"), _("Routing Settings"), 4)
	entry({"admin", "services", "dae", "log"}, cbi("dae/log"), _("Logs"), 5)
	entry({"admin", "services", "dae", "get_log"}, call("get_log"))
	entry({"admin", "services", "dae", "clear_log"}, call("clear_log"))
end

function act_status()
	local sys  = require "luci.sys"
	local e = { }
	e.running = sys.call("pidof dae >/dev/null") == 0
	if e.running then
		e.memory = sys.exec("awk '/VmRSS/ {print $2/1024 \" MB\"}' /proc/$(pidof dae | cut -d' ' -f1)/status 2>/dev/null")
		if e.memory then
			e.memory = e.memory:gsub("\n", "")
			if e.memory == "" then
				e.memory = nil
			end
		end
	end
	luci.http.prepare_content("application/json")
	luci.http.write_json(e)
end

function get_log()
	http.write(sys.exec("cat /var/log/dae/dae.log"))
end

function clear_log()
	sys.call("true > /var/log/dae/dae.log")
end
