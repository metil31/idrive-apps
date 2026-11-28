'use strict';

const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');
const { model, readEta, readMetricTrip, readTurn, readSpeedLimit, hasWazeDock } = require('./ocr');
const INTERVAL = 4000;
const KEEP = 120000;
const TURN_KEEP = 9500;
const LEASE = 12000;
const LIMIT_KEEP = 6500;
const START_WINDOW = 45000;
const FRAME = '/run/waze-eta-reader/frame.rgb';
const SOCKET = '/run/waze-eta-reader/control.sock';
const SIZES = [[1920, 720], [1280, 480], [1440, 540], [960, 360]];

function state(now) {
    const ends = { navigation: 0, limit: 0 };
    let front = null, bootstrap = 0, generation = 0, guidance = false;
    let last = null, candidate = null, code = 'idle';
    let lastTurn = null, candidateTurn = null, missedTurn = false;
    let candidateLanes = '';
    const clearTurn = () => { lastTurn = candidateTurn = null; missedTurn = false; candidateLanes = ''; };
    let lastLimit = null, candidateLimit = null;
    const clearLimit = () => { lastLimit = candidateLimit = null; };
    const leased = (channel) => now() < ends[channel];
    const active = () => leased('navigation') || leased('limit');
    const canCapture = () => front === true || (front === null && (guidance || now() < bootstrap));
    return {
        start(channel = 'navigation') {
            if (!active()) {
                bootstrap = now() + START_WINDOW;
                if (front === false) front = null;
                generation++; last = null; candidate = null; code = 'waiting';
                clearTurn(); clearLimit();
            }
            if (channel === 'limit' && !leased('limit')) clearLimit();
            ends[channel] = now() + LEASE;
        },
        stop() {
            ends.navigation = 0;
            last = candidate = null;
            clearTurn();
            if (!active()) { generation++; code = 'idle'; clearLimit(); }
        },
        setFront(value) {
            if (value === front) return;
            front = value; generation++; candidate = null; code = value ? 'waiting' : 'hidden';
            clearTurn(); clearLimit();
        },
        setGuidance(value) { guidance = value === true || value === 1; },
        captureToken() { return active() && canCapture() ? generation : null; },
        wantsLimit: () => leased('limit'),
        wantsNavigation: () => leased('navigation'),
        result(token, value, reason, turn, limit, capturedAt = now()) {
            if (!active() || !canCapture() || token !== generation) return;
            if (!leased('limit') || !limit) clearLimit();
            else {
                const previous = candidateLimit;
                // A late or conflicting frame cannot refresh a previous road sign.
                lastLimit = previous && previous.kmh === limit && capturedAt > previous.at && capturedAt - previous.at < LIMIT_KEEP ?
                    { kmh: limit, at: capturedAt, since: previous.at } : null;
                candidateLimit = { kmh: limit, at: capturedAt };
            }
            if (!value || !turn) {
                if (missedTurn) clearTurn();
                else {
                    missedTurn = true; candidateTurn = null; candidateLanes = '';
                    if (lastTurn && lastTurn.kind === 'lanes') lastTurn = null;
                    else if (lastTurn) delete lastTurn.lanes;
                }
            } else {
                const key = turn.kind + ':' + (turn.exit || '');
                const verified = lastTurn && lastTurn.kind === turn.kind && lastTurn.exit === turn.exit &&
                    now() - lastTurn.at < TURN_KEEP;
                const laneKey = turn.lanes ? JSON.stringify(turn.lanes) : '';
                if (candidateTurn === key || verified) {
                    lastTurn = Object.assign({ at: now() }, turn);
                    if (candidateTurn !== key || candidateLanes !== laneKey) delete lastTurn.lanes;
                    if (turn.kind === 'lanes' && !lastTurn.lanes) lastTurn = null;
                } else lastTurn = null;
                missedTurn = false;
                candidateTurn = key;
                candidateLanes = laneKey;
            }
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
            if (!active()) return { code: 'idle', active: false };
            const age = last ? now() - last.at : Infinity;
            const limitAge = lastLimit ? now() - lastLimit.at : Infinity;
            return { code: canCapture() ? code : front === null ? 'no-screen-event' : 'hidden', active: true,
                eta: age >= 0 && age < KEEP ? last : null,
                limit: leased('limit') && canCapture() && limitAge >= 0 && limitAge < LIMIT_KEEP ? lastLimit : null,
                turn: canCapture() && lastTurn && now() - lastTurn.at < TURN_KEEP ? lastTurn : null };
        },
    };
}

