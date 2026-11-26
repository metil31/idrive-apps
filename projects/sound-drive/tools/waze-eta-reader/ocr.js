'use strict';

const WIDTH = 12, HEIGHT = 16;
const GLYPHS = '0123456789:,.·ETAarrivalhdminokms';
const AREAS = {
    dashboard: [[300, 421, 665, 458]],
    fullscreen: [[102, 400, 282, 428], [102, 433, 278, 460]],
};
const TURNS = {
    dashboard: [[899, 34, 954, 94], [956, 40, 1135, 87]],
    fullscreen: [[108, 24, 164, 79], [167, 30, 326, 76]],
};
const LEFT = ['001000000000', '011000000000', '111111100000', '111111111000',
    '011000011100', '001000001100', '000000000110', '000000000010', '000000000011',
    '000000000011', '000000000011', '000000000011', '000000000011', '000000000011',
    '000000000011', '000000000011'];
const ARROWS = { left: LEFT.join(''), right: LEFT.map(row => [...row].reverse().join('')).join('') };

function normalize(get, x0, y0, x1, y1) {
    const pixels = [];
    for (let y = 0; y < HEIGHT; ++y) {
        const sy = y0 + (y + 0.5) * (y1 - y0) / HEIGHT - 0.5;
        for (let x = 0; x < WIDTH; ++x) {
            const sx = x0 + (x + 0.5) * (x1 - x0) / WIDTH - 0.5;
            const xi = Math.floor(sx), yi = Math.floor(sy), fx = sx - xi, fy = sy - yi;
            pixels.push((1 - fy) * ((1 - fx) * get(xi, yi) + fx * get(xi + 1, yi)) +
                fy * ((1 - fx) * get(xi, yi + 1) + fx * get(xi + 1, yi + 1)));
        }
    }
    return pixels;
}

function model(fonts) {
    const templates = {};
    for (const font of fonts) {
        for (const size of font.sizes) {
            const alpha = require('zlib').inflateSync(Buffer.from(size.alpha, 'base64'));
            for (const ch of new Set(GLYPHS)) {
                const g = size.glyphs[ch.charCodeAt(0)];
                if (!g || !g[2]) continue;
                for (const cutoff of [120, 185]) {
                    const get = (x, y) => x >= 0 && x < g[2] && y >= 0 && y < g[3] &&
                        alpha[(y + g[1]) * size.atlasW + x + g[0]] >= cutoff ? 1 : 0;
                    let l = g[2], t = g[3], r = 0, b = 0;
                    for (let y = 0; y < g[3]; y++) for (let x = 0; x < g[2]; x++) {
                        if (!get(x, y)) continue;
                        l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x + 1); b = Math.max(b, y + 1);
                    }
                    if (l >= r || t >= b) continue;
                    (templates[ch] || (templates[ch] = [])).push({
                        pixels: normalize(get, l, t, r, b), aspect: (r - l) / (b - t),
                        height: (b - t) / size.size,
                    });
                }
            }
        }
    }
    return templates;
}

function line(frame, width, height, rect, threshold) {
    const [left, top, right, bottom] = rect.map((n, i) => Math.round(n * (i % 2 ? height / 480 : width / 1280)));
    const regionWidth = right - left, regionHeight = bottom - top;
    const mask = new Uint8Array(regionWidth * regionHeight);
    const columns = new Uint8Array(regionWidth);
    for (let y = 0; y < regionHeight; y++) for (let x = 0; x < regionWidth; x++) {
        const i = ((top + y) * width + left + x) * 4;
        const low = Math.min(frame[i], frame[i + 1], frame[i + 2]);
        if (low >= threshold && Math.max(frame[i], frame[i + 1], frame[i + 2]) - low <= 50) {
            mask[y * regionWidth + x] = 1; columns[x]++;
        }
    }
    const get = (x, y) => x >= 0 && x < regionWidth && y >= 0 && y < regionHeight ? mask[y * regionWidth + x] : 0;
    const glyphs = [];
    for (let x = 0; x < regionWidth;) {
        if (!columns[x]) { x++; continue; }
        const start = x;
        while (x < regionWidth && columns[x]) x++;
        let y0 = regionHeight, y1 = 0;
        for (let i = start; i < x; i++) for (let y = 0; y < regionHeight; y++) if (get(i, y)) {
            y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
        }
        if (x - start >= 2 && y1 - y0 >= 2) {
            glyphs.push({ start, end: x, top: y0, height: y1 - y0, aspect: (x - start) / (y1 - y0),
                pixels: normalize(get, start, y0, x, y1) });
        }
    }
    return glyphs;
}

