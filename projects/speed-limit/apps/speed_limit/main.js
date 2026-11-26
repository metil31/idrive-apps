'use strict';
/**
 * Speed Limit - the speed limit of the road the car is on, on the cluster's map and the head-up display, from an
 * offline OpenStreetMap pack (romania.pack, kit/tools/pack_sli.py). Read only: it subscribes to the car's position,
 * speed and power state and writes nothing to any unit.
 *
 * Starts with the car (app.json "autostart": background() runs without screens). It works only while it is shown
 * somewhere (setting "Show on": Cluster, HUD, or both) and the car is on (power state 7 ignition, 8 starting,
 * 10 drive-ready, 12 ending): then it matches the position to a road twice a second (every 2 s, without matching
 * again, while standing still) and
 * shows the limit. Otherwise it idles: the position and speed subscriptions are dropped, the map file is closed,
 * the cluster-render connection goes (the HUD and the cluster are given back) and no timer runs; only the power
 * state stays subscribed, so it wakes with the car.
 *
 * The app's page is the HMI's own list (no GPU renderer), laid out as Maps on cluster's (below). Its settings are
 * app.json "hidden" ones: the page itself shows and changes them.
 *
 * In the car: the driver corrects the limit of the road the car is on (fixes.js, data/corrections.json, kept by app
 * updates and new maps), and the drive log (setting "driveLog") writes a line to the app's log each time the road or
 * the limit changes; the page's "Show the log as QR codes" puts the log on screen for a phone photo (qrlog.js).
 */
const path = require('path');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const { menuLanguage } = require('./kit/menu-language');
const { WazeLimit, chooseWazeLimit } = require('./waze-limit');
const { LimitPack } = require('./limitpack');
const { Matcher } = require('./matcher');
const { Position, DemoDrive } = require('./position');
const { Cameras, camText } = require('./cameras');
const { Outputs, TARGETS } = require('./outputs');
const { Fixes } = require('./fixes');
const { unmerc } = require('./limitpack');
const { Junctions, DEMO, demoAllowed } = require('./junctions');
const JUNCTION_DATA = require('./junctions-data');

const APP_ID = 'speed_limit';
const WAZE_MODES = ['offline', 'uncertain', 'prefer'];
const PACK = path.join(__dirname, 'romania.pack');
const TICK_MS = 500;            // driving: twice a second
const STILL_MS = 2000;          // standing still (a light, a jam): every 2 s
const BOOT_WAIT_MS = 5000;      // at start-up, the time the power state has to arrive before the app runs without it
const VIEW_HOLD_MS = 8000;
const JUNCTION_DEMO_MS = 90000;
const ACTIVE = { 7: true, 8: true, 10: true, 12: true };
const DRIVE_LOG_PER_MIN = 40;   // the drive log's most lines a minute (a road that flips back and forth)

/* ---------- the engine: runs with or without the app's screens ---------- */
class Engine {
    constructor(bg) {
        this.log = bg.log;
        this.settings = bg.settings;
        this.signals = bg.signals;
        this.pack = null;               // open only while active
        this.matcher = null;
        this.meta = null;               // the map's META (its date, for the page), read once
        this.packError = '';
        try { const p = LimitPack.open(PACK); this.meta = p.meta; this.log.info('map: ' + p.describe()); p.close(); } catch (e) { this.packError = String(e.message || e); this.log.error('map: ' + this.packError); }
        this.fixes = new Fixes(path.join(bg.dataDir || '.', 'corrections.json'), this.log);
        if (this.fixes.count) this.log.info('corrections: ' + this.fixes.count + (this.fixes.count === 1 ? ' road' : ' roads'));
        this.drive = { key: '', minute: 0, n: 0 };   // the drive log's last line and its lines this minute
        this.position = new Position(this.signals, this.log);
        this.outputs = new Outputs(APP_ID, this.log, this.settings);
        this.waze = new WazeLimit();
        this.demoOn = this.settings.get('demo') === 'on';   // the PC's emulator and preview; never set in a car
        this.demo = null;
        this.condition = undefined;
        this.carOn = undefined;         // from the power state; undefined: not known (then it runs)
        this.active = false;
        this.timer = null;
        this.bootTimer = null;
        this.res = null;
        this.view = null;
        this.viewAt = 0;
        this.speed = null;
        this.fix = null;
        this.cams = null;               // speed cameras ahead (the pack's), while active
        this.camera = null;             // { dist, ms } of the one ahead
        this.junctions = null;
        this.junction = null;
        this.junctionDemo = null;
        this.listeners = [];
        this.settings.onChange((k) => {
            if (k === 'show') this._evaluate();
            if (k === 'wazeLimit') this.waze.reset();
            if (/^def/.test(k) && this.matcher) this.matcher.setDefaults(this.defaults());
            if (this.active) {
                const now = Date.now();
                if (!this.junctionAvailable()) this.junctionDemo = null;
                if (k === 'junctionHud' || k === 'junctionCluster' || k === 'show') {
                    this.junction = null;
                    this.junctions.update(null, null);
                }
                if (k === 'wazeLimit') this._decide(now);
                this._show(now);
            }
            this._changed();
        });
    }

