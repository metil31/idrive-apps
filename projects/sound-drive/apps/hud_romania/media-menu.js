'use strict';

const { PLACEMENT, position } = require('./media-view');
const OUTPUTS = ['hud', 'cluster', 'both'];
const SECTIONS = { hud: 'MR_HUD', cluster: 'MR_CL' };
const MOVE = { LEFT: ['x', -10], RIGHT: ['x', 10], UP: ['y', -10], DOWN: ['y', 10] };

function wireMenu(ctx) {
    const { ui, settings, background, app, language, preview, renderDemo = () => {} } = ctx;
    const { t } = language;
    const shown = new Map();
    for (const [id, sample] of [['MR_HUD_DEMO', 'mediaHud'], ['MR_CL_DEMO', 'mediaCluster']]) {
        ui.onClick(id, () => { if (preview) preview.toggle(sample); render(); });
    }
    const parts = Object.keys(SECTIONS).map((target) => {
        const row = SECTIONS[target], config = PLACEMENT[target], sliderId = row + '_SIZE';
        const steps = settings.item(config.size).steps;
        return { target, row, config, steps, sliderId, slider: ui.comp(sliderId) };
    });
    const write = (key, value, apply) => {
        if (shown.has(key) && shown.get(key) === value) return;
        shown.set(key, value);
        apply(value);
    };
    const active = (part) => preview && preview.selected() === (part.target === 'hud' ? 'mediaHud' : 'mediaCluster') ||
        settings.get('enabled') && (settings.get('show') === 'both' || settings.get('show') === part.target);
    const set = (key, value) => { if (settings.get(key) !== value) settings.set(key, value); };
    const clear = () => { shown.clear(); };

    function render() {
        if (!ui.isVisible('HUD_MEDIA')) return;
        if (language.render('HUD_MEDIA')) clear();
        renderDemo('HUD_MEDIA', (method, id, value) => write(method + id, value, v => ui[method](id, v)));
        for (const [id, key] of [['MR_ENABLED', 'enabled'], ['MR_ART', 'albumArt']]) {
            write(id, !!settings.get(key), (value) => ui.checked(id, value));
        }
        write('show', Math.max(0, OUTPUTS.indexOf(settings.get('show'))), (value) => ui.selected('MR_SHOW', value));
        const track = background && background.track();
        write('status', background ? background.status(t) : t('Starting', 'Pornire aplicatie'), (value) => ui.text('MR_STATUS', value));
        write('track', track ? [track.title, track.artist].filter(Boolean).join(' · ').slice(0, 110) : t('Now playing: —', 'In redare: —'),
            (value) => ui.text('MR_TRACK', value));

        for (const part of parts) {
            const { row, config, sliderId, slider, steps } = part;
            const x = position(settings, config.x), y = position(settings, config.y), enabled = !!active(part);
            const size = Number(settings.get(config.size)) || 100;
            let step = 0;
            steps.forEach((value, index) => { if (Math.abs(value - size) < Math.abs(steps[step] - size)) step = index; });
            write(row + ':size', t('Size: ', 'Marime: ') + size + '%', (value) =>
                ui.cells(sliderId, 0, { TextDescription: value }));
            write(row + ':step', step, (value) => {
                if (slider && slider.setStepValue) slider.setStepValue(value);
                else ui.cells(sliderId, 0, { Value: value });
            });
            write(row + ':position', t('Position: X ', 'Pozitie: X ') + (x > 0 ? '+' : '') + x + ' px · Y ' + y + ' px',
                (value) => ui.text(row + '_POS', value));
            for (const direction of Object.keys(MOVE)) {
                const [name, delta] = MOVE[direction], axis = config[name];
                const at = (name === 'x' ? x : y) + delta, id = row + '_' + direction;
                write(id, enabled && at >= axis.min && at <= axis.max, (value) => ui.enabled(id, value));
            }
            write(sliderId, enabled, (value) => ui.enabled(sliderId, value));
            write(row + '_RESET', enabled && (x !== config.x.base || y !== config.y.base),
                (value) => ui.enabled(row + '_RESET', value));
        }
    }

    ui.onClick('MR_ENABLED', () => set('enabled', !settings.get('enabled')));
    ui.onClick('MR_ART', () => set('albumArt', !settings.get('albumArt')));
    ui.onClick('MR_SHOW', (event) => { if (OUTPUTS[event.row]) set('show', OUTPUTS[event.row]); });
    for (const part of parts) {
        const { row, config, slider, steps } = part;
        for (const direction of Object.keys(MOVE)) {
            const [name, delta] = MOVE[direction], axis = config[name];
            ui.onClick(row + '_' + direction, () => {
                const next = position(settings, axis) + delta;
                if (active(part) && next >= axis.min && next <= axis.max) set(axis.key, next);
            });
        }
        ui.onClick(row + '_RESET', () => {
            if (!active(part)) return;
            set(config.x.key, config.x.base);
            set(config.y.key, config.y.base);
        });
        if (slider && slider.on) slider.on('changed', (step) => {
            if (!active(part) || steps[step] === undefined) return;
            shown.set(row + ':step', step);
            set(config.size, steps[step]);
        });
    }
    let timer = null;
    function setVisible(visible) {
        if (timer !== null) { clearInterval(timer); timer = null; }
        if (visible) {
            clear();
            render();
            timer = setInterval(render, 1000);
            if (timer.unref) timer.unref();
        }
    }
    settings.onChange(render);
    ui.onVisible((name, visible) => { if (name === 'HUD_MEDIA') setVisible(visible); });
    if (app && app.on) app.on('shutdown', () => setVisible(false));
    setVisible(ui.isVisible('HUD_MEDIA'));
}

module.exports = { wireMenu };
