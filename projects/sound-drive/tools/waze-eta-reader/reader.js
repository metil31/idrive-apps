'use strict';

const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');
const { model, readEta } = require('./ocr');
const FONT = require('./eta-atlas.json');
const INTERVAL = 4000;
const KEEP = 120000;
const SESSION = 30 * 60 * 1000;
const START_WINDOW = 45000;
const FRAME = '/run/waze-eta-reader/frame.rgb';
const SOCKET = '/run/waze-eta-reader/control.sock';
const SIZES = [[1920, 720], [1280, 480], [1440, 540], [960, 360]];

function state(now) {
    let end = 0, front = null, bootstrap = 0, generation = 0;
    let last = null, candidate = null, code = 'idle';
    const active = () => now() < end;
    const canCapture = () => front === true || (front === null && now() < bootstrap);
    return {
        start() {
            end = now() + SESSION; bootstrap = now() + START_WINDOW;
            if (front === false) front = null;
            generation++; last = null; candidate = null; code = 'waiting';
        },
        stop() { end = 0; generation++; last = null; candidate = null; code = 'idle'; },
        setFront(value) {
            if (value === front) return;
            front = value; generation++; candidate = null; code = value ? 'waiting' : 'hidden';
        },
        captureToken() { return active() && canCapture() ? generation : null; },
        result(token, value, reason) {
            if (!active() || !canCapture() || token !== generation) return;
            const wasLive = code === 'live';
            code = value ? 'confirming' : reason;
            if (!value) { candidate = null; return; }
            const key = [value.arrival, value.duration, value.distance].join('|');
            if (candidate === key || (wasLive && last && last.key === key)) {
                last = { key, arrival: value.arrival, duration: value.duration, distance: value.distance,
                    layout: value.layout, at: now() };
                code = 'live';
            }
            candidate = key;
        },
        snapshot() {
            if (!active()) return { code: end ? 'ended' : 'idle', active: false };
            const age = last ? now() - last.at : Infinity;
            return { code: canCapture() ? code : front === null ? 'no-screen-event' : 'hidden', active: true,
                eta: age >= 0 && age < KEEP ? last : null,
                remembered: !!last && (!canCapture() || code !== 'live' || age > 12000) };
        },
    };
}

function run() {
    const probe = state(Date.now), templates = model([FONT]);
    const interfaceInfo = {
        name: 'CarPlayManager', serviceId: 64353, version: { major: 0, minor: 5 },
        instances: { CarPlayManagerInst1: 128 }, methods: {}, fields: {},
        events: { onScreenChange: { id: 32773, groups: [5],
            schema: { t: 'Enum', e: { PROJECTED: 0, NATIVE: 1 } } } },
        eventGroups: { fields: {}, events: { '32773': [5] } },
    };
    let gateStatus = 'initializing';
    Promise.resolve().then(() => require('/usr/lib/someip.node').buildProxy(interfaceInfo, 'CarPlayManagerInst1')).then(async (proxy) => {
        await proxy.init();
        await proxy.subscribe({ name: 'onScreenChange', onReceive: (value) => {
            const owner = value && typeof value === 'object' ? value.screenOwner : value;
            if (owner === 0 || owner === 'PROJECTED') probe.setFront(true);
            if (owner === 1 || owner === 'NATIVE') probe.setFront(false);
        } });
        gateStatus = 'ready';
        if (proxy.subscribeToAvailability) {
            try { await proxy.subscribeToAvailability((available) => { if (!available) probe.setFront(null); }); }
            catch (error) { console.warn('CarPlay availability: ' + error.message); }
        }
    }).catch((error) => { gateStatus = 'unavailable'; console.error('CarPlay: ' + error.message); });

    let capturing = false;
    let captureDetail = '';
    function clearFrame() { try { fs.unlinkSync(FRAME); } catch (error) {} }
    function capture() {
        const token = probe.captureToken();
        if (capturing || token === null) return;
        capturing = true;
        clearFrame();
        execFile('/usr/bin/winston-grabber', ['-s', 'center', '-n', '1', FRAME], { timeout: 6000 }, (error) => {
            try {
                if (token !== probe.captureToken()) return;
                if (error) {
                    captureDetail = error.killed ? 'Timp expirat' : error.code === 'ENOENT' ? 'Utilitar absent' :
                        Number.isInteger(error.code) ? 'Cod ' + error.code : 'Eroare la pornire';
                    probe.result(token, null, 'capture-failed'); return;
                }
                const size = fs.statSync(FRAME).size;
                const base = Math.sqrt(size / 96);
                const dims = SIZES.find(([w, h]) => w * h * 4 === size) ||
                    (Number.isInteger(base) && base >= 100 && base <= 320 ? [base * 8, base * 3] : null);
                captureDetail = dims ? dims.join(' × ') : size + ' octeți';
                if (!dims) { probe.result(token, null, 'capture-format'); return; }
                const frame = fs.readFileSync(FRAME);
                const eta = readEta(frame, dims[0], dims[1], templates);
                probe.result(token, eta, 'no-eta');
            } catch (err) {
                console.warn('ETA read: ' + err.message);
                captureDetail = err.code === 'ENOENT' ? 'Captura nu a produs un cadru' : 'Cadrul nu a putut fi citit';
                probe.result(token, null, 'capture-failed');
            } finally { clearFrame(); capturing = false; }
        });
    }
    setInterval(capture, INTERVAL);
    // Only three fixed operations. No file paths or arbitrary commands from clients.
    const server = net.createServer((socket) => {
        let input = '';
        socket.setTimeout(1500, () => socket.destroy());
        socket.on('error', () => socket.destroy());
        socket.on('data', (data) => {
            input += data.toString('utf8');
            if (input.length > 8) { socket.destroy(); return; }
            if (!input.endsWith('\n')) return;
            socket.pause();
            const command = input.slice(0, -1);
            if (command === 'start') { captureDetail = ''; probe.start(); }
            else if (command === 'stop') probe.stop();
            else if (command !== 'get') { socket.destroy(); return; }
            socket.end(JSON.stringify(Object.assign(probe.snapshot(), { gateStatus, captureDetail })) + '\n');
        });
    });
    try { fs.unlinkSync(SOCKET); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    server.maxConnections = 8;
    server.listen(SOCKET, () => {
        const entry = fs.readFileSync('/etc/group', 'utf8').split('\n')
            .find((row) => row.split(':')[0] === 'tm_oap_app');
        if (!entry) throw new Error('OAP application group is missing');
        fs.chownSync(SOCKET, 0, Number(entry.split(':')[2]));
        fs.chmodSync(SOCKET, 0o660);
    });
}

if (require.main === module) run();
module.exports = { state, KEEP };
