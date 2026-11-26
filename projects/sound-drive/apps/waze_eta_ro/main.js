'use strict';

const net = require('net');
const mgu = require('./kit/mgu');
const { conditionOf } = require('./kit/car');
const { Canvas, ScaledCanvas } = require('./kit/canvas');
const { ClusterRender } = require('./cluster_render_client');
const { MAP, hostArea, mapDisplays } = require('./map-area');

const SOCKET = '/run/waze-eta-reader/control.sock';
const SIZE = [70, 80, 90, 100, 110, 120, 130];
const HUD = { x: 0, y: 0, w: 800, h: 480 };
const PARTS = [
    { row: 'WE', enabled: 'hud', keys: ['x', 'y', 'size'], base: [220, 270], target: 'hud', w: 230, h: 46 },
    { row: 'WE_CL', enabled: 'cluster', keys: ['clusterX', 'clusterY', 'clusterSize'], base: [544, 425], target: 'map', w: 270, h: 48 },
    { row: 'WE_TH', enabled: 'turnHud', keys: ['turnHudX', 'turnHudY', 'turnHudSize'], base: [415, 185], target: 'hud', w: 118, h: 44, turn: true },
    { row: 'WE_TC', enabled: 'turnCluster', keys: ['turnClusterX', 'turnClusterY', 'turnClusterSize'], base: [544, 120], target: 'map', w: 138, h: 48, turn: true },
];
const MOVES = { LEFT: [0, -10], RIGHT: [0, 10], UP: [1, -10], DOWN: [1, 10] };
const STATUS = {
    idle: 'Așteaptă pornirea cititorului', hidden: 'Așteaptă ecranul CarPlay',
    waiting: 'Așteaptă următoarea captură', 'no-eta': 'Bara ETA nu a fost citită',
    confirming: 'Verifică valoarea pe următorul cadru', live: 'ETA citit din Waze',
    'capture-failed': 'Captură indisponibilă', 'capture-format': 'Format de captură necunoscut',
    'no-screen-event': 'Așteaptă un traseu activ în CarPlay', unavailable: 'Cititorul nu răspunde',
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

function stepOf(settings, part) {
    const step = settings.get(part.keys[2]);
    return Number.isInteger(step) && SIZE[step] ? step : 3;
}

function bounds(settings, part, axis) {
    if (part.row === 'WE') return axis === 0 ? [150, 650] : [40, 440];
    const area = part.target === 'hud' ? HUD : MAP;
    const extent = axis === 0 ? area.w : area.h, size = axis === 0 ? part.w : part.h;
    const margin = Math.ceil(size * SIZE[stepOf(settings, part)] / 200);
    return [margin, extent - margin];
}

function position(settings, part, axis) {
    const value = settings.get(part.keys[axis]), [min, max] = bounds(settings, part, axis);
    return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : part.base[axis];
}

function placement(settings, part, area, hosted) {
    let cx = position(settings, part, 0), cy = position(settings, part, 1);
    let scale = SIZE[stepOf(settings, part)] / 100;
    if (hosted) {
        const sx = area.w / area.sw, sy = area.h / area.sh;
        cx = area.x + (cx - area.sx) * sx;
        cy = area.y + (cy - area.sy) * sy;
        scale *= Math.min(sx, sy);
    }
    scale = Math.min(scale, area.w / part.w, area.h / part.h);
    const w = Math.round(part.w * scale), h = Math.round(part.h * scale);
    if (h < 16) return null;
    return { x: Math.max(area.x, Math.min(area.x + area.w - w, Math.round(cx - w / 2))),
        y: Math.max(area.y, Math.min(area.y + area.h - h, Math.round(cy - h / 2))), w, h };
}

function etaLabel(eta) { return eta.arrival + '  ·  ' + eta.duration + '  ·  ' + eta.distance; }

function pill(part, value) {
    const { w, h } = part, highRes = part.target === 'map';
    const cv = highRes ? new ScaledCanvas(w, h, 2) : new Canvas(w, h);
    cv.clear();
    cv.roundRect(1, 1, w - 2, h - 2, (h - 2) / 2, [24, 27, 31, 207]);
    if (part.turn && value.kind === 'roundabout') {
        const x = 32, y = h / 2;
        cv.arc(x, y, 10, 13, 0, 360, '#7a8188');
        cv.arc(x, y, 10, 13, 8, 156, '#ffffff');
        cv.arc(x, y, 10, 13, 182, 315, '#ffffff');
        cv.text(String(value.exit), x, y + 5, 15, '#ffffff', { align: 'center', font: 'bold', literal: true });
    } else if (part.turn) {
        const x = n => value.kind === 'right' ? 23 + n : 23 + 25 - n;
        const y = h / 2 - 13;
        cv.polyline([[x(0), y + 24], [x(0), y + 15], [x(3), y + 9], [x(9), y + 5], [x(23), y + 5]], 4, '#ffffff');
        cv.polyline([[x(17), y], [x(23), y + 5], [x(17), y + 10]], 4, '#ffffff');
    }
    const text = part.turn ? value.distance : etaLabel(value), offset = part.turn ? 43 : 0;
    const style = { align: 'center', font: 'bold', literal: true };
    const measured = cv.textWidth(text, 18, style);
    const size = Math.min(18, 18 * (w - offset - 18) / Math.max(1, measured));
    cv.text(text, (w + offset) / 2, h / 2 + size * 0.34, size, '#ffffff', style);
    const pixels = highRes ? cv.canvas.d : cv.d;
    return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

function background({ app, settings, signals, log }) {
    let data = { code: 'idle' }, pending = false, ready = false, stopped = false, watch, leased = false;
    let client, connected = false, host, maps, lastStatus = 0, asked = null;
    const layers = new Map();
    const want = () => ready && PARTS.some(part => settings.get(part.enabled));
    const drop = (part) => {
        const layer = layers.get(part);
        if (layer) { client.drop(layer.ref); layers.delete(part); }
    };
    function close() {
        const old = client;
        client = null; connected = false; maps = host = null; asked = null;
        layers.clear();
        if (old) old.close();
    }
    function draw() {
        const now = Date.now();
        const fresh = (value, ttl) => value && now >= value.at && now - value.at < ttl ? value : null;
        const eta = fresh(data.eta, 120000), turn = fresh(data.turn, 10000);
        const enabled = stopped || !ready ? [] : PARTS.filter(part => settings.get(part.enabled) && (part.turn ? turn : eta));
        if (!enabled.length) { close(); return; }
        if (!client) {
            const active = client = new ClusterRender('waze_eta_ro');
            active.on('ready', () => { if (client === active) { connected = true; asked = null; draw(); } });
            active.on('disconnected', () => {
                if (client !== active) return;
                connected = false; maps = host = null;
                PARTS.filter(part => part.target === 'map').forEach(drop);
            });
            active.on('host', (target, event) => {
                if (client !== active || target !== 'map') return;
                host = hostArea(event, active.targets); maps = null; asked = null; draw();
            });
            active.on('target', (target, state) => {
                if (client !== active || target !== 'map' && target !== 'panel') return;
                if (maps && state !== 'shown') maps[target] = false;
                asked = null; draw();
            });
            active.on('status', (text) => {
                if (client !== active) return;
                maps = mapDisplays(text); lastStatus = Date.now(); draw();
            });
            active.connect();
        }
        if (!connected) return;
        if (now - lastStatus > 7000) maps = null;
        if (enabled.some(part => part.target === 'map') && (asked === null || now - asked >= 3000)) {
            asked = now;
            client.status();
        }
        for (const part of PARTS) {
            const hosted = part.target === 'map' && maps && maps.panel && host;
            const target = hosted ? 'panel' : part.target;
            const area = target === 'hud' ? HUD : hosted || (maps && maps.map && MAP);
            const rect = enabled.includes(part) && area && placement(settings, part, area, !!hosted);
            let layer = layers.get(part);
            if (!rect || layer && layer.target !== target) { drop(part); layer = null; }
            if (!rect) continue;
            const shape = JSON.stringify(rect);
            if (!layer) {
                const scale = part.target === 'map' ? 2 : 1;
                const ref = client.image(Object.assign({ target, klass: 'overlay', z: part.turn ? 13 : 12,
                    iw: part.w * scale, ih: part.h * scale, sampling: 'bilinear', fps: 2, contend: 0, yield: 1 }, rect));
                if (!ref) continue;
                layers.set(part, layer = { ref, target, shape });
            } else if (shape !== layer.shape) { client.set(layer.ref, rect); layer.shape = shape; }
            const value = part.turn ? turn : eta;
            const key = part.turn ? [value.kind, value.exit, value.distance].join(':') : etaLabel(value);
            if (layer.key !== key && client.pixels(layer.ref, null, pill(part, value))) layer.key = key;
        }
    }
    async function refresh() {
        if (stopped || pending || !want() && !leased) return;
        pending = true;
        const reading = want();
        try {
            data = await request(reading ? 'start' : 'stop');
            leased = reading;
        } catch (error) {
            data = { code: 'unavailable', captureDetail: error.code === 'EACCES' ? 'Acces refuzat' :
                error.code === 'ENOENT' ? 'Cititorul nu este pornit' : '' };
        } finally { pending = false; }
        if (stopped) { if (leased) request('stop').catch(() => {}); return; }
        draw();
        if (reading !== want()) refresh();
    }
    const tick = () => { draw(); refresh(); };
    signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
        VehicleCondition: (v) => { ready = conditionOf(v && v.statusConditionVehicle) === 10; tick(); },
    }, log).then((sub) => { if (stopped) sub.shutdown(); else watch = sub; }).catch(() => {});
    settings.onChange(tick);
    const timer = setInterval(tick, 1000);
    app.on('shutdown', () => {
        stopped = true;
        clearInterval(timer); close();
        if (!pending && leased) request('stop').catch(() => {});
        if (watch) watch.shutdown();
    });
    return { refresh, snapshot: () => ({ data, ready, clusterVisible: PARTS.some(part => part.target === 'map' && layers.has(part)) }) };
}

