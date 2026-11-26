'use strict';

const net = require('net');
const mgu = require('./kit/mgu');
const { conditionOf } = require('./kit/car');
const { ScaledCanvas } = require('./kit/canvas');
const { ClusterRender } = require('./cluster_render_client');
const { MAP, hostArea, mapDisplays } = require('./map-area');
const { displayPreview } = require('./kit/display-preview');
const { menuLanguage } = require('./kit/menu-language');

const SOCKET = '/run/waze-eta-reader/control.sock';
const TEXTURE_SCALE = 3;
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
    idle: ['Waiting for reader', 'Asteapta cititorul'], hidden: ['Waiting for CarPlay', 'Asteapta ecranul CarPlay'],
    waiting: ['Waiting for the next frame', 'Asteapta urmatorul cadru'],
    'no-eta': ['ETA bar could not be read', 'Bara ETA nu a putut fi citita'],
    confirming: ['Confirming ETA', 'Confirma valoarea ETA'], live: ['ETA read from Waze', 'ETA citit din Waze'],
    'capture-failed': ['Capture unavailable', 'Captura indisponibila'],
    'capture-format': ['Unknown capture format', 'Format de captura necunoscut'],
    'no-screen-event': ['Waiting for CarPlay navigation', 'Asteapta un traseu CarPlay'],
    unavailable: ['Reader unavailable', 'Cititor indisponibil'],
};
const DETAILS = {
    'capture-timeout': ['Capture timed out', 'Timp expirat la captura'],
    'missing-capture-tool': ['Capture tool missing', 'Utilitarul de captura lipseste'],
    'no-frame': ['No frame captured', 'Captura nu a produs un cadru'],
    'unreadable-frame': ['Frame unreadable', 'Cadrul nu a putut fi citit'],
    'access-denied': ['Access denied', 'Acces refuzat'],
    'capture-start-failed': ['Capture could not start', 'Captura nu a putut porni'],
    'reader-off': ['Reader is not running', 'Cititorul nu este pornit'],
};
const DEMO_ETA = { arrival: '16:28', duration: '12 min', distance: '6 km', demo: true };
const DEMO_TURNS = [
    { kind: 'right', distance: '530 m', demo: true },
    { kind: 'left', distance: '70 m', demo: true },
    { kind: 'roundabout', exit: 2, distance: '100 m', demo: true },
    { kind: 'lanes', distance: '700 m', demo: true, lanes: [
        { kind: 'straight', active: true }, { kind: 'straight', active: true }, { kind: 'right', active: false },
    ] },
    { kind: 'fork-left', distance: '250 m', demo: true },
    { kind: 'fork-right', distance: '250 m', demo: true },
];

