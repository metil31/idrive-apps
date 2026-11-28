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

const FORK_ROUTE = [
    '000000111111','000000011111','000000011111','000001111111','000011110011','000111000000','011110000000','111100000000',
    '111000000000','110000000000','110000000000','110000000000','110000000000','110000000000','110000000000','110000000000',
];
const FORK_BOTH = [
    '000000111111','000000111111','111000011111','111000111111','111011110111','111111100011','111110000000','111100000000',
    '111000000000','111000000000','111000000000','111000000000','111000000000','111000000000','111000000000','111000000000',
];
const LANE_UP = [
    '000001110000','000111111000','011111111111','111111111111','000011110000','000011110000','000001110000','000001110000',
    '000001110000','000001110000','000001110000','000001110000','000001110000','000001110000','000001110000','000001100000',
];
const LANE_UP_RIGHT = [
    '000100000000','011110000000','111111000000','111111100000','001100001000','001100001100','001100001110','001111111111',
    '001111111111','001111001111','001110001110','001100001100','001100000000','001100000000','001100000000','001100000000',
];
const mirrored = rows => rows.map(row => [...row].reverse().join('')).join('');
const FORKS = {
    'fork-right': [FORK_ROUTE.join(''), FORK_BOTH.join('')],
    'fork-left': [mirrored(FORK_ROUTE), mirrored(FORK_BOTH)],
};
const LANE_SHAPES = {
    left: LEFT.join(''), right: mirrored(LEFT), straight: LANE_UP.join(''),
    'straight-right': LANE_UP_RIGHT.join(''), 'straight-left': mirrored(LANE_UP_RIGHT),
};
const shapeCost = (glyph, ref) => glyph.pixels.reduce(
    (sum, p, i) => sum + Math.abs(p - Number(ref[i])), 0) / (WIDTH * HEIGHT);


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