function score(glyph, ch, templates, capHeight) {
    const scores = glyph.scores || (glyph.scores = {});
    if (scores[ch] !== undefined) return scores[ch];
    let best = Infinity;
    for (const ref of templates[ch] || []) {
        const shape = glyph.pixels.reduce((n, v, i) => n + Math.abs(v - ref.pixels[i]), 0) / (WIDTH * HEIGHT);
        const ratio = Math.abs(Math.log(glyph.aspect / ref.aspect));
        const height = Math.abs(glyph.height / capHeight - ref.height / 0.71);
        best = Math.min(best, shape + 0.10 * ratio + 0.15 * height);
    }
    scores[ch] = best;
    return best;
}

function match(glyphs, pattern, templates, capHeight) {
    if (glyphs.length !== pattern.length) return null;
    let text = '', cost = 0;
    for (let i = 0; i < glyphs.length; i++) {
        const glyph = glyphs[i], allowed = pattern[i] === '#' ? '0123456789' : pattern[i];
        const candidates = Array.from(allowed, (ch) => ({ ch, cost: score(glyph, ch, templates, capHeight) }))
            .sort((a, b) => a.cost - b.cost);
        const pick = candidates[0];
        if (pick.cost > 0.38 || (candidates.length > 1 && candidates[1].cost - pick.cost < 0.012)) return null;
        cost += pick.cost;
        text += pick.ch;
    }
    return { text, cost: cost / pattern.length };
}

const TIMES = ['##:##', '#:##'];
const DURATIONS = ['#min', '##min', '###min', '#h', '##h', '#h#min', '#h##min', '##h##min'];
const DISTANCES = ['#', '##', '###', '####', '#.#', '##.#', '###.#', '#,##', '#,#', '##,#', '###,#'];

function candidates(glyphs, layout, templates) {
    if (!glyphs.length) return [];
    const capHeight = Math.max(...glyphs.map((g) => g.height));
    const tryPattern = (parts) => {
        const full = parts.join('');
        const reading = match(glyphs, full, templates, capHeight);
        if (!reading || reading.cost > 0.24) return;
        let offset = 0;
        const values = parts.map((p) => {
            const v = reading.text.slice(offset, offset + p.length); offset += p.length; return v;
        });
        out.push({ values, cost: reading.cost });
    };
    const out = [];
    if (layout === 'arrival') {
        TIMES.forEach((t) => tryPattern([t, 'arrival']));
    } else {
        for (const duration of DURATIONS) for (const distance of DISTANCES) for (const unit of ['km', 'mi', 'm']) {
            if (layout === 'trip') tryPattern([duration, '·', distance, unit]);
            else for (const t of TIMES) tryPattern([t, 'ETA', duration, distance, unit]);
        }
    }
    return out.sort((a, b) => a.cost - b.cost);
}

function readEta(frame, width, height, templates) {
    if (frame.length !== width * height * 4 || Math.abs(width / height - 8 / 3) > 0.03) return null;
    const reads = [];
    for (const layout of Object.keys(AREAS)) for (const threshold of [187, 208, 166, 227]) {
        const lines = AREAS[layout].map((r) => line(frame, width, height, r, threshold));
        let arrival, duration, distance, unit, cost;
        if (layout === 'dashboard') {
            const row = candidates(lines[0], layout, templates)[0];
            if (!row) continue;
            [arrival, , duration, distance, unit] = row.values;
            cost = row.cost;
        } else {
            const time = candidates(lines[0], 'arrival', templates)[0];
            const trip = candidates(lines[1], 'trip', templates)[0];
            if (!time || !trip) continue;
            arrival = time.values[0];
            [duration, , distance, unit] = trip.values;
            cost = (time.cost + trip.cost) / 2;
        }
        const clock = arrival.split(':').map(Number);
        if (clock[0] > 23 || clock[1] > 59 || Number(distance.replace(',', '.')) <= 0) continue;
        reads.push({
            arrival: arrival.padStart(5, '0'),
            duration: duration.replace(/(\d)(h|min)/g, '$1 $2').replace(/h(?=\d)/g, 'h '),
            distance: distance + ' ' + unit, layout, cost,
        });
    }
    reads.sort((a, b) => a.cost - b.cost);
    return reads[0] || null;
}

