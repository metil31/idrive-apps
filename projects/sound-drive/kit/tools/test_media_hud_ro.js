'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { Canvas, ScaledCanvas } = require('../runtime/canvas');
const { conditionOf } = require('../runtime/car');
const { decodeTrack } = require('../../apps/hud_romania/media');
const { startService } = require('../../apps/hud_romania/media-service');
const { fitText, drawTrack } = require('../../apps/hud_romania/media-view');
const { AlbumArt } = require('../../apps/hud_romania/album-art');

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
    const coverPath = '/tmp/mediaramdisk_hu/covers/cover_wifi_7.jpg';
    const trackWithCover = Object.assign({}, song, { cover: coverPath });
    assert.deepStrictEqual(decodeTrack({ TITLE: song.title, ARTIST: song.artist, COVER_FILE: coverPath }), trackWithCover);
    let loaded = 0;
    const image = { data: Buffer.from([180, 32, 89, 255]), width: 1, height: 1 };
    const art = new AlbumArt(() => { loaded++; return Promise.resolve({ bytes: Buffer.alloc(4), stamp: '1' }); }, () => image);
    assert.strictEqual(art.get(trackWithCover, false), null);
    assert.strictEqual(art.get(Object.assign({}, song, { cover: '/etc/cover.jpg' }), true), null);
    assert.strictEqual(loaded, 0);
    assert.strictEqual(art.get(trackWithCover, true), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(art.get(trackWithCover, true), image);
    const artCanvas = new Canvas(410, 56).clear();
    drawTrack(artCanvas, trackWithCover, image);
    assert.ok(artCanvas.d.some((pixel, i, data) => i % 4 === 0 && pixel === 180 && data[i + 1] === 32));
    const narrow = new Canvas(200, 56);
    const labels = [];
    narrow.text = (...args) => { labels.push(args); };
    const long = { title: song.title.repeat(20), artist: song.artist.repeat(20) };
    drawTrack(narrow, long, image);
    assert.strictEqual(labels.length, 2);
    for (const [label, x, , size, , options] of labels) {
        assert.ok(label.endsWith('...') && x + narrow.textWidth(label, size, options) <= 200);
    }
    const pillCanvas = new Canvas(250, 68).clear();
    drawTrack(pillCanvas, song, image, true);
    const hasPill = (bytes) => bytes.some((value, i) =>
        i % 4 === 0 && value === 23 && bytes[i + 1] === 25 && bytes[i + 2] === 29 && bytes[i + 3] === 208);
    assert.ok(hasPill(pillCanvas.d) && pillCanvas.d[3] === 0, 'map pill has a translucent centre and clear corners');
    assert.strictEqual(pillCanvas.d[(5 * 250 + 125) * 4 + 3], 208, 'pill extends above the cover');
    assert.strictEqual(pillCanvas.d[(62 * 250 + 125) * 4 + 3], 208, 'pill extends below the cover');
    const labelsOnBoard = [];
    pillCanvas.text = (...args) => { labelsOnBoard.push(args); };
    drawTrack(pillCanvas, long, image, true);
    assert.strictEqual(labelsOnBoard.length, 2);
    for (const [label, x, , size, , options] of labelsOnBoard) {
        assert.ok(label.endsWith('...') && x + pillCanvas.textWidth(label, size, options) <= 222,
            'long board lines leave room for the cover and end padding');
    }
    assert.ok(!hasPill(artCanvas.d), 'the windshield texture stays transparent behind the text');
    assert.strictEqual(art.get(Object.assign({}, trackWithCover, { title: 'Altă melodie' }), true), null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(art.get(Object.assign({}, trackWithCover, { title: 'Altă melodie' }), true), null);

    const clients = [], watches = new Map();
    class Renderer extends EventEmitter {
        constructor() {
            super();
            this.frames = [];
            this.specs = [];
            this.removed = [];
            this.targets = 'map:1088x480,panel:1920x720,hud:800x480';
            clients.push(this);
        }
        connect() { this.emit('ready'); }
        image(spec) { this.spec = spec; this.specs.push(spec); return this.specs.length; }
        pixels(ref, rects, bytes) { this.frames.push(bytes); return true; }
        set(ref, change) { this.change = change; }
        drop(ref) { this.removed.push(ref); this.dropped = true; }
        close() { this.closed = true; }
        status() { this.asked = true; }
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
    }, { Canvas, ScaledCanvas, conditionOf, makeClient: () => new Renderer() });
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
        assert.deepStrictEqual([cr.spec.x, cr.spec.y, cr.spec.yield, cr.spec.klass, cr.spec.w, cr.spec.iw], [300, 322, 1, 'overlay', 200, 200]);
        assert.ok(cr.frames[0].some((pixel, i) => i % 4 === 3 && i >= 27 * 200 * 4 && pixel > 0));
        values.positionX = -120;
        values.positionY = 200;
        changed();
        assert.deepStrictEqual(cr.change, { x: 180, y: 172, w: 200, h: 56 });
        assert.strictEqual(cr.frames.length, 1, 'changing position reuses the pixels');
        player.currentItemMetadata({ title: 'Altă melodie', artist: 'Alt artist' });
        assert.strictEqual(cr.frames.length, 2);
        values.hudSize = 150;
        changed();
        assert.strictEqual(cr.change.w, 300, 'even the largest HUD text stays compact');
        values.show = 'both';
        changed();
        assert.ok(cr.asked);
        cr.emit('status', 'layer 8 video of waze-on-cluster on map, content z 0: shown');
        assert.deepStrictEqual([cr.spec.target, cr.spec.x, cr.spec.y], ['map', 419, 51]);
        assert.deepStrictEqual([cr.spec.iw, cr.spec.ih, cr.spec.sampling], [500, 136, 'bilinear']);
        const boardFrame = cr.frames[cr.frames.length - 1];
        assert.strictEqual(boardFrame.length, 500 * 136 * 4);
        assert.ok(hasPill(boardFrame), 'the map uses a high-resolution translucent pill');
        values.clusterSize = 150;
        changed();
        assert.strictEqual(cr.change.w, 375, 'board media stays narrow at maximum size');
        values.clusterSize = 100;
        const host = { into: 'panel', shown: 1, x: 440, y: 150, w: 544, h: 240 };
        cr.emit('host', 'map', host);
        cr.emit('status', 'layer 8 video of unrelated on panel, content z 0: shown');
        assert.strictEqual(cr.specs.length, 2);
        cr.emit('status', 'layer 8 video of waze-on-cluster on panel, content z 0: shown');
        assert.deepStrictEqual([cr.spec.target, cr.spec.x, cr.spec.y, cr.spec.w, cr.spec.h, cr.spec.iw, cr.spec.ih],
            ['panel', 650, 176, 125, 34, 500, 136]);
        values.clusterX = -200;
        values.clusterSize = 80;
        changed();
        assert.strictEqual(cr.change.w, 100);
        assert.strictEqual(cr.change.x, 562);
        cr.emit('status', 'layer 8 video of waze-on-cluster on panel, content z 0: stalled');
        assert.ok(cr.removed.includes(3) && !cr.removed.includes(1), 'stalled map drops only the board layer');
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
verify().then(() => console.log('Media HUD România: redare, copertă, dimensiune și hartă găzduită verificate'), (error) => {
    console.error(error);
    process.exitCode = 1;
});
