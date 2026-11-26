'use strict';

const TEXTURE_SCALE = 2;
const WIDTH = 410, HEIGHT = 64;
const Y = { high: 122, middle: 186, low: 252 };
const ARROW_W = 40, ARROW_H = 30;

function drawArrow(cv, direction, color) {
    const mirror = direction === 'left' ? -1 : 1;
    const outline = [[-14, -5], [0, -5], [0, -11], [14, 0], [0, 11], [0, 5], [-14, 5]];
    cv.fill(outline.map(([x, y]) => [ARROW_W / 2 + x * mirror, ARROW_H / 2 + y]), color);
}

function boundedSetting(settings, key, fallback, min, max) {
    const value = settings.get(key);
    return Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;
}

class HudOutput {
    constructor(makeClient, ScaledCanvas) {
        this.makeClient = makeClient;
        this.ScaledCanvas = ScaledCanvas;
        this.client = null;
        this.layers = {};
        this.ready = false;
    }

    update(view, settings) {
        if (view.direction === 'off' && !view.eta) { this.stop(); return; }
        this.last = { view, settings };
        if (!this.client) {
            const c = this.client = this.makeClient();
            c.on('ready', () => {
                if (c !== this.client) return;
                this.ready = true;
                Object.keys(this.layers).forEach((name) => { this.layers[name].key = null; });
                this.update(this.last.view, this.last.settings);
            });
            c.on('disconnected', () => { this.ready = false; });
            c.connect();
        }
        if (!this.ready) return;
        const dim = settings.get('brightness') === 'dim';
        if (view.eta) {
            this.render('eta', 195, Y[settings.get('position')] || Y.low, WIDTH, HEIGHT, view.eta + '|' + dim, (cv) => {
                cv.text(view.eta, WIDTH / 2, 40, 18, dim ? [245, 245, 245, 165] : '#ffffff',
                    { align: 'center', font: 'bold', literal: true });
            });
        } else this.drop('eta');

        const centre = 400 + boundedSetting(settings, 'indicatorX', 0, -100, 100);
        const y = boundedSetting(settings, 'indicatorY', 286, 126, 366) - ARROW_H / 2;
        const halfGap = boundedSetting(settings, 'indicatorGap', 362, 122, 482) / 2;
        const green = dim ? [67, 255, 107, 145] : '#43ff6b';
        for (const direction of ['left', 'right']) {
            if (view.direction !== direction && view.direction !== 'both') { this.drop(direction); continue; }
            const x = Math.round(centre + (direction === 'left' ? -halfGap : halfGap) - ARROW_W / 2);
            this.render(direction, x, y, ARROW_W, ARROW_H, view.bright ? 'on|' + dim : 'off', (cv) => {
                if (view.bright) drawArrow(cv, direction, green);
            });
        }
    }

    render(name, x, y, w, h, key, draw) {
        let layer = this.layers[name];
        if (!layer) {
            const ref = this.client.image({ target: 'hud', klass: 'overlay', z: name === 'eta' ? 12 : 13,
                x, y, w, h, iw: w * TEXTURE_SCALE, ih: h * TEXTURE_SCALE, sampling: 'bilinear', fps: 4, yield: 1 });
            if (!ref) return;
            layer = this.layers[name] = { ref, x, y, key: null };
        } else if (x !== layer.x || y !== layer.y) {
            this.client.set(layer.ref, { x, y });
            Object.assign(layer, { x, y });
        }
        if (key === layer.key) return;
        const cv = new this.ScaledCanvas(w, h, TEXTURE_SCALE).clear();
        draw(cv);
        const pixels = cv.canvas.d;
        const bytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        if (this.client.pixels(layer.ref, null, bytes)) layer.key = key;
    }

    drop(name) {
        if (!this.layers[name]) return;
        this.client.drop(this.layers[name].ref);
        delete this.layers[name];
    }

    stop() {
        if (!this.client) return;
        Object.keys(this.layers).forEach((name) => this.drop(name));
        this.client.close();
        this.client = null;
        this.ready = false;
    }
}

module.exports = { HudOutput };
