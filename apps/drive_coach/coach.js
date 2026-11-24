'use strict';
/**
 * coach.js - Bewertung des Fahrstils, ohne Kit (testbar auf dem PC: node kit/tools/test_drive_coach.js).
 *
 *   const c = new Coach({ mode: 'balanced', engine: 'diesel', maxTorque: 400, ... });
 *   c.feed(data, tMs)   jedes Fahrzeugsignal (speed km/h, rpm, gLong / gLat in g, torque Nm, oil / coolant degC)
 *   c.tick(tMs)         einmal pro Sekunde (Fahrtende auch ohne neue Signale)
 *   c.view()            Live-Werte fuer die Anzeige (Wertung hoechstens 1x pro Sekunde neu gerechnet)
 *   c.on('trip'|'event'|'tip', fn)
 *
 * Leistung: die Signale kommen "bei Aenderung" und unregelmaessig (oft mehrere pro ms). Gerechnet wird
 * in festen 50-ms-Schritten (20 Hz) mit den jeweils letzten Werten - O(1) pro Schritt, keine Speicher-
 * anforderungen im Schritt (nur Ereignisse legen kleine Objekte an). Ruck (Ableitung) ist so stabil,
 * und ein Signal-Schauer kostet nichts ausser dem Merken der Werte.
 *
 * Kategorien (je 0-100): Vorausschau (Bremsen), Beschleunigen, Kurven, Ruhe (Ruck + Wasserglas),
 * Drehzahl (Lastbereich, Untertourig, Ueberdrehen), Motorschonung (kalter Motor) und Leerlauf.
 */

const STEP = 50;                     // ms pro Rechenschritt
const STEP_S = STEP / 1000;
const MAX_CATCHUP = 2000;            // laengere Luecken (Steuergeraet schlief) werden nicht nachintegriert

const MODES = {
    eco: { label: 'Eco', brake: 0.25, accel: 0.20, lat: 0.25, soft: 0.12, jerk0: 0.22, rim: 0.36,
        w: { brake: 1.3, accel: 1.3, corner: 0.8, smooth: 1.0, engine: 1.2, care: 1.0, idle: 0.8 } },
    balanced: { label: 'Ausgewogen', brake: 0.32, accel: 0.28, lat: 0.33, soft: 0.17, jerk0: 0.30, rim: 0.44,
        w: { brake: 1.2, accel: 1.0, corner: 1.0, smooth: 1.2, engine: 1.0, care: 1.0, idle: 0.6 } },
    // sportlich, aber sauber: zuegig ist erlaubt, ruppig nicht
    sport: { label: 'Sportlich', brake: 0.45, accel: 0.42, lat: 0.50, soft: 0.28, jerk0: 0.42, rim: 0.56,
        w: { brake: 1.0, accel: 0.6, corner: 1.0, smooth: 1.6, engine: 0.7, care: 1.4, idle: 0.4 } },
};
const ENGINES = {
    diesel: { bandLo: 1200, bandHi: 2600, over: 3800, lug: 1100 },
    petrol: { bandLo: 1500, bandHi: 3800, over: 5600, lug: 1300 },
};
const GLASS = { low: 1.25, mid: 1.0, high: 0.8 };