function line(frame, width, height, rect, threshold, dark = false) {
    const [left, top, right, bottom] = rect.map((n, i) => Math.round(n * (i % 2 ? height / 480 : width / 1280)));
    const regionWidth = right - left, regionHeight = bottom - top;
    const mask = new Uint8Array(regionWidth * regionHeight);
    const columns = new Uint8Array(regionWidth);
    for (let y = 0; y < regionHeight; y++) for (let x = 0; x < regionWidth; x++) {
        const i = ((top + y) * width + left + x) * 4;
        const low = Math.min(frame[i], frame[i + 1], frame[i + 2]);
        const high = Math.max(frame[i], frame[i + 1], frame[i + 2]);
        if (dark ? high < threshold : low >= threshold && high - low <= 50) {
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

// Full-screen Waze has a separate trip row. A failed arrival-clock OCR
// need not block the speed sign when that row still confirms metric units.
function readMetricTrip(frame, width, height, templates) {
    if (frame.length !== width * height * 4 || Math.abs(width / height - 8 / 3) > 0.03) return false;
    let best = null;
    for (const threshold of [187, 208, 166, 227]) {
        const glyphs = line(frame, width, height, AREAS.fullscreen[1], threshold);
        const trip = candidates(glyphs, 'trip', templates)[0];
        if (trip && Number(trip.values[2].replace(',', '.')) > 0 && (!best || trip.cost < best.cost)) best = trip;
    }
    return !!best && /^(km|m)$/.test(best.values[3]);
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

function readFork(frame, width, height, rect) {
    const route = line(frame, width, height, rect, 176), both = line(frame, width, height, rect, 75);
    if (route.length !== 1 || both.length !== 1 || route[0].height < height * 0.055 ||
        both[0].aspect < 0.48 || both[0].aspect > 1 || both[0].height < route[0].height) return null;
    const ranks = Object.keys(FORKS).map(kind => {
        const [primary, branches] = FORKS[kind];
        return { kind, route: shapeCost(route[0], primary), both: shapeCost(both[0], branches) };
    }).sort((a, b) => a.route + a.both - b.route - b.both);
    return ranks[0].route <= 0.14 && ranks[0].both <= 0.15 &&
        ranks[1].route + ranks[1].both - ranks[0].route - ranks[0].both >= 0.20 ? ranks[0].kind : null;
}

function readLanes(frame, width, height, layout) {
    // A verified fullscreen Waze instruction card is required. The Dashboard
    // has a different footer. Search the final row of the black card only.
    if (layout !== 'fullscreen') return null;
    const sx = width / 1280, sy = height / 480;
    const pixel = (x, y) => (Math.round(y * sy) * width + Math.round(x * sx)) * 4;
    const neutral = (i, minimum) => {
        const lo = Math.min(frame[i], frame[i + 1], frame[i + 2]);
        return lo >= minimum && Math.max(frame[i], frame[i + 1], frame[i + 2]) - lo <= 48;
    };
    let base = 105;
    for (let y = base; y < 208; y++) {
        const darkSamples = [118, 153, 193, 234, 273, 313, 353, 393, 419].filter(x => {
            const i = pixel(x, y);
            return Math.max(frame[i], frame[i + 1], frame[i + 2]) < 48;
        });
        if (darkSamples.length >= 8) base = y;
        else if (y - base > 6) break;
    }
    if (base < 142) return null;
    const ink = y => {
        let count = 0;
        for (let x = 110; x < 423; x++) count += +neutral(pixel(x, y), 65);
        return count >= 4;
    };
    let bottom = base - 3;
    while (bottom > base - 26 && !ink(bottom)) bottom--;
    if (bottom <= base - 26) return null;
    let top = bottom;
    while (top > bottom - 37 && ink(top)) top--;
    if (bottom - top < 12 || bottom - top > 36 || top < 104) return null;
    const left = 110;
    const glyphs = line(frame, width, height, [left, top + 1, 423, bottom + 1], 65);
    if (glyphs.length < 2 || glyphs.length > 6) return null;
    const h = Math.max(...glyphs.map(glyph => glyph.height));
    const gap = glyphs.slice(1).map((glyph, index) => glyph.start - glyphs[index].end);
    if (gap.some(n => n < 3 * sx || n > h * 2) || glyphs.some(glyph =>
        glyph.height < h * 0.74 || glyph.aspect < 0.25 || glyph.aspect > 1.15)) return null;
    const lanes = [];
    for (const glyph of glyphs) {
        const ranks = Object.keys(LANE_SHAPES).map(kind => ({
            kind, cost: shapeCost(glyph, LANE_SHAPES[kind]),
        })).sort((a, b) => a.cost - b.cost);
        const best = ranks[0];
        if (best.cost > 0.22 || ranks[1].cost - best.cost < 0.032) return null;
        const combo = best.kind.startsWith('straight-');
        let stem = 0, side = 0;
        for (let i = glyph.start; i < glyph.end; i++) {
            const x = Math.round(left * sx) + i, relativeX = (i - glyph.start) / (glyph.end - glyph.start);
            const split = best.kind === 'straight-left' ? relativeX > 0.58 : relativeX < 0.42;
            const y0 = Math.round((top + 1) * sy) + glyph.top;
            for (let y = y0; y < y0 + glyph.height; y++) {
                if (!neutral((y * width + x) * 4, 172)) continue;
                if (!combo || split && y < y0 + glyph.height * 0.30) stem++;
                else if (!split && y >= y0 + glyph.height * 0.21) side++;
            }
        }
        const minimum = 6 * sx * sy;
        lanes.push({ kind: best.kind, active: stem >= minimum, branch: side >= minimum });
    }
    return lanes.some(lane => lane.active || lane.branch) ? lanes : null;
}


function readTurn(frame, width, height, templates, layout) {
    const areas = TURNS[layout];
    if (!areas || frame.length !== width * height * 4) return null;
    const exit = roundabout(frame, width, height, areas[0], templates);
    if (exit === 0) return null;
    const fork = exit === null ? readFork(frame, width, height, areas[0]) : null;
    const lanes = exit === null ? readLanes(frame, width, height, layout) : null;
    for (const threshold of TURN_THRESHOLDS) {
        let kind = fork || 'roundabout';
        if (exit === null && !fork) {
            const arrow = line(frame, width, height, areas[0], threshold);
            const glyph = arrow[0];
            const valid = arrow.length === 1 && glyph.height >= height * 0.055 && glyph.aspect >= 0.65 && glyph.aspect <= 1.1;
            const ranks = valid ? Object.keys(ARROWS).map(kind => ({ kind, cost: shapeCost(glyph, ARROWS[kind]) }))
                .sort((a, b) => a.cost - b.cost) : null;
            if (ranks && ranks[0].cost <= 0.15 && ranks[1].cost - ranks[0].cost >= 0.13) kind = ranks[0].kind;
            else if (lanes) kind = 'lanes';
            else continue;
        }
        const distance = readTurnDistance(frame, width, height, areas[1], threshold, templates);
        if (distance) {
            const turn = { kind, distance };
            if (exit !== null) turn.exit = exit;
            if (lanes) turn.lanes = lanes;
            return turn;
        }
    }
    return null;
}

const WAZE_DOCK = [
    '000001110000','000100000100','001011111010','000111111100','000111111101','011110110110','011110110110','001111111110',
    '001110110110','101110010110','011111001101','101111111100','010001111000','000000000000','001001100100','000110011000',
].join('');

function hasWazeDock(frame, width, height) {
    if (frame.length !== width * height * 4 || Math.abs(width / height - 8 / 3) > 0.03) return false;
    return [0, 61, 122].some(offset => {
        const glyphs = line(frame, width, height, [22, 149 + offset, 67, 205 + offset], 172);
        return glyphs.length === 1 && glyphs[0].height >= height * 0.050 && glyphs[0].height <= height * 0.077 &&
            glyphs[0].aspect >= 0.83 && glyphs[0].aspect <= 1.16 && shapeCost(glyphs[0], WAZE_DOCK) <= 0.16;
    });
}

// Calibrated for the metric 8:3 CarPlay layouts. The red rim and light disc
// disambiguate the sign from the actual speed in the adjacent dark dial.
function readSpeedLimit(frame, width, height, templates, layout) {
    if (frame.length !== width * height * 4 || Math.abs(width / height - 8 / 3) > 0.03) return null;
    const origin = { dashboard: [793, 49], fullscreen: [1202, 42] }[layout];
    if (!origin) return null;
    const sx = width / 1280, sy = height / 480;
    const pixel = (x, y) => (Math.round(y * sy) * width + Math.round(x * sx)) * 4;
    const red = (i) => frame[i] >= 165 && frame[i] - frame[i + 1] >= 42 && frame[i] - frame[i + 2] >= 35;
    const white = (i) => Math.min(frame[i], frame[i + 1], frame[i + 2]) >= 170;
    const rings = [];
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
        const x = origin[0] + dx, y = origin[1] + dy;
        for (const radius of [14, 16, 18, 20, 22]) {
            let rim = 0, disc = 0;
            for (let a = 0; a < 16; a++) {
                const angle = a * Math.PI / 8, u = Math.cos(angle) * radius, v = Math.sin(angle) * radius;
                rim += +red(pixel(x + u, y + v));
                disc += +white(pixel(x + u * 0.66, y + v * 0.66));
            }
            if (rim >= 13 && disc >= 12) rings.push({ x, y, radius, rank: rim * 3 + disc - Math.hypot(dx, dy) * 0.35 });
        }
    }
    rings.sort((a, b) => b.rank - a.rank);
    if (!rings.length) return null;
    const { x, y, radius } = rings[0];
    const rect = [x - radius * 0.68, y - radius * 0.58, x + radius * 0.68, y + radius * 0.64];
    const counts = new Map();
    for (const cutoff of [80, 110, 125, 140]) {
        const digits = line(frame, width, height, rect, cutoff, true);
        if (digits.length < 2 || digits.length > 3) continue;
        const cap = Math.max(...digits.map(g => g.height));
        if (cap < radius * sy * 0.55 || digits.some(g => g.height < cap * 0.78)) continue;
        const value = match(digits, '#'.repeat(digits.length), templates, cap);
        if (!value || value.cost > 0.265 || value.text[0] === '0') continue;
        const kmh = Number(value.text);
        if (kmh < 10 || kmh > 130 || kmh % 5 !== 0) continue;
        counts.set(kmh, (counts.get(kmh) || 0) + 1);
    }
    return counts.size === 1 && [...counts.values()][0] >= 2 ? [...counts.keys()][0] : null;
}

module.exports = { model, readEta, readMetricTrip, readTurn, readSpeedLimit, hasWazeDock };
