'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { Canvas } = require('../runtime/canvas');
const { conditionOf } = require('../runtime/car');
const { decodeTrack } = require('../../apps/media_hud_ro/media');
const { startService } = require('../../apps/media_hud_ro/service');
const { fitText } = require('../../apps/media_hud_ro/view');

const song = { title: 'Și dacă', artist: 'Țapinarii' };
const metadata = { currentItemMetadata: [
    { key: 'TITLE', value: { stringValue: song.title } },
    { key: 'ARTIST', value: { stringValue: song.artist } },
] };
assert.deepStrictEqual(decodeTrack(metadata), song);
assert.deepStrictEqual(decodeTrack({ value: { TITLE: song.title, ARTIST: song.artist } }), song);
assert.strictEqual(decodeTrack([{ key: 'ALBUM', value: 'Album' }]), null);
const cv = new Canvas(410, 56), style = { font: 'bold', literal: true };
const fit = fitText(cv, song.title.repeat(12), 18, 394, style);
assert.ok(fit.endsWith('...') && cv.textWidth(fit, 18, style) <= 394);

async function verify() {
    const clients = [], watches = new Map();
    class Renderer extends EventEmitter {
        constructor() { super(); this.frames = []; clients.push(this); }
        connect() { this.emit('ready'); }
        image(spec) { this.spec = spec; return 1; }
        pixels(ref, rects, bytes) { this.frames.push(bytes); return true; }
        set(ref, change) { this.change = change; }
        drop() { this.dropped = true; }
        close() { this.closed = true; }
    }
    const values = { enabled: true, positionX: 0, positionY: 350 };
    let changed;
    const media = { available: true, shutdown: () => Promise.resolve() };
    const service = startService({
        signals: { watch: (iface, instance, handlers) => {
            const name = iface.split('.').pop();
            watches.set(name, handlers);
            if (name === 'MediaPlayer') {
                assert.strictEqual(instance, 'CarPlayMedia');
                return Promise.resolve(media);
            }
            return Promise.resolve({ shutdown: () => Promise.resolve() });
        } },
        settings: { get: (key) => values[key], onChange: (fn) => { changed = fn; } },
        log: { warn: (error) => { throw new Error(error); } },
        app: new EventEmitter(),
    }, { Canvas, conditionOf, makeClient: () => new Renderer() });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        const ready = watches.get('VehicleCondition').VehicleCondition;
        const player = watches.get('MediaPlayer');
        player.currentItemMetadata(metadata);
        player.playerState({ playerState: { name: 'PLAYER_STATE_PLAY' } });
        assert.strictEqual(clients.length, 0);
        ready({ statusConditionVehicle: 'FAHREN' });
        assert.deepStrictEqual(service.track(), song);
        const cr = clients[0];
        assert.deepStrictEqual([cr.spec.x, cr.spec.y, cr.spec.yield, cr.spec.klass], [195, 322, 1, 'overlay']);
        assert.ok(cr.frames[0].some((pixel, i) => i % 4 === 3 && i >= 27 * 410 * 4 && pixel > 0));
        values.positionX = -120;
        values.positionY = 200;
        changed();
        assert.deepStrictEqual(cr.change, { x: 75, y: 172 });
        assert.strictEqual(cr.frames.length, 1, 'changing position reuses the pixels');
        player.currentItemMetadata({ title: 'Altă melodie', artist: 'Alt artist' });
        assert.strictEqual(cr.frames.length, 2);
        player.playerState('PLAYER_STATE_PAUSE');
        assert.ok(cr.dropped && cr.closed);
        assert.strictEqual(service.track(), null);
        player.playerState('PLAYER_STATE_PLAY');
        assert.strictEqual(service.track().title, 'Altă melodie');
        media.available = false;
        changed();
        media.available = true;
        changed();
        assert.strictEqual(service.track(), null, 'disconnect drops the old track');
        player.currentItemMetadata(metadata);
        player.playerState('PLAYER_STATE_PLAY');
        values.enabled = false;
        changed();
        assert.strictEqual(service.track(), null);
    } finally { service.stop(); }
}
verify().then(() => console.log('Media HUD România: redare și poziție verificate'), (error) => {
    console.error(error);
    process.exitCode = 1;
});