const CATS = [
    ['brake', 'Vorausschau'], ['accel', 'Beschleunigen'], ['corner', 'Kurven'], ['smooth', 'Ruhe'],
    ['engine', 'Drehzahl'], ['care', 'Motorschonung'], ['idle', 'Leerlauf'],
];
const POTENTIAL = {
    brake: 'Frueher vom Gas gehen und rollen lassen - so brauchst du die Bremse kaum.',
    accel: 'Gleichmaessiger beschleunigen: der Diesel zieht schon ab 1500 U/min kraeftig.',
    corner: 'Vor der Kurve verzoegern und mit leichtem Zug hindurch - nicht in der Kurve bremsen.',
    smooth: 'Weicher in die Pedale und ins Lenkrad: das Wasserglas soll stillstehen.',
    engine: 'Im mittleren Drehzahlbereich bleiben - weder untertourig quaelen noch hoch drehen.',
    care: 'Kalter Motor: unter der Kaltgrenze bleiben, bis das Oel warm ist.',
    idle: 'Langes Stehen im Leerlauf vermeiden - Start-Stopp arbeiten lassen.',
};
const EVENT_TEXT = {
    brake: 'Harte Bremsung', accel: 'Starkes Beschleunigen', corner: 'Schnelle Kurve', spill: 'Wasserglas verschuettet',
    lug: 'Untertourig unter Last', over: 'Hohe Drehzahl', cold: 'Kalter Motor belastet', idle: 'Langer Leerlauf',
    coast: 'Schoen gerollt', streak: 'Saubere Serie',
};
const TIPS = {
    brake: 'Frueher vom Gas - rollen lassen statt bremsen',
    accel: 'Gefuehlvoller Gas geben - der Turbo zieht auch so',
    corner: 'Vor der Kurve bremsen, durch die Kurve rollen',
    spill: 'Wasserglas verschuettet - weicher lenken und bremsen',
    lug: 'Drehzahl zu niedrig unter Last - Gang runter / mehr Schwung',
    over: 'Hohe Drehzahl - frueher hochschalten spart Sprit',
    idle: 'Lange im Leerlauf - Motor aus spart Sprit',
    coast: 'Schoen gerollt - so geht Vorausschau!',
    cooldown: 'Zuegig gefahren - Turbo vor dem Abstellen kurz nachlaufen lassen',
};
const NEGATIVE = { brake: 1, accel: 1, corner: 1, spill: 1, lug: 1, over: 1, cold: 1 };

// genau einmal, wenn ein Zaehler die Grenze ueberschreitet (vorher < Grenze <= nachher)
const crossed = (before, after, limit) => before < limit && after >= limit;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const num = (x) => typeof x === 'number' && isFinite(x);

class Coach {
    constructor(opts) {
        this.handlers = { trip: [], event: [], tip: [] };
        this.cur = { speed: 0, rpm: 0, gLong: 0, gLat: 0, torque: null, oil: null, coolant: null };
        this.clock = 0;          // Zeit des letzten Rechenschritts
        this.lastData = 0;
        this.trip = null;
        this.tip = null;
        this.events = [];        // die letzten Ereignisse (neueste zuerst), max. 6
        this.glass = { x: 0, y: 0, vx: 0, vy: 0, level: 1, spillUntil: 0 };
        this.cache = null; this.cacheAt = 0;
        this.configure(opts || {});
    }

    configure(o) {
        this.opt = Object.assign({ mode: 'balanced', engine: 'diesel', maxTorque: 400, coldOil: 70, coldRpm: 2500,
            glass: 'mid', tripEndMin: 3, tips: true }, this.opt || {}, o);
        this.M = MODES[this.opt.mode] || MODES.balanced;
        this.E = ENGINES[this.opt.engine] || ENGINES.diesel;
        this.rim = this.M.rim * (GLASS[this.opt.glass] || 1);
        this.cache = null;
    }

    on(ev, fn) { this.handlers[ev].push(fn); }
    _emit(ev, x) { const h = this.handlers[ev]; for (let i = 0; i < h.length; i++) { try { h[i](x); } catch (e) { /* Anzeige darf die Wertung nicht stoeren */ } } }

    /** Neue Signalwerte merken; gerechnet wird in festen Schritten. */
    feed(d, t) {
        const c = this.cur;
        if (num(d.speed)) c.speed = d.speed;
        if (num(d.rpm)) c.rpm = d.rpm;
        if (num(d.gLong) && Math.abs(d.gLong) < 3) c.gLong = d.gLong;
        if (num(d.gLat) && Math.abs(d.gLat) < 3) c.gLat = d.gLat;
        if (num(d.torque)) c.torque = d.torque;
        if (num(d.oil)) c.oil = d.oil;
        if (num(d.coolant)) c.coolant = d.coolant;
        this.lastData = t;
        this.advance(t);
    }

    /** Einmal pro Sekunde von aussen: haelt die Zeit am Laufen, wenn das Auto nichts Neues sendet. */
    tick(t) {
        this.advance(t);
        const tr = this.trip;
        // keine Signale mehr (Zuendung aus, App neu gestartet): Fahrt nach 90 s beenden
        if (tr && this.lastData && t - this.lastData > 90000) this.endTrip(this.lastData);
        if (this.tip && t > this.tip.until) this.tip = null;
    }

