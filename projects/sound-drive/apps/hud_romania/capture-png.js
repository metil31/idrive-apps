'use strict';

const { createInflate } = require('zlib');
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readHeader(png) {
    if (png.length < 33 || !png.slice(0, 8).equals(SIGNATURE) || png.readUInt32BE(8) !== 13 ||
        png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('invalid PNG header');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const channels = { 2: 3, 6: 4 }[png[25]];
    if (!channels || png[24] !== 8 || png[26] || png[27] || png[28] ||
        height < 240 || height > 1080 || width > 2560 || Math.abs(width / height - 1280 / 480) > 0.03) {
        throw new Error('unsupported PNG format');
    }
    return { width, height, channels };
}

function inflateRows(parts, length) {
    return new Promise((resolve, reject) => {
        const inflate = createInflate();
        const rows = Buffer.alloc(length);
        let used = 0;
        inflate.on('error', reject);
        inflate.on('data', (chunk) => {
            if (used + chunk.length > length) {
                reject(new Error('excess PNG data'));
                inflate.destroy();
                return;
            }
            chunk.copy(rows, used);
            used += chunk.length;
        });
        inflate.on('end', () => {
            if (used === length) resolve(rows);
            else reject(new Error('incomplete PNG data'));
        });
        inflate.end(Buffer.concat(parts));
    });
}

function paeth(left, up, diagonal) {
    const estimate = left + up - diagonal;
    const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - diagonal);
    if (a <= b && a <= c) return left;
    return b <= c ? up : diagonal;
}

async function decodePng(png) {
    const { width, height, channels } = readHeader(png);
    const parts = [];
    let complete = false;
    for (let offset = 33; offset + 12 <= png.length;) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('ascii', offset + 4, offset + 8);
        const next = offset + 12 + length;
        if (next > png.length) throw new Error('truncated PNG chunk');
        if (type === 'IDAT') parts.push(png.slice(offset + 8, next - 4));
        if (type === 'IEND') { complete = true; break; }
        offset = next;
    }
    if (!complete || !parts.length) throw new Error('missing PNG image data');
    const pitch = width * channels;
    const rows = await inflateRows(parts, height * (pitch + 1));
    const frame = Buffer.alloc(height * pitch);
    const filters = [() => 0, (left) => left, (left, up) => up, (left, up) => (left + up) >> 1, paeth];
    for (let y = 0; y < height; y++) {
        const start = y * pitch, source = start + y;
        const predict = filters[rows[source]];
        if (!predict) throw new Error('invalid PNG filter');
        for (let x = 0; x < pitch; x++) {
            const left = x >= channels ? frame[start + x - channels] : 0;
            const up = y ? frame[start + x - pitch] : 0;
            const diagonal = y && x >= channels ? frame[start + x - pitch - channels] : 0;
            frame[start + x] = rows[source + 1 + x] + predict(left, up, diagonal);
        }
    }
    return { frame, width, height, channels };
}

module.exports = { decodePng };
