'use strict';

const WIDTH = 410, HEIGHT = 64;
const Y = { high: 122, middle: 186, low: 252 };

function arrow(cv, x, y, direction, color) {
    const scale = direction === 'left' ? -1 : 1;
    const point = (dx, dy) => [x + dx * scale, y + dy];
    cv.polyline([point(-12, 0), point(11, 0)], 4, color);
    cv.polyline([point(3, -8), point(11, 0), point(3, 8)], 4, color);
}

function drawHud(cv, view, dim) {
    cv.clear();
    const ink = dim ? [245, 245, 245, 165] : '#ffffff';
    const green = dim ? [80, 255, 170, 145] : '#50ffaa';
    if (view.eta) {
        cv.text(view.eta, WIDTH / 2, 40, 18, ink, { align: 'center', font: 'bold', literal: true });
    }
    if (view.bright) {
        if (view.direction === 'left' || view.direction === 'both') arrow(cv, 24, 34, 'left', green);
        if (view.direction === 'right' || view.direction === 'both') arrow(cv, WIDTH - 24, 34, 'right', green);
    }
    return cv;
}

class HudOutput {
    constructor(makeClient, Canvas) {
        this.makeClient = makeClient;
        this.Canvas = Canvas;
        this.client = null;
        this.layer = 0;
        this.ready = false;
        this.key = '';
    }

    update(view, settings) {
        if (view.direction === 'off' && !view.eta) { this.stop(); return; }
        const y = Y[settings.get('position')] || Y.low;
        const dim = settings.get('brightness') === 'dim';
        if (!this.client) {
            const c = this.client = this.makeClient();
            c.on('ready', () => { this.ready = true; this.key = ''; this.update(this.last.view, this.last.settings); });
            c.on('disconnected', () => { this.ready = false; });
            this.last = { view, settings };
            c.connect();
        }
        this.last = { view, settings };
        if (!this.ready) return;
        if (!this.layer) {
            this.layer = this.client.image({ target: 'hud', klass: 'overlay', z: 12, x: 195, y, w: WIDTH, h: HEIGHT,
                iw: WIDTH, ih: HEIGHT, fps: 4, yield: 1 });
            if (!this.layer) return;
            this.y = y;
        } else if (y !== this.y) {
            this.client.set(this.layer, { y });
            this.y = y;
        }
        const key = [view.direction, view.direction === 'off' ? false : view.bright, view.eta, dim].join('|');
        if (this.key === key) return;
        const cv = drawHud(new this.Canvas(WIDTH, HEIGHT), view, dim);
        if (this.client.pixels(this.layer, null, Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.byteLength))) this.key = key;
    }

    stop() {
        if (!this.client) return;
        if (this.layer) this.client.drop(this.layer);
        this.client.close();
        this.client = null;
        this.layer = 0;
        this.ready = false;
        this.key = '';
    }
}

module.exports = { HudOutput, drawHud, WIDTH, HEIGHT };
