'use strict';

const AXES = {
    indicatorX: { base: 0, min: -100, max: 100 },
    indicatorY: { base: 286, min: 126, max: 366 },
    indicatorGap: { base: 362, min: 122, max: 482 },
};
const MOVES = { LEFT: ['indicatorX', -10], RIGHT: ['indicatorX', 10], UP: ['indicatorY', -10],
    DOWN: ['indicatorY', 10], NARROW: ['indicatorGap', -10], WIDEN: ['indicatorGap', 10] };
const CHOICES = { HR_ETA_POSITION: ['position', ['high', 'middle', 'low']], HR_BRIGHTNESS: ['brightness', ['dim', 'normal']] };
const LABELS = { left: ['Left', 'Stanga'], right: ['Right', 'Dreapta'], both: ['Hazards', 'Avarii'], off: ['Indicators inactive', 'Semnalizari inactive'] };

function wireMenu({ app, ui, settings, background, language, preview, renderDemo = () => {} }) {
    const { t } = language;
    const canAdjust = () => !!settings.get('indicators') || !!(preview && preview.selected() === 'indicators');
    ui.onClick('HR_IND_DEMO', () => { if (preview) preview.toggle('indicators'); render(); });
    ui.onClick('HR_ETA_DEMO', () => { if (preview) preview.toggle('eta'); render(); });
    const drawn = new Map();
    const get = (key) => {
        const { base, min, max } = AXES[key], value = settings.get(key);
        return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : base;
    };
    const set = (key, value) => { if (settings.get(key) !== value) settings.set(key, value); };
    const write = (method, id, value) => {
        const key = method + id;
        if (drawn.get(key) === value) return;
        drawn.set(key, value);
        ui[method](id, value);
    };
    const pages = ['MAIN', 'HUD_IND', 'HUD_ETA'];
    function selected(id) {
        const [key, values] = CHOICES[id];
        write('selected', id, Math.max(0, values.indexOf(settings.get(key))));
    }
    function render() {
        const s = background;
        if (ui.isVisible('MAIN')) {
            language.render('MAIN');
            selected('HR_BRIGHTNESS');
            write('text', 'HR_RENDERER', s && s.out.ready ? t('HUD renderer connected', 'Renderer HUD conectat') :
                t('Waiting for HUD', 'HUD in asteptare'));
        }
        if (ui.isVisible('HUD_IND')) {
            if (language.render('HUD_IND')) drawn.clear();
            const view = s ? s.view() : { direction: 'off' };
            write('checked', 'HR_IND', !!settings.get('indicators'));
            write('text', 'HR_IND_STATUS', t(...(LABELS[view.direction] || LABELS.off)));
            write('text', 'HR_POSITION', t('Position: X ', 'Pozitie: X ') + get('indicatorX') + ', Y ' +
                get('indicatorY') + t(' px · Gap ', ' px · Distanta ') + get('indicatorGap') + ' px');
            for (const [name, [key, delta]] of Object.entries(MOVES)) {
                const next = get(key) + delta;
                write('enabled', 'HR_' + name, canAdjust() && next >= AXES[key].min && next <= AXES[key].max);
            }
            write('enabled', 'HR_RESET', canAdjust() && Object.keys(AXES).some(key => get(key) !== AXES[key].base));
            renderDemo('HUD_IND', write);
        }
        if (ui.isVisible('HUD_ETA')) {
            if (language.render('HUD_ETA')) drawn.clear();
            const eta = !!settings.get('eta');
            write('checked', 'HR_ETA', eta);
            write('text', 'HR_ETA_STATUS', !eta ? t('ETA disabled', 'Estimare dezactivata') :
                !s || !s.state.awake ? t('Waiting for READY', 'Asteapta starea READY') : s.view().eta || s.etaStatus(t));
            write('text', 'HR_ETA_DETAIL', s && s.state.awake ? s.state.etaDiagnostics(t) : t('CarPlay route: —', 'Traseu CarPlay: —'));
            selected('HR_ETA_POSITION');
            renderDemo('HUD_ETA', write);
        }
    }
    ui.onClick('HR_IND', () => set('indicators', !settings.get('indicators')));
    ui.onClick('HR_ETA', () => set('eta', !settings.get('eta')));
    for (const [name, [key, delta]] of Object.entries(MOVES)) {
        ui.onClick('HR_' + name, () => {
            const next = get(key) + delta;
            if (canAdjust() && next >= AXES[key].min && next <= AXES[key].max) set(key, next);
        });
    }
    ui.onClick('HR_RESET', () => {
        if (canAdjust()) Object.keys(AXES).forEach(key => set(key, AXES[key].base));
    });
    for (const [id, [key, values]] of Object.entries(CHOICES)) {
        ui.onClick(id, ({ row }) => { if (values[row]) set(key, values[row]); });
    }
    let timer;
    function visible() {
        clearInterval(timer);
        if (!pages.some(page => ui.isVisible(page))) return;
        drawn.clear();
        render();
        timer = setInterval(render, 1000);
    }
    settings.onChange(render);
    ui.onVisible(name => { if (pages.includes(name)) visible(); });
    app.on('shutdown', () => clearInterval(timer));
    visible();
}

module.exports = { wireMenu };
