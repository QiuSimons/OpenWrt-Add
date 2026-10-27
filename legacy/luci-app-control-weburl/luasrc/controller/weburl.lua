module("luci.controller.weburl", package.seeall)

function index()
	if not nixio.fs.access("/etc/config/weburl") then
		return
	end

	local page = entry({"admin", "control"}, firstchild(), "Control", 50)
	page.dependent = false
	page.acl_depends = { "luci-app-control-weburl" }

	entry({"admin", "control", "weburl"}, cbi("weburl"), _("Weburl"), 12).dependent = true
	entry({"admin", "control", "weburl", "status"}, call("act_status")).leaf = true
end

function act_status()
	local e = {}
	e.running = luci.sys.call("iptables -L FORWARD|grep WEBURL >/dev/null") == 0
	luci.http.prepare_content("application/json")
	luci.http.write_json(e)
end
