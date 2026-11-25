'use strict';
/**
 * outputs.js - the sign on the head-up display and on the instrument cluster, through cluster-render. Node 8.
 *
 *   const out = new Outputs('speed_limit', log, settings).start();
 *   out.update({ limit, inferred, over } | { limit: null, unknown: true } | null, now);   out.tick(now);   out.stop()
 *
 * Setting "show": cluster | hud | both | off (as Maps on cluster's Show on).
 * Cluster: the map target (1088 x 480, the centre under the dials), only while another app (Maps on cluster) shows
 * its picture there: cluster-render's status lists every client's layers ("layer 3 video of <app> on map, content
 * z 0: shown"); asked every 3 s while the sign is on the map, else every 10 s and at once on a map target event. The
 * sign never opens the map or panel by itself. It follows Maps on cluster into a panel only when the renderer has
 * announced the map's host rectangle and a Maps on cluster video is shown there.
 * A view with camera: '350 m' (a speed camera ahead) adds the camera pill to the sign's right (sign.js).
 * HUD (800 x 480): beside BMW's own speed (transparent pixels are see-through); it gives way to BMW's pop-ups on the
 * HUD (yield 1), unless setting "hudKeep" keeps it over them (yield 0).
 * Each place has its size and offset settings: hudSize/X/Y, clusterSize/X/Y (the map). A view
 * { limit: null, unknown: true } shows the "---" sign (setting "noLimit"). A layer with nothing to show is hidden
 * (visible 0): the display is given back after cluster-render's linger (3 s). stop() drops the layers and closes the
 * connection: cluster-render releases the surfaces at once.
 */
const { ClusterRender } = require('./crclient');
const { drawSign, signWidth } = require('./sign');

const TARGETS = {
    hud: { w: 800, h: 480, cx: 175, cy: 290, size: 'hudSize', x: 'hudX', y: 'hudY', def: 88 },
    // the bottom of the phone map, left of the car's arrow (bottom centre): the area narrows towards the bottom
    // between the dials, and its corners sit behind them
    map: { w: 1088, h: 480, cx: 400, cy: 405, size: 'clusterSize', x: 'clusterX', y: 'clusterY', def: 110, pillLeft: true },
};
const LAYER_RX = /^layer \d+ (\S+) of (.+) on (\w+), (\w+) z -?\d+[^:]*: (\w+)/;
const PHONE_MAP = new Set(['waze-on-cluster', 'robertn_waze_cluster']);
const STATUS_MS = 3000;          // while the sign is on the cluster's map: notice soon that the phone map went
const STATUS_IDLE_MS = 10000;    // otherwise (a map target event asks at once)

function panelHost(event, targets) {
    const panel = /(?:^|,)panel:(\d+)x(\d+)(?:,|$)/.exec(targets);
    if (!panel || event.shown !== 1 || event.into !== 'panel') return null;
    const { x, y, w, h } = event;
    const sx = event.src_x === undefined ? 0 : event.src_x;
    const sy = event.src_y === undefined ? 0 : event.src_y;
    const sw = event.src_w || TARGETS.map.w;
    const sh = event.src_h || TARGETS.map.h;
    if (![x, y, w, h, sx, sy, sw, sh].every(Number.isInteger) || x < 0 || y < 0 || w < 64 || h < 32 ||
        x + w > Number(panel[1]) || y + h > Number(panel[2]) || sx < 0 || sy < 0 || sw < 64 || sh < 32 ||
        sx + sw > TARGETS.map.w || sy + sh > TARGETS.map.h) return null;
    return { x, y, w, h, sx, sy, sw, sh };
}

function hostedPlace(place, host) {
    const horizontal = host.w / host.sw, vertical = host.h / host.sh;
    const scale = Math.min(horizontal, vertical, host.w / place.W, host.h / place.size);
    const w = Math.round(place.W * scale), h = Math.round(place.size * scale);
    if (h < 24) return null;
    const centreX = host.x + (place.x + place.W - place.size / 2 - host.sx) * horizontal;
    const centreY = host.y + (place.y + place.size / 2 - host.sy) * vertical;
    const x = Math.max(host.x, Math.min(host.x + host.w - w, Math.round(centreX - w + h / 2)));
    const y = Math.max(host.y, Math.min(host.y + host.h - h, Math.round(centreY - h / 2)));
    return { x, y, w, h };
}

