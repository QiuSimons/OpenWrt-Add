'use strict';
'require form';
'require rpc';
'require poll';
'require uci';
'require view';
'require ui';
'require dom';
'require fs';
'require tools.widgets as widgets';

const callFlowconeStatus = rpc.declare({
	object: 'luci.flowcone',
	method: 'status',
	expect: { '': {} }
});

const callFlowconeAction = rpc.declare({
	object: 'luci.flowcone',
	method: 'action',
	params: ['action'],
	expect: { '': {} }
});

function updateStatus(data, targetEl) {
	var el = targetEl || document.getElementById('flowcone_status');
	if (!el) return;

	if (data && data.running) {
		var mem = data.memory ? ' (' + _('Memory: %s').format(data.memory) + ')' : '';
		dom.content(el, [
			E('span', { 'style': 'color: var(--success, #22c55e); font-weight: bold;' }, _('FlowCone Running')),
			' ',
			E('span', { 'style': 'color: var(--text-muted, #888); font-size: 0.9em;' }, mem)
		]);
	} else {
		dom.content(el, [
			E('span', { 'style': 'color: var(--danger, #ef4444); font-weight: bold;' }, _('FlowCone Not Running'))
		]);
	}
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callFlowconeStatus(), {}),
			uci.load('flowcone'),
			uci.load('firewall'),
			L.resolveDefault(fs.stat('/etc/init.d/nat6'), null)
		]);
	},

	render: function(res) {
		var status = res[0] || {};
		var nat6Installed = res[3] != null;
		var m, s, o;

		m = new form.Map('flowcone', _('FlowCone'),
			_('RFC 4787 Full-Cone NAT based on eBPF and TCX.'));

		s = m.section(form.NamedSection, '_status');
		s.render = function() {
			var statusEl = E('span', { 'id': 'flowcone_status', 'style': 'font-weight: 500; margin-right: 15px;' }, [
				E('em', {}, _('Collecting data...'))
			]);

			var reloadBtn = E('button', {
				'type': 'button',
				'class': 'btn cbi-button cbi-button-action',
				'click': function(ev) {
					var btn = ev.target;
					btn.disabled = true;
					btn.innerText = _('Reloading...');
					callFlowconeAction('reload').then(function() {
						btn.disabled = false;
						btn.innerText = _('Reload Service');
						ui.addNotification(null, E('p', _('FlowCone service reloaded successfully.')), 'info');
					}).catch(function(err) {
						btn.disabled = false;
						btn.innerText = _('Reload Service');
						ui.addNotification(null, E('p', _('Failed to reload FlowCone:') + ' ' + (err.message || err)), 'error');
					});
				}
			}, _('Reload Service'));

			var section = E('fieldset', { 'class': 'cbi-section' }, [
				E('legend', {}, _('Status')),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Running Status')),
					E('div', { 'class': 'cbi-value-field' }, [
						statusEl,
						reloadBtn
					])
				]),
			]);

			updateStatus(status, statusEl);

			var pollFn = function() {
				if (!document.body.contains(statusEl)) {
					poll.remove(pollFn);
					return;
				}
				return callFlowconeStatus().then(function(stat) {
					updateStatus(stat, statusEl);
				}).catch(function() {});
			};
			poll.add(pollFn, 3);

			return section;
		};

		s = m.section(form.NamedSection, 'config', 'flowcone', _('Settings'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'enable_v4', _('IPv4 Full-Cone'));
		o.default = o.enabled;
		o.rmempty = false;

		o = s.option(form.Flag, 'enable_v6', _('IPv6 Full-Cone'),
			_('NAT66 for ULA prefixes, direct wire-speed for GUA.'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Flag, 'nat6', _('IPv6 NAT6 Helper'),
			_('Use the nat6 package for ULA/RA/DHCPv6; FlowCone keeps IPv6 UDP fullcone when enabled.'));
		o.default = o.disabled;
		o.rmempty = false;
		o.cfgvalue = function() {
			return uci.get('firewall', '@defaults[0]', 'nat6') === '1' ? '1' : '0';
		};
		o.write = function(section_id, value) {
			uci.set('firewall', '@defaults[0]', 'nat6', (value === '1' || value === true) ? '1' : '0');
		};
		if (!nat6Installed) {
			o.readonly = true;
			o.description = _('Use the nat6 package for ULA/RA/DHCPv6; FlowCone keeps IPv6 UDP fullcone when enabled.') + ' ' + _('The nat6 package is not installed.');
		}

		o = s.option(widgets.DeviceSelect, 'interface', _('WAN Interface'),
			_('WAN interface device to attach TCX programs to. Leave empty for automatic WAN detection.'));
		o.multiple = false;
		o.noaliases = true;
		o.nobridges = true;
		o.nocreate = true;
		o.rmempty = true;

		o = s.option(form.Flag, '_advanced', _('Advanced Settings'),
			_('Show advanced port range, timeout, and firewall integration options.'));

		o = s.option(form.Value, 'min_port', _('Min Port'));
		o.datatype = 'port';
		o.placeholder = '1024';
		o.default = '1024';
		o.depends('_advanced', '1');

		o = s.option(form.Value, 'max_port', _('Max Port'));
		o.datatype = 'port';
		o.placeholder = '65535';
		o.default = '65535';
		o.depends('_advanced', '1');

		o = s.option(form.Value, 'timeout', _('Timeout (seconds)'));
		o.datatype = 'uinteger';
		o.placeholder = '120';
		o.default = '120';
		o.validate = function(section_id, value) {
			var v = +value;
			if (!(v >= 120 && v <= 604800))
				return _('Timeout must be between 120 and 604800 seconds (RFC 4787 REQ-5).');
			return true;
		};
		o.depends('_advanced', '1');

		o = s.option(form.Value, 'interval', _('Expiry Scheduler Tick (seconds)'));
		o.datatype = 'uinteger';
		o.placeholder = '5';
		o.default = '5';
		o.validate = function(section_id, value) {
			var v = +value;
			if (!(v >= 1 && v <= 3600))
				return _('Interval must be between 1 and 3600 seconds.');
			return true;
		};
		o.depends('_advanced', '1');

		o = s.option(form.Flag, 'manage_nft', _('Firewall (fw4) Integration'),
			_('Automatically insert masquerade bypass and forward rules.'));
		o.default = o.enabled;
		o.rmempty = false;
		o.depends('_advanced', '1');

		o = s.option(form.Value, 'bypass_mark', _('Bypass Fwmark'),
			_('Optional fwmark for custom policy routing.'));
		o.placeholder = '0x100/0xff00';
		o.depends('_advanced', '1');

		return m.render();
	}
});
