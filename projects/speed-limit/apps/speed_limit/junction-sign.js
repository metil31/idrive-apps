'use strict';

const { inflateSync } = require('zlib');
const { Canvas } = require('./kit/canvas');
const art = require('./junction-art');

const sprites = {};

function junctionFrame(item, size, onLeft) {
    const label = item.demo ? 'DEMO ' + item.metres + ' m' : item.metres + ' m';
    const gap = Math.max(3, Math.round(size * 0.06));
    const font = Math.max(10, Math.round(size * (item.demo ? 0.24 : 0.32)));
    const style = { literal: true, font: 'bold', align: onLeft ? 'right' : 'left' };
    const template = item.demo ? 'DEMO 99 m' : '99 m';
    const width = Math.ceil(new Canvas(1, 1).textWidth(template, font, style)) + 2;
    const extra = gap + width;
    const cx = (onLeft ? extra : 0) + size / 2;
    const canvas = new Canvas(size + extra, size);
    const icon = Math.round(size * 0.84);
    if (!sprites[item.kind]) sprites[item.kind] = inflateSync(Buffer.from(art[item.kind], 'base64'));
    canvas.drawImage(sprites[item.kind], 96, 96, Math.round(cx - icon / 2), Math.round((size - icon) / 2), icon, icon);
    canvas.text(label, onLeft ? extra - gap : size + gap, size / 2 + font * 0.36, font, '#ffffff', style);
    return { w: canvas.w, offset: onLeft ? extra : 0, px: Buffer.from(canvas.d.buffer, canvas.d.byteOffset, canvas.d.length) };
}

function opacity(pixels, value) {
    if (value === 1) return pixels;
    const result = Buffer.from(pixels);
    for (let i = 3; i < result.length; i += 4) result[i] = Math.round(result[i] * value);
    return result;
}

module.exports = { junctionFrame, opacity };
