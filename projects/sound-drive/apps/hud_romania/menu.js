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

function wireMenu({ app, ui, settings, background, language, preview }) {
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
    function render() {
        if (!ui.isVisible('MAIN')) return;
        if (language.render()) drawn.clear();
        const ind = !!settings.get('indicators'), eta = !!settings.get('eta');
        const s = background, view = s ? s.view() : { direction: 'off' };
        write('checked', 'HR_IND', ind);
        write('checked', 'HR_ETA', eta);
        write('text', 'HR_IND_STATUS', t(...(LABELS[view.direction] || LABELS.off)));
        write('text', 'HR_POSITION', t('Position: X ', 'Pozitie: X ') + get('indicatorX') + ', Y ' + get('indicatorY') + t(' px · Gap ', ' px · Distanta ') + get('indicatorGap') + ' px');
        write('text', 'HR_ETA_STATUS', !eta ? t('ETA disabled', 'Estimare dezactivata') : !s || !s.state.awake ? t('Waiting for READY', 'Asteapta starea READY') : view.eta || s.etaStatus(t));
        write('text', 'HR_ETA_DETAIL', s && s.state.awake ? s.state.etaDiagnostics(t) : t('CarPlay route: —', 'Traseu CarPlay: —'));
        write('text', 'HR_RENDERER', s && s.out.ready ? t('HUD renderer connected', 'Renderer HUD conectat') : t('Waiting for HUD', 'HUD in asteptare'));
        write('enabled', 'HR_DEMO_STOP', !!(preview && preview.selected()));
        write('text', 'HR_DEMO_STATUS', preview && preview.current() ? t('Demo active', 'Demo activ') :
            t('Demo requires READY and standstill', 'Demo disponibil in READY cu masina oprita'));
        for (const [name, [key, delta]] of Object.entries(MOVES)) {
            const next = get(key) + delta;
            write('enabled', 'HR_' + name, canAdjust() && next >= AXES[key].min && next <= AXES[key].max);
        }
        write('enabled', 'HR_RESET', canAdjust() && Object.keys(AXES).some(key => get(key) !== AXES[key].base));
        for (const [id, [key, values]] of Object.entries(CHOICES)) {
            write('selected', id, Math.max(0, values.indexOf(settings.get(key))));
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
    function visible(open) {
        clearInterval(timer);
        if (!open) return;
        drawn.clear();
        render();
        timer = setInterval(render, 1000);
    }
    settings.onChange(render);
    ui.onVisible((name, open) => { if (name === 'MAIN') visible(open); });
    app.on('shutdown', () => visible(false));
    visible(ui.isVisible('MAIN'));
}

module.exports = { wireMenu };