    advance(t) {
        if (!this.clock) { this.clock = t; this._prime(); return; }
        if (t - this.clock > MAX_CATCHUP) { this.clock = t - STEP; this._prime(); }
        while (this.clock + STEP <= t) { this.clock += STEP; this._step(this.clock); }
    }

    _prime() {
        const s = this.f || (this.f = {});
        s.gl = this.cur.gLong; s.gt = this.cur.gLat; s.jl = 0; s.jt = 0; s.jerk = 0;
    }

    /* ---------------- ein Rechenschritt (20 Hz) ---------------- */
    _step(t) {
        const c = this.cur, M = this.M, E = this.E, f = this.f, dt = STEP_S;
        // Glaettung 150 ms (Schlagloecher, Rauschen), danach Ruck in g/s, nochmals geglaettet
        const a = dt / (0.15 + dt);
        const gl0 = f.gl, gt0 = f.gt;
        f.gl += (c.gLong - f.gl) * a; f.gt += (c.gLat - f.gt) * a;
        const b = dt / (0.2 + dt);
        f.jl += ((f.gl - gl0) / dt - f.jl) * b; f.jt += ((f.gt - gt0) / dt - f.jt) * b;
        const jerk = Math.sqrt(f.jl * f.jl + f.jt * f.jt);
        f.jerk = jerk;
        this._glass(t, f.gt, f.gl, dt);

        const v = c.speed, moving = v > 4;
        let tr = this.trip;
        if (!tr) {
            if (!moving) return;
            tr = this.startTrip(t);
        }
        tr.dur += dt;
        tr.km += v * dt / 3600;
        if (v > tr.vmax) tr.vmax = v;
        const rpmOn = c.rpm > 400;
        const load = num(c.torque) ? c.torque / this.opt.maxTorque : null;

        if (v < 1) {
            tr.still += dt;
            if (rpmOn) {
                tr.idle += dt; tr.idleRun += dt;
                if (tr.idleRun > 60 && !tr.idleFlag) { tr.idleFlag = true; this._event(t, 'idle', Math.round(tr.idleRun)); }
            }
            // nach zuegiger Fahrt: Turbo nachlaufen lassen
            if (crossed(tr.still - dt, tr.still, 2) && tr.heat > 0.6) this._tip(t, 'cooldown', TIPS.cooldown, 'info');
            if (tr.still > this.opt.tripEndMin * 60) { this.endTrip(t - tr.still * 1000); return; }
        } else { tr.still = 0; tr.idleRun = 0; tr.idleFlag = false; }

        if (moving) {
            tr.move += dt;
            tr.jerk2 += jerk * jerk * dt;
            // "Hitze": Lastanteil der letzten ~60 s (fuer den Nachlauf-Tipp)
            const hot = (load !== null ? load > 0.65 : f.gl > M.soft) || c.rpm > E.bandHi + 600 ? 1 : 0;
            tr.heat += (hot - tr.heat) * dt / 60;

            // Beschleunigen / Kurven: Anteil oberhalb der weichen Grenze
            if (f.gl > M.soft) tr.aggr += (f.gl - M.soft) * dt;
            const lat = Math.abs(f.gt);
            if (lat > M.soft * 1.2) tr.latAggr += (lat - M.soft * 1.2) * dt;

            // Verzoegerung: rollen (sanft) oder bremsen - gewichtet mit der Geschwindigkeit (Energie)
            if (f.gl < -0.03 && v > 10) {
                if (f.gl > -0.12) tr.coastE += -f.gl * v * dt; else tr.brakeE += -f.gl * v * dt;
            }
            // Rollphase ohne Antrieb ohne Bremse: Lob nach 8 s
            const rolling = f.gl < 0.02 && f.gl > -0.12 && v > 25 && (load === null ? true : load < 0.05);
            const roll0 = tr.rollRun;
            tr.rollRun = rolling ? tr.rollRun + dt : 0;
            if (crossed(roll0, tr.rollRun, 8)) { tr.rolls++; this._event(t, 'coast', 0, true); }

            // Drehzahl: nur unter Antrieb bewerten
            const power = load !== null ? load > 0.12 : f.gl > 0.03;
            if (power && rpmOn) {
                tr.powerS += dt;
                if (c.rpm >= E.bandLo && c.rpm <= E.bandHi) tr.bandS += dt;
                const lugging = c.rpm < E.lug && (load !== null ? load > 0.45 : f.gl > 0.1) && v > 12;
                const lug0 = tr.lugRun;
                tr.lugRun = lugging ? tr.lugRun + dt : 0;
                if (lugging) tr.lugS += dt;
                if (crossed(lug0, tr.lugRun, 2)) this._event(t, 'lug', Math.round(c.rpm));
            } else tr.lugRun = 0;
            const over = c.rpm > E.over + (this.opt.mode === 'sport' ? 500 : 0);
            if (over) tr.overS += dt;
            const over0 = tr.overRun;
            tr.overRun = over ? tr.overRun + dt : 0;
            if (crossed(over0, tr.overRun, 1)) this._event(t, 'over', Math.round(c.rpm));

            // kalter Motor (Oel, sonst Kuehlwasser - 10)
            const temp = num(c.oil) ? c.oil : num(c.coolant) ? c.coolant - 10 : null;
            if (temp !== null) {
                tr.tempKnown = true;
                if (tr.coldStart === null) tr.coldStart = temp < this.opt.coldOil;
                if (temp < this.opt.coldOil) {
                    tr.coldS += dt;
                    const abuse = c.rpm > this.opt.coldRpm || (load !== null && load > 0.7);
                    if (abuse) tr.coldBad += dt;
                    const cold0 = tr.coldRun;
                    tr.coldRun = abuse ? tr.coldRun + dt : 0;
                    if (crossed(cold0, tr.coldRun, 1)) this._event(t, 'cold', Math.round(temp));
                } else tr.coldRun = 0;
            }

            // harte Manoever: Episoden mit Mindestdauer, je Episode ein Ereignis mit Spitzenwert
            this._episode(t, tr.epB, -f.gl, M.brake, 0.25, 'brake', dt);
            this._episode(t, tr.epA, f.gl, M.accel, 0.4, 'accel', dt);
            this._episode(t, tr.epC, lat, M.lat, 0.4, 'corner', dt);
            // Kurven ueberhaupt (fuer "Kurvenkuenstler"): > 0.15 g fuer 1.5 s
            const curve0 = tr.curveRun;
            tr.curveRun = lat > 0.15 ? tr.curveRun + dt : 0;
            if (crossed(curve0, tr.curveRun, 1.5)) tr.curves++;

            // saubere Serie (Fahrzeit seit dem letzten negativen Ereignis)
            tr.streak += dt;
            if (tr.streak > tr.bestStreak) tr.bestStreak = tr.streak;
            const mins = Math.floor(tr.streak / 300);
            if (mins > tr.streakMark) { tr.streakMark = mins; this._event(t, 'streak', mins * 5, true); }
        }
    }