function run() {
    const probe = state(Date.now);
    let templates;
    const interfaceInfo = {
        name: 'CarPlayManager', serviceId: 64353, version: { major: 0, minor: 5 },
        instances: { CarPlayManagerInst1: 128 }, methods: {},
        fields: { projectedGuidanceActive: { schema: { t: 'Bool' }, getter: { id: 2 }, event: { id: 32770, groups: [2] } } },
        events: { onScreenChange: { id: 32773, groups: [5],
            schema: { t: 'Enum', e: { PROJECTED: 0, NATIVE: 1 } } } },
        eventGroups: { fields: { '32770': [2] }, events: { '32773': [5] } },
    };
    let gateStatus = 'initializing', gate, gateEpoch = 0, guidanceDue = 0;
    function guidance(value) {
        probe.setGuidance(value && typeof value === 'object' ? value.projectedGuidanceActive : value);
        scheduleCapture();
    }
    function refreshGuidance() {
        if (!gate || !gate.getValue || Date.now() < guidanceDue) return;
        const proxy = gate, epoch = gateEpoch;
        guidanceDue = Date.now() + 12000;
        Promise.resolve().then(() => proxy.getValue('projectedGuidanceActive', 2500))
            .then(value => { if (gate === proxy && gateEpoch === epoch) guidance(value); }).catch(() => {});
    }
    async function connectGate() {
        let proxy;
        const screen = (value) => {
            if (gate !== proxy) return;
            const owner = value && typeof value === 'object' ? value.screenOwner : value;
            if (owner === 0 || owner === 'PROJECTED') probe.setFront(true);
            if (owner === 1 || owner === 'NATIVE') probe.setFront(false);
            scheduleCapture();
        };
        try {
            proxy = await require('/usr/lib/someip.node').buildProxy(interfaceInfo, 'CarPlayManagerInst1');
            await proxy.init();
            gate = proxy;
            await proxy.subscribe({ name: 'onScreenChange', onReceive: screen });
            try {
                await proxy.subscribe({ name: 'projectedGuidanceActive',
                    onReceive: value => { if (gate === proxy) guidance(value); } });
            } catch (error) { console.warn('CarPlay guidance event: ' + error.message); }
            if (proxy.subscribeToAvailability) {
                try { await proxy.subscribeToAvailability((available) => {
                    if (gate !== proxy) return;
                    guidanceDue = 0;
                    if (available) refreshGuidance();
                    else { gateEpoch++; probe.setGuidance(false); probe.setFront(null); scheduleCapture(); }
                }); } catch (error) { console.warn('CarPlay availability: ' + error.message); }
            }
            gateStatus = 'ready';
            refreshGuidance();
        } catch (error) {
            gate = null;
            gateStatus = 'unavailable';
            console.warn('CarPlay: ' + error.message);
            if (proxy && proxy.shutdown) Promise.resolve().then(() => proxy.shutdown()).catch(() => {});
            setTimeout(connectGate, 10000);
        }
    }

    let capturing = false, timer = null, nextCapture = 0;
    let captureDetail = '';
    function clearFrame() { try { fs.unlinkSync(FRAME); } catch (error) {} }
    function scheduleCapture() {
        if (probe.captureToken() === null) {
            if (timer !== null) clearTimeout(timer);
            timer = null;
            return;
        }
        if (capturing || timer !== null) return;
        timer = setTimeout(() => { timer = null; capture(); }, Math.max(0, nextCapture - Date.now()));
    }
    function capture() {
        const token = probe.captureToken(), capturedAt = Date.now();
        if (capturing || token === null) return;
        capturing = true;
        nextCapture = capturedAt + INTERVAL;
        clearFrame();
        execFile('/usr/bin/winston-grabber', ['-s', 'center', '-n', '1', FRAME], { timeout: 6000 }, (error) => {
            try {
                if (token !== probe.captureToken()) return;
                if (error) {
                    captureDetail = error.killed ? 'capture-timeout' : error.code === 'ENOENT' ? 'missing-capture-tool' :
                        Number.isInteger(error.code) ? 'exit:' + error.code : 'capture-start-failed';
                    probe.result(token, null, 'capture-failed'); return;
                }
                const size = fs.statSync(FRAME).size;
                const base = Math.sqrt(size / 96);
                const dims = SIZES.find(([w, h]) => w * h * 4 === size) ||
                    (Number.isInteger(base) && base >= 100 && base <= 320 ? [base * 8, base * 3] : null);
                captureDetail = dims ? dims.join(' × ') : size + ' bytes';
                if (!dims) { probe.result(token, null, 'capture-format'); return; }
                const frame = fs.readFileSync(FRAME);
                if (!templates) templates = model([require('./eta-atlas.json')]);
                const eta = readEta(frame, dims[0], dims[1], templates);
                let limit = null;
                if (probe.wantsLimit() && hasWazeDock(frame, dims[0], dims[1])) {
                    const layout = eta ? (/ (m|km)$/.test(eta.distance) ? eta.layout : null) :
                        readMetricTrip(frame, dims[0], dims[1], templates) ? 'fullscreen' : null;
                    if (layout) limit = readSpeedLimit(frame, dims[0], dims[1], templates, layout);
                }
                const turn = eta && probe.wantsNavigation() ? readTurn(frame, dims[0], dims[1], templates, eta.layout) : null;
                probe.result(token, eta, 'no-eta', turn, limit, capturedAt);
            } catch (err) {
                console.warn('ETA read: ' + err.message);
                captureDetail = err.code === 'ENOENT' ? 'no-frame' : 'unreadable-frame';
                probe.result(token, null, 'capture-failed');
            } finally { clearFrame(); capturing = false; scheduleCapture(); }
        });
    }
    // Only fixed operations. No file paths or arbitrary commands from clients.
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
            if (command === 'start') { if (!probe.snapshot().active) captureDetail = ''; probe.start(); }
            else if (command === 'stop') probe.stop();
            else if (command === 'limit') probe.start('limit');
            else if (command !== 'get') { socket.destroy(); return; }
            socket.end(JSON.stringify(Object.assign(probe.snapshot(), { gateStatus, captureDetail })) + '\n');
            if (command === 'start' || command === 'limit') refreshGuidance();
            scheduleCapture();
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
    connectGate();
}

if (require.main === module) run();
module.exports = { state, KEEP, LEASE };