    defaults() {
        const s = this.settings, n = (k, d) => Number(s.get(k)) || d;
        return { living: n('defLiving', 20), urban: n('defUrban', 50), rural: n('defRural', 90),
            european: n('defEuropean', 100), expressway: n('defExpressway', 120), motorway: n('defMotorway', 130) };
    }

    async start() {
        // the power state: the one subscription kept while idle
        const sub = await Promise.resolve(this.signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: (v) => this._condition(Car.conditionOf(v && v.statusConditionVehicle)),
        }, this.log)).catch((e) => ({ error: String(e) }));
        if (this.demoOn) { this.log.info('demo drive (no car)'); this.carOn = true; } else if (sub && sub.error) this.log.warn('power state not available (' + sub.error + '): running while the app runs');
        else if (this.condition === undefined) {
            // the head unit starting up: wait for the power state before running (a parked car's start-up then never
            // opens the map or subscribes to anything); without one after BOOT_WAIT_MS, run while the app runs
            this.bootTimer = setTimeout(() => { this.bootTimer = null; this._evaluate(); }, BOOT_WAIT_MS);
            return;
        }
        this._evaluate();
    }

    enabled() { return this.settings.get('show') !== 'off'; }

    /** Run while shown somewhere and the car is on (or its state is not known). */
    _evaluate() { if (!this.bootTimer) this._setActive(this.enabled() && this.carOn !== false && !this.packError); }

    _condition(c) {
        if (c === undefined || c === this.condition) return;
        this.condition = c;
        if (this.junctionDemo && c !== 7 && c !== 10) this.previewJunction(null);
        if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
        if (!this.demoOn) this.carOn = !!ACTIVE[c];
        this._evaluate();
    }

    _setActive(on) {
        if (on === this.active) return;
        this.active = on;
        if (on) {
            this.log.info('on: matching');
            try {
                this.pack = LimitPack.open(PACK);
                this.matcher = new Matcher(this.pack, { defaults: this.defaults(), fixes: this.fixes });
                this.cams = new Cameras(this.pack.cameras);
                this.junctions = new Junctions(this.pack, JUNCTION_DATA.signs);
                if (this.demoOn) this.demo = new DemoDrive(this.pack, { way: this.settings.get('demoWay'), speed: this.settings.get('demoSpeed') });
            } catch (e) { this.packError = String(e.message || e); this.log.error('map: ' + this.packError); this.active = false; return; }
            if (!this.demoOn) this.position.start().catch((e) => this.log.warn('position: ' + e));
            this.outputs.start();
            this._schedule(0);
        } else {
            this.log.info((this.enabled() ? 'car off' : 'switched off') + ': idle (subscriptions dropped, map closed, HUD and cluster given back)');
            clearTimeout(this.timer); this.timer = null;
            this.position.stop().catch(() => {});
            this.outputs.stop();
            this.waze.reset();
            if (this.pack) this.pack.close();
            this.pack = null; this.matcher = null; this.demo = null; this.cams = null; this.camera = null;
            this.junctions = this.junction = this.junctionDemo = null;
            this.view = null; this.res = null; this.fix = null; this.speed = null;
        }
        this._changed();
    }

    /** The next tick: twice a second while driving, every 2 s while standing still; none while idle. */
    _schedule(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; if (this.active) { this._tick(); if (this.active) this._schedule(this._still() ? STILL_MS : TICK_MS); } }, ms);
    }

    /** Standing still on a matched road: nothing to match again (the position only wanders). */
    _still() { return this.speed !== null && this.speed < 2 && !!this.fix && !!this.res && this.res.state === 'match'; }

    _tick() {
        const now = Date.now();
        if (!this.demo) { this.position.poll(now); this.outputs.tick(now); } else this.outputs.tick(now);
        this.fix = this.demo ? this.demo.fix(now) : this.position.fix(now);
        this.speed = this.demo ? this.demo.speedKmh(now) : this.position.speedKmh(now);
        const alerts = this.junctionAvailable(true);
        const approaching = alerts && this.condition === 10 && this.speed !== null && (this.speed >= 2 || !!this.junction);
        if (!this._still() || approaching) this.res = this.matcher.update(this.fix, now);
        // a speed camera ahead (setting "cameras"): a few multiplications per camera near the car
        this.camera = this.cams && this.settings.get('cameras') !== 'off' ? this.cams.update(this.fix, this.matcher.heading, now) : null;
        const r = this.res, wazeMode = this.settings.get('wazeLimit');
        if ((wazeMode === 'uncertain' || wazeMode === 'prefer') && this.condition === 10 && !this.demo) {
            const road = r && r.state === 'match' && r.way && r.dir && this.fix && this.fix.age <= 2500 ?
                r.way + ':' + r.dir : '';
            this.waze.tick(now, road);
        } else if (this.waze.road || this.waze.due) this.waze.reset();
        this._decide(now);
        const live = approaching && this.fix && this.fix.age <= 2500;
        this.junction = this.junctions.update(live ? this.fix : null, this.res);
        this._show(now);
        if (this.settings.get('driveLog') !== false) this._driveLog(now);
        this._changed();
    }

    junctionAvailable(requireEnabled = false) {
        const show = this.settings.get('show');
        return ((show === 'hud' || show === 'both') && (!requireEnabled || this.settings.get('junctionHud') === true)) ||
            ((show === 'cluster' || show === 'both') && (!requireEnabled || this.settings.get('junctionCluster') === true));
    }

    canPreviewJunction(now) {
        return this.active && this.junctionAvailable() && demoAllowed(this.condition, this.position.speedKmh(now));
    }

    previewJunction(kind) {
        const now = Date.now();
        if (kind && (!(DEMO[kind] || kind === 'limit' || kind === 'camera') || !this.canPreviewJunction(now))) return;
        this.junctionDemo = kind ? { kind, metres: DEMO[kind], demo: true, until: now + JUNCTION_DEMO_MS } : null;
        if (this.active) this._show(now);
        this._changed();
    }

    _show(now) {
        if (this.junctionDemo && (now >= this.junctionDemo.until || !this.canPreviewJunction(now))) this.junctionDemo = null;
        const sample = this.junctionDemo;
        const numeric = sample && (sample.kind === 'limit' || sample.kind === 'camera');
        this.outputs.setJunction(numeric ? null : sample || this.junction, now);
        this.outputs.update(numeric ? { limit: 50, camera: sample.kind === 'camera' ? '350 m' : '', demo: true } : this.view, now);
    }

    /** The drive log: a line when the road, its limit or what is shown changes (a few a minute), for a report. */
    _driveLog(now) {
        const r = this.res, v = this.view, f = this.fix;
        const lim = (o) => (o && o.limit ? o.limit + (o.corrected ? 'c' : o.source === 'waze' ? 'w' : o.inferred ? 'd' : '') : '-');
        const key = (r ? r.state + ' way ' + (r.way || '-') + ' ' + lim(r) : 'none') + ' shown ' + lim(v) + (v && v.camera ? ' cam' : '');
        if (key === this.drive.key) return;
        const minute = Math.floor(now / 60000);
        if (minute !== this.drive.minute) { this.drive.minute = minute; this.drive.n = 0; }
        if (++this.drive.n > DRIVE_LOG_PER_MIN) return;
        this.drive.key = key;
        let at = '';
        if (f) {
            const ll = f.lat != null ? [f.lat, f.lon] : unmerc(f.x, f.y);
            at = ' at ' + ll[0].toFixed(5) + ',' + ll[1].toFixed(5) + (this.matcher && this.matcher.heading != null ? ' h' + Math.round(this.matcher.heading) : '') +
                (this.speed != null ? ' ' + Math.round(this.speed) + 'km/h' : '') + (f.source ? ' ' + f.source : '') + (r && r.dist != null ? ' ' + Math.round(r.dist) + 'm off' : '');
        }
        this.log.info('drive: ' + key + (r && r.corrected ? ' (map ' + (r.mapLimit || '-') + (r.mapInferred ? 'd' : '') + ')' : '') + at);
    }

    /** The road the car is on now, for a correction: { way, dir, P } or null. */
    road() {
        const r = this.res;
        if (!this.active || !this.pack || !r || !r.way || r.piece < 0 || (r.state !== 'match' && r.state !== 'hold')) return null;
        return { way: r.way, dir: r.dir, P: this.pack.piece(r.piece) };
    }

    /** Correct the limit of the road the car is on (0: back to the map's). Both directions unless the map gives the
     * two directions different limits (then the one driven). -> true when done. */
    correct(kmh) {
        const rd = this.road();
        if (!rd) return false;
        if (!kmh) { this.fixes.remove(rd.way, 'back to the map on the page'); this._refresh(); return true; }
        const { limitOf } = require('./matcher');
        const d = this.defaults(), same = (rd.P.flags & 1) || rd.dir === 0 || limitOf(rd.P, 1, d).limit === limitOf(rd.P, -1, d).limit;
        const old = this.fixes.get(rd.way) || { f: 0, b: 0 };
        const f = same || rd.dir > 0 ? kmh : old.f, b = same || rd.dir < 0 ? kmh : old.b;
        const ll = this.fix ? (this.fix.lat != null ? [this.fix.lat, this.fix.lon] : unmerc(this.fix.x, this.fix.y)) : null;
        this.fixes.set(rd.way, f, b, ll ? { lat: ll[0], lon: ll[1] } : null);
        this._refresh();
        return true;
    }
    /**
     * Every correction into the log, with what the map says of that road, for the QR log (kit/tools/qrlog_decode.py
     * --osm makes them a list of roads to fix in OpenStreetMap):
     *   correction: way=59594305 set=50/50 map=60d/60d oneway=1 at=41.58993,44.94827 on=2026-11-22T14:23
     * set / map: km/h along / against the way (0 none; d: the default, none tagged). The map is opened for it when the
     * app is idle (closed again right after).
     */
    logFixes() {
        const list = this.fixes.list;
        if (!list.length) return;
        const { limitOf } = require('./matcher'), { merc, groundScale } = require('./limitpack');
        let pack = this.pack, opened = false;
        try { if (!pack) { pack = LimitPack.open(PACK); opened = true; } } catch (e) { pack = null; }
        const d = this.defaults(), lim = (L) => (L.limit || 0) + (L.inferred ? 'd' : '');
        list.forEach((r) => {
            let map = '-', ow = '-';
            if (pack && r.lat != null) {
                const xy = merc(r.lat, r.lon), ids = pack.near(xy[0], xy[1], 80 / groundScale(xy[1]));
                for (let i = 0; i < ids.length; i++) {
                    const P = pack.piece(ids[i]);
                    if (P.way !== r.way) continue;
                    map = lim(limitOf(P, 1, d)) + '/' + lim(limitOf(P, -1, d));
                    ow = P.flags & 1 ? '1' : '0';
                    break;
                }
            }
            this.log.info('correction: way=' + r.way + ' set=' + r.f + '/' + r.b + ' map=' + map + ' oneway=' + ow +
                ' at=' + (r.lat != null ? r.lat + ',' + r.lon : '-') + ' on=' + (r.at || '-'));
        });
        if (opened) pack.close();
    }

    undoFix() { if (this.fixes.undo()) this._refresh(); }
    clearFixes() { if (this.fixes.clear()) this._refresh(); }

    /** The road's limit again after a correction changed (without waiting for the next tick). */
    _refresh() {
        if (this.active && this.matcher && this.matcher.cur && this.res) this.res = this.matcher._result(this.res.state, this.matcher.cur, { candidates: this.res.candidates });
        if (this.active) { const now = Date.now(); this._decide(now); this._show(now); }
        this._changed();
    }

    _decide(now) {
        const r = this.res, s = this.settings;
        const thr = Number(s.get('overspeed')) || 0;
        // over from limit + threshold, back under 2 km/h below it: a speed right at it does not flip the sign (and
        // send its pixels) again and again
        const wasOver = !!(this.view && this.view.over);
        const over = (lim) => thr > 0 && this.speed !== null && lim > 0 && this.speed > lim + thr - (wasOver ? 2 : 0);
        const waze = chooseWazeLimit(this.waze.value(now), s.get('wazeLimit'), r);
        if (waze) {
            this.view = { limit: waze, source: 'waze', inferred: false, over: over(waze) };
        } else if (r && r.limit && !(r.inferred && s.get('untagged') === 'hide')) {
            this.view = { limit: r.limit, inferred: r.inferred, over: over(r.limit), corrected: !!r.corrected };
            this.viewAt = now;
        } else if (!(r && r.state === 'match') && this.view && this.view.limit && this.view.source !== 'waze' && now - this.viewAt < VIEW_HOLD_MS) {
            this.view = { limit: this.view.limit, inferred: this.view.inferred, over: over(this.view.limit), corrected: this.view.corrected };
        } else if (s.get('noLimit') === 'dashes') {
            this.view = { limit: null, unknown: true, inferred: false, over: false };     // "---", as BMW's own
        } else this.view = null;
        // the camera's distance in the pill beside the sign (with "---" when no limit is known)
        if (this.camera) {
            const camera = camText(this.camera.dist);
            this.view = this.view ? Object.assign({}, this.view, { camera }) : { limit: null, unknown: true, inferred: false, over: false, camera };
        }
    }

    onChange(fn) { this.listeners.push(fn); }
    _changed() { for (let i = 0; i < this.listeners.length; i++) this.listeners[i](); }
}

