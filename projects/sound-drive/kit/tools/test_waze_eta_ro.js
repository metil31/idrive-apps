'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { model, readEta } = require('../../tools/waze-eta-reader/ocr');
const { state, KEEP } = require('../../tools/waze-eta-reader/reader');
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
reader.start();
assert.strictEqual(reader.captureToken(), null);
reader.setFront(true);
let token = reader.captureToken();
reader.result(token, synthetic);
assert.strictEqual(reader.snapshot().eta, null);
reader.result(token, synthetic);
assert.strictEqual(reader.snapshot().eta.arrival, '09:48');
assert.strictEqual(reader.snapshot().remembered, false);
reader.setFront(false);
reader.result(token, Object.assign({}, synthetic, { arrival: '10:00' }));
assert.strictEqual(reader.snapshot().remembered, true);
assert.strictEqual(reader.snapshot().eta.arrival, '09:48');
time += KEEP;
assert.strictEqual(reader.snapshot().eta, null);
reader.setFront(true);
token = reader.captureToken();
reader.result(token, synthetic);
assert.strictEqual(reader.snapshot().eta, null);
reader.result(token, synthetic);
assert.strictEqual(reader.snapshot().remembered, false);
reader.result(token, null, 'no-eta');
assert.strictEqual(reader.snapshot().remembered, true);
time += 31 * 60 * 1000;
assert.strictEqual(reader.snapshot().code, 'ended');
reader.stop();
assert.strictEqual(reader.snapshot().code, 'idle');

const external = process.argv.slice(2);
if (external.length) {
    assert.strictEqual(external.length, 3);
    const read = (file) => readEta(fs.readFileSync(file), 1280, 480, templates);
    assert.deepStrictEqual(values(read(external[0])), ['17:15', '36 min', '12 km', 'dashboard']);
    assert.deepStrictEqual(values(read(external[1])), ['17:15', '36 min', '12 km', 'fullscreen']);
    assert.strictEqual(read(external[2]), null);
}

async function testHud() {
    const draws = [], targets = [];
    let appImpl, acceptCondition, payload, configured = true;
    const net = {
        createConnection(_path, onConnect) {
            const socket = new EventEmitter();
            socket.setTimeout = () => {};
            socket.destroy = (err) => socket.emit('error', err);
            socket.write = () => {
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
    }
    class Renderer extends EventEmitter {
        connect() {}
        image(options) { targets.push(options.target); return 1; }
        pixels() { return true; }
        close() { targets.push('closed'); }
    }
    const deps = {
        net, './kit/mgu': { run: (value) => { appImpl = value; } },
        './kit/car': { conditionOf: (n) => n },
        './kit/canvas': { Canvas },
        './cluster_render_client': { ClusterRender: Renderer },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../apps/waze_eta_ro/main.js'), 'utf8'), {
        require: (name) => deps[name], Buffer, setInterval: () => 0, clearInterval() {},
    });
    const app = new EventEmitter();
    const settings = { get: (key) => key === 'hud' ? configured : undefined, onChange() {} };
    const signals = {
        async watch(_name, _instance, callbacks) {
            acceptCondition = callbacks.VehicleCondition;
            return { shutdown() {} };
        },
    };
    const service = appImpl.background({ app, settings, signals });
    payload = { eta: Object.assign({ at: Date.now() }, synthetic), remembered: false };
    await service.query('get');
    assert.deepStrictEqual(targets, []);
    acceptCondition({ statusConditionVehicle: 10 });
    assert.deepStrictEqual(targets, ['hud']);
    assert.ok(draws.includes('WAZE · SOSIRE'));
    payload.remembered = true;
    await service.query('get');
    assert.ok(draws.includes('WAZE · MEMORAT'));
    configured = false;
    await service.query('get');
    assert.deepStrictEqual(targets, ['hud', 'closed']);
    app.emit('shutdown');
}

testHud().then(() => {
    console.log('Waze ETA: recunoaștere, confirmare, memorare, expirare și randare numai pe HUD verificate');
}).catch((err) => { console.error(err); process.exitCode = 1; });
