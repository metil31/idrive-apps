'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { model, readEta, readTurn, readSpeedLimit, hasWazeDock } = require('../../tools/waze-eta-reader/ocr');
const { state, KEEP, LEASE } = require('../../tools/waze-eta-reader/reader');
const { ScaledCanvas } = require('../runtime/canvas');
const atlas = require('../../tools/waze-eta-reader/eta-atlas.json');
const templates = model([atlas]);

function frame(text, width, height, left = 340, baseline = 448, sizeIndex = 3) {
    const buffer = Buffer.alloc(width * height * 4);
    const size = atlas.sizes[sizeIndex];
    const alpha = zlib.inflateSync(Buffer.from(size.alpha, 'base64'));
    for (const ch of text) {
        if (ch === ' ') { left += 9; continue; }
        const [x, y, w, h] = size.glyphs[ch.charCodeAt(0)];
        const top = baseline - h;
        for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
            const at = ((top + ty) * width + left + tx) * 4;
            const v = alpha[(y + ty) * size.atlasW + x + tx];
            buffer.fill(v, at, at + 3);
        }
        left += w + 3;
    }
    return buffer;
}

function values(read) { return read && [read.arrival, read.duration, read.distance, read.layout]; }
const synthetic = readEta(frame('09:48 ETA 27 min 25 km', 1280, 480), 1280, 480, templates);
assert.deepStrictEqual(values(synthetic), ['09:48', '27 min', '25 km', 'dashboard']);
assert.strictEqual(readEta(Buffer.alloc(1280 * 480 * 4), 1280, 480, templates), null);
assert.strictEqual(readEta(Buffer.alloc(12), 1280, 480, templates), null);

for (const exit of [1, 2, 3]) {
    const digit = String(exit), [,, digitWidth, digitHeight] = atlas.sizes[0].glyphs[digit.charCodeAt(0)];
    const turnFrame = frame('100 m', 1280, 480, 175, 59);
    const number = frame(digit, 1280, 480, Math.round(136 - digitWidth / 2), Math.round(51 + digitHeight / 2), 0);
    for (let y = 30; y < 73; y++) for (let x = 114; x < 158; x++) {
        const radius = Math.hypot(x - 136, y - 51);
        const at = (y * 1280 + x) * 4;
        if (radius >= 16 && radius <= 21) turnFrame.fill(x < 136 ? 145 : 250, at, at + 3);
        else number.copy(turnFrame, at, at, at + 3);
    }
    assert.deepStrictEqual(readTurn(turnFrame, 1280, 480, templates, 'fullscreen'),
        { kind: 'roundabout', distance: '100 m', exit });
}

let time = 0;
const reader = state(() => time);
function advance(ms, probe) {
    while (ms > 0) { const step = Math.min(ms, LEASE - 1); time += step; ms -= step; probe.start(); }
}
reader.start();
assert.notStrictEqual(reader.captureToken(), null);
reader.setFront(true);
let token = reader.captureToken();
const left = { kind: 'left', distance: '70 m' };
reader.result(token, synthetic, null, left);
assert.strictEqual(reader.snapshot().eta, null);
assert.strictEqual(reader.snapshot().turn, null);
reader.start();
reader.result(token, synthetic, null, { kind: 'left', distance: '60 m' });
assert.strictEqual(reader.snapshot().eta.arrival, '09:48');
assert.strictEqual(reader.snapshot().turn.distance, '60 m');
reader.result(token, null, 'capture-failed');
assert.strictEqual(reader.snapshot().turn.distance, '60 m', 'one failed capture does not blink');
reader.result(token, synthetic, null, { ...left, distance: '50 m' });
assert.strictEqual(reader.snapshot().turn.distance, '50 m', 'matching turn refreshes immediately');
reader.result(token, synthetic, null, null);
reader.result(token, null, 'no-eta');
assert.strictEqual(reader.snapshot().turn, null, 'two misses retire the turn');