    _episode(t, ep, v, thr, minS, type, dt) {
        if (v > thr) {
            ep.run += dt; if (v > ep.peak) ep.peak = v;
            if (!ep.fired && ep.run >= minS) { ep.fired = true; this._event(t, type, ep.peak, false, ep); }
            else if (ep.fired && ep.ev && v > ep.ev.value) ep.ev.value = Math.round(v * 100) / 100;
        } else if (v < thr * 0.8) { ep.run = 0; ep.peak = 0; ep.fired = false; ep.ev = null; }
    }

    /* Wasserglas: gedaempfter Schwinger (0.8 Hz, Daempfung 0.25) in beide Richtungen, angeregt von der Beschleunigung.
     * Gleichmaessige Verzoegerung neigt die Oberflaeche nur, ruppige Wechsel schaukeln sie ueber den Rand. */
    _glass(t, lat, lon, dt) {
        const g = this.glass, w = 5.0, z = 0.25, k = w * w, d = 2 * z * w;
        g.vx += (k * (lat - g.x) - d * g.vx) * dt; g.x += g.vx * dt;
        g.vy += (k * (lon - g.y) - d * g.vy) * dt; g.y += g.vy * dt;
        const m = Math.sqrt(g.x * g.x + g.y * g.y);
        g.mag = m;
        if (m > this.rim && t > g.spillUntil && this.cur.speed > 3) {
            g.spillUntil = t + 2500;
            g.level = Math.max(0.35, g.level - 0.08);
            if (this.trip) this._event(t, 'spill', Math.round(m * 100) / 100);
        }
    }

