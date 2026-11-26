'use strict';
/**
 * outputs.js - the sign on the head-up display and on the instrument cluster, through cluster-render. Node 8.
 *
 *   const out = new Outputs('speed_limit', log, settings).start();
 *   out.update({ limit, inferred, over } | { limit: null, unknown: true } | null, now);   out.tick(now);   out.stop()
 *
 * Setting "show": cluster | hud | both | off (as Maps on cluster's Show on).
 * Cluster: draws on the full iDrive 7 panel, independently of any map or navigation app.
 * A view with camera: '350 m' (a speed camera ahead) adds the camera pill to the sign's right (sign.js).
 * HUD (800 x 480): beside BMW's own speed (transparent pixels are see-through); it gives way to BMW's pop-ups on the
 * HUD (yield 1), unless setting "hudKeep" keeps it over them (yield 0).
 * Each place has its size and offset settings: hudSize/X/Y, clusterSize/X/Y (the panel). A view
 * { limit: null, unknown: true } shows the "---" sign (setting "noLimit"). A layer with nothing to show is hidden
 * (visible 0): the display is given back after cluster-render's linger (3 s). stop() drops the layers and closes the
 * connection: cluster-render releases the surfaces at once.
 */
const { ClusterRender } = require('./crclient');
const { drawSign, signWidth, TEXTURE_SCALE } = require('./sign');
const { junctionFrame } = require('./junction-sign');

const TARGETS = {
    hud: { w: 800, h: 480, cx: 175, cy: 290, size: 'hudSize', x: 'hudX', y: 'hudY', def: 88 },
    // Keep the previous default close to its position in the central map.
    panel: { w: 1920, h: 720, cx: 816, cy: 525, size: 'clusterSize', x: 'clusterX', y: 'clusterY', def: 110, pillLeft: true },
};
const FADE_MS = 400;

class Outputs {
    /** opts.cr: options for the cluster-render client ({ path, check }: tests) */
    constructor(appId, log, settings, opts) {
        this.appId = appId;
        this.crOpts = (opts && opts.cr) || undefined;
        this.log = log || { info() {}, warn() {} };
        this.settings = settings;
        this.cr = null;
        this.layers = {};           // HUD and panel images, including priority signs
        this.panelAvailable = false;
        this.targets = {};          // target -> { state, holder, reason }
        this.layerStates = {};      // ref -> state
        this.view = null;
        this.junction = null;
        this.fade = null;
        this.fadeTimer = null;
        this.refused = '';
    }

    start() {
        if (this.cr) return this;
        const cr = this.cr = new ClusterRender(this.appId, this.log, this.crOpts).start();
        cr.on('ready', () => {
            this.layers = {};
            this.panelAvailable = cr.targets.split(',').includes('panel:1920x720');
            this._apply(Date.now());
        });
        cr.on('down', () => {
            Object.keys(this.layers).forEach((key) => cr.drop(this.layers[key].ref));
            this.layers = {};
            this.layerStates = {};
            this.targets = {};
            this.panelAvailable = false;
        });
        cr.on('target', (m) => {
            this.targets[m.target] = { state: m.state, holder: m.holder || '', reason: m.reason || '' };
        });
        cr.on('layer', (m) => { this.layerStates[m.ref] = m.state + (m.reason ? ' (' + m.reason + ')' : ''); });
        cr.on('refused', (m) => { this.refused = (m.op || '') + ': ' + (m.reason || ''); this.log.warn('cluster-render refused ' + this.refused); });
        return this;
    }

    stop() {
        clearTimeout(this.fadeTimer);
        this.fadeTimer = this.fade = this.junction = null;
        if (!this.cr) return;
        const cr = this.cr;
        this.cr = null;
        Object.keys(this.layers).forEach((k) => { try { cr.drop(this.layers[k].ref); } catch (e) { /* gone */ } });
        this.layers = {};
        this.layerStates = {};
        this.targets = {};
        this.panelAvailable = false;
        try { cr.close(); } catch (e) { /* gone */ }
    }

    /** Place the sign and its optional camera pill within the selected display. */
    _where(t, camera) {
        const s = this.settings, T = TARGETS[t];
        const size = Number(s.get(T.size)) || T.def, W = signWidth(size, camera);
        const dx = Number(s.get(T.x)) || 0, dy = Number(s.get(T.y)) || 0;
        const baseX = Math.max(0, Math.min(T.w - size, Math.round(T.cx + dx - size / 2)));
        const pillLeft = T.pillLeft && baseX >= W - size;
        const x = Math.max(0, Math.min(T.w - W, baseX - (pillLeft ? W - size : 0)));
        const y = Math.max(0, Math.min(T.h - size, Math.round(T.cy + dy - size / 2)));
        return { size, W, x, y, pillLeft };
    }

    _wanted(t) {
        const show = this.settings.get('show');
        if (t === 'hud') return show === 'hud' || show === 'both';
        return (show === 'cluster' || show === 'both') && this.panelAvailable;
    }

    /** Show this (or nothing). */
    update(view, now) {
        this.view = view;
        this._apply(now || Date.now());
    }

    setJunction(item, now) {
        const target = item ? 1 : 0;
        const previous = this.fade ? this.fade.to : 0;
        if (target !== previous) {
            this.fade = { from: this._blend(now), to: target, at: now };
            this._animateFade();
        }
        if (item) this.junction = item;
    }

    _blend(now) {
        if (!this.fade) return 0;
        const { from, to, at } = this.fade;
        const progress = Math.max(0, Math.min(1, (now - at) / FADE_MS));
        return from + (to - from) * progress;
    }

