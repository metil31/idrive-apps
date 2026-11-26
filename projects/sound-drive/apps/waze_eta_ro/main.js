'use strict';

const net = require('net');
const mgu = require('./kit/mgu');
const { conditionOf } = require('./kit/car');
const { Canvas } = require('./kit/canvas');
const { ClusterRender } = require('./cluster_render_client');

const SOCKET = '/run/waze-eta-reader/control.sock';
const WIDTH = 230, HEIGHT = 47;
const SIZE = [70, 80, 90, 100, 110, 120, 130];
const POSITION = { x: { base: 220, min: 150, max: 650 }, y: { base: 270, min: 40, max: 440 } };
const MOVE = { LEFT: ['x', -10], RIGHT: ['x', 10], UP: ['y', -10], DOWN: ['y', 10] };
const STATUS = {
    idle: 'Test oprit', ended: 'Testul a expirat', hidden: 'Așteaptă ecranul CarPlay',
    waiting: 'Așteaptă următoarea captură', 'no-eta': 'Bara ETA nu a fost citită',
    confirming: 'Confirmă valorile pe al doilea cadru', live: 'ETA citit din Waze',
    'capture-failed': 'Captură indisponibilă', 'capture-format': 'Format de captură necunoscut',
    'no-screen-event': 'iDrive nu a semnalat deschiderea CarPlay. Repornește testul.',
    unavailable: 'Serviciul de captură nu răspunde',
};

function request(command) {
    return new Promise((resolve, reject) => {
        let result = '';
        const socket = net.createConnection(SOCKET, () => socket.write(command + '\n'));
        socket.setTimeout(1500, () => socket.destroy(new Error('Timp expirat')));
        socket.on('error', reject);
        socket.on('data', (part) => {
            result += part.toString('utf8');
            if (result.length > 1024) socket.destroy(new Error('Răspuns prea mare'));
        });
        socket.on('end', () => {
            try { resolve(JSON.parse(result)); } catch (error) { reject(error); }
        });
    });
}

function position(settings, axis) {
    const value = settings.get(axis), range = POSITION[axis];
    return Number.isInteger(value) ? Math.max(range.min, Math.min(range.max, value)) : range.base;
}
function stepOf(settings) { return SIZE[settings.get('size')] ? settings.get('size') : 3; }
function etaLabel(eta) { return eta.arrival + '  ·  ' + eta.duration + '  ·  ' + eta.distance; }

function background({ app, settings, signals, log }) {
    let data = { code: 'idle' }, latest = 0, pending = false, ready = false, stopped = false, watch;
    let client, layer, drawn = '', layout = '';
    const canvas = new Canvas(WIDTH, HEIGHT);
    function closeHud() {
        if (client) client.close();
        client = layer = null;
        drawn = layout = '';
    }
    function draw() {
        const eta = data.eta;
        if (stopped || !settings.get('hud') || !ready || !eta || Date.now() - eta.at >= 120000) {
            closeHud(); return;
        }
        const scale = SIZE[stepOf(settings)] / 100, w = Math.round(WIDTH * scale), h = Math.round(HEIGHT * scale);
        const rect = { x: Math.round(position(settings, 'x') - w / 2),
            y: Math.round(position(settings, 'y') - h / 2), w, h };
        const key = JSON.stringify(rect);
        if (!client) {
            client = new ClusterRender('waze_eta_ro');
            client.on('ready', () => { drawn = ''; draw(); });
            client.connect();
        }
        if (!layer) {
            layer = client.image(Object.assign({ target: 'hud', klass: 'overlay',
                z: 12, iw: WIDTH, ih: HEIGHT, sampling: 'bilinear', fps: 2, contend: 0, yield: 1 }, rect));
            if (!layer) return;
            layout = key;
        } else if (layout !== key) { client.set(layer, rect); layout = key; }
        const title = data.remembered ? 'WAZE · MEMORAT' : 'WAZE · SOSIRE';
        const line = etaLabel(eta), next = title + line;
        if (next === drawn) return;
        canvas.clear().roundRect(1, 1, WIDTH - 2, HEIGHT - 2, 22, [27, 30, 35, 192]);
        canvas.text(title, WIDTH / 2, 15, 11, '#dce7f4', { align: 'center', font: 'label', literal: true });
        canvas.text(line, WIDTH / 2, 31, 17, '#ffffff', { align: 'center', font: 'bold', literal: true });
        if (client.pixels(layer, null, Buffer.from(canvas.d.buffer, canvas.d.byteOffset, canvas.d.byteLength))) drawn = next;
    }
    async function query(command) {
        if (command === 'get' && pending) return;
        const tag = ++latest;
        pending = true;
        let next;
        try { next = await request(command); } catch (error) {
            next = { code: 'unavailable', captureDetail: error.code === 'EACCES' ? 'Acces refuzat' :
                error.code === 'ENOENT' ? 'Cititorul nu este pornit' : '' };
        }
        if (stopped || tag !== latest) return;
        pending = false;
        data = next;
        draw();
    }
    signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
        VehicleCondition: (v) => { ready = conditionOf(v && v.statusConditionVehicle) === 10; draw(); },
    }, log).then((sub) => { if (stopped) sub.shutdown(); else watch = sub; }).catch(() => {});
    settings.onChange(draw);
    const timer = setInterval(() => {
        if (settings.get('hud') && ready) query('get');
        else draw();
    }, 1000);
    app.on('shutdown', () => {
        stopped = true;
        clearInterval(timer);
        closeHud();
        if (watch) watch.shutdown();
    });
    return { query, snapshot: () => data };
}

