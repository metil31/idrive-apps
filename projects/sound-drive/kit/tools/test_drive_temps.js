'use strict';

const assert = require('assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const vm = require('vm');
const { Temperatures, SENSORS, decode } = require('../../apps/drive_temps/temperature');
const spec = require('../../apps/drive_temps/app.json');

const defaults = Object.fromEntries(spec.settings.map(entry => [entry.key, entry.default]));
assert.strictEqual(SENSORS.find(sensor => sensor.id === 'gearbox').label[0], 'GEARBOX');
const readings = new Temperatures();
const get = key => defaults[key];
assert.strictEqual(decode(255), null);
assert.strictEqual(decode(128), 80);
assert.strictEqual(decode({ value: 120 }), 72);
readings.engine({ temperatureEngineOilDrive: 127, temperatureEngineDrive: 128 }, 100);
readings.gearboxSignal({ valueTemperatureTransmissionOil: 48 }, 100);
assert.deepStrictEqual(readings.visible({ get }, 101).map(v => v.sensor.id), ['oil']);
readings.gearboxSignal({ valueTemperatureTransmissionOil: 88 }, 200);
readings.engine({ temperatureEngineOilDrive: 128, temperatureEngineDrive: 125 }, 200);
assert.deepStrictEqual(readings.visible({ get }, 201).map(v => v.sensor.id), ['gearbox']);
assert.strictEqual(readings.get('gearbox', 201), 40);
assert.strictEqual(readings.get('gearbox', 25300), null);
readings.reset();
readings.engine({ temperatureEngineOilDrive: 125 }, 300);
assert.strictEqual(readings.visible({ get }, 301)[0].value, 77, 'a new drive resets warm-up');

async function backgroundTest() {
    const subscriptions = new Map(), layers = [], changes = [], frames = [], dropped = [];
    const settings = { values: { ...defaults }, get(key) { return this.values[key]; },
        onChange(fn) { this.changed = fn; }, set(key, value) { this.values[key] = value; this.changed(key); } };
    let entry, now = 10000, timer, closed = 0;
    const egsReads = [];
    class Renderer extends EventEmitter {
        constructor() { super(); this.targets = 'hud:800x480,panel:1920x720'; }
        connect() { this.emit('ready'); }
        image(opts) { layers.push(opts); return layers.length; }
        set(ref, target) { changes.push({ ref, target }); }
        pixels(ref, _crop, rgba) { frames.push({ ref, rgba }); return true; }
        close() { closed++; }
        drop(ref) { dropped.push(ref); }
    }
    const deps = {
        './kit/mgu': { run: app => { entry = app; } },
        './kit/watch-retry': { watchRetry(_signals, iface, _instance, handlers) {
            subscriptions.set(iface.split('.').pop(), Object.values(handlers)[0]);
            return { stop() {}, refresh() {} };
        } },
        './kit/readonly-diag': { ReadOnlyDiag: class {
            constructor() { this.ready = true; }
            async init() { return this; }
            async read(ecu, did) { egsReads.push([ecu, did]); return [0x62, 0x60, 0, 96]; }
            wake() {}
            cancel() {}
        } },
        './cluster_render_client': { ClusterRender: Renderer },
    };
    const main = require.resolve('../../apps/drive_temps/main');
    vm.runInNewContext(fs.readFileSync(main, 'utf8'), {
        Buffer, Date: { now: () => now },
        setInterval: fn => { timer = fn; return {}; }, clearInterval: () => {},
        require: name => deps[name] || (name.startsWith('./kit/') ?
            require('../runtime/' + name.slice(6)) : require('../../apps/drive_temps/' + name.slice(2))),
    });
    const app = new EventEmitter();
    const service = entry.background({ app, settings, signals: {} });
    subscriptions.get('CDS')({ temperatureEngineOilDrive: 112 });
    assert.strictEqual(frames.length, 0, 'no parked overlay');
    subscriptions.get('VehicleCondition')({ statusConditionVehicle: 'FAHREN' });
    subscriptions.get('CDS')({ temperatureEngineOilDrive: 112, temperatureEngineDrive: 120 });
    assert.strictEqual(layers[0].target, 'hud');
    const { rgba } = frames[0];
    assert.ok(rgba.some((v, i) => i % 4 === 0 && v === 104 && rgba[i + 1] === 202 && rgba[i + 2] === 255 && rgba[i + 3] === 255),
        'live readings produce opaque blue digits');
    const count = frames.length;
    settings.set('hudX', 10);
    assert.strictEqual(changes[0].target.x, layers[0].x + 10);
    assert.strictEqual(frames.length, count, 'movement does not resend the texture');
    now += 6000;
    timer();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(egsReads.map(item => item.join(':')), ['24:24576']);
    assert.strictEqual(service.snapshot().readings[2], 56, 'EGS reports a live gearbox temperature in Celsius');
    settings.set('cluster', true);
    const panel = layers.find(layer => layer.target === 'panel');
    assert.strictEqual(panel.iw, 584, 'the cluster overlay does not require a Waze map');
    const previous = layers.length;
    settings.set('hudLayout', 'vertical');
    const vertical = layers[layers.length - 1];
    assert.strictEqual(layers.length, previous + 1);
    assert.deepStrictEqual([vertical.target, vertical.iw, vertical.ih], ['hud', 208, 336]);
    assert.deepStrictEqual([vertical.x + vertical.w / 2, vertical.y + vertical.h / 2], [410, 180]);
    assert.deepStrictEqual(dropped, [1], 'only the HUD layer is recreated when its layout changes');
    const stacked = frames[frames.length - 1].rgba;
    for (let row = 0; row < 3; row++) {
        const band = stacked.subarray(row * 112 * vertical.iw * 4, (row + 1) * 112 * vertical.iw * 4);
        assert.ok(band.some((v, i) => i % 4 === 0 && v === 104 && band[i + 1] === 202 && band[i + 2] === 255 && band[i + 3] === 255),
            'each vertical row has its own blue reading');
    }
    subscriptions.get('VehicleCondition')({ statusConditionVehicle: 'WOHNEN' });
    assert.ok(closed > 0);
    app.emit('shutdown');
}

backgroundTest().then(() => console.log('Drive Temps: readings, warm-up, blue text, movement, and read-only EGS pass'))
    .catch(error => { console.error(error); process.exitCode = 1; });