const TURN_THRESHOLDS = [187, 208, 166, 227];

function readTurnDistance(frame, width, height, rect, threshold, templates) {
    const glyphs = line(frame, width, height, rect, threshold);
    if (!glyphs.length) return null;
    const cap = Math.max(...glyphs.map(g => g.height));
    for (const unit of ['km', 'mi', 'm']) for (const pattern of DISTANCES) {
        const result = match(glyphs, pattern + unit, templates, cap);
        if (!result || result.cost > 0.21) continue;
        const value = result.text.slice(0, -unit.length);
        if (Number(value.replace(',', '.')) > 0) return value + ' ' + unit;
    }
    return null;
}

function roundabout(frame, width, height, rect, templates) {
    for (const threshold of [135, 105, 165]) {
        const icons = line(frame, width, height, rect, threshold);
        if (icons.length !== 1) continue;
        const icon = icons[0], span = icon.end - icon.start;
        if (icon.height < height * 0.055 || icon.aspect < 0.78 || icon.aspect > 1.24) continue;
        const radial = (angle, radius) => {
            const x = Math.floor(WIDTH * (0.5 + radius * Math.cos(angle)));
            const y = Math.floor(HEIGHT * (0.5 + radius * Math.sin(angle)));
            return icon.pixels[y * WIDTH + x];
        };
        let rim = 0, corners = 0;
        for (let i = 0; i < 24; i++) {
            const angle = i * Math.PI / 12;
            if (Math.max(radial(angle, 0.40), radial(angle, 0.46)) >= 0.5) rim++;
            if (i % 6 === 3 && radial(angle, 0.61) >= 0.5) corners++;
        }
        if (rim < 19 || corners > 1) continue;
        const digitRect = [
            rect[0] + (icon.start + span * 0.26) * 1280 / width,
            rect[1] + (icon.top + icon.height * 0.20) * 480 / height,
            rect[0] + (icon.end - span * 0.26) * 1280 / width,
            rect[1] + (icon.top + icon.height * 0.80) * 480 / height,
        ];
        const readings = new Set();
        for (const level of [187, 208, 166]) {
            const digits = line(frame, width, height, digitRect, level);
            if (digits.length !== 1 || digits[0].height < icon.height * 0.28 || digits[0].height > icon.height * 0.57) continue;
            const result = match(digits, '#', templates, digits[0].height);
            if (result && result.cost <= 0.22) readings.add(Number(result.text));
        }
        if (readings.size === 1) return [...readings][0];
        return 0;
    }
    return null;
}

function readTurn(frame, width, height, templates, layout) {
    const areas = TURNS[layout];
    if (!areas || frame.length !== width * height * 4) return null;
    const exit = roundabout(frame, width, height, areas[0], templates);
    if (exit === 0) return null;
    for (const threshold of TURN_THRESHOLDS) {
        let kind = 'roundabout';
        if (exit === null) {
            const arrow = line(frame, width, height, areas[0], threshold);
            if (arrow.length !== 1 || arrow[0].height < height * 0.055 || arrow[0].aspect < 0.65 || arrow[0].aspect > 1.1) continue;
            const ranks = Object.keys(ARROWS).map(kind => ({ kind, cost: arrow[0].pixels.reduce(
                (sum, p, i) => sum + Math.abs(p - Number(ARROWS[kind][i])), 0) / (WIDTH * HEIGHT) })).sort((a, b) => a.cost - b.cost);
            if (ranks[0].cost > 0.15 || ranks[1].cost - ranks[0].cost < 0.13) continue;
            kind = ranks[0].kind;
        }
        const distance = readTurnDistance(frame, width, height, areas[1], threshold, templates);
        if (distance) return exit === null ? { kind, distance } : { kind, distance, exit };
    }
    return null;
}

module.exports = { model, readEta, readTurn };