const roundabout = { kind: 'roundabout', exit: 1, distance: '100 m' };
reader.result(token, synthetic, null, roundabout);
reader.result(token, synthetic, null, roundabout);
assert.strictEqual(reader.snapshot().turn.exit, 1);
reader.result(token, synthetic, null, Object.assign({}, roundabout, { exit: 2 }));
assert.strictEqual(reader.snapshot().turn, null);
reader.result(token, synthetic, null, { kind: 'right', distance: '530 m' });
assert.strictEqual(reader.snapshot().turn, null);
reader.setFront(false);
reader.result(token, Object.assign({}, synthetic, { arrival: '10:00' }));
assert.strictEqual(reader.snapshot().turn, null);
assert.strictEqual(reader.snapshot().eta.arrival, '09:48');
advance(KEEP, reader);
assert.strictEqual(reader.snapshot().eta, null);
reader.setFront(true);
token = reader.captureToken();
reader.result(token, synthetic);
assert.strictEqual(reader.snapshot().eta, null);
reader.result(token, synthetic);
assert.strictEqual(reader.snapshot().code, 'live');
reader.result(token, null, 'no-eta');
assert.strictEqual(reader.snapshot().code, 'no-eta');
time += LEASE;
assert.strictEqual(reader.snapshot().code, 'idle');
reader.stop();
assert.strictEqual(reader.snapshot().code, 'idle');

const missingGate = state(() => time);
missingGate.start();
const initial = missingGate.captureToken();
assert.notStrictEqual(initial, null);
missingGate.result(initial, synthetic);
missingGate.result(initial, synthetic);
assert.strictEqual(missingGate.snapshot().code, 'live');
advance(45000, missingGate);
assert.strictEqual(missingGate.captureToken(), null);
assert.strictEqual(missingGate.snapshot().code, 'no-screen-event');
missingGate.setGuidance(true);
assert.notStrictEqual(missingGate.captureToken(), null);
missingGate.setFront(true);
assert.notStrictEqual(missingGate.captureToken(), initial);

const dual = state(() => time);
dual.start();
dual.start('limit');
dual.setFront(true);
let dualToken = dual.captureToken();
dual.result(dualToken, synthetic, null, left, 80);
assert.strictEqual(dual.snapshot().limit, null);
time += 4000;
dual.result(dualToken, synthetic, null, left, 80);
assert.strictEqual(dual.snapshot().limit.kmh, 80);
assert.strictEqual(dual.snapshot().limit.since, time - 4000);
dual.stop();
assert.strictEqual(dual.snapshot().limit.kmh, 80, 'navigation stop does not revoke the limit lease');
time += 4000;
dual.result(dualToken, synthetic, null, left, 130);
assert.strictEqual(dual.snapshot().limit, null, 'discard the old limit immediately on disagreement');
dual.start('limit');
time += 4000;
dual.result(dualToken, synthetic, null, left, 130);
assert.strictEqual(dual.snapshot().limit.kmh, 130);
dual.setFront(false);
assert.strictEqual(dual.snapshot().limit, null, 'a hidden centre screen cannot supply a live limit');

dual.setFront(true);
dualToken = dual.captureToken();
const laneTest = { ...left, lanes: [{ kind: 'left', active: true }, { kind: 'straight', active: false }] };
dual.result(dualToken, synthetic, null, left);
dual.result(dualToken, synthetic, null, laneTest);
assert.ok(!dual.snapshot().turn.lanes, 'a lane indication needs two matching reads');
dual.result(dualToken, synthetic, null, laneTest);
assert.deepStrictEqual(dual.snapshot().turn.lanes, laneTest.lanes);
dual.result(dualToken, synthetic, null, left);
assert.ok(!dual.snapshot().turn.lanes && dual.snapshot().turn.kind === 'left',
    'loss of lane certainty leaves the valid primary turn in place');

