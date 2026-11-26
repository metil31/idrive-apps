'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { model, readEta, readTurn } = require('../../tools/waze-eta-reader/ocr');
const { state, KEEP, LEASE } = require('../../tools/waze-eta-reader/reader');
const atlas = require('../../tools/waze-eta-reader/eta-atlas.json');
const templates = model([atlas]);

function frame(text, width, height) {
    const buffer = Buffer.alloc(width * height * 4);
    const size = atlas.sizes[3];
    const alpha = zlib.inflateSync(Buffer.from(size.alpha, 'base64'));
    let left = 340;
    for (const ch of text) {
        if (ch === ' ') { left += 9; continue; }
        const [x, y, w, h] = size.glyphs[ch.charCodeAt(0)];
        const top = 448 - h;
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

const external = process.argv.slice(2);
if (external.length) {
    assert.strictEqual(external.length, 3);
    const read = (file) => readEta(fs.readFileSync(file), 1280, 480, templates);
    assert.deepStrictEqual(values(read(external[0])), ['17:15', '36 min', '12 km', 'dashboard']);
    assert.deepStrictEqual(values(read(external[1])), ['17:15', '36 min', '12 km', 'fullscreen']);
    assert.strictEqual(read(external[2]), null);
    for (const [index, mode] of [[0, 'dashboard'], [1, 'fullscreen']]) {
        assert.deepStrictEqual(readTurn(fs.readFileSync(external[index]), 1280, 480, templates, mode), left);
        assert.strictEqual(readTurn(fs.readFileSync(external[2]), 1280, 480, templates, mode), null);
    }
    const rightFixture = fs.readFileSync(external[1]);
    const original = Buffer.from(rightFixture);
    for (let y = 24; y < 79; y++) for (let x = 108; x < 164; x++) {
        const from = (y * 1280 + (163 - x + 108)) * 4;
        original.copy(rightFixture, (y * 1280 + x) * 4, from, from + 4);
    }
    assert.deepStrictEqual(readTurn(rightFixture, 1280, 480, templates, 'fullscreen'), { kind: 'right', distance: '70 m' });
}

async function testHud() {
    const draws = [], targets = [], commands = [], adjustments = [], dropped = [];
    let appImpl, acceptCondition, payload, renderer, tick, changed;
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
    class Canvas {
        constructor() { this.d = Buffer.alloc(4); }
        clear() { return this; }
        roundRect() {}
        text(text) { draws.push(text); }
        textWidth() { return 100; }
        polyline() {}
    }
    class ScaledCanvas extends Canvas { constructor() { super(); this.canvas = this; } }
    class Renderer extends EventEmitter {
        connect() { renderer = this; this.targets = 'map:1088x480,panel:1920x720'; this.emit('ready'); }
        image(options) { targets.push(options); return targets.length; }
        pixels() { return true; }
        set(ref, place) { adjustments.push({ ref, place }); }
        drop(ref) { dropped.push(ref); }
        status() {}
        close() {}
    }
    const deps = {
        net, './kit/mgu': { run: (value) => { appImpl = value; } },
        './kit/car': { conditionOf: (n) => n },
        './kit/canvas': { Canvas, ScaledCanvas },
        './map-area': require('../../apps/waze_eta_ro/map-area'),
        './cluster_render_client': { ClusterRender: Renderer },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../apps/waze_eta_ro/main.js'), 'utf8'), {
        require: (name) => deps[name], Buffer, setInterval: (fn) => { tick = fn; return 0; }, clearInterval() {},
    });
    const app = new EventEmitter();
    const config = { hud: true, cluster: true, turnCluster: true, turnHud: false };
    const settings = { get: (key) => config[key], onChange(fn) { changed = fn; } };
    const signals = {
        async watch(_name, _instance, callbacks) {
            acceptCondition = callbacks.VehicleCondition;
            return { shutdown() {} };
        },
    };
    const service = appImpl.background({ app, settings, signals });
    payload = { eta: Object.assign({ at: Date.now() }, synthetic), turn: Object.assign({ at: Date.now() }, left) };
    await service.refresh();
    assert.deepStrictEqual(commands, []);
    acceptCondition({ statusConditionVehicle: 10 });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    await flush();
    assert.deepStrictEqual(commands, ['start']);
    assert.deepStrictEqual(targets.map(x => x.target), ['hud']);
    renderer.emit('status', 'layer 1 video of waze-on-cluster on map, content z 0: shown');
    assert.deepStrictEqual(targets.map(x => x.target), ['hud', 'map', 'map']);
    assert.deepStrictEqual(draws, ['09:48  ·  27 min  ·  25 km', '09:48  ·  27 min  ·  25 km', '70 m']);
    config.clusterX = 554;
    changed();
    assert.strictEqual(adjustments.length, 1);
    assert.strictEqual(adjustments[0].ref, 2);
    assert.strictEqual(adjustments[0].place.x, targets[1].x + 10);
    await flush();
    renderer.emit('host', 'map', { into: 'panel', shown: 1, x: 100, y: 30, w: 900, h: 400 });
    renderer.emit('status', 'layer 1 video of robertn_waze_cluster on panel, content z 0: shown');
    assert.deepStrictEqual(targets.slice(-2).map(x => x.target), ['panel', 'panel']);
    payload = { eta: payload.eta, turn: null };
    tick(); await flush();
    assert.ok(dropped.includes(5), 'turn disappears independently of ETA');
    acceptCondition({ statusConditionVehicle: 5 });
    await flush();
    assert.strictEqual(commands.slice(-1)[0], 'stop');
    app.emit('shutdown');
}

testHud().then(() => {
    console.log('Waze: citire automată, sosire, viraje, poziții independente și hartă găzduită verificate');
}).catch((err) => { console.error(err); process.exitCode = 1; });
