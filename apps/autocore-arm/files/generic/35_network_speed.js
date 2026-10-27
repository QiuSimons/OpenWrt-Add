'use strict';
'require baseclass';
'require rpc';

const callNetworkDeviceStatus = rpc.declare({
	object: 'network.device',
	method: 'status',
	expect: {}
});

let last_stats = {};
let last_time = 0;

return baseclass.extend({
	title: _('Network Speed'),

	load() {
		return callNetworkDeviceStatus();
	},

	render(devices) {
		const now = Date.now();
		let diff = (now - last_time) / 1000;
		last_time = now;

		const is_first_run = (Object.keys(last_stats).length === 0 || diff <= 0 || diff > 10);
		if (is_first_run) diff = 1;

		const table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Interface')),
				E('th', { 'class': 'th' }, _('Download Rate (RX)')),
				E('th', { 'class': 'th' }, _('Upload Rate (TX)'))
			])
		]);

		const devNames = Object.keys(devices).filter(d => d !== 'lo' && devices[d].up && devices[d].statistics).sort();
		let has_active = false;

		const formatSpeed = bytesPerSec => {
			const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
			let i = 0;
			while (bytesPerSec >= 1024 && i < units.length - 1) {
				bytesPerSec /= 1024;
				i++;
			}
			return `${bytesPerSec.toFixed(1)} ${units[i]}`;
		};

		for (const name of devNames) {
			const stats = devices[name].statistics;
			const rx_bytes = stats.rx_bytes;
			const tx_bytes = stats.tx_bytes;
			let rx_rate = 0, tx_rate = 0;

			has_active = true;

			if (!is_first_run && last_stats[name]) {
				rx_rate = Math.max(0, (rx_bytes - last_stats[name].rx) / diff);
				tx_rate = Math.max(0, (tx_bytes - last_stats[name].tx) / diff);
			}

			last_stats[name] = { rx: rx_bytes, tx: tx_bytes };

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