class Outputs {
    /** opts.cr: options for the cluster-render client ({ path, check }: tests) */
    constructor(appId, log, settings, opts) {
        this.appId = appId;
        this.crOpts = (opts && opts.cr) || undefined;
        this.log = log || { info() {}, warn() {} };
        this.settings = settings;
        this.cr = null;
        this.layers = {};           // hud | map -> { ref, size, x, y, key, visible, yld }
        this.mapBusy = false;       // another app shows a picture on the map target
        this.mapBusyBy = '';
        this.mapHost = '';
        this.hostRect = null;
        this.panelMapBy = '';
        this.panelBy = [];
        this.lastStatus = 0;
        this.statusAt = 0;
        this.targets = {};          // target -> { state, holder, reason }
        this.layerStates = {};      // ref -> state
        this.view = null;
        this.refused = '';
    }

    start() {
        if (this.cr) return this;
        const cr = this.cr = new ClusterRender(this.appId, this.log, this.crOpts).start();
        cr.on('ready', () => { this.layers = {}; this._apply(Date.now()); });
        cr.on('down', () => {
            Object.keys(this.layers).forEach((key) => cr.drop(this.layers[key].ref));
            this.layers = {};
            this.layerStates = {};
            this.mapBusy = false;
            this.mapBusyBy = '';
            this.mapHost = '';
            this.hostRect = null;
            this.panelMapBy = '';
            this.panelBy = [];
            this.lastStatus = 0;
            this.statusAt = 0;
        });
        cr.on('status', (text) => this._status(text));
        cr.on('host', (m) => {
            if (m.target !== 'map') return;
            this.mapHost = m.shown === 1 && /^[a-z0-9_]{1,32}$/.test(m.into || '') ? m.into : '';
            this.hostRect = panelHost(m, cr.targets);
            this.panelMapBy = '';
            this.lastStatus = 0;
            this._apply();
        });
        cr.on('target', (m) => {
            const was = this.targets[m.target];
            this.targets[m.target] = { state: m.state, holder: m.holder || '', reason: m.reason || '' };
            if (m.target === 'map' || m.target === 'panel' && this.hostRect) {
                if (!was || was.state !== m.state) this.lastStatus = 0;
                if (m.target === 'panel' && m.state !== 'shown') { this.panelMapBy = ''; this._apply(); }
            }
        });
        cr.on('layer', (m) => { this.layerStates[m.ref] = m.state + (m.reason ? ' (' + m.reason + ')' : ''); });
        cr.on('refused', (m) => { this.refused = (m.op || '') + ': ' + (m.reason || ''); this.log.warn('cluster-render refused ' + this.refused); });
        return this;
    }

    stop() {
        if (!this.cr) return;
        const cr = this.cr;
        this.cr = null;
        Object.keys(this.layers).forEach((k) => { try { cr.drop(this.layers[k].ref); } catch (e) { /* gone */ } });
        this.layers = {};
        this.mapBusy = false;
        this.mapBusyBy = '';
        this.mapHost = '';
        this.hostRect = null;
        this.panelMapBy = '';
        this.panelBy = [];
        this.lastStatus = 0;
        this.statusAt = 0;
        try { cr.close(); } catch (e) { /* gone */ }
    }

    /** Where the picture goes: the sign centred on its place, a camera pill (width W) running on to its right, or on
     * the phone map to its left (clear of the car's arrow, TARGETS pillLeft). */
    _where(t, camera) {
        const s = this.settings, T = TARGETS[t];
        const size = Number(s.get(T.size)) || T.def, W = signWidth(size, camera);
        const dx = Number(s.get(T.x)) || 0, dy = Number(s.get(T.y)) || 0;
        const left = T.pillLeft ? W - size : 0;
        const x = Math.max(0, Math.min(T.w - W, Math.round(T.cx + dx - size / 2 - left)));
        const y = Math.max(0, Math.min(T.h - size, Math.round(T.cy + dy - size / 2)));
        return { size, W, x, y };
    }

    _wanted(t) {
        const show = this.settings.get('show');
        if (t === 'hud') return show === 'hud' || show === 'both';
        return (show === 'cluster' || show === 'both') && (this.mapBusy || !!this.panelMapBy);
    }

    /** Show this (or nothing). */
    update(view, now) {
        this.view = view;
        this._apply(now || Date.now());
    }