function start({ app, ui, settings, background }) {
    const shown = new Map();
    const set = (key, value) => { if (settings.get(key) !== value) settings.set(key, value); };
    function show(method, id, value) {
        const key = method + id;
        if (shown.get(key) === value) return;
        shown.set(key, value); ui[method](id, value);
    }
    const sections = PARTS.map(part => ({ part, slider: ui.comp(part.row + '_SIZE') }));
    for (const { part, slider } of sections) {
        const { row, enabled, keys, base } = part;
        ui.onClick(row + '_ON', () => set(enabled, !settings.get(enabled)));
        for (const [direction, [axis, delta]] of Object.entries(MOVES)) {
            ui.onClick(row + '_' + direction, () => {
                const [min, max] = bounds(settings, part, axis), next = position(settings, part, axis) + delta;
                if (settings.get(enabled) && next >= min && next <= max) set(keys[axis], next);
            });
        }
        ui.onClick(row + '_RESET', () => { if (settings.get(enabled)) { set(keys[0], base[0]); set(keys[1], base[1]); } });
        if (slider && slider.on) slider.on('changed', step => { if (settings.get(enabled) && SIZE[step]) set(keys[2], step); });
    }
    function render() {
        if (!ui.isVisible('MAIN')) return;
        const state = background ? background.snapshot() : { data: {}, ready: false };
        const { data } = state;
        const any = PARTS.some(part => settings.get(part.enabled));
        const status = !any ? 'Afișare dezactivată' : !state.ready ? 'Așteaptă starea READY' :
            (STATUS[data.code] || STATUS.idle) + (data.captureDetail ? ' · ' + data.captureDetail : '');
        show('text', 'WE_STATUS', status);
        show('text', 'WE_ETA', data.eta ? etaLabel(data.eta) : 'Sosire estimată · —');
        show('text', 'WE_MAP_STATUS', state.clusterVisible ? 'Afișaj Waze pe hartă' : 'Așteaptă harta și datele de traseu');
        for (const { part, slider } of sections) {
            const { row } = part, enabled = !!settings.get(part.enabled), step = stepOf(settings, part);
            show('checked', row + '_ON', enabled);
            show('text', row + '_POS', 'Poziție · ' + position(settings, part, 0) + ', ' + position(settings, part, 1) + ' px');
            for (const [direction, [axis, delta]] of Object.entries(MOVES)) {
                const [min, max] = bounds(settings, part, axis), next = position(settings, part, axis) + delta;
                show('enabled', row + '_' + direction, enabled && next >= min && next <= max);
            }
            show('enabled', row + '_SIZE', enabled);
            show('enabled', row + '_RESET', enabled);
            if (shown.get(row + ':step') !== step) {
                shown.set(row + ':step', step);
                ui.cells(row + '_SIZE', 0, { TextDescription: 'Mărime · ' + SIZE[step] + '%' });
                if (slider && slider.setStepValue) slider.setStepValue(step);
                else ui.cells(row + '_SIZE', 0, { Value: step });
            }
        }
    }
    let timer;
    function visible(open) {
        clearInterval(timer);
        if (open) { shown.clear(); render(); timer = setInterval(render, 1000); }
    }
    ui.onVisible((name, open) => { if (name === 'MAIN') visible(open); });
    settings.onChange(render);
    app.on('shutdown', () => visible(false));
    visible(ui.isVisible('MAIN'));
}

mgu.run({ background, start });