async function background(bg) {
    const engine = new Engine(bg);
    await engine.start();
    return engine;
}

/* ---------- the page: the HMI's own list, laid out as Maps on cluster's (app.json screen "menu") ----------
 * General: Show on (Cluster, HUD, Cluster and HUD, Off), Red sign over the limit, When there's no limit (nothing, or
 * "---" as BMW's own), Speed cameras (Warn: a pill with the camera's distance joined to the sign; Off), Speed limit.
 * Cluster (on the phone map, Maps on cluster's): Cluster sign, Size (a slider), Position with Move left / right / up /
 * down and Default position.
 * HUD: HUD sign, Keep HUD sign over BMW's pop-ups, Size, Position, the moves and Default position.
 * This road: what the map says of the road the car is on, Correct its limit (Use the map, 20 ... 130 km/h), how many
 * corrections there are, Undo the last one, Clear all (pressed twice).
 * Drive log: Keep a drive log (on), Show the log as QR codes (the SL_QR screen: Previous, Next, Size).
 * A section's controls are greyed while Show on leaves its display out. Map: the data's date and licence. Info rows
 * read "Name: Value"; a row is written only when it changes, and only while the page shows. ASCII only. */
const SHOW = ['cluster', 'hud', 'both', 'off'];
const OVER = ['0', '5', '10', '15', '20'];
const NOLIMIT = ['nothing', 'dashes'];
const CAMS = ['warn', 'off'];
const FIXV = [0, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];
// The slider sizes in step order, and the move step on each target.
const SIZES = {
    hud: [40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144],
    map: [70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180],
};
const STEP = { hud: 10, map: 10 };
/** A section's place: the HUD's, or the cluster's (the phone map). */
function placeOf(k) {
    const target = k === 'hud' ? 'hud' : 'map', T = TARGETS[target];
    return { target, show: k, size: T.size, x: T.x, y: T.y, def: T.def, sizes: SIZES[target], step: STEP[target], row: k === 'hud' ? 'SL_HUD' : 'SL_CL' };
}