    _event(t, type, value, positive, ep) {
        const tr = this.trip;
        const e = { t, type, value: typeof value === 'number' ? Math.round(value * 100) / 100 : value, text: EVENT_TEXT[type], positive: !!positive };
        if (ep) ep.ev = e;
        this.events.unshift(e);
        if (this.events.length > 6) this.events.pop();
        if (tr) {
            tr.ev[type] = (tr.ev[type] || 0) + 1;
            if (type === 'brake' && value > this.M.brake * 1.4) tr.severe++;
            if (NEGATIVE[type]) { tr.streak = 0; tr.streakMark = 0; }
        }
        this.cache = null;
        this._emit('event', e);
        if (type === 'cold') this._tip(t, type, 'Motor kalt (Oel ' + Math.round(value) + ' °C) - unter ' + this.opt.coldRpm + ' U/min bleiben', 'warn');
        else if (type === 'streak') this._tip(t, type, value + ' Minuten ohne Ereignis - weiter so!', 'good');
        else if (TIPS[type]) this._tip(t, type, TIPS[type], positive ? 'good' : 'warn');
    }

    _tip(t, key, text, kind) {
        if (!this.opt.tips) return;
        // derselbe Tipp hoechstens alle 45 s, ein neuer verdraengt einen aelteren erst nach 3 s
        const last = (this.tipSeen || (this.tipSeen = {}))[key] || 0;
        if (t - last < 45000) return;
        if (this.tip && t - this.tip.t < 3000 && this.tip.kind === 'warn' && kind !== 'warn') return;
        this.tipSeen[key] = t;
        this.tip = { t, key, text, kind, until: t + 8000 };
        this._emit('tip', this.tip);
    }

    /* ---------------- Fahrten ---------------- */
    startTrip(t) {
        const ep = () => ({ run: 0, peak: 0, fired: false, ev: null });
        this.trip = { start: t, dur: 0, move: 0, km: 0, vmax: 0, still: 0, idle: 0, idleRun: 0, idleFlag: false,
            jerk2: 0, aggr: 0, latAggr: 0, coastE: 0, brakeE: 0, rollRun: 0, rolls: 0, powerS: 0, bandS: 0, lugS: 0, lugRun: 0,
            overS: 0, overRun: 0, coldS: 0, coldBad: 0, coldRun: 0, coldStart: null, tempKnown: false, heat: 0,
            epB: ep(), epA: ep(), epC: ep(), curveRun: 0, curves: 0, streak: 0, bestStreak: 0, streakMark: 0, severe: 0,
            ev: {}, mode: this.opt.mode };
        this.glass.level = 1;
        this.events.length = 0;
        this.cache = null;
        const temp = num(this.cur.oil) ? this.cur.oil : num(this.cur.coolant) ? this.cur.coolant - 10 : null;
        if (temp !== null && temp < this.opt.coldOil) this._tip(t, 'coldstart', 'Motor kalt - sanft warmfahren, max. ' + this.opt.coldRpm + ' U/min', 'info');
        return this.trip;
    }

    /** Fahrt beenden (Stillstand, keine Signale, Taste). Liefert die Zusammenfassung oder null (zu kurz). */
    endTrip(tEnd) {
        const tr = this.trip;
        if (!tr) return null;
        this.trip = null;
        this.cache = null;
        if (tr.km < 0.2 || tr.move < 60) return null;
        const s = Coach.summarize(tr, this.opt, tEnd || this.clock);
        this._emit('trip', s);
        return s;
    }

    /** Die laufende Fahrt zum Speichern (ueberlebt einen Neustart der App). */
    snapshot() { return this.trip ? JSON.parse(JSON.stringify(this.trip)) : null; }
    restore(tr) { if (tr && typeof tr.start === 'number') { this.trip = tr; this.cache = null; } }

    /** Live-Werte fuer die Anzeige; Wertungen hoechstens einmal pro Sekunde neu. */
    view(t) {
        const now = t || this.clock;
        if (!this.cache || now - this.cacheAt > 1000) {
            this.cacheAt = now;
            this.cache = this.trip ? Coach.scores(this.trip, this.opt) : null;
        }
        return { trip: this.trip, scores: this.cache, glass: this.glass, rim: this.rim, tip: this.tip, events: this.events,
            jerk: this.f ? this.f.jerk : 0, gLong: this.f ? this.f.gl : 0, gLat: this.f ? this.f.gt : 0, cur: this.cur };
    }
}

