'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { decodePng } = require('./capture-png');

const DELAY_MS = 12000;
const SIZES = [[1280, 480], [1440, 540], [1920, 720]];
const REGIONS = {
    dashboard: { eta: [333, 422, 640, 455], arrow: [899, 37, 951, 91], distance: [961, 46, 1051, 85] },
    full: { eta: [102, 398, 286, 466], arrow: [110, 26, 160, 76], distance: [167, 30, 264, 76] },
};

function brightFraction(frame, width, height, channels, rect) {
    const [left, top, right, bottom] = rect.map((v, i) => Math.round(v * (i % 2 ? height / 480 : width / 1280)));
    let bright = 0;
    for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
            const i = (y * width + x) * channels;
            const low = Math.min(frame[i], frame[i + 1], frame[i + 2]);
            const high = Math.max(frame[i], frame[i + 1], frame[i + 2]);
            if (low > 190 && high - low < 35) bright++;
        }
    }
    return bright / ((right - left) * (bottom - top));
}

function inspectFrame(frame, width, height, channels = 4) {
    const matches = {};
    for (const layout of Object.keys(REGIONS)) {
        const region = REGIONS[layout];
        const eta = brightFraction(frame, width, height, channels, region.eta) >= 0.05;
        const turn = eta && brightFraction(frame, width, height, channels, region.arrow) >= 0.06 &&
            brightFraction(frame, width, height, channels, region.distance) >= 0.07;
        matches[layout] = { eta, turn };
    }
    return { width, height, matches };
}

function runCapture(run, tool, args, env) {
    return new Promise((resolve, reject) => {
        run(tool, args, { env, timeout: 6000, maxBuffer: 16384 }, (error, stdout, stderr) => {
            if (!error) { resolve(); return; }
            error.detail = String(stderr || stdout || '');
            reject(error);
        });
    });
}

function captureError(error) {
    const detail = error.detail || '';
    if (error.code === 'EACCES' || error.code === 'EPERM' || /permission denied|not permitted|access denied|denied/i.test(detail)) {
        return 'acces refuzat';
    }
    if (error.killed) return 'timp expirat';
    if (error.code === 'ENOENT') return 'utilitar sau fișier absent';
    if (error.code === 'FRAME') return 'format necunoscut';
    if (/wayland|display|compositor|socket/i.test(detail)) return 'ecran indisponibil';
    return typeof error.code === 'number' ? 'cod ' + error.code : 'eroare';
}

async function captureFrame(dataDir, run = execFile) {
    const dir = fs.mkdtempSync(path.join(dataDir, '.waze-capture-'));
    const rgb = path.join(dir, 'frame.rgb'), png = path.join(dir, 'frame.png');
    const env = Object.assign({ WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/wayland' }, process.env);
    const errors = [];
    try {
        try {
            await runCapture(run, 'winston-grabber', ['-s', 'center', '-n', '1', rgb], env);
            const size = fs.statSync(rgb).size;
            const dims = SIZES.find(([w, h]) => w * h * 4 === size);
            if (!dims) throw Object.assign(new Error('unknown raw frame size'), { code: 'FRAME' });
            return Object.assign(inspectFrame(fs.readFileSync(rgb), dims[0], dims[1]), { method: 'RAW' });
        } catch (e) { errors.push('RAW: ' + captureError(e)); }

        try {
            await runCapture(run, 'ivi-screenshot-control', ['--screenshot', 'center', '-f', png], env);
            if (fs.statSync(png).size > 8 * 1024 * 1024) throw Object.assign(new Error('oversize image'), { code: 'FRAME' });
            const image = await decodePng(fs.readFileSync(png)).catch(() => {
                throw Object.assign(new Error('unsupported PNG'), { code: 'FRAME' });
            });
            return Object.assign(inspectFrame(image.frame, image.width, image.height, image.channels), { method: 'PNG' });
        } catch (e) { errors.push('PNG: ' + captureError(e)); }
        return { errors };
    } finally {
        for (const file of [rgb, png]) {
            try { fs.unlinkSync(file); } catch (e) { /* capture may not have produced a file */ }
        }
        try { fs.rmdirSync(dir); } catch (e) { /* already gone */ }
    }
}

function resultText(result) {
    if (result.errors) return 'Captură eșuată · ' + result.errors.join(' · ');
    const label = (key) => {
        const match = result.matches[key];
        return [match.eta ? 'ETA' : '', match.turn ? 'viraj' : ''].filter(Boolean).join(' și ') || 'fără indicii';
    };
    return 'Captură ' + result.method + ' ' + result.width + ' × ' + result.height + ' · Compact: ' + label('dashboard') +
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
                message = 'Pregătirea capturii a eșuat: ' + captureError(error) + '.';
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
