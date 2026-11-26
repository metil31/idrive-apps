'use strict';

const { inflateSync } = require('zlib');
const { Canvas, ScaledCanvas } = require('./kit/canvas');
const art = require('./junction-art');
const { TEXTURE_SCALE } = require('./sign');

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
    const canvas = new ScaledCanvas(size + extra, size, TEXTURE_SCALE);
    const icon = Math.round(size * 0.84);
    if (!sprites[item.kind]) sprites[item.kind] = inflateSync(Buffer.from(art[item.kind], 'base64'));
    canvas.drawImage(sprites[item.kind], 96, 96, Math.round(cx - icon / 2), Math.round((size - icon) / 2), icon, icon);
    canvas.text(label, onLeft ? extra - gap : size + gap, size / 2 + font * 0.36, font, '#ffffff', style);
    const pixels = canvas.canvas.d;
    return { w: canvas.w, offset: onLeft ? extra : 0, px: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length) };
}

module.exports = { junctionFrame };
