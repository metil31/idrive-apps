'use strict';

const { MAP, hostArea, mapDisplays } = require('./map-area');
const { AlbumArt } = require('./album-art');

const WIDTH = 410, HEIGHT = 56;
const HUD = { x: 0, y: 0, w: 800, h: 480 };
const TITLE = { align: 'center', font: 'bold', literal: true };
const ARTIST = { align: 'center', font: 'label', literal: true };
const TITLE_LEFT = { font: 'bold', literal: true };
const ARTIST_LEFT = { font: 'label', literal: true };

function drawTrack(cv, track, cover) {
    const titleStyle = cover ? TITLE_LEFT : TITLE, artistStyle = cover ? ARTIST_LEFT : ARTIST;
    const width = WIDTH - (cover ? 70 : 16);
    const title = fitText(cv, track.title, 18, width, titleStyle);
    const artist = track.artist ? fitText(cv, track.artist, 15, width, artistStyle) : '';
    let x = WIDTH / 2;
    if (cover) {
        const side = 44, gap = 10;
        const textWidth = Math.max(cv.textWidth(title, 18, titleStyle), cv.textWidth(artist, 15, artistStyle));
        const imageX = Math.round((WIDTH - side - gap - textWidth) / 2);
        cv.drawImage(cover.data, cover.width, cover.height, imageX, 6, side, side);
        x = imageX + side + gap;
    }
    cv.text(title, x, artist ? 22 : 32, 18, '#ffffff', titleStyle);
    if (artist) cv.text(artist, x, 43, 15, '#dce7f4', artistStyle);
}

function fitText(cv, text, size, width, opts) {
    if (cv.textWidth(text, size, opts) <= width) return text;
    const chars = Array.from(text);
    let lo = 0, hi = chars.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = chars.slice(0, mid).join('') + '...';
        if (cv.textWidth(candidate, size, opts) <= width) lo = mid;
        else hi = mid - 1;
    }
    return chars.slice(0, lo).join('').replace(/\s+$/, '') + '...';
}

function bounded(value, fallback, min, max) {
    return Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
}

function place(area, cx, cy, scale) {
    scale = Math.min(scale, area.w / WIDTH, area.h / HEIGHT);
    const w = Math.round(WIDTH * scale), h = Math.round(HEIGHT * scale);
    if (h < 16) return null;
    return {
        x: Math.max(area.x, Math.min(area.x + area.w - w, Math.round(cx - w / 2))),
        y: Math.max(area.y, Math.min(area.y + area.h - h, Math.round(cy - h / 2))),
        w, h,
    };
}

class MediaOutput {
    constructor(makeClient, Canvas, artwork = new AlbumArt()) {
        this.makeClient = makeClient;
        this.Canvas = Canvas;
        this.artwork = artwork;
        this.layers = {};
        this.stop();
    }

    update(track, settings) {
        if (!track) { this.stop(); return; }
        this.last = { track, settings };
        if (!this.client) {
            const client = this.client = this.makeClient();
            client.on('ready', () => {
                if (client !== this.client) return;
                this.ready = true;
                this.lastAsked = null;
                this.update(this.last.track, this.last.settings);
            });
            client.on('disconnected', () => {
                if (client !== this.client) return;
                this.ready = false;
                this.host = null;
                this.map = null;
                this.drop('cluster');
            });
            client.on('host', (target, event) => {
                if (client !== this.client || target !== 'map') return;
                this.host = hostArea(event, client.targets);
                this.map = null;
                this.lastAsked = null;
                this.drop('cluster');
                this.update(this.last.track, this.last.settings);
            });
            client.on('target', (target, state) => {
                if (client !== this.client || target !== 'panel' && target !== 'map') return;
                if (this.map && state !== 'shown') this.map[target] = false;
                this.lastAsked = null;
                this.update(this.last.track, this.last.settings);
            });
            client.on('status', (text) => {
                if (client !== this.client) return;
                this.map = mapDisplays(text);
                this.lastStatus = Date.now();
                this.update(this.last.track, this.last.settings);
            });
            client.connect();
        }
        if (!this.ready) return;
        const cover = this.artwork.get(track, settings.get('albumArt'));
        const selected = settings.get('show');
        const show = selected === 'cluster' || selected === 'both' ? selected : 'hud';
        const hud = show !== 'cluster' && place(HUD,
            400 + bounded(settings.get('positionX'), 0, -180, 180),
            bounded(settings.get('positionY'), 350, 110, 440), bounded(settings.get('hudSize'), 100, 60, 150) / 100);
        this.sync('hud', 'hud', hud, track, cover);
        if (show === 'hud') { this.drop('cluster'); return; }

        const now = Date.now();
        if (now - this.lastStatus > 7000) this.map = null;
        if (this.lastAsked === null || now - this.lastAsked >= 3000) {
            this.lastAsked = now;
            this.client.status();
        }
        const target = this.map && this.map.panel && this.host ? 'panel' : 'map';
        if (!this.map || !this.map[target]) { this.drop('cluster'); return; }
        let cx = 544 + bounded(settings.get('clusterX'), 0, -300, 300);
        let cy = bounded(settings.get('clusterY'), 85, 45, 440);
        let scale = bounded(settings.get('clusterSize'), 100, 60, 150) / 100;
        const area = target === 'panel' ? this.host : MAP;
        if (target === 'panel') {
            const horizontal = area.w / area.sw, vertical = area.h / area.sh;
            cx = area.x + (cx - area.sx) * horizontal;
            cy = area.y + (cy - area.sy) * vertical;
            scale *= Math.min(horizontal, vertical);
        }
        this.sync('cluster', target, place(area, cx, cy, scale), track, cover);
    }

    sync(name, target, rect, track, cover) {
        let layer = this.layers[name];
        if (!rect || layer && layer.target !== target) {
            this.drop(name);
            layer = null;
        }
        if (!rect) return;
        if (!layer) {
            const ref = this.client.image(Object.assign({ target, klass: 'overlay', z: 11,
                iw: WIDTH, ih: HEIGHT, fps: 4, contend: 0, yield: 1 }, rect));
            if (!ref) return;
            layer = this.layers[name] = { ref, target, rect, key: '' };
        } else if (Object.keys(rect).some((key) => rect[key] !== layer.rect[key])) {
            this.client.set(layer.ref, rect);
            layer.rect = rect;
        }
        const key = JSON.stringify([track.title, track.artist, cover ? track.cover : null]);
        if (layer.key === key) return;
        if (this.key !== key) {
            const cv = new this.Canvas(WIDTH, HEIGHT).clear();
            drawTrack(cv, track, cover);
            this.bytes = Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.byteLength);
            this.key = key;
        }
        if (this.client.pixels(layer.ref, null, this.bytes)) layer.key = key;
    }

    drop(name) {
        const layer = this.layers[name];
        if (!layer) return;
        this.client.drop(layer.ref);
        delete this.layers[name];
    }

    stop() {
        const client = this.client;
        Object.keys(this.layers).forEach((name) => this.drop(name));
        this.client = null;
        if (client) client.close();
        this.ready = false;
        this.host = null;
        this.map = null;
        this.lastAsked = null;
        this.lastStatus = 0;
        this.key = '';
        this.bytes = null;
        this.artwork.get(null, false);
    }
}

module.exports = { MediaOutput, fitText, drawTrack };
