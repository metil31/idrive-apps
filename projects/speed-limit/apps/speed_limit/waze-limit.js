'use strict';

const net = require('net');
const SOCKET = '/run/waze-eta-reader/control.sock';
const MAX_AGE = 6500;
const POLL_MS = 1500;

function requestLimit(done) {
    const socket = net.createConnection(SOCKET, () => socket.write('limit\n'));
    let body = '';
    socket.setTimeout(1200, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
        body += chunk.toString('utf8');
        if (body.length > 2048) { body = ''; socket.destroy(); }
    });
    socket.on('close', hadError => {
        if (!hadError && body.endsWith('\n')) {
            try { const data = JSON.parse(body); done(data && data.limit); return; } catch (error) {}
        }
        done(null);
    });
}

function eligible(reading, roadSince, now) {
    return reading && Number.isInteger(reading.kmh) && reading.kmh >= 10 && reading.kmh <= 130 && reading.kmh % 5 === 0 &&
        Number.isFinite(reading.at) && Number.isFinite(reading.since) && reading.since >= roadSince &&
        reading.since < reading.at && reading.at - reading.since < MAX_AGE &&
        reading.at <= now && now - reading.at < MAX_AGE ? reading.kmh : null;
}

function chooseWazeLimit(waze, mode, offline) {
    if (!waze || (offline && offline.corrected)) return null;
    const uncertain = !offline || !offline.limit || offline.inferred || offline.uncertain || offline.variable;
    if (mode !== 'prefer' && !(mode === 'uncertain' && uncertain)) return null;
    return uncertain || offline.limit !== waze ? waze : null;
}

class WazeLimit {
    constructor(request = requestLimit) {
        this.request = request;
        this.reset();
    }

    reset() {
        this.epoch = {};
        this.pending = false;
        this.last = null;
        this.road = '';
        this.since = Infinity;
        this.due = 0;
    }

    tick(now, road) {
        if (this.road !== road) {
            this.last = null;
            this.road = road;
            this.since = road ? now : Infinity;
        }
        if (this.pending || now < this.due) return;
        this.pending = true;
        this.due = now + POLL_MS;
        const epoch = this.epoch;
        this.request(reading => {
            if (epoch !== this.epoch) return;
            this.last = reading;
            this.pending = false;
        });
    }

    value(now) { return this.road ? eligible(this.last, this.since, now) : null; }
}

module.exports = { WazeLimit, chooseWazeLimit };