function limitText(e, t) {
    const r = e.res, v = e.view, prefix = t('Speed limit: ', 'Limita de viteza: ');
    if (e.packError) return prefix + t('no map', 'harta indisponibila');
    if (!e.active) return prefix + (e.enabled() ? t('car off', 'masina oprita') : t('off', 'dezactivata'));
    const cam = v && v.camera ? t(', speed camera in ', ', radar in ') + v.camera : '';
    if (v && v.source === 'waze') {
        const offline = r && r.limit ? ' · ' + t('Offline ', 'Offline ') + r.limit + ' km/h' : '';
        return prefix + v.limit + ' km/h · Waze' + offline + cam;
    }
    if (v && v.limit) return prefix + v.limit + ' km/h' + (v.inferred ? t(' (road default)', ' (implicita pentru drum)') : '') + cam;
    if (r && r.variable) return t('Variable or conditional limit', 'Limita variabila sau conditionata') + cam;
    if (r && r.uncertain) return t('Limit varies by direction', 'Limita difera in functie de sensul de mers') + cam;
    if (cam) return prefix + t('unknown', 'necunoscuta') + cam;
    if (!r || r.state === 'nofix') return prefix + t('waiting for position', 'asteapta pozitia');
    if (r.state === 'outside') return prefix + t('outside the map', 'in afara hartii');
    return prefix + t('no road here', 'niciun drum aici');
}

