module("luci.controller.DNSProxy",package.seeall)
function index()
    if not nixio.fs.access("/etc/config/DNSProxy")then
        return
    end
    local page = entry({"admin","services","DNSProxy"},cbi("DNSProxy"),_("DNSProxy"))
    page.order = 30
    page.dependent = true
    page.acl_depends = { "luci-app-dnsproxy" }
    entry({"admin","services","DNSProxy","status"},call("act_status")).leaf=true
end

function act_status()
    local e={}
    e.running=luci.sys.call("pgrep -f dnsproxy >/dev/null")==0
    luci.http.prepare_content("application/json")
    luci.http.write_json(e)
end