function request(command) {
    return new Promise((resolve, reject) => {
        let result = '';
        const socket = net.createConnection(SOCKET, () => socket.write(command + '\n'));
        socket.setTimeout(1500, () => socket.destroy(new Error('Request timed out')));
        socket.on('error', reject);
        socket.on('data', (part) => {
            result += part.toString('utf8');
            if (result.length > 1024) socket.destroy(new Error('Response too large'));
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

function drawFork(cv, x, y, left) {
    const dir = left ? -1 : 1;
    cv.polyline([[x, y + 3], [x - 8 * dir, y - 5], [x - 8 * dir, y - 13]], 3, '#838a93');
    cv.polyline([[x, y + 13], [x, y + 3], [x + 9 * dir, y - 10]], 4, '#ffffff');
    cv.polyline([[x + 2 * dir, y - 9], [x + 10 * dir, y - 11], [x + 11 * dir, y - 3]], 3, '#ffffff');
}

function drawLanes(cv, lanes, cx, y, width) {
    const step = Math.min(16, width / lanes.length);
    const first = cx - step * (lanes.length - 1) / 2;
    lanes.forEach((lane, index) => {
        const x = first + step * index, stem = lane.active ? '#ffffff' : '#838a93';
        const split = lane.kind.startsWith('straight-');
        if (lane.kind === 'straight' || split) {
            cv.polyline([[x, y + 9], [x, y - 3], [x - 2.5, y]], 1.6, stem);
            cv.polyline([[x, y - 3], [x + 2.5, y]], 1.6, stem);
        }
        if (lane.kind !== 'straight') {
            const dir = lane.kind.endsWith('left') ? -1 : 1;
            const color = (split ? lane.branch : lane.active) ? '#ffffff' : '#838a93';
            const end = x + dir * Math.min(4, step * 0.34);
            cv.polyline([[x, y + 9], [x, y + 5], [end, y + 1]], 1.6, color);
            cv.polyline([[end - dir * 3, y + 1], [end, y + 1], [end, y + 4]], 1.6, color);
        }
    });
}

function drawOverlay(part, value) {
    const { w, h } = part;
    const cv = new ScaledCanvas(w, h, TEXTURE_SCALE);
    cv.clear();
    const lanes = value.lanes;
    const text = part.turn ? (value.demo ? 'Demo ' : '') + value.distance : (value.demo ? 'Demo  ' : '') + etaLabel(value);
    const style = { align: 'center', font: 'bold', literal: true };
    const padding = 9, iconWidth = 28, leading = part.turn && value.kind !== 'lanes' ? iconWidth + 8 : 0;
    const maxTextWidth = w - 2 * padding - leading - 2;
    const baseSize = 18;
    const size = Math.min(baseSize, baseSize * maxTextWidth / Math.max(1, cv.textWidth(text, baseSize, style)));
    const bodyWidth = Math.min(maxTextWidth, Math.max(lanes ? lanes.length * 10 : 0, Math.ceil(cv.textWidth(text, size, style))));
    const cardWidth = 2 * padding + leading + bodyWidth;
    // Keep the layer and its anchor stable as the numbers change.
    const left = (w - cardWidth) / 2, y = h / 2;
    const iconCenter = left + padding + iconWidth / 2;
    const textCenter = left + padding + leading + bodyWidth / 2;
    cv.roundRect(left, 1, cardWidth, h - 2, 7, [24, 27, 31, 207]);
    if (part.turn && value.kind.startsWith('fork-')) {
        drawFork(cv, iconCenter, y, value.kind === 'fork-left');
    } else if (part.turn && value.kind === 'roundabout') {
        const x = iconCenter;
        cv.arc(x, y, 10, 13, 0, 360, '#7a8188');
        cv.arc(x, y, 9, 13, 20, 284, '#ffffff');
        cv.polyline([[x - 10, y + 6], [x - 10, y + 15]], 4, '#ffffff');
        cv.text(String(value.exit), x, y + 5, 15, '#ffffff', { align: 'center', font: 'bold', literal: true });
    } else if (part.turn && value.kind !== 'lanes') {
        const x = n => iconCenter + (value.kind === 'right' ? n - 12 : 12 - n);
        const top = y - 13;
        cv.polyline([[x(0), top + 24], [x(0), top + 15], [x(3), top + 9], [x(9), top + 5], [x(23), top + 5]], 4, '#ffffff');
        cv.polyline([[x(17), top], [x(23), top + 5], [x(17), top + 10]], 4, '#ffffff');
    }
    cv.text(text, textCenter, lanes ? y - 2 : y + size * 0.34, size, '#ffffff', style);
    if (lanes) drawLanes(cv, lanes, textCenter, y + 6, bodyWidth);
    const pixels = cv.canvas.d;
    return Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

function background({ app, settings, signals, log }) {
    let data = { code: 'idle' }, pending = false, ready = false, stopped = false, watch, leased = false;
    let client, connected = false, host, maps, lastStatus = 0, asked = null;
    const layers = new Map();
    const preview = displayPreview(signals, log, () => ready && !stopped, draw);
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
        const eta = fresh(data.eta, 120000), turn = fresh(data.turn, 9500);
        const sample = preview.current();
        const values = new Map();
        if (!stopped && ready) for (const part of PARTS) {
            const value = sample && sample.part === part ? sample.value : settings.get(part.enabled) && (part.turn ? turn : eta);
            if (value) values.set(part, value);
        }
        if (!values.size) { close(); return; }
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
                const next = hostArea(event, active.targets);
                if (JSON.stringify(next) === JSON.stringify(host || null)) return;
                if (maps) maps.panel = false;
                host = next; asked = null; draw();
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
        if (Array.from(values.keys()).some(part => part.target === 'map') && (asked === null || now - asked >= 3000)) {
            asked = now;
            client.status();
        }
        for (const part of PARTS) {
            const hosted = part.target === 'map' && maps && maps.panel && host;
            const target = hosted ? 'panel' : part.target;
            const area = target === 'hud' ? HUD : hosted || (maps && maps.map && MAP);
            const rect = values.has(part) && area && placement(settings, part, area, !!hosted);
            let layer = layers.get(part);
            if (!rect || layer && layer.target !== target) { drop(part); layer = null; }
            if (!rect) continue;
            const shape = JSON.stringify(rect);
            if (!layer) {
                const ref = client.image(Object.assign({ target, klass: 'overlay', z: part.turn ? 13 : 12,
                    iw: part.w * TEXTURE_SCALE, ih: part.h * TEXTURE_SCALE, sampling: 'bilinear', fps: 2, contend: 0, yield: 1 }, rect));
                if (!ref) continue;
                layers.set(part, layer = { ref, target, shape });
            } else if (shape !== layer.shape) { client.set(layer.ref, rect); layer.shape = shape; }
            const value = values.get(part);
            const key = (value.demo ? 'demo:' : '') + (part.turn ? [value.kind, value.exit, value.distance, JSON.stringify(value.lanes)].join(':') : etaLabel(value));
            if (layer.key !== key && client.pixels(layer.ref, null, drawOverlay(part, value))) layer.key = key;
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
            data = Object.assign({}, data, { code: 'unavailable', captureDetail: error.code === 'EACCES' ? 'access-denied' :
                error.code === 'ENOENT' ? 'reader-off' : '' });
        } finally { pending = false; }
        if (stopped) { if (leased) request('stop').catch(() => {}); return; }
        draw();
        if (reading !== want()) refresh();
    }
    const tick = () => { draw(); refresh(); };
    signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
        VehicleCondition: (v) => { ready = conditionOf(v && v.statusConditionVehicle) === 10; if (!ready) preview.stop(); tick(); },
    }, log).then((sub) => { if (stopped) sub.shutdown(); else watch = sub; }).catch(() => {});
    settings.onChange(tick);
    const timer = setInterval(tick, 1000);
    app.on('shutdown', () => {
        stopped = true;
        clearInterval(timer); preview.stop(); close();
        if (!pending && leased) request('stop').catch(() => {});
        if (watch) watch.shutdown();
    });
    return { refresh, preview, snapshot: () => ({ data, ready, clusterVisible: PARTS.some(part => part.target === 'map' && layers.has(part)) }) };
}

function start(ctx) {
    const { app, ui, settings, background } = ctx;
    const language = menuLanguage(ctx), { t } = language;
    const samples = PARTS.map(part => (part.turn ? DEMO_TURNS : [DEMO_ETA]).map(value => ({ part, value })));
    const selected = () => background && background.preview.selected();
    const adjustable = part => settings.get(part.enabled) || selected() && selected().part === part;
    const shown = new Map();
    const set = (key, value) => { if (settings.get(key) !== value) settings.set(key, value); };
    function show(method, id, value) {
        const key = method + id;
        if (shown.get(key) === value) return;
        shown.set(key, value); ui[method](id, value);
    }
    const sections = PARTS.map(part => ({ part, slider: ui.comp(part.row + '_SIZE') }));
    for (const [index, { part, slider }] of sections.entries()) {
        const { row, enabled, keys, base } = part;
        for (const [sampleIndex, sample] of samples[index].entries()) {
            ui.onClick(row + '_DEMO' + sampleIndex, () => {
                if (!background || !background.snapshot().ready) return;
                background.preview.toggle(sample);
                render();
            });
        }
        ui.onClick(row + '_ON', () => set(enabled, !settings.get(enabled)));
        for (const [direction, [axis, delta]] of Object.entries(MOVES)) {
            ui.onClick(row + '_' + direction, () => {
                const [min, max] = bounds(settings, part, axis), next = position(settings, part, axis) + delta;
                if (adjustable(part) && next >= min && next <= max) set(keys[axis], next);
            });
        }
        ui.onClick(row + '_RESET', () => { if (adjustable(part)) { set(keys[0], base[0]); set(keys[1], base[1]); } });
        if (slider && slider.on) slider.on('changed', step => { if (adjustable(part) && SIZE[step]) set(keys[2], step); });
    }
    function render() {
        if (!ui.isVisible('MAIN')) return;
        const state = background ? background.snapshot() : { data: {}, ready: false };
        if (language.render()) shown.clear();
        const { data } = state;
        const detail = DETAILS[data.captureDetail];
        const diagnostic = detail ? t(...detail) : String(data.captureDetail || '').replace(/^exit:/, t('Code ', 'Cod ')).replace(' bytes', t(' bytes', ' octeti'));
        const any = PARTS.some(part => settings.get(part.enabled));
        const status = !any ? t('Display disabled', 'Afisare dezactivata') : !state.ready ? t('Waiting for READY', 'Asteapta starea READY') :
            t(...(STATUS[data.code] || STATUS.idle)) + (diagnostic ? ' · ' + diagnostic : '');
        show('text', 'WE_STATUS', status);
        show('text', 'WE_ETA', data.eta ? etaLabel(data.eta) : t('Estimated arrival', 'Sosire estimata') + ' · —');
        show('text', 'WE_MAP_STATUS', state.clusterVisible ? t('Waze overlay on map', 'Afisaj Waze pe harta') :
            t('Waiting for the cluster map', 'Asteapta harta din bord'));
        show('text', 'WE_DEMO_STATUS', background && background.preview.current() ?
            t('Demo active', 'Demo activ') : t('Demo requires READY and standstill', 'Demo disponibil in READY cu masina oprita'));
        show('enabled', 'WE_DEMO_STOP', !!selected());
        for (const { part, slider } of sections) {
            const { row } = part, enabled = !!adjustable(part), step = stepOf(settings, part);
            show('checked', row + '_ON', !!settings.get(part.enabled));
            show('text', row + '_POS', t('Position · ', 'Pozitie · ') + position(settings, part, 0) + ', ' + position(settings, part, 1) + ' px');
            for (const [direction, [axis, delta]] of Object.entries(MOVES)) {
                const [min, max] = bounds(settings, part, axis), next = position(settings, part, axis) + delta;
                show('enabled', row + '_' + direction, enabled && next >= min && next <= max);
            }
            show('enabled', row + '_SIZE', enabled);
            show('enabled', row + '_RESET', enabled);
            if (shown.get(row + ':step') !== step) {
                shown.set(row + ':step', step);
                ui.cells(row + '_SIZE', 0, { TextDescription: t('Size · ', 'Marime · ') + SIZE[step] + '%' });
                if (slider && slider.setStepValue) slider.setStepValue(step);
                else ui.cells(row + '_SIZE', 0, { Value: step });
            }
        }
    }
    function stopDemo() {
        if (background) background.preview.stop();
    }
    ui.onClick('WE_DEMO_STOP', () => { stopDemo(); render(); });
    let timer;
    function visible(open) {
        clearInterval(timer);
        if (open) { shown.clear(); render(); timer = setInterval(render, 1000); }
        else stopDemo();
    }
    ui.onVisible((name, open) => { if (name === 'MAIN') visible(open); });
    settings.onChange(render);
    app.on('shutdown', () => visible(false));
    visible(ui.isVisible('MAIN'));
}

mgu.run({ background, start });
