'use strict';

const WIDTH = 410, HEIGHT = 56;
const TITLE = { align: 'center', font: 'bold', literal: true };
const ARTIST = { align: 'center', font: 'label', literal: true };

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

class MediaOutput {
    constructor(makeClient, Canvas) {
        this.makeClient = makeClient;
        this.Canvas = Canvas;
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
                this.key = '';
                this.update(this.last.track, this.last.settings);
            });
            client.on('disconnected', () => { if (client === this.client) this.ready = false; });
            client.connect();
        }
        if (!this.ready) return;
        const x = 400 + bounded(settings.get('positionX'), 0, -180, 180) - WIDTH / 2;
        const y = bounded(settings.get('positionY'), 350, 110, 440) - HEIGHT / 2;
        if (!this.ref) {
            this.ref = this.client.image({ target: 'hud', klass: 'overlay', z: 11, x, y,
                w: WIDTH, h: HEIGHT, iw: WIDTH, ih: HEIGHT, fps: 4, yield: 1 });
            if (!this.ref) return;
        } else if (this.x !== x || this.y !== y) {
            this.client.set(this.ref, { x, y });
        }
        this.x = x;
        this.y = y;
        const key = JSON.stringify([track.title, track.artist]);
        if (key === this.key) return;
        const cv = new this.Canvas(WIDTH, HEIGHT).clear();
        cv.text(fitText(cv, track.title, 18, WIDTH - 16, TITLE), WIDTH / 2, track.artist ? 22 : 32, 18, '#ffffff', TITLE);
        if (track.artist) cv.text(fitText(cv, track.artist, 15, WIDTH - 16, ARTIST), WIDTH / 2, 43, 15, '#dce7f4', ARTIST);
        const bytes = Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.byteLength);
        if (this.client.pixels(this.ref, null, bytes)) this.key = key;
    }

    stop() {
        const client = this.client;
        this.client = null;
        if (client) {
            if (this.ref) client.drop(this.ref);
            client.close();
        }
        this.ref = 0;
        this.ready = false;
        this.key = '';
    }
}

module.exports = { MediaOutput, fitText };
