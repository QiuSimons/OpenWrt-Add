module("luci.controller.DNSProxy",package.seeall)
function index()
if not nixio.fs.access("/etc/config/DNSProxy")then
return
end
	entry({"admin","services","DNSProxy"},cbi("DNSProxy"),_("DNSProxy"),30).dependent=true
    entry({"admin","services","DNSProxy","status"},call("act_status")).leaf=true
end 

function act_status()
  local e={}
  e.running=luci.sys.call("pgrep -f dnsproxy >/dev/null")==0
  luci.http.prepare_content("application/json")
  luci.http.write_json(e)
end