function signState(e, surface, t) {
    const show = e.settings.get('show'), o = e.outputs.diag();
    if (show !== surface && show !== 'both') return t('Off', 'Dezactivat');
    if (!e.active) return e.enabled() ? t('Car off', 'Masina oprita') : t('Off', 'Dezactivat');
    if (!o.connected) return t('Renderer unavailable', 'Renderer indisponibil');
    if (surface === 'cluster' && !o.mapBusy && !o.panelMapBy) return t('Waiting for the cluster map', 'Asteapta harta din bord');
    const alert = e.junctionDemo || e.junction;
    if (alert && (alert.demo || e.settings.get(surface === 'cluster' ? 'junctionCluster' : 'junctionHud') === true)) {
        if (alert.kind === 'limit') return t('Demo speed limit', 'Demo limita de viteza');
        if (alert.kind === 'camera') return t('Demo speed camera', 'Demo radar');
        return (alert.demo ? 'Demo ' : '') + (alert.kind === 'stop' ? 'STOP' : t('Give way', 'Cedeaza trecerea')) + ', ' + alert.metres + ' m';
    }
    if (!e.view) return t('No limit to show', 'Limita indisponibila');
    const state = o[surface];
    return /^shown/.test(state) ? t('Shown', 'Afisat') : t('Waiting', 'In asteptare');
}

/** How far a sign may move from its default place and stay on its display (outputs.js TARGETS). */
function room(P, s) {
    const T = TARGETS[P.target], z = Number(s.get(P.size)) || P.def;
    return { x0: z / 2 - T.cx, x1: T.w - T.cx - z / 2, y0: z / 2 - T.cy, y1: T.h - T.cy - z / 2 };
}

function clusterRoute(e, t) {
    const o = e.outputs.diag();
    const show = e.settings.get('show'), prefix = t('Cluster: ', 'Bord: ');
    if (show !== 'cluster' && show !== 'both') return prefix + t('display disabled', 'afisare dezactivata');
    if (!o.connected) return prefix + t('renderer disconnected', 'renderer deconectat');
    if (o.mapHost) return prefix + t('map hosted in ', 'harta mutata in ') + o.mapHost;
    if (!o.statusAt) return prefix + t('waiting for renderer status', 'asteapta starea rendererului');
    if (o.panelBy.length && o.mapBusy) return prefix + t('map and separate panel', 'harta si panou separat') + ' (' + o.panelBy[0] + ')';
    if (o.panelBy.length) return prefix + t('panel without separate map', 'panou fara harta separata') + ' (' + o.panelBy[0] + ')';
    return prefix + (o.mapBusy ? t('map in standard area', 'harta in zona standard') : t('no visible map', 'fara harta vizibila'));
}

function posText(x, y, t) {
    if (!x && !y) return t('Position: Default', 'Pozitie: Implicita');
    const h = x > 0 ? x + t(' px right', ' px dreapta') : x < 0 ? -x + t(' px left', ' px stanga') : '';
    const v = y > 0 ? y + t(' px down', ' px jos') : y < 0 ? -y + t(' px up', ' px sus') : '';
    return t('Position: ', 'Pozitie: ') + (h && v ? h + ', ' + v : h || v);
}

