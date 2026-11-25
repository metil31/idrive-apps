'use strict';

const { MAP, hostArea, mapDisplays } = require('./map-area');
const { AlbumArt } = require('./album-art');

const HUD_TEXTURE = { w: 200, h: 56, scale: 1 };
const CLUSTER_TEXTURE = { w: 410, h: 68, scale: 2 };
const HUD = { x: 0, y: 0, w: 800, h: 480 };
const TITLE = { align: 'center', font: 'bold', literal: true };
const ARTIST = { align: 'center', font: 'label', literal: true };
const TITLE_LEFT = { font: 'bold', literal: true };
const ARTIST_LEFT = { font: 'label', literal: true };

function drawTrack(cv, track, cover, pill = false) {
    const titleStyle = cover ? TITLE_LEFT : TITLE, artistStyle = cover ? ARTIST_LEFT : ARTIST;
    const side = pill ? 48 : 44, gap = pill ? 12 : 10;
    const coverWidth = cover ? side + gap : 0;
    const padding = pill ? 56 : 16;
    const width = cv.w - padding - coverWidth;
    const titleSize = pill ? 19 : 18, artistSize = pill ? 16 : 15;
    const title = fitText(cv, track.title, titleSize, width, titleStyle);
    const artist = track.artist ? fitText(cv, track.artist, artistSize, width, artistStyle) : '';
    const textWidth = Math.max(cv.textWidth(title, titleSize, titleStyle), cv.textWidth(artist, artistSize, artistStyle));
    if (pill) {
        const pillWidth = Math.ceil(textWidth + coverWidth + padding);
        cv.roundRect((cv.w - pillWidth) / 2, 3, pillWidth, cv.h - 6, (cv.h - 6) / 2, [23, 25, 29, 208]);
    }
    let x = cv.w / 2;
    if (cover) {
        const imageX = Math.round((cv.w - coverWidth - textWidth) / 2);
        cv.drawImage(cover.data, cover.width, cover.height, imageX, (cv.h - side) / 2, side, side);
        x = imageX + side + gap;
    }
    const y = (cv.h - HUD_TEXTURE.h) / 2;
    cv.text(title, x, y + (artist ? 22 : 32), titleSize, '#ffffff', titleStyle);
    if (artist) cv.text(artist, x, y + 43, artistSize, '#dce7f4', artistStyle);
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

function place(area, cx, cy, scale, texture) {
    scale = Math.min(scale, area.w / texture.w, area.h / texture.h);
    const w = Math.round(texture.w * scale), h = Math.round(texture.h * scale);
    if (h < 16) return null;
    return {
        x: Math.max(area.x, Math.min(area.x + area.w - w, Math.round(cx - w / 2))),
        y: Math.max(area.y, Math.min(area.y + area.h - h, Math.round(cy - h / 2))),
        w, h,
    };
}

class MediaOutput {
    constructor(makeClient, Canvas, ScaledCanvas, artwork = new AlbumArt()) {
        this.makeClient = makeClient;
        this.Canvas = Canvas;
        this.ScaledCanvas = ScaledCanvas;
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
            bounded(settings.get('positionY'), 350, 110, 440), bounded(settings.get('hudSize'), 100, 60, 150) / 100, HUD_TEXTURE);
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
        this.sync('cluster', target, place(area, cx, cy, scale, CLUSTER_TEXTURE), track, cover);
    }

    sync(name, target, rect, track, cover) {
        const cluster = name === 'cluster';
        const texture = cluster ? CLUSTER_TEXTURE : HUD_TEXTURE;
        let layer = this.layers[name];
        if (!rect || layer && layer.target !== target) {
            this.drop(name);
            layer = null;
        }
        if (!rect) return;
        if (!layer) {
            const ref = this.client.image(Object.assign({ target, klass: 'overlay', z: 11,
                iw: texture.w * texture.scale, ih: texture.h * texture.scale,
                sampling: cluster ? 'bilinear' : 'nearest', fps: 4, contend: 0, yield: 1 }, rect));
            if (!ref) return;
            layer = this.layers[name] = { ref, target, rect, key: '' };
        } else if (Object.keys(rect).some((key) => rect[key] !== layer.rect[key])) {
            this.client.set(layer.ref, rect);
            layer.rect = rect;
        }
        const key = JSON.stringify([track.title, track.artist, cover ? track.cover : null]);
        if (layer.key === key) return;
        const cv = cluster ? new this.ScaledCanvas(texture.w, texture.h, texture.scale)
            : new this.Canvas(texture.w, texture.h);
        drawTrack(cv.clear(), track, cover, cluster);
        const pixels = cluster ? cv.canvas.d : cv.d;
        const bytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        if (this.client.pixels(layer.ref, null, bytes)) layer.key = key;
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
        this.artwork.get(null, false);
    }
}

module.exports = { MediaOutput, fitText, drawTrack };