const external = process.argv.slice(2);
if (external.length) {
    assert.ok([3, 4, 9].includes(external.length));
    if (external[3]) assert.deepStrictEqual(readTurn(fs.readFileSync(external[3]), 1280, 480, templates, 'fullscreen'), roundabout);
    const read = (file) => readEta(fs.readFileSync(file), 1280, 480, templates);
    assert.deepStrictEqual(values(read(external[0])), ['17:15', '36 min', '12 km', 'dashboard']);
    assert.deepStrictEqual(values(read(external[1])), ['17:15', '36 min', '12 km', 'fullscreen']);
    assert.strictEqual(read(external[2]), null);
    for (const [index, mode] of [[0, 'dashboard'], [1, 'fullscreen']]) {
        assert.deepStrictEqual(readTurn(fs.readFileSync(external[index]), 1280, 480, templates, mode), left);
        assert.strictEqual(readSpeedLimit(fs.readFileSync(external[index]), 1280, 480, templates, mode), 30);
        assert.ok(hasWazeDock(fs.readFileSync(external[index]), 1280, 480));
        const withoutWaze = fs.readFileSync(external[index]);
        for (let y = 140; y < 335; y++) withoutWaze.fill(0, y * 1280 * 4, (y * 1280 + 75) * 4);
        assert.strictEqual(hasWazeDock(withoutWaze, 1280, 480), false);
        assert.strictEqual(readTurn(fs.readFileSync(external[2]), 1280, 480, templates, mode), null);
    }
    const rightFixture = fs.readFileSync(external[1]);
    const original = Buffer.from(rightFixture);
    for (let y = 24; y < 79; y++) for (let x = 108; x < 164; x++) {
        const from = (y * 1280 + (163 - x + 108)) * 4;
        original.copy(rightFixture, (y * 1280 + x) * 4, from, from + 4);
    }
    assert.deepStrictEqual(readTurn(rightFixture, 1280, 480, templates, 'fullscreen'), { kind: 'right', distance: '70 m' });
    if (external.length === 9) {
        const [fork, lanes, partial, eighty, oneThirty] = external.slice(4).map(file => fs.readFileSync(file));
        assert.deepStrictEqual(readTurn(fork, 1280, 480, templates, 'fullscreen'),
            { kind: 'fork-right', distance: '70 m' });
        const opposite = Buffer.from(fork);
        for (let y = 24; y < 79; y++) for (let x = 108; x < 164; x++) {
            const at = (y * 1280 + 108 + 163 - x) * 4;
            fork.copy(opposite, (y * 1280 + x) * 4, at, at + 4);
        }
        assert.deepStrictEqual(readTurn(opposite, 1280, 480, templates, 'fullscreen'),
            { kind: 'fork-left', distance: '70 m' });
        const guidance = readTurn(lanes, 1280, 480, templates, 'fullscreen');
        assert.deepStrictEqual(guidance.lanes, [
            { kind: 'left', active: false, branch: false },
            { kind: 'straight', active: false, branch: false },
            { kind: 'straight-right', active: false, branch: true },
        ]);
        assert.ok(!readTurn(partial, 1280, 480, templates, 'fullscreen').lanes);
        assert.strictEqual(readSpeedLimit(eighty, 1280, 480, templates, 'dashboard'), 80);
        assert.strictEqual(readSpeedLimit(oneThirty, 1280, 480, templates, 'fullscreen'), 130);
        assert.strictEqual(readSpeedLimit(eighty, 1280, 480, templates, 'fullscreen'), null);
    }
}

