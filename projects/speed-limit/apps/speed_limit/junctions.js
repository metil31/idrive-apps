'use strict';

const { groundScale } = require('./limitpack');

const RANGE = 90;
const DEMO = { yield: 60, stop: 40 };

function project(points, x, y) {
    let best = Infinity, chosen = 0, measured = 0;
    for (let i = 2; i < points.length; i += 2) {
        const dx = points[i] - points[i - 2], dy = points[i + 1] - points[i - 1];
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        const sx = x - points[i - 2], sy = y - points[i - 1];
        const u = Math.max(0, Math.min(1, (sx * dx + sy * dy) / (length * length)));
        const d = Math.hypot(sx - dx * u, sy - dy * u);
        if (d < best) { best = d; chosen = measured + length * u; }
        measured += length;
    }
    return { along: chosen, off: best, length: measured };
}

function distance(pack, fix, road, marker) {
    const scale = groundScale(fix.y), x = marker[3], y = marker[4];
    if (Math.hypot(x - fix.x, y - fix.y) * scale > RANGE + 10) return null;
    const ids = pack.near(fix.x, fix.y, (RANGE + 10) / scale)
        .filter((id) => pack.piece(id).way === road.way);
    if (ids.indexOf(road.piece) < 0) return null;
    const pieces = pack.chain(ids);
    const along = { car: null, sign: null, best: Infinity };
    let offset = 0, group = 0, end = null;
    for (const id of pieces) {
        const points = pack.points(id);
        if (end && Math.hypot(points[0] - end[0], points[1] - end[1]) > 1) group++;
        const at = project(points, x, y);
        if (at.off < along.best) {
            along.best = at.off;
            along.sign = { at: offset + at.along, group };
        }
        if (id === road.piece) {
            along.car = { at: offset + project(points, fix.x, fix.y).along, group };
        }
        offset += at.length;
        end = points.slice(-2);
    }
    if (!along.sign || !along.car || along.sign.group !== along.car.group || along.best * scale > 3) return null;
    const metres = (along.sign.at - along.car.at) * road.dir * scale;
    return metres > 3 && metres <= RANGE ? metres : null;
}

class Junctions {
    constructor(pack, records) {
        this.pack = pack;
        this.byWay = new Map();
        for (const item of records) {
            if (!this.byWay.has(item[0])) this.byWay.set(item[0], []);
            this.byWay.get(item[0]).push(item);
        }
        this.last = null;
    }

    update(fix, road) {
        let best = null;
        const onWay = fix && road && road.state === 'match' && road.junctionMatch && this.byWay.get(road.way);
        if (onWay) {
            for (const item of onWay) {
                if (item[1] !== road.dir) continue;
                const metres = distance(this.pack, fix, road, item);
                if (metres !== null && (!best || metres < best.metres)) best = { item, metres };
            }
        }
        const same = !!best && this.last === best.item;
        this.last = best ? best.item : null;
        return same ? { kind: best.item[2], metres: Math.max(5, Math.round(best.metres / 5) * 5) } : null;
    }
}

function demoAllowed(condition, speed) {
    return (condition === 7 || condition === 10) && Number.isFinite(speed) && speed >= 0 && speed < 0.5;
}

module.exports = { Junctions, DEMO, demoAllowed };