function roadText(e, t) {
    const rd = e.road(), r = e.res, label = t('This road: ', 'Drumul curent: ');
    if (!rd) return label + (e.active ? t('no matched road', 'niciun drum identificat') : '-');
    const lim = (l, inf) => l ? l + ' km/h' + (inf ? t(' (default, none on map)', ' (implicita, lipseste din harta)') : '') : t('none', 'niciuna');
    const id = t(', OSM way ', ', segment OSM ') + rd.way;
    if (r.corrected) return label + t('your limit ', 'limita ta ') + r.limit + ' km/h' + t(' (map: ', ' (harta: ') + lim(r.mapLimit, r.mapInferred) + ')' + id;
    return label + t('map ', 'harta ') + lim(r.limit, r.inferred) + id;
}

function fixesText(e, t) {
    const n = e.fixes.count;
    return t('Corrections: ', 'Corectii: ') + (n ? n + (n === 1 ? t(' road', ' drum') : t(' roads', ' drumuri')) : t('none', 'niciuna'));
}

function mapText(e, t) {
    return t('Map: ', 'Harta: ') + (e.meta ? 'OpenStreetMap ' + (e.meta.data || '') + ', (c) OpenStreetMap contributors, ODbL' : '-');
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings: s } = ctx;
        const language = menuLanguage(ctx), { t } = language;
        const engine = ctx.background || await background(ctx);
        const done = {};
        const once = (key, value, fn) => { if (done[key] === value) return; done[key] = value; Promise.resolve().then(fn).catch(() => {}); };
        const on = (P) => s.get('show') === P.show || s.get('show') === 'both';
        const sliders = { hud: ui.comp('SL_HUD_SIZE'), cluster: ui.comp('SL_CL_SIZE') };
        let clearArmed = 0;             // Clear all: pressed once at (ms); a second press within 6 s clears

        /** A display's section: its status row, size slider, position row and buttons (greyed while it is not chosen). */
        function renderPlace(k) {
            const P = placeOf(k), R = P.row, slider = sliders[k], live = on(P);
            const x = Number(s.get(P.x)) || 0, y = Number(s.get(P.y)) || 0;
            // the slider at the size nearest the setting; its text says the size itself (keyed by the place too: two
            // places can share a slider position with different sizes)
            const size = Number(s.get(P.size)) || P.def;
            let step = 0;
            P.sizes.forEach((v, i) => { if (Math.abs(v - size) < Math.abs(P.sizes[step] - size)) step = i; });
            const st = (k === 'hud' ? t('HUD sign: ', 'Semn HUD: ') : t('Cluster sign: ', 'Semn bord: ')) + signState(engine, k, t);
            once(R, st, () => ui.text(R, st));
            once(R + ':sizeText', P.target + ':' + size, () => ui.cells(R + '_SIZE', 0, { TextDescription: t('Size: ', 'Marime: ') + size + ' px' }));
            once(R + ':sizeStep', step, () => (slider && slider.setStepValue ? slider.setStepValue(step) : ui.cells(R + '_SIZE', 0, { Value: step })));
            once(R + ':pos', P.target + ':' + x + ',' + y, () => ui.text(R + '_POS', posText(x, y, t)));
            ['_SIZE', '_LEFT', '_RIGHT', '_UP', '_DOWN'].concat(k === 'hud' ? ['_KEEP'] : []).forEach((n) => once('en:' + R + n, live, () => ui.enabled(R + n, live)));
            const back = live && (x !== 0 || y !== 0);
            once('en:' + R + '_DEFAULT', back, () => ui.enabled(R + '_DEFAULT', back));
        }

        function render() {
            if (!ui.isVisible('MAIN')) return;
            if (language.render()) Object.keys(done).forEach(key => delete done[key]);
            const show = Math.max(0, SHOW.indexOf(s.get('show'))), over = Math.max(0, OVER.indexOf(String(s.get('overspeed'))));
            const nolim = Math.max(0, NOLIMIT.indexOf(s.get('noLimit')));
            const lim = limitText(engine, t);
            once('show', show, () => ui.selected('SL_SHOW', show));
            once('over', over, () => ui.selected('SL_OVER', over));
            once('nolim', nolim, () => ui.selected('SL_NOLIMIT', nolim));
            const cams = Math.max(0, CAMS.indexOf(s.get('cameras')));
            once('cams', cams, () => ui.selected('SL_CAMS', cams));
            once('limit', lim, () => ui.text('SL_LIMIT', lim));
            const wazeMode = Math.max(0, WAZE_MODES.indexOf(s.get('wazeLimit')));
            once('wazeMode', wazeMode, () => ui.selected('SL_WAZE', wazeMode));
            const reading = wazeMode && engine.waze.value(Date.now());
            const wazeStatus = !wazeMode ? t('Waze: off', 'Waze: dezactivat') : reading ?
                'Waze: ' + reading + ' km/h' : t('Waze: waiting for a confirmed limit', 'Waze: asteapta o limita confirmata');
            once('wazeStatus', wazeStatus, () => ui.text('SL_WAZE_STATUS', wazeStatus));
            once('keep', !!s.get('hudKeep'), () => ui.checked('SL_HUD_KEEP', !!s.get('hudKeep')));
            once('map', mapText(engine, t), () => ui.text('SL_MAP', mapText(engine, t)));
            // this road and its correction
            const rd = engine.road(), fx = rd ? engine.fixes.get(rd.way) : null;
            const cur = fx ? (rd.dir < 0 ? fx.b : fx.f) || fx.f || fx.b : 0, fi = Math.max(0, FIXV.indexOf(cur));
            once('road', roadText(engine, t), () => ui.text('SL_ROAD', roadText(engine, t)));
            once('fix', fi, () => ui.selected('SL_FIX', fi));
            once('en:fix', !!rd, () => ui.enabled('SL_FIX', !!rd));
            const n = engine.fixes.count, armed = n > 0 && Date.now() - clearArmed < 6000;
            once('fixes', fixesText(engine, t), () => ui.text('SL_FIXES', fixesText(engine, t)));
            once('en:undo', n > 0, () => ui.enabled('SL_FIX_UNDO', n > 0));
            once('en:clear', n > 0, () => ui.enabled('SL_FIX_CLEAR', n > 0));
            const ct = armed ? t('Press again to clear all ', 'Apasa din nou pentru a sterge toate cele ') + n : t('Clear all corrections', 'Sterge toate corectiile');
            once('clear', ct, () => ui.text('SL_FIX_CLEAR', ct));
            once('log', s.get('driveLog') !== false, () => ui.checked('SL_LOG', s.get('driveLog') !== false));
            renderPlace('cluster');
            const route = clusterRoute(engine, t);
            once('clusterRoute', route, () => ui.text('SL_CL_ROUTE', route));
            renderPlace('hud');
            const preview = engine.canPreviewJunction(Date.now()), demo = !!engine.junctionDemo;
            once('junction', s.get('junctionHud') === true, () => ui.checked('SL_JUNCTION', s.get('junctionHud') === true));
            const hud = on(placeOf('hud')), cluster = on(placeOf('cluster'));
            once('en:junction', hud, () => ui.enabled('SL_JUNCTION', hud));
            once('junctionCluster', s.get('junctionCluster') === true,
                () => ui.checked('SL_JUNCTION_CL', s.get('junctionCluster') === true));
            once('en:junctionCluster', cluster, () => ui.enabled('SL_JUNCTION_CL', cluster));
            once('en:preview', preview, () => {
                ui.enabled('SL_JUNCTION_YIELD', preview);
                ui.enabled('SL_JUNCTION_STOP', preview);
                ui.enabled('SL_DEMO_LIMIT', preview);
                ui.enabled('SL_DEMO_CAMERA', preview);
            });
            once('en:demoEnd', demo, () => ui.enabled('SL_JUNCTION_END', demo));
        }

        // the HMI moves a drop-down's choice and the slider itself: only the setting follows
        ui.onClick('SL_WAZE', (ev) => { if (WAZE_MODES[ev.row]) s.set('wazeLimit', WAZE_MODES[ev.row]); });
        ui.onClick('SL_SHOW', (ev) => { const v = SHOW[ev.row]; if (v) { done.show = ev.row; s.set('show', v); } });
        ui.onClick('SL_OVER', (ev) => { const v = OVER[ev.row]; if (v != null) { done.over = ev.row; s.set('overspeed', v); } });
        ui.onClick('SL_NOLIMIT', (ev) => { const v = NOLIMIT[ev.row]; if (v) { done.nolim = ev.row; s.set('noLimit', v); } });
        ui.onClick('SL_CAMS', (ev) => { const v = CAMS[ev.row]; if (v) { done.cams = ev.row; s.set('cameras', v); } });
        ui.onClick('SL_HUD_KEEP', () => { if (on(placeOf('hud'))) s.set('hudKeep', !s.get('hudKeep')); });
        ui.onClick('SL_JUNCTION', () => { if (on(placeOf('hud'))) s.set('junctionHud', s.get('junctionHud') !== true); });
        ui.onClick('SL_JUNCTION_CL', () => {
            if (on(placeOf('cluster'))) s.set('junctionCluster', s.get('junctionCluster') !== true);
        });
        ui.onClick('SL_DEMO_LIMIT', () => engine.previewJunction('limit'));
        ui.onClick('SL_DEMO_CAMERA', () => engine.previewJunction('camera'));
        ui.onClick('SL_JUNCTION_YIELD', () => engine.previewJunction('yield'));
        ui.onClick('SL_JUNCTION_STOP', () => engine.previewJunction('stop'));
        ui.onClick('SL_JUNCTION_END', () => engine.previewJunction(null));
        // a correction of the road the car is on; off a road the drop-down goes back to what it showed
        ui.onClick('SL_FIX', (ev) => {
            const v = FIXV[ev.row];
            if (v == null || !engine.correct(v)) delete done.fix; else done.fix = ev.row;
            render();
        });
        ui.onClick('SL_FIX_UNDO', () => { engine.undoFix(); render(); });
        ui.onClick('SL_FIX_CLEAR', () => {
            if (Date.now() - clearArmed < 6000) { clearArmed = 0; engine.clearFixes(); } else {
                clearArmed = Date.now();
                setTimeout(render, 6100);
            }
            render();
        });
        ui.onClick('SL_LOG', () => s.set('driveLog', s.get('driveLog') === false));
        ui.onClick('SL_QR_SHOW', () => { ui.open('SL_QR'); });
        ['hud', 'cluster'].forEach((k) => {
            const R = k === 'hud' ? 'SL_HUD' : 'SL_CL', slider = sliders[k];
            if (slider && slider.on) slider.on('changed', (step) => { const P = placeOf(k), v = P.sizes[step]; if (v && on(P)) { done[R + ':sizeStep'] = step; s.set(P.size, v); } });
            const move = (dx, dy) => () => {
                const P = placeOf(k);
                if (!on(P)) return;
                const B = room(P, s), x = Number(s.get(P.x)) || 0, y = Number(s.get(P.y)) || 0;
                const nx = Math.round(Math.max(B.x0, Math.min(B.x1, x + dx * P.step))), ny = Math.round(Math.max(B.y0, Math.min(B.y1, y + dy * P.step)));
                if (nx !== x) s.set(P.x, nx);
                if (ny !== y) s.set(P.y, ny);
            };
            ui.onClick(R + '_LEFT', move(-1, 0));
            ui.onClick(R + '_RIGHT', move(1, 0));
            ui.onClick(R + '_UP', move(0, -1));
            ui.onClick(R + '_DOWN', move(0, 1));
            ui.onClick(R + '_DEFAULT', () => { const P = placeOf(k); if (s.get(P.x)) s.set(P.x, 0); if (s.get(P.y)) s.set(P.y, 0); });
        });
        s.onChange(render);
        // the status rows: at most once a second, and only while the page is open
        let timer = null;
        engine.onChange(() => {
            if (timer || !ui.isVisible('MAIN')) return;
            timer = setTimeout(() => { timer = null; render(); }, 1000);
        });
        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            if (!v) { if (engine.junctionDemo) engine.previewJunction(null); return; }
            Object.keys(done).forEach((k) => delete done[k]); render();
        });
        render();
        qrScreen(ctx, engine, language);
    },
});