async function testReaderScheduling() {
    let now = 1000, acceptSocket, finishCapture, captures = 0, sequence = 0;
    const timers = new Map(), listeners = new Map();
    const dependencies = {
        fs: { unlinkSync() {} },
        net: { createServer(handler) { acceptSocket = handler; return { listen() {} }; } },
        child_process: { execFile(_file, _args, _options, done) { captures++; finishCapture = done; } },
        './ocr': {},
        '/usr/lib/someip.node': { buildProxy: () => ({
            async init() {},
            async subscribe({ name, onReceive }) { listeners.set(name, onReceive); },
        }) },
    };
    const file = path.join(__dirname, '../../tools/waze-eta-reader/reader.js');
    vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nrun();', {
        module: { exports: {} }, require: name => dependencies[name], Date: { now: () => now },
        setTimeout(fire, delay) { const id = ++sequence; timers.set(id, { fire, delay }); return id; },
        clearTimeout: id => timers.delete(id),
    });
    await new Promise(resolve => setImmediate(resolve));
    function command(name) {
        const socket = new EventEmitter();
        socket.setTimeout = socket.pause = socket.end = () => {};
        acceptSocket(socket);
        socket.emit('data', Buffer.from(name + '\n'));
    }
    function fireTimer(delay) {
        assert.strictEqual(timers.size, 1);
        const [id, timer] = timers.entries().next().value;
        assert.strictEqual(timer.delay, delay);
        timers.delete(id);
        now += delay;
        timer.fire();
    }
    const screen = listeners.get('onScreenChange');
    screen('PROJECTED');
    assert.strictEqual(timers.size, 0, 'no capture timer without a lease');
    command('start');
    command('limit');
    fireTimer(0);
    command('start');
    assert.strictEqual(timers.size, 0, 'in-flight capture is not duplicated');
    finishCapture({ code: 1 });
    assert.strictEqual(timers.size, 1);
    screen('NATIVE');
    assert.strictEqual(timers.size, 0, 'native screen stops capture scheduling');
    screen('PROJECTED');
    command('stop');
    fireTimer(4000);
    assert.strictEqual(captures, 2, 'the limit lease keeps capturing independently');
    finishCapture({ code: 1 });
    now += LEASE;
    fireTimer(4000);
    assert.strictEqual(captures, 2);
    assert.strictEqual(timers.size, 0, 'an expired lease does not rearm capture');
}

