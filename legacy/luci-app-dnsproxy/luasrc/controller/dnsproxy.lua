module("luci.controller.dnsproxy",package.seeall)

function index()
	if not nixio.fs.access("/etc/config/dnsproxy") then
		return
	end

	local page = entry({"admin", "services", "dnsproxy"}, cbi("dnsproxy"), _("DNSProxy"), 30)
	page.dependent = true
	page.acl_depends = { "luci-app-dnsproxy" }

	entry({"admin", "services", "dnsproxy", "status"}, call("act_status")).leaf = true
end

function act_status()
	local e = {}
	e.running = luci.sys.call("pgrep -f dnsproxy >/dev/null") == 0
	luci.http.prepare_content("application/json")
	luci.http.write_json(e)
end
