'use strict';
/* Loads the app's LuCI class modules (resources/vantage/*.js) in Node.
   LuCI evaluates a module body as a function whose parameters are the
   names from its 'require X [as Y]' lines; baseclass.extend() is replaced
   by returning the prototype object, which is what the view calls
   methods on after L.require() instantiated it. */
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, '..', 'luci-app-vantage', 'htdocs', 'luci-static', 'resources');

/* LuCI globals the modules use */
global._ = s => s;
global.N_ = (n, singular, plural) => n === 1 ? singular : plural;
if (!String.prototype.format) {
	Object.defineProperty(String.prototype, 'format', {
		value: function() {
			let i = 0;
			const args = arguments;
			return this.replace(/%(%|s|d|\.?\d*f)/g, (m, k) => {
				if (k === '%') return '%';
				const v = args[i++];
				if (k === 's') return String(v);
				if (k === 'd') return String(Math.trunc(+v));
				const p = /\.(\d+)f/.exec(k);
				return (+v).toFixed(p ? +p[1] : 6);
			});
		}
	});
}

const cache = new Map();
const baseclass = { extend: proto => proto };

function load(name) {
	if (name === 'baseclass') return baseclass;
	if (cache.has(name)) return cache.get(name);
	const src = fs.readFileSync(path.join(RES, name.replace(/\./g, '/') + '.js'), 'utf8');
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(load(m[1]));
	}
	const mod = new Function(...params, src)(...values);
	cache.set(name, mod);
	return mod;
}

module.exports = { load, RES };
