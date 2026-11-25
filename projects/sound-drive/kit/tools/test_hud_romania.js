'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { Canvas } = require('../runtime/canvas');
const { conditionOf } = require('../runtime/car');
const { HudState, indicator, decodeWaypoints, routeLabel, ETA_MS, INDICATOR_MS } = require('../../apps/hud_romania/hud-state');
const { startService } = require('../../apps/hud_romania/service');

const trip = {
    estimatedArrivalTime: { time: { hour: 18, minute: 42 } },
    formattedDistance: { rawDistance: 19320, distance: '12.0', unit: 'MILE_US' },
    travelTime: 1440,
    isCheckeredFlag: true,
};
const settings = { indicators: true, eta: true, position: 'low', brightness: 'normal' };
const cfg = { get: (key) => settings[key], onChange: (fn) => { cfg.changed = fn; } };
const waypoints = { value: { waypoints: [{ travelTime: 120 }, trip] } };
const route = decodeWaypoints(waypoints);
assert.strictEqual(routeLabel(route), 'Sosire 18:42 · 24 min · 19 km');
assert.strictEqual(decodeWaypoints([{ travelTime: 0, formattedDistance: { rawDistance: 0 }, estimatedArrivalTime: trip.estimatedArrivalTime }]), null);
assert.strictEqual(decodeWaypoints([{ travelTime: 4294967295, estimatedArrivalTime: { time: { hour: 24, minute: 1 } } }]), null);
assert.strictEqual(routeLabel(decodeWaypoints([{ travelTime: 10, formattedDistance: { distance: '1,4', unit: 'KM' } }])), '1 min · 1,4 km');
assert.strictEqual(indicator({ controlIndicateDirection: 'TIPP_BLINKEN_LINKS_EIN' }), 'left');
assert.strictEqual(indicator({ value: { activeFunctionIndicateDirection: '8' } }), 'right');
assert.strictEqual(indicator({ controlIndicateDirection: 1, activeFunctionIndicateDirection: 'WARNBLINKEN_MANUELL' }), 'both');
assert.strictEqual(indicator({ activeFunctionIndicateDirection: 'CRASH_BLINKEN' }), null);
assert.strictEqual(indicator({ controlIndicateDirection: 0 }), 'off');

const state = new HudState();
state.setFlag('projectedGuidanceActive', true);
state.setWaypoints(waypoints, 1);
assert.strictEqual(state.view(2, cfg).eta, '');
state.setReady(true);
assert.strictEqual(state.view(2, cfg).eta, 'Sosire 18:42 · 24 min · 19 km');
assert.strictEqual(state.view(0, cfg).eta, '');
assert.strictEqual(state.view(1 + ETA_MS, cfg).eta, '');
state.setFlag('projectedGuidanceMetadataAvailable', false);
assert.strictEqual(state.view(2, cfg).eta, '');
state.setIndicator({ controlIndicateDirection: 3 }, 30);
assert.deepStrictEqual(state.view(30, cfg), { direction: 'left', bright: true, eta: '' });
assert.strictEqual(state.view(430, cfg).bright, false);
assert.strictEqual(state.view(30 + INDICATOR_MS, cfg).direction, 'off');

const clients = [], watches = new Map();
class Renderer extends EventEmitter {
    constructor() { super(); this.frames = []; this.specs = []; clients.push(this); }
    connect() {}
    image(spec) { this.specs.push(spec); return this.specs.length; }
    pixels(ref, rects, bytes) { this.frames.push({ ref, rects, bytes }); return true; }
    set(ref, changes) { this.changes = changes; }
    drop(ref) { this.dropped = ref; }
    close() { this.closed = true; }
}
let clock = 1000;
const service = startService({
    signals: { watch: (iface, instance, cb) => { watches.set(iface.split('.').pop(), cb); return Promise.resolve({ shutdown: () => Promise.resolve() }); } },
    settings: cfg, log: { warn: (msg) => { throw new Error(msg); } }, app: new EventEmitter(),
}, { Canvas, conditionOf, makeClient: () => new Renderer(), now: () => clock });
try {
    watches.get('Light').StatusFunctionsIndicators({ controlIndicateDirection: 8 });
    assert.strictEqual(clients.length, 0, 'no layer before the vehicle reports drive-ready');
    watches.get('VehicleCondition').VehicleCondition({ statusConditionVehicle: 'FAHREN' });
    const cr = clients[0];
    cr.emit('ready');
    assert.strictEqual(cr.specs.length, 1);
    const spec = cr.specs[0];
    assert.strictEqual(spec.target, 'hud');
    assert.strictEqual(spec.klass, 'overlay');
    assert.strictEqual(spec.yield, 1);
    assert.strictEqual(cr.frames[0].bytes.length, spec.iw * spec.ih * 4);
    assert.ok(cr.frames[0].bytes.some((v, index) => index % 4 === 3 && v > 0), 'visible arrows render pixels');
    watches.get('CarPlayManager').projectedGuidanceActive({ projectedGuidanceActive: true });
    watches.get('ProjectedModeGuiding').waypoints(waypoints);
    assert.ok(service.view().eta.indexOf('18:42') !== -1, 'ETA can appear without opening the app');
    const before = cr.frames.length;
    cr.emit('disconnected');
    clock += 400;
    cfg.changed();
    assert.strictEqual(cr.frames.length, before, 'no writes until the renderer is ready again');
    cr.emit('ready');
    assert.strictEqual(cr.frames.length, before + 1);
    assert.strictEqual(cr.specs.length, 1, 'the client restores the one layer after reconnecting');
    settings.position = 'high';
    cfg.changed();
    assert.strictEqual(cr.changes.y, 122);
    clock += INDICATOR_MS;
    watches.get('CarPlayManager').projectedGuidanceActive(false);
    assert.strictEqual(service.view().eta, '');
    assert.strictEqual(cr.dropped, 1);
    assert.strictEqual(cr.closed, true);
    watches.get('VehicleCondition').VehicleCondition({ statusConditionVehicle: 5 });
    watches.get('ProjectedModeGuiding').waypoints(waypoints);
    assert.strictEqual(clients.length, 1, 'parked and stale route data cannot reopen the HUD');
} finally { service.stop(); }
console.log('HUD România: CarPlay ETA, semnalizări, fundal și renderer verificate');
