'use strict';
'require baseclass';
'require rpc';

var callNetworkDeviceStatus = rpc.declare({
	object: 'network.device',
	method: 'status',
	expect: {}
});

var last_stats = {};
var last_time = 0;

return baseclass.extend({
	title: _('Network Speed'),

	load: function () {
		return callNetworkDeviceStatus();
	},

	render: function (devices) {
		var now = Date.now();
		var diff = (now - last_time) / 1000;
		last_time = now;

		var is_first_run = (Object.keys(last_stats).length === 0 || diff <= 0 || diff > 10);
		if (is_first_run) {
			diff = 1;
		}

		var table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Interface')),
				E('th', { 'class': 'th' }, _('Download Rate (RX)')),
				E('th', { 'class': 'th' }, _('Upload Rate (TX)'))
			])
		]);

		var devNames = Object.keys(devices).filter(function (d) {
			return d !== 'lo' && devices[d].up && devices[d].statistics;
		}).sort();

		var has_active = false;

		for (var i = 0; i < devNames.length; i++) {
			var name = devNames[i];
			var stats = devices[name].statistics;
			var rx_bytes = stats.rx_bytes;
			var tx_bytes = stats.tx_bytes;

			has_active = true;
			var rx_rate = 0;
			var tx_rate = 0;

			if (!is_first_run && last_stats[name]) {
				rx_rate = (rx_bytes - last_stats[name].rx) / diff;
				tx_rate = (tx_bytes - last_stats[name].tx) / diff;

				if (rx_rate < 0) rx_rate = 0;
				if (tx_rate < 0) tx_rate = 0;
			}

			last_stats[name] = {
				rx: rx_bytes,
				tx: tx_bytes
			};

			var formatSpeed = function (bps) {
				if (bps < 1024) return bps.toFixed(1) + ' B/s';
				if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
				return (bps / 1048576).toFixed(1) + ' MB/s';
			};

			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'data-title': _('Interface') }, E('strong', {}, name)),
				E('td', { 'class': 'td', 'data-title': _('Download Rate (RX)') }, is_first_run ? _('Calculating...') : formatSpeed(rx_rate)),
				E('td', { 'class': 'td', 'data-title': _('Upload Rate (TX)') }, is_first_run ? _('Calculating...') : formatSpeed(tx_rate))
			]));
		}

		if (!has_active) {
			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td', 'colspan': '3' }, _('No active network interfaces'))
			]));
		}

		return table;
	}
});
