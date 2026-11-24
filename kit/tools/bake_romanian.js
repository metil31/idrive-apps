'use strict';
// Adds Romanian Latin glyphs to the existing pre-baked atlases without changing
// their typefaces. The accents are rasterized from the same alpha data so the
// generated files remain deterministic and do not need a host font package.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const INPUT = path.join(ROOT, 'runtime', 'fonts');
const OUTPUT = path.join(ROOT, 'localization', 'fonts', 'ro');
const targets = [
  ['ă', 'a', 'breve'], ['Ă', 'A', 'breve'],
  ['â', 'a', 'circ'], ['Â', 'A', 'circ'],
  ['î', 'i', 'circ'], ['Î', 'I', 'circ'],
  ['ș', 's', 'comma'], ['Ș', 'S', 'comma'],
  ['ț', 't', 'comma'], ['Ț', 'T', 'comma']
];

function put(buf, w, h, x, y, value) {
  if (x >= 0 && x < w && y >= 0 && y < h) {
    const i = y * w + x;
    if (value > buf[i]) buf[i] = value;
  }
}

function line(buf, w, h, x0, y0, x1, y1, thick) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / steps);
    const y = Math.round(y0 + (y1 - y0) * i / steps);
    for (let dx = -thick; dx <= thick; dx++) for (let dy = -thick; dy <= thick; dy++) put(buf, w, h, x + dx, y + dy, 255);
  }
}

function glyphImage(alpha, atlasW, glyph, size, accent) {
  const [sx, sy, sw, sh, xoff, yoff, advance] = glyph;
  const extra = Math.max(3, Math.round(size * 0.18));
  const top = accent === 'comma' ? 0 : extra;
  const bottom = accent === 'comma' ? extra : 0;
  const w = Math.max(sw, Math.round(size * 0.5));
  const h = sh + top + bottom;
  const out = Buffer.alloc(w * h);
  const dx = Math.floor((w - sw) / 2);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) out[(y + top) * w + x + dx] = alpha[(sy + y) * atlasW + sx + x];
  const cx = Math.floor(w / 2), thick = size >= 32 ? 1 : 0;
  if (accent === 'circ') {
    line(out, w, h, cx - extra, top - 1, cx, 0, thick);
    line(out, w, h, cx, 0, cx + extra, top - 1, thick);
  } else if (accent === 'breve') {
    line(out, w, h, cx - extra, 0, cx - Math.floor(extra / 2), top - 2, thick);
    line(out, w, h, cx - Math.floor(extra / 2), top - 2, cx + Math.floor(extra / 2), top - 2, thick);
    line(out, w, h, cx + Math.floor(extra / 2), top - 2, cx + extra, 0, thick);
  } else {
    const y = sh + 1;
    line(out, w, h, cx + 1, y, cx - 1, h - 1, thick);
  }
  return { pixels: out, w, h, xoff: xoff - dx, yoff: yoff - top, advance };
}

function bake(name) {
  const data = JSON.parse(fs.readFileSync(path.join(INPUT, name), 'utf8'));
  data.cacheKey = (data.cacheKey || data.family || name) + '/ro-1';
  for (const face of data.sizes) {
    const old = zlib.inflateSync(Buffer.from(face.alpha, 'base64'));
    const available = targets.filter(([, base]) => face.glyphs[base.codePointAt(0)]);
    if (!available.length) continue; // numeric-only atlases never draw Romanian words
    const images = available.map(([ch, base, accent]) => [ch, glyphImage(old, face.atlasW, face.glyphs[base.codePointAt(0)], face.size, accent)]);
    const rowH = Math.max(...images.map(([, image]) => image.h)) + 2;
    const nextH = face.atlasH + rowH;
    const alpha = Buffer.alloc(face.atlasW * nextH);
    old.copy(alpha);
    let x = 0;
    for (const [ch, image] of images) {
      if (x + image.w > face.atlasW) throw new Error('Romanian glyph row exceeds atlas width');
      const y = face.atlasH + 1;
      for (let gy = 0; gy < image.h; gy++) image.pixels.copy(alpha, (y + gy) * face.atlasW + x, gy * image.w, (gy + 1) * image.w);
      face.glyphs[ch.codePointAt(0)] = [x, y, image.w, image.h, image.xoff, image.yoff, image.advance];
      x += image.w + 2;
    }
    face.atlasH = nextH;
    face.alpha = zlib.deflateSync(alpha, { level: 9 }).toString('base64');
  }
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT, name), JSON.stringify(data) + '\n');
}

for (const name of ['label.json', 'bold.json', 'light.json', 'num.json']) bake(name);
console.log('Romanian font atlases written to ' + OUTPUT);
