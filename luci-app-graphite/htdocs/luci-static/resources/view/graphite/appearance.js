'use strict';
'require view';
'require form';
'require uci';
'require ui';

/* Appearance settings for luci-theme-graphite.
 *
 * The theme is achromatic by default and says so in its design language:
 * grey carries hierarchy, hue carries state. That is a position, not an
 * oversight, and a product other people deploy should not have it imposed —
 * so the negative becomes a default plus a constrained switch.
 *
 * There was a free accent-hue picker here, constrained so that lightness and
 * chroma stayed fixed and no choice could fail contrast. It was removed: the
 * constraint delivered legibility, and legibility turned out not to be the
 * problem. An arbitrary hue dropped into a grey system is readable and still
 * looks wrong, because what makes the palettes below work is that every one
 * of their values was chosen against the others.
 *
 * What is left is a choice between whole palettes and a small neutral tint —
 * both are sets of values someone designed together.
 */

/* sRGB hex to an OKLCH hue angle. The lightness and chroma the code carries
 * are read and thrown away on purpose — see the note at the top. */
function hexToHue(hex) {
	const m = String(hex).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);

	if (!m)
		return null;

	let h = m[1];

	if (h.length === 3)
		h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];

	const srgb = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255);
	const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
	const [r, g, b] = lin;

	/* sRGB-linear to OKLab, the standard matrices. */
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m2 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

	const oa = 1.9779984951 * l - 2.4285922050 * m2 + 0.4505937099 * s;
	const ob = 0.0259040371 * l + 0.7827717662 * m2 - 0.8086757660 * s;

	/* A grey has no hue to take. Treating it as 0 would silently mean red. */
	if (Math.hypot(oa, ob) < 0.002)
		return null;

	const deg = Math.atan2(ob, oa) * 180 / Math.PI;

	return String(Math.round((deg + 360) % 360));
}

