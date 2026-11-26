'use strict';

const AXES = {
    indicatorX: { base: 0, min: -100, max: 100 },
    indicatorY: { base: 286, min: 126, max: 366 },
    indicatorGap: { base: 362, min: 122, max: 482 },
};
const MOVES = { LEFT: ['indicatorX', -10], RIGHT: ['indicatorX', 10], UP: ['indicatorY', -10],
    DOWN: ['indicatorY', 10], NARROW: ['indicatorGap', -10], WIDEN: ['indicatorGap', 10] };
const CHOICES = { HR_ETA_POSITION: ['position', ['high', 'middle', 'low']], HR_BRIGHTNESS: ['brightness', ['dim', 'normal']] };
const LABELS = { left: 'Stânga', right: 'Dreapta', both: 'Avarii', off: 'Semnalizări inactive' };

function wireMenu({ app, ui, settings, background }) {
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
        const ind = !!settings.get('indicators'), eta = !!settings.get('eta');
        const s = background, view = s ? s.view() : { direction: 'off' };
        write('checked', 'HR_IND', ind);
        write('checked', 'HR_ETA', eta);
        write('text', 'HR_IND_STATUS', LABELS[view.direction] || LABELS.off);
        write('text', 'HR_POSITION', 'Poziție: X ' + get('indicatorX') + ', Y ' + get('indicatorY') + ' px · Distanță ' + get('indicatorGap') + ' px');
        write('text', 'HR_ETA_STATUS', !eta ? 'Estimare dezactivată' : !s || !s.state.awake ? 'Așteaptă starea READY' : view.eta || s.etaStatus());
        write('text', 'HR_ETA_DETAIL', s && s.state.awake ? s.state.etaDiagnostics() : 'Stare traseu CarPlay: —');
        write('text', 'HR_RENDERER', s && s.out.ready ? 'Renderer HUD conectat' : 'HUD în așteptare');
        for (const [name, [key, delta]] of Object.entries(MOVES)) {
            const next = get(key) + delta;
            write('enabled', 'HR_' + name, ind && next >= AXES[key].min && next <= AXES[key].max);
        }
        write('enabled', 'HR_RESET', ind && Object.keys(AXES).some(key => get(key) !== AXES[key].base));
        for (const [id, [key, values]] of Object.entries(CHOICES)) {
            write('selected', id, Math.max(0, values.indexOf(settings.get(key))));
        }
    }
    ui.onClick('HR_IND', () => set('indicators', !settings.get('indicators')));
    ui.onClick('HR_ETA', () => set('eta', !settings.get('eta')));
    for (const [name, [key, delta]] of Object.entries(MOVES)) {
        ui.onClick('HR_' + name, () => {
            const next = get(key) + delta;
            if (settings.get('indicators') && next >= AXES[key].min && next <= AXES[key].max) set(key, next);
        });
    }
    ui.onClick('HR_RESET', () => {
        if (settings.get('indicators')) Object.keys(AXES).forEach(key => set(key, AXES[key].base));
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