async function testHud() {
    const draws = [], targets = [], commands = [], adjustments = [], dropped = [], frames = new Map(), uploads = [];
    const timers = new Set();
    let menuTimer;
    let appImpl, acceptCondition, acceptSpeed, payload, renderer, tick, changed;
    const net = {
        createConnection(_path, onConnect) {
            const socket = new EventEmitter();
            socket.setTimeout = () => {};
            socket.destroy = (err) => socket.emit('error', err);
            socket.write = (value) => {
                commands.push(value.trim());
                socket.emit('data', Buffer.from(JSON.stringify(payload)));
                socket.emit('end');
            };
            process.nextTick(onConnect);
            return socket;
        },
    };
    class RecordingCanvas extends ScaledCanvas {
        text(text, ...args) {
            if (args[3] === '#ffffff') draws.push(text);
            return super.text(text, ...args);
        }
    }
    function edges(ref, y) {
        const { iw } = targets[ref - 1], px = frames.get(ref);
        const row = px.subarray(y * iw * 4, (y + 1) * iw * 4);
        let left = 0, right = iw - 1;
        while (left < iw && row[left * 4 + 3] === 0) left++;
        while (right >= left && row[right * 4 + 3] === 0) right--;
        return { left, right, width: right - left + 1 };
    }
    class Renderer extends EventEmitter {
        connect() { renderer = this; this.targets = 'map:1088x480,panel:1920x720'; this.emit('ready'); }
        image(options) { targets.push(options); return targets.length; }
        pixels(ref, regions, bytes) {
            const { iw, ih } = targets[ref - 1];
            uploads.push({ ref, regions, bytes: bytes.length });
            if (regions) {
                const next = frames.get(ref) || Buffer.alloc(iw * ih * 4);
                const [r] = regions;
                for (let y = 0; y < r.h; y++) {
                    bytes.copy(next, ((y + r.y) * iw + r.x) * 4, y * r.w * 4, (y + 1) * r.w * 4);
                }
                frames.set(ref, next);
            } else frames.set(ref, bytes);
            return true;
        }
        set(ref, place) { adjustments.push({ ref, place }); }
        drop(ref) { dropped.push(ref); }
        status() {}
        close() {}
    }
    const deps = {
        net, './kit/display-preview': require('../runtime/display-preview'),
        './kit/menu-language': require('../runtime/menu-language'), './kit/mgu': { run: (value) => { appImpl = value; } },
        './kit/car': { conditionOf: (n) => n },
        './kit/canvas': { ScaledCanvas: RecordingCanvas },
        './map-area': require('../../apps/waze_eta_ro/map-area'),
        './cluster_render_client': { ClusterRender: Renderer },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../apps/waze_eta_ro/main.js'), 'utf8'), {
        require: (name) => deps[name], Buffer, setInterval(fn) {
            if (!tick) tick = fn;
            else menuTimer = fn;
            timers.add(fn);
            return fn;
        },
        clearInterval: fn => timers.delete(fn),
    });
    const app = new EventEmitter();
    const config = { hud: true, cluster: true, turnCluster: true, turnHud: false };
    const settings = { get: (key) => config[key], onChange(fn) {
        const previous = changed;
        changed = key => { if (previous) previous(key); fn(key); };
    } };
    const signals = {
        async watch(_name, _instance, callbacks) {
            if (callbacks.VehicleCondition) acceptCondition = callbacks.VehicleCondition;
            else acceptSpeed = callbacks.statusCarSpeed2;
            return { shutdown() {} };
        },
    };
    const service = appImpl.background({ app, settings, signals });
    payload = { eta: Object.assign({ at: Date.now() }, synthetic), turn: Object.assign({ at: Date.now() }, left) };
    await service.refresh();
    assert.deepStrictEqual(commands, []);
    assert.strictEqual(timers.size, 0, 'no polling while the vehicle is off');
    acceptCondition({ statusConditionVehicle: 10 });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    await flush();
    assert.deepStrictEqual(commands, ['start']);
    assert.deepStrictEqual(targets.map(x => x.target), ['hud']);
    renderer.emit('status', 'layer 1 video of waze-on-cluster on map, content z 0: shown');
    assert.deepStrictEqual(targets.map(x => x.target), ['hud', 'map', 'map']);
    assert.deepStrictEqual(draws, ['09:48  ·  27 min  ·  25 km', '09:48  ·  27 min  ·  25 km', '70 m']);
    const etaCenterRow = targets[1].ih / 2, turnCenterRow = targets[2].ih / 2;
    const etaEdges = edges(2, etaCenterRow), turnEdges = edges(3, turnCenterRow);
    assert.strictEqual(targets[1].iw, targets[1].w * 4);
    assert.strictEqual(targets[1].ih, targets[1].h * 4);
    const firstEta = uploads.find(frame => frame.ref === 2);
    assert.ok(firstEta.regions && firstEta.bytes < targets[1].iw * targets[1].ih * 4);
    for (const ref of [2, 3]) {
        const { iw, ih } = targets[ref - 1], scale = ih / 48, frame = frames.get(ref);
        const pixel = (x, y) => Array.from(frame.subarray((y * iw + x) * 4, (y * iw + x) * 4 + 4));
        const x = iw / 2;
        assert.deepStrictEqual(pixel(x, 8 * scale), [52, 52, 52, 224], 'the card is neutral grey and nearly solid');
        const shadow = [42, 44, 46, 47].map(y => pixel(x, y * scale));
        assert.ok(shadow.every(([r, g, b]) => r === 0 && g === 0 && b === 0), 'the card casts a neutral shadow');
        assert.ok(shadow[0][3] > shadow[1][3] && shadow[1][3] > shadow[2][3] && shadow[3][3] === 0, 'the shadow fades below the card');
        assert.ok(frame.some((value, i) => i % 4 === 0 && value === 255 && frame[i + 3] === 255), 'the guidance stays opaque');
    }
    assert.ok(etaEdges.width < targets[1].iw - 40 && turnEdges.width < targets[2].iw - 40,
        'short labels leave no painted background in the unused side space');
    const turnTop = edges(3, 4 * 3);
    assert.ok(turnTop.left > turnEdges.left && turnTop.right < turnEdges.right,
        'the maneuver card is narrower at the top because its corners are rounded');
    const activePayload = payload;
    payload = {
        eta: { ...payload.eta, duration: '2 h 27 min', distance: '125 km' },
        turn: { ...payload.turn, distance: '1.5 km' },
    };
    tick(); await flush();
    assert.ok(edges(2, etaCenterRow).width > etaEdges.width);
    assert.ok(edges(3, turnCenterRow).width > turnEdges.width);
    assert.strictEqual(targets.length, 3, 'changing label width does not recreate the layers');
    payload = activePayload;
    tick(); await flush();
    assert.deepStrictEqual(edges(2, etaCenterRow), etaEdges);
    assert.deepStrictEqual(edges(3, turnCenterRow), turnEdges);
    payload = { ...activePayload, eta: { ...activePayload.eta, arrival: '08:49' } };
    tick(); await flush();
    const textUpdate = uploads[uploads.length - 1];
    assert.strictEqual(textUpdate.ref, 2);
    assert.strictEqual(textUpdate.regions[0].y, 8 * 4, 'same-width updates only upload the text band');
    assert.strictEqual(textUpdate.regions[0].h, (48 - 16) * 4);
    payload = activePayload;
    config.clusterX = 554;
    changed();
    assert.strictEqual(adjustments.length, 1);
    assert.strictEqual(adjustments[0].ref, 2);
    assert.strictEqual(adjustments[0].place.x, targets[1].x + 10);
    await flush();
    renderer.emit('host', 'map', { into: 'panel', shown: 1, x: 100, y: 30, w: 900, h: 400 });
    renderer.emit('status', 'layer 1 video of robertn_waze_cluster on panel, content z 0: shown');
    assert.deepStrictEqual(targets.slice(-2).map(x => x.target), ['panel', 'panel']);
    payload = { eta: payload.eta, turn: Object.assign({ at: Date.now() }, roundabout) };
    tick(); await flush();
    assert.deepStrictEqual(draws.slice(-2), ['1', '100 m']);
    payload = { eta: payload.eta, turn: null };
    tick(); await flush();
    assert.ok(dropped.includes(5), 'turn disappears independently of ETA');
    const menu = new Map(), shown = [];
    let onVisible;
    const spec = require('../../apps/waze_eta_ro/app.json');
    const ui = {
        onClick: (id, fn) => menu.set(id, fn), onVisible: fn => { onVisible = fn; },
        isVisible: () => true, comp: () => null, checked() {}, text: (id, value) => shown.push([id, value]),
        enabled() {}, selected() {}, cells() {},
    };
    settings.set = (key, value) => { config[key] = value; changed(key); };
    appImpl.start({ ui, settings, spec, app, background: service });
    menu.get('WE_TH_DEMO2')();
    await flush();
    assert.strictEqual(service.preview.current(), null);
    acceptSpeed({ speedVehicleCentreOfGravity: 0 });
    assert.strictEqual(service.preview.current().value.exit, 2);
    const previewLayer = targets[targets.length - 1];
    assert.strictEqual(previewLayer.target, 'hud');
    assert.strictEqual(previewLayer.iw, previewLayer.w * 3);
    assert.strictEqual(previewLayer.ih, previewLayer.h * 3);
    assert.deepStrictEqual(draws.slice(-2), ['2', 'Demo 100 m']);
    menu.get('WE_TH_RIGHT')();
    assert.strictEqual(config.turnHudX, 425);
    menu.get('APP_LANGUAGE')({ row: 1 });
    assert.strictEqual(config.menuLanguage, 'ro');
    assert.ok(shown.some(([id, value]) => id === 'WE_TH_HEAD' && value === 'Manevre pe HUD · experimental'));
    menu.get('WE_TH_DEMO3')();
    await flush();
    acceptSpeed({ speedVehicleCentreOfGravity: 0 });
    assert.strictEqual(service.preview.current().value.kind, 'lanes');
    assert.strictEqual(draws.slice(-1)[0], 'Demo 700 m');
    acceptSpeed({ speedVehicleCentreOfGravity: 1 });
    assert.strictEqual(service.preview.current(), null);
    onVisible('MAIN', false);
    acceptCondition({ statusConditionVehicle: 5 });
    await flush();
    assert.strictEqual(commands.slice(-1)[0], 'stop');
    assert.ok(!timers.has(tick) && !timers.has(menuTimer), 'polling stops when leaving READY and closing the menu');
    app.emit('shutdown');
}

testReaderScheduling().then(testHud).then(() => {
    console.log('Waze: citire automată, sosire, viraje, poziții independente și hartă găzduită verificate');
}).catch((err) => { console.error(err); process.exitCode = 1; });