/* ---------- the QR screen: the app's log as codes to photograph (qrlog.js), for a report without SSH ----------
 * Made when it opens (the log read, compressed and cut into codes; a report line written first: version, map,
 * corrections, settings), a code drawn when it is shown; the picture is dropped when the screen closes. */
function qrScreen(ctx, engine, language) {
    const { ui, settings: s, log } = ctx;
    const { t } = language;
    const Q = require('./qrlog'), qr = require('./qr'), { Canvas } = require('./kit/canvas');
    const file = path.join(ctx.dataDir || '.', APP_ID + '.log');
    const st = { size: 'medium', page: 0, list: null };
    const sizeLabel = () => t(Q.SIZES[st.size].label, { large: 'Mare', medium: 'Medie', small: 'Mica' }[st.size]);
    const load = () => {
        st.list = Q.pages(Q.logText(file), st.size, APP_ID + ' ' + ((ctx.spec && ctx.spec.version) || ''));
        st.page = Math.min(st.page, st.list.length - 1);
    };
    const show = () => {
        if (!st.list || !ui.isVisible('SL_QR')) return;
        const cv = new Canvas(1600, 520), q = qr.encode(st.list[st.page], { version: Q.SIZES[st.size].version, ecl: 'L' });
        Q.drawCode(cv, q, { page: st.page + 1, pages: st.list.length, size: sizeLabel(), t });
        ui.image('SL_QR_GFX', cv);
        ui.text('SL_QR_TITLE', t('Log: code ', 'Jurnal: cod ') + (st.page + 1) + t(' of ', ' din ') + st.list.length);
        ui.enabled('SL_QR_PREV', st.page > 0);
        ui.enabled('SL_QR_NEXT', st.page < st.list.length - 1);
    };
    ui.onVisible((name, v) => {
        if (name !== 'SL_QR') return;
        if (!v) { st.list = null; return; }
        language.render('SL_QR');
        ui.text('SL_QR_SIZE', t('Size: ', 'Marime: ') + sizeLabel());
        const m = engine.meta || {}, keys = ['show', 'overspeed', 'noLimit', 'cameras', 'untagged', 'hudKeep', 'hudSize', 'clusterSize'];
        log.info('report: ' + APP_ID + ' ' + ((ctx.spec && ctx.spec.version) || '') + ', map ' + (m.data || '-') + ' (' + (m.pieces || 0) + ' pieces), ' +
            engine.fixes.count + ' corrections, ' + (engine.active ? 'on' : 'idle') + ', ' + keys.map((k) => k + '=' + s.get(k)).join(' '));
        engine.logFixes();
        st.page = 0;
        load();
        show();
    });
    ui.onClick('SL_QR_PREV', () => { if (st.list && st.page > 0) { st.page--; show(); } });
    ui.onClick('SL_QR_NEXT', () => { if (st.list && st.page < st.list.length - 1) { st.page++; show(); } });
    ui.onClick('SL_QR_SIZE', () => { st.size = Q.ORDER[(Q.ORDER.indexOf(st.size) + 1) % Q.ORDER.length]; st.page = 0; load(); show(); ui.text('SL_QR_SIZE', t('Size: ', 'Marime: ') + sizeLabel()); });
}