    _apply() {
        const cr = this.cr;
        if (!cr || !cr.ready) return;
        ['hud', 'map'].forEach((t) => {
            let L = this.layers[t];
            const show = !!(this.view && (this.view.limit || this.view.unknown) && this._wanted(t));
            const target = t === 'map' && this.panelMapBy ? 'panel' : t;
            if (L && L.target !== target) {
                cr.drop(L.ref);
                delete this.layerStates[L.ref];
                delete this.layers[t];
                L = null;
            }
            const cam = show ? this.view.camera || '' : '';
            const w = show ? this._where(t, cam) : null;
            const place = w && (target === 'panel' ? hostedPlace(w, this.hostRect) : { x: w.x, y: w.y, w: w.W, h: w.size });
            if (!place) {
                if (L && L.visible) { cr.set(L.ref, { visible: 0 }); L.visible = false; }
                return;
            }
            // the pixels only when the picture changes (limit, size, default, over, the camera's distance step): not
            // on every tick
            const key = [this.view.limit, w.size, !!this.view.inferred, !!this.view.over, cam].join(':');
            const sign = L && L.size === w.size && L.W === w.W && L.key === key ? null
                : drawSign(this.view.limit, { size: w.size, inferred: this.view.inferred, over: this.view.over, camera: cam, pillLeft: !!TARGETS[t].pillLeft });
            if (L && (L.size !== w.size || L.W !== w.W)) {
                cr.drop(L.ref);
                delete this.layerStates[L.ref];
                L = null;
            }
            const yld = t === 'hud' && this.settings.get('hudKeep') ? 0 : 1;
            if (!L) {
                const ref = cr.image(Object.assign({ target, class: 'overlay', z: 20, iw: w.W, ih: w.size,
                    fps: 4, visible: 1, contend: 0, yield: yld }, place));
                L = this.layers[t] = { ref, target, size: w.size, W: w.W, place, key: '', visible: true, yld };
            } else {
                if (L.place.x !== place.x || L.place.y !== place.y || L.place.w !== place.w || L.place.h !== place.h) {
                    cr.set(L.ref, place);
                    L.place = place;
                }
                if (L.yld !== yld) { cr.set(L.ref, { yield: yld }); L.yld = yld; }
                if (!L.visible) { cr.set(L.ref, { visible: 1 }); L.visible = true; }
            }
            if (sign && L.key !== sign.key) { cr.pixels(L.ref, sign.px); L.key = sign.key; }
        });
    }

    /** Ask for the visible layers while cluster display is selected, even without a known limit. */
    tick(now) {
        const cr = this.cr;
        const show = this.settings.get('show');
        if (!cr || !cr.ready || (show !== 'cluster' && show !== 'both')) return;
        const interval = this.mapBusy || this.hostRect ? STATUS_MS : STATUS_IDLE_MS;
        if (now - this.lastStatus < interval) return;
        this.lastStatus = now;
        cr.status();
        // Retire the last reported layers if the renderer stops answering.
        if (this.statusAt && now - this.statusAt > 2 * interval + 1000) {
            this.mapBusy = false;
            this.mapBusyBy = '';
            this.panelMapBy = '';
            this.panelBy = [];
            this.statusAt = 0;
            this._apply(now);
        }
    }

    _status(text) {
        this.statusAt = Date.now();
        let busy = false, by = '', panelMapBy = '';
        const panel = new Set();
        String(text || '').split('\n').forEach((line) => {
            const m = LAYER_RX.exec(line.trim());
            if (!m || m[2] === this.appId || m[5] !== 'shown') return;
            if (m[3] === 'panel' && panel.size < 4) {
                panel.add(m[2].replace(/[^\w.-]/g, '_').slice(0, 48));
            }
            if (this.hostRect && m[3] === 'panel' && m[1] === 'video' && PHONE_MAP.has(m[2])) panelMapBy = m[2];
            if (m[3] === 'map' && m[1] !== 'effect' && m[1] !== 'mesh') { busy = true; by = m[2]; }
        });
        if (busy !== this.mapBusy) this.log.info('cluster map ' + (busy ? 'shown by ' + by : 'not shown') + ': the sign ' + (busy ? 'joins it' : 'leaves it'));
        this.mapBusy = busy;
        this.mapBusyBy = by;
        this.panelMapBy = panelMapBy;
        this.panelBy = Array.from(panel);
        this._apply(Date.now());
    }

    diag() {
        const cr = this.cr, L = this.layers;
        const st = (t) => (L[t] ? (L[t].visible ? this.layerStates[L[t].ref] || 'sent' : 'hidden') : 'none');
        return {
            connected: !!(cr && cr.ready), unsupported: cr ? cr.unsupported : '', targetsOffered: cr ? cr.targets : '',
            hud: st('hud'), map: st('map'), cluster: st('map'), mapBusy: this.mapBusy, mapBusyBy: this.mapBusyBy,
            mapHost: this.mapHost, panelMapBy: this.panelMapBy, panelBy: this.panelBy,
            statusAt: this.statusAt, targets: this.targets, refused: this.refused,
        };
    }
}

module.exports = { Outputs, LAYER_RX, TARGETS };