return view.extend({
	load() {
		return uci.load('graphite');
	},

	render() {
		const m = new form.Map('graphite', _('Appearance'),
			_('Settings for the Graphite theme. They apply to every browser that opens this device; a reader can still override light and dark for their own browser from the bar at the top of the page.'));

		const s = m.section(form.NamedSection, 'appearance', 'appearance');
		s.anonymous = true;

		const pal = s.option(form.ListValue, 'palette', _('Palette'),
			_('Which surface colours the interface uses. Ports are named for their dark flavour; the light side is Latte for Catppuccin and Day for Tokyo Night.'));
		/* Upstream's own flavour and style names. Renaming them into something
		 * tidier would make it impossible to check a rendering against the
		 * project that published the colours. */
		pal.value('', _('Graphite'));
		pal.value('catppuccin-frappe', 'Catppuccin Frappé (Latte / Frappé)');
		pal.value('catppuccin-macchiato', 'Catppuccin Macchiato (Latte / Macchiato)');
		pal.value('catppuccin-mocha', 'Catppuccin Mocha (Latte / Mocha)');
		pal.value('tokyonight-storm', 'Tokyo Night Storm (Day / Storm)');
		pal.value('tokyonight-night', 'Tokyo Night (Day / Night)');
		pal.default = '';

		/* The accent paints the primary button, the focus ring and the active
		 * badge — nothing else. Black is the default and is not a placeholder:
		 * an achromatic primary is what the design language argues for, and
		 * these four elements are where a hue can carry "this is the main
		 * action" without becoming decoration.
		 *
		 * A fixed list rather than the free hue picker that used to be here
		 * (see the note at the top of this file). The objection to that one
		 * was not legibility but that an arbitrary hue looks wrong in a grey
		 * system; a short list of values chosen against the greys is the part
		 * of the idea that survives. The palettes below ship their own
		 * colours, and an accent set here overrides them. */
		const accent = s.option(form.ListValue, 'accent', _('Accent colour'),
			_('The colour of the primary button, the focus ring, the active badge and the sidebar mark. Every palette answers the same eight names in its own values, so the accent belongs to the set around it.'));
		accent.value('', _('None (default)'));
		accent.value('pink', _('Pink'));
		accent.value('mauve', _('Mauve'));
		accent.value('red', _('Red'));
		accent.value('peach', _('Peach'));
		accent.value('yellow', _('Yellow'));
		accent.value('green', _('Green'));
		accent.value('teal', _('Teal'));
		accent.value('blue', _('Blue'));
		accent.default = '';

		/* A hand-written colour, and it wins over the list above. The readable
		 * foreground is derived from its lightness in CSS rather than asked
		 * for here, so there is one field and not two. */
		const accentCustom = s.option(form.Value, 'accent_custom', _('Custom accent colour'),
			_('A colour code such as #2f6feb. It wins over the choice above, under any palette. Leave empty to use that choice. Only six hex digits are accepted.'));
		accentCustom.placeholder = '#000000';
		accentCustom.validate = function (section_id, value) {
			if (value === '' || value == null)
				return true;

			return /^#?[0-9a-fA-F]{6}$/.test(value)
				? true
				: _('Six hex digits, for example #2f6feb.');
		};

		/* What the sidebar and the login page put beside the mark. The theme's
		 * own name is the default because a hostname makes a weak wordmark:
		 * lowercase, often abbreviated, different on every device. The
		 * hostname stays on offer because on a desk with four routers it
		 * answers the question the interface is worst at — which box is this
		 * tab pointed at. */
		const brand = s.option(form.ListValue, 'brand', _('Brand name'),
			_('What appears beside the mark in the sidebar and on the login page. With the theme name shown, the hostname moves to the nameplate under the login form.'));
		brand.value('', _('Theme name (Graphite)'));
		brand.value('hostname', _('Device hostname'));
		brand.default = '';

		const tintH = s.option(form.Value, 'tint_hue', _('Grey tint hue'),
			_('Biases every grey surface towards one hue. A colour code or a hue angle. Leave empty for neutral grey.'));
		tintH.placeholder = '0';
		/* Without this the field takes anything, the normalisation below turns
		   what it cannot read into an empty string, and the page reports a
		   successful save of a value that was silently discarded. A grey
		   colour code lands here too — it has no hue to take, and saying so is
		   more use than quietly clearing the field. */
		tintH.validate = function (section_id, value) {
			if (value == null || value === '')
				return true;

			if (/^[0-9]{1,3}$/.test(value))
				return (+value <= 360) || _('A hue angle runs from 0 to 360.');

			if (!/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value))
				return _('Enter a hue angle from 0 to 360, or a colour code such as #3b82f6.');

			return (hexToHue(value) !== null) || _('That colour is a grey, so it has no hue to take. Leave the field empty for neutral grey.');
		};

		const tintC = s.option(form.Value, 'tint_chroma', _('Grey tint strength'),
			_('How far the greys move towards that hue. 0 is neutral. Above 0.01 they stop reading as grey and start competing with the status colours, so that is the ceiling.'));
		tintC.datatype = 'range(0,0.01)';
		tintC.placeholder = '0';

		/* Normalisation only. The tint field accepts a colour code and the
		 * template reads an angle, so the conversion happens once here rather
		 * than making the template do colour maths on every page load. */
		m.save = function (...args) {
			return form.Map.prototype.save.apply(this, args).then(() => {
				const cfg = uci.get('graphite', 'appearance') ?? {};
				const tint = cfg.tint_hue ?? '';

				if (tint && !/^[0-9]{1,3}$/.test(tint))
					uci.set('graphite', 'appearance', 'tint_hue', hexToHue(tint) ?? '');

				return uci.save();
			});
		};

		this.map = m;

		return m.render();
	},

	/* The theme reads these values server-side and writes them into the
	 * document head, so a saved change is not visible until the page is built
	 * again. Reloading is the difference between "it works" and "nothing
	 * happened" — but it belongs here, after the save handler has resolved,
	 * and not on a timer inside save(). On a slow device that timer fired
	 * while ui.changes.apply() was still waiting for its confirmation and
	 * took the apply flow down with the page.
	 *
	 * Save & Apply needs nothing added: that flow reloads the page itself once
	 * the device has confirmed the change. */
	handleSave(ev) {
		return view.prototype.handleSave.call(this, ev).then(() => this.reloadForTheme());
	},

	/* Save & Apply must not come through this view's handleSave, and calling
	 * the base handleSaveApply is not enough to avoid it — the base is
	 *
	 *     handleSaveApply(ev, mode) {
	 *         return this.handleSave(ev).then(() => ui.changes.apply(…));
	 *     }
	 *
	 * so it dispatches back through the override and picks the reload timer up
	 * again. The apply path therefore repeats the base's two steps itself,
	 * against the base save. Apply reloads the page on its own once the device
	 * has confirmed the change; the only path that needs help is plain Save,
	 * because a theme rendered server-side does not change until the page is
	 * built again. */
	handleSaveApply(ev, mode) {
		return view.prototype.handleSave.call(this, ev)
			.then(() => ui.changes.apply(mode == '0'));
	},

	reloadForTheme() {
		ui.addNotification(null, E('p', _('Appearance saved. Reloading to apply it…')), 'info');
		window.setTimeout(() => location.reload(), 700);
	},
});