    _animateFade() {
        if (this.fadeTimer) return;
        this.fadeTimer = setTimeout(() => {
            this.fadeTimer = null;
            const now = Date.now();
            if (!this.fade.to && now - this.fade.at >= FADE_MS) this.fade = this.junction = null;
            this._apply(now);
            if (this.fade && now - this.fade.at < FADE_MS) this._animateFade();
        }, 50);
    }

    _apply(now = Date.now()) {
        const cr = this.cr;
        if (!cr || !cr.ready) return;
        const blend = this._blend(now);
        ['hud', 'panel'].forEach((t) => {
            let L = this.layers[t];
            const setting = t === 'hud' ? 'junctionHud' : 'junctionCluster';
            const priority = blend && this.junction && this._wanted(t) &&
                (this.junction.demo || this.settings.get(setting) === true) ? blend : 0;
            const yld = t === 'hud' && this.settings.get('hudKeep') ? 0 : 1;
            const alpha = this._applyJunction(t, priority, yld) ? 1 - priority : 1;
            const view = this.view || (this.junction && this.junction.demo && priority ? { limit: null, unknown: true } : null);
            const show = !!(alpha && view && (view.limit || view.unknown) && this._wanted(t));
            const cam = show ? view.camera || '' : '';
            const w = show ? this._where(t, cam) : null;
            const place = w && { x: w.x, y: w.y, w: w.W, h: w.size };
            if (!place) {
                if (L && L.visible) { cr.set(L.ref, { visible: 0 }); L.visible = false; }
                return;
            }
            // the pixels only when the picture changes (limit, size, default, over, the camera's distance step): not
            // on every tick
            const key = [view.limit, w.size, !!view.inferred, !!view.over, !!view.demo, cam, w.pillLeft].join(':');
            const sign = L && L.size === w.size && L.W === w.W && L.key === key ? null
                : drawSign(view.limit, { size: w.size, inferred: view.inferred, over: view.over, demo: view.demo, camera: cam, pillLeft: w.pillLeft });
            if (L && (L.size !== w.size || L.W !== w.W)) {
                cr.drop(L.ref);
                delete this.layerStates[L.ref];
                L = null;
            }
            if (!L) {
                const ref = cr.image(Object.assign({ target: t, class: 'overlay', z: 20, iw: w.W * TEXTURE_SCALE, ih: w.size * TEXTURE_SCALE, sampling: 'bilinear', opacity: alpha,
                    fps: t === 'hud' ? 20 : 4, visible: 1, contend: 0, yield: yld }, place));
                L = this.layers[t] = { ref, size: w.size, W: w.W, place, key: '', visible: true, yld, alpha };
            } else {
                if (L.place.x !== place.x || L.place.y !== place.y || L.place.w !== place.w || L.place.h !== place.h) {
                    cr.set(L.ref, place);
                    L.place = place;
                }
                if (L.yld !== yld) { cr.set(L.ref, { yield: yld }); L.yld = yld; }
                if (L.alpha !== alpha) { cr.set(L.ref, { opacity: alpha }); L.alpha = alpha; }
                if (!L.visible) { cr.set(L.ref, { visible: 1 }); L.visible = true; }
            }
            if (sign) { cr.pixels(L.ref, sign.px); L.key = key; }
        });
    }

    _applyJunction(surface, blend, yld) {
        const cr = this.cr, item = this.junction;
        const key = surface + 'Junction';
        let layer = this.layers[key];
        if (!blend && !layer) return false;
        const { x, y, size } = this._where(surface, '');
        const frameKey = blend ? [item.kind, item.metres, !!item.demo, size, x].join(':') : '';
        let frame = frameKey && (layer && layer.frameKey === frameKey ? layer.frame : junctionFrame(item, size, surface === 'panel'));
        if (frame && frame.offset > x) frame = junctionFrame(item, size, false);
        if (frame && !frame.offset && x + frame.w > TARGETS[surface].w) frame = junctionFrame(item, size, true);
        const origin = frame && Math.max(0, Math.min(TARGETS[surface].w - frame.w, x - frame.offset));
        const place = frame && { x: origin, y, w: frame.w, h: size };
        if (layer && (!place || layer.frame.w !== frame.w || layer.size !== size)) {
            cr.drop(layer.ref);
            delete this.layerStates[layer.ref];
            delete this.layers[key];
            layer = null;
        }
        if (!place) return false;
        if (!layer) {
            const ref = cr.image(Object.assign({ target: surface, class: 'overlay', z: 21, iw: frame.w * TEXTURE_SCALE, ih: size * TEXTURE_SCALE, sampling: 'bilinear', opacity: blend,
                fps: 20, visible: 1, contend: 0, yield: yld }, place));
            layer = this.layers[key] = { ref, size, place, yld };
        } else if (layer.place.x !== place.x || layer.place.y !== place.y || layer.place.w !== place.w ||
            layer.place.h !== place.h || layer.yld !== yld) {
            cr.set(layer.ref, Object.assign({ yield: yld }, place));
            layer.place = place;
            layer.yld = yld;
        }
        if (layer.blend !== undefined && layer.blend !== blend) cr.set(layer.ref, { opacity: blend });
        if (layer.frameKey !== frameKey) cr.pixels(layer.ref, frame.px);
        Object.assign(layer, { frame, frameKey, blend });
        return true;
    }

    diag() {
        const cr = this.cr, L = this.layers;
        const st = (t) => (L[t] ? (L[t].visible ? this.layerStates[L[t].ref] || 'sent' : 'hidden') : 'none');
        return {
            connected: !!(cr && cr.ready), unsupported: cr ? cr.unsupported : '', targetsOffered: cr ? cr.targets : '',
            hud: st('hud'), cluster: st('panel'), panelAvailable: this.panelAvailable,
            targets: this.targets, refused: this.refused,
        };
    }
}

module.exports = { Outputs, TARGETS };
