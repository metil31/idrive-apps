'use strict';

const MAP = { x: 0, y: 0, w: 1088, h: 480 };
const MAP_APPS = new Set(['waze-on-cluster', 'robertn_waze_cluster']);

function hostArea(event, targets) {
    const panel = /(?:^|,)panel:(\d+)x(\d+)(?:,|$)/.exec(targets);
    if (!panel || event.into !== 'panel' || event.shown !== 1) return null;
    const { x, y, w, h } = event;
    const sx = event.src_x || 0, sy = event.src_y || 0;
    const sw = event.src_w || MAP.w, sh = event.src_h || MAP.h;
    if (![x, y, w, h, sx, sy, sw, sh].every(Number.isInteger) ||
        x < 0 || y < 0 || w < 64 || h < 32 || x + w > Number(panel[1]) || y + h > Number(panel[2]) ||
        sx < 0 || sy < 0 || sw < 64 || sh < 32 || sx + sw > MAP.w || sy + sh > MAP.h) return null;
    return { x, y, w, h, sx, sy, sw, sh };
}

function mapDisplays(report) {
    const shown = { map: false, panel: false };
    for (const line of String(report || '').split('\n')) {
        const layer = /^layer \d+ video of (\S+) on (map|panel), content z -?\d+[^:]*: shown\b/.exec(line.trim());
        if (layer && MAP_APPS.has(layer[1])) shown[layer[2]] = true;
    }
    return shown;
}

module.exports = { MAP, hostArea, mapDisplays };