function start({ app, ui, settings, background }) {
    const slider = ui.comp('WE_SIZE'), shown = {};
    function show(id, value, update) {
        if (shown[id] === value) return;
        shown[id] = value;
        update(value);
    }
    function set(key, value) { if (settings.get(key) !== value) settings.set(key, value); }
    ui.onClick('WE_START', () => { if (background) background.query('start'); });
    ui.onClick('WE_STOP', () => { if (background) background.query('stop'); });
    ui.onClick('WE_HUD', () => set('hud', !settings.get('hud')));
    for (const direction of Object.keys(MOVE)) {
        const [axis, delta] = MOVE[direction];
        ui.onClick('WE_' + direction, () => {
            const p = position(settings, axis) + delta, range = POSITION[axis];
            if (p >= range.min && p <= range.max) set(axis, p);
        });
    }
    ui.onClick('WE_RESET', () => { set('x', POSITION.x.base); set('y', POSITION.y.base); });
    if (slider && slider.on) slider.on('changed', (step) => {
        if (SIZE[step]) { shown.step = step; set('size', step); }
    });

    function render() {
        if (!ui.isVisible('MAIN')) return;
        const data = background ? background.snapshot() : { code: 'unavailable' };
        const status = (STATUS[data.code] || STATUS.unavailable) + (data.captureDetail ? ' · ' + data.captureDetail : '');
        show('status', status, (v) => ui.text('WE_STATUS', v));
        const eta = data.eta, line = eta ? (data.remembered ? 'Memorat · ' : '') + etaLabel(eta) : 'Sosire · —';
        show('eta', line, (v) => ui.text('WE_ETA', v));
        show('enabled', !!settings.get('hud'), (v) => ui.checked('WE_HUD', v));
        show('pos', 'Poziție · ' + position(settings, 'x') + ', ' + position(settings, 'y') + ' px', (v) => ui.text('WE_POS', v));
        const step = stepOf(settings);
        show('size', SIZE[step], (v) => ui.cells('WE_SIZE', 0, { TextDescription: 'Mărime · ' + v + '%' }));
        show('step', step, (v) => {
            if (slider && slider.setStepValue) slider.setStepValue(v);
            else ui.cells('WE_SIZE', 0, { Value: v });
        });
    }
    function update() {
        if (ui.isVisible('MAIN') && background) background.query('get').then(render);
        else render();
    }
    ui.onVisible((name, visible) => { if (name === 'MAIN' && visible) update(); });
    settings.onChange(render);
    const timer = setInterval(update, 1000);
    app.on('shutdown', () => clearInterval(timer));
    update();
}

mgu.run({ background, start });