/* ---------------- Wertung (rein rechnerisch, auch fuer gespeicherte Fahrten) ---------------- */
Coach.scores = function (tr, opt) {
    const M = MODES[tr.mode] || MODES[opt.mode] || MODES.balanced;
    const ev = tr.ev, per10 = (n) => n / Math.max(tr.km, 4) * 10, perMin = (x) => x / Math.max(tr.move / 60, 3);
    const decel = tr.coastE + tr.brakeE;
    const ant = decel > 30 ? tr.coastE / decel : 0.7;
    const jerkRms = tr.move > 1 ? Math.sqrt(tr.jerk2 / tr.move) : 0;
    const cats = {
        brake: 28 + 72 * ant - 14 * per10(ev.brake || 0) - 10 * per10(tr.severe),
        accel: 100 - 11 * per10(ev.accel || 0) - 160 * perMin(tr.aggr),
        corner: 100 - 11 * per10(ev.corner || 0) - 140 * perMin(tr.latAggr),
        smooth: 100 - 140 * Math.max(0, jerkRms - M.jerk0) - 6 * per10(ev.spill || 0),
        engine: tr.powerS > 20 ? 35 + 65 * (tr.bandS / tr.powerS) - 300 * (tr.lugS / tr.powerS) - 4 * (ev.lug || 0) - 500 * (tr.overS / Math.max(tr.move, 60)) : null,
        care: tr.tempKnown && tr.coldS > 0 ? 100 - 5 * tr.coldBad : tr.tempKnown ? 100 : null,
        idle: 100 - 2.5 * Math.max(0, tr.idle / Math.max(tr.dur, 60) * 100 - 6) - 6 * (ev.idle || 0),
    };
    let sum = 0, wsum = 0;
    for (const k in cats) {
        if (cats[k] === null) continue;
        cats[k] = Math.round(clamp(cats[k], 0, 100));
        sum += cats[k] * M.w[k]; wsum += M.w[k];
    }
    const total = wsum ? Math.round(sum / wsum) : 0;
    return { total, cats, ant, jerkRms };
};

Coach.summarize = function (tr, opt, tEnd) {
    const sc = Coach.scores(tr, opt);
    let worst = null;
    for (const k in sc.cats) if (sc.cats[k] !== null && (worst === null || sc.cats[k] < sc.cats[worst])) worst = k;
    const ev = {};
    ['brake', 'accel', 'corner', 'spill', 'lug', 'over', 'cold', 'idle', 'coast'].forEach((k) => { ev[k] = tr.ev[k] || 0; });
    return {
        start: tr.start, end: tEnd, km: Math.round(tr.km * 10) / 10, min: Math.round(tr.dur / 6) / 10, move: Math.round(tr.move),
        avg: tr.move > 0 ? Math.round(tr.km / (tr.move / 3600)) : 0, vmax: Math.round(tr.vmax), score: sc.total, cats: sc.cats, worst,
        ev, ant: Math.round(sc.ant * 100), idlePct: Math.round(tr.idle / Math.max(tr.dur, 1) * 100),
        bandPct: tr.powerS > 0 ? Math.round(tr.bandS / tr.powerS * 100) : null, jerk: Math.round(sc.jerkRms * 100) / 100,
        coldStart: !!tr.coldStart, coldClean: !!tr.coldStart && tr.coldBad < 2, bestStreak: Math.round(tr.bestStreak),
        curves: tr.curves, mode: tr.mode,
    };
};

Coach.grade = function (s) {
    if (s >= 95) return 'Meisterhaft';
    if (s >= 85) return 'Sehr gut';
    if (s >= 75) return 'Gut';
    if (s >= 60) return 'Ordentlich';
    if (s >= 45) return 'Ausbaufaehig';
    return 'Unruhig';
};

Coach.MODES = MODES; Coach.ENGINES = ENGINES; Coach.CATS = CATS; Coach.POTENTIAL = POTENTIAL; Coach.EVENT_TEXT = EVENT_TEXT;
Coach.STEP = STEP;
module.exports = Coach;
