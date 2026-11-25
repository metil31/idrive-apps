'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DELAY_MS = 12000;
const SIZES = [[1280, 480], [1440, 540], [1920, 720]];
const REGIONS = {
    dashboard: { eta: [333, 422, 640, 455], arrow: [899, 37, 951, 91], distance: [961, 46, 1051, 85] },
    full: { eta: [102, 398, 286, 466], arrow: [110, 26, 160, 76], distance: [167, 30, 264, 76] },
};

function brightFraction(frame, width, height, rect) {
    const [left, top, right, bottom] = rect.map((v, i) => Math.round(v * (i % 2 ? height / 480 : width / 1280)));
    let bright = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const i = (y * width + x) * 4;
            const low = Math.min(frame[i], frame[i + 1], frame[i + 2]);
            const high = Math.max(frame[i], frame[i + 1], frame[i + 2]);
            if (low > 190 && high - low < 35) bright++;
        }
    }
    return bright / ((right - left) * (bottom - top));
}

function inspectFrame(frame, width, height) {
    const matches = {};
    for (const layout of Object.keys(REGIONS)) {
        const region = REGIONS[layout];
        const eta = brightFraction(frame, width, height, region.eta) >= 0.05;
        const turn = eta && brightFraction(frame, width, height, region.arrow) >= 0.06 &&
            brightFraction(frame, width, height, region.distance) >= 0.07;
        matches[layout] = { eta, turn };
    }
    return { width, height, matches };
}

function captureFrame(dataDir, run = execFile) {
    return new Promise((resolve, reject) => {
        const dir = fs.mkdtempSync(path.join(dataDir, '.waze-capture-'));
        const file = path.join(dir, 'frame.rgb');
        const env = Object.assign({}, process.env, { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/wayland' });
        function done(error) {
            try {
                if (error) return reject(error);
                const size = fs.statSync(file).size;
                const dims = SIZES.find(([w, h]) => w * h * 4 === size);
                if (!dims) return resolve({ bytes: size });
                return resolve(inspectFrame(fs.readFileSync(file), dims[0], dims[1]));
            } catch (e) {
                return reject(e);
            } finally {
                try { fs.unlinkSync(file); } catch (e) { /* no capture file */ }
                try { fs.rmdirSync(dir); } catch (e) { /* already gone */ }
            }
        }
        try {
            run('winston-grabber', ['-s', 'center', '-n', '1', file], { env, timeout: 6000, maxBuffer: 16384 }, done);
        } catch (e) { done(e); }
    });
}

function resultText(result) {
    if (!result.matches) return 'Cadru capturat, dimensiune necunoscută (' + result.bytes + ' octeți).';
    const label = (key) => {
        const match = result.matches[key];
        return [match.eta ? 'ETA' : '', match.turn ? 'viraj' : ''].filter(Boolean).join(' și ') || 'fără indicii';
    };
    return 'Captură ' + result.width + ' × ' + result.height + ' · Compact: ' + label('dashboard') +
        ' · Complet: ' + label('full');
}

function captureTest(dataDir, capture = captureFrame, clock = { now: Date.now, setTimeout, clearTimeout }) {
    let timer = null, deadline = 0, running = false, stopped = false;
    let message = 'Test Waze: pornește testul cu mașina staționată.';
    function start() {
        if (stopped || timer !== null || running) return;
        deadline = clock.now() + DELAY_MS;
        timer = clock.setTimeout(() => {
            timer = null;
            running = true;
            message = 'Se citește ecranul central…';
            capture(dataDir).then((result) => { message = resultText(result); }, (error) => {
                if (error.code === 'ENOENT') message = 'Captură indisponibilă: utilitarul de captură sau cadrul lipsește.';
                else if (error.code === 'EACCES' || error.code === 'EPERM') message = 'iDrive a refuzat accesul la captură.';
                else if (error.killed) message = 'Captura nu a răspuns la timp.';
                else message = 'Captura a eșuat' + (typeof error.code === 'number' ? ' (cod ' + error.code + ')' : '') + '.';
            }).then(() => { running = false; });
        }, DELAY_MS);
    }
    function status() {
        if (timer === null) return message;
        return 'Revino la Waze în ' + Math.max(1, Math.ceil((deadline - clock.now()) / 1000)) +
            ' s. După captură, redeschide HUD România.';
    }
    function stop() {
        stopped = true;
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
    }
    return { start, status, stop };
}

module.exports = { captureFrame, captureTest, inspectFrame };
