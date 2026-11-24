'use strict';
/**
 * Fahrstil-Coach - bewertet jede Fahrt live und danach, wie sanft, vorausschauend und motorschonend sie war.
 *
 *   Live     Wertung der laufenden Fahrt (Ring), Wasserglas (schwappt bei ruppigem Fahren ueber),
 *            saubere Serie, Live-Tipp, sieben Kategorien, letzte Ereignisse
 *   Fahrt    laufende oder letzte Fahrt im Detail: Kategorien, Ereignisse, Kennzahlen, groesstes Potenzial
 *   Verlauf  Wertung der letzten 30 Fahrten (mit gleitendem Schnitt), Woche gegen Vorwoche, letzte Fahrten
 *   Ziele    Level / Erfahrungspunkte und 15 Abzeichen mit Fortschritt
 *
 * Laeuft im Hintergrund (app.json "autostart"): Fahrten werden auch ohne geoeffnete App aufgezeichnet.
 * Gespeichert in data/: drive_coach_trips.json (Fahrten, nur bei Fahrtende geschrieben) und
 * drive_coach_current.json (laufende Fahrt alle 30 s, klein - uebersteht einen Neustart der App).
 *
 * Leistung: Wertung in coach.js mit 20 Hz in O(1); die Anzeige rechnet Wertungen hoechstens 1x pro Sekunde,
 * Ziele / Verlauf nur nach einer neuen Fahrt; Textumbrueche werden zwischengespeichert.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha, mix } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const Coach = require('./coach');
const Goals = require('./goals');

const W = 1600, H = 520;
const VERSION = '1.0.3';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const GOOD = '#2fd27a', WATER = '#3d9bff';
const MAX_TRIPS = 400;
const DAY = 86400000;

/* Fahrerlebnisschalter (actualValueModeDrivingExperience) -> Coach-Modus */
function driveModeOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : null;
    if (n !== null) return n >= 1 && n <= 3 || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport' : n >= 7 && n <= 9 || n === 18 ? 'eco' : n >= 4 ? 'balanced' : null;
    const w = String(raw).toUpperCase();
    return /SPORT|BOOST/.test(w) ? 'sport' : /ECO/.test(w) ? 'eco' : /COMFORT|ADAPTIV|HYBRID/.test(w) ? 'balanced' : null;
}

function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

/** Beispielfahrten fuer den Demo-Modus (immer gleich, damit Verlauf und Ziele etwas zeigen). */
function demoTrips(now) {
    const out = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 26; i >= 1; i--) {
        const km = Math.round((4 + rnd() * 38) * 10) / 10, score = Math.round(Math.min(97, 58 + (26 - i) * 1.1 + rnd() * 16));
        const start = now - i * 0.9 * DAY - rnd() * 3600000;
        out.push({ start, end: start + km * 90000, km, min: Math.round(km * 1.5), move: km * 80, avg: 40 + Math.round(rnd() * 30), vmax: 90 + Math.round(rnd() * 70),
            score, cats: { brake: score - 6, accel: score + 3, corner: score, smooth: score - 2, engine: score + 4, care: 100, idle: 92 }, worst: 'brake',
            ev: { brake: score > 85 ? 0 : 2, accel: 1, corner: score > 80 ? 0 : 1, spill: score > 88 ? 0 : 1, lug: 0, over: 0, cold: 0, idle: 0, coast: 5 },
            ant: score - 4, idlePct: 4, bandPct: 80, jerk: 0.3, coldStart: i % 3 === 0, coldClean: i % 3 === 0, bestStreak: 300 + score * 6, curves: 12, mode: 'balanced' });
    }
    return out;
}

/* ---------------- Kern: Signale, Coach, Speicher (laeuft auch ohne Bildschirm) ---------------- */
function makeCore(host) {
    const { settings, log } = host;
    const dir = host.dataDir || '.';
    const TRIPS = path.join(dir, 'drive_coach_trips.json'), CUR = path.join(dir, 'drive_coach_current.json');
    let driveMode = null, driveSeen = 0;
    const car = new Car(host, ['speed', 'rpm', 'accel', 'temps', 'torque'], {
        [FES]: { statusFESVehicleDynamicSwitchHMI: (v) => {
            const raw = v && v.actualValueModeDrivingExperience, m = driveModeOf(raw);
            if (driveSeen++ < 10) log.info('coach: Fahrmodus ' + JSON.stringify(raw) + ' -> ' + m);
            if (m && m !== driveMode) { driveMode = m; apply(); }
        } },
    });
    car.setRedline(4800);                              // Demo-Fahrt wie ein Diesel

    const modeNow = () => (settings.get('mode') === 'auto' ? driveMode || 'balanced' : settings.get('mode') || 'balanced');
    const cfg = () => ({ mode: modeNow(), engine: settings.get('engine'), maxTorque: settings.get('maxTorque'), coldOil: settings.get('coldOil'),
        coldRpm: settings.get('coldRpm'), glass: settings.get('glass'), tripEndMin: settings.get('tripEnd'), tips: settings.get('tips') !== false });
    const coach = new Coach(cfg());
    function apply() { coach.configure(cfg()); if (coach.trip) coach.trip.mode = coach.opt.mode; }
    settings.onChange((k) => { if (k !== 'theme' && k !== 'layout' && k !== 'renderer') apply(); });

    let trips = [];
    try { trips = JSON.parse(fs.readFileSync(TRIPS, 'utf8')).trips || []; } catch (e) { /* erste Fahrt */ }
    // eine Fahrt, die beim letzten Mal lief: fortsetzen (App-Neustart waehrend der Fahrt) oder abschliessen
    try {
        const cur = JSON.parse(fs.readFileSync(CUR, 'utf8'));
        if (cur && cur.trip) {
            if (Date.now() - cur.savedAt < 5 * 60000) { coach.restore(cur.trip); log.info('coach: laufende Fahrt fortgesetzt'); }
            else if (cur.trip.km >= 0.2 && cur.trip.move >= 60) { trips.push(Coach.summarize(cur.trip, coach.opt, cur.savedAt)); saveTrips(); log.info('coach: unterbrochene Fahrt gespeichert'); }
        }
        fs.unlinkSync(CUR);
    } catch (e) { /* keine */ }

    const core = { car, coach, version: VERSION, notice: null, last: trips[trips.length - 1] || null, rev: 0 };
    let demoList = null, goalsCache = null, goalsKey = '';
    core.demo = () => !!car.data().demo;
    core.trips = () => (core.demo() ? demoList || (demoList = demoTrips(Date.now())) : trips);
    core.mode = () => coach.opt.mode;
    core.autoMode = () => settings.get('mode') === 'auto';
    core.goals = () => {
        const key = (core.demo() ? 'd' : 'l') + core.trips().length + '|' + core.rev;
        if (key !== goalsKey) { goalsKey = key; goalsCache = Goals.evaluate(core.trips(), Date.now()); }
        return goalsCache;
    };
    core.say = (text, kind) => { core.notice = { text, kind: kind || 'info', until: Date.now() + 9000 }; };

    function saveTrips() { try { writeWhole(TRIPS, JSON.stringify({ v: 1, trips })); } catch (e) { log.warn('coach: speichern ' + e); } }

    coach.on('trip', (s) => {
        const list = core.trips(), before = core.goals();
        list.push(s);
        if (list.length > MAX_TRIPS) list.splice(0, list.length - MAX_TRIPS);
        core.last = s; core.rev++;
        if (!core.demo()) { saveTrips(); try { fs.unlinkSync(CUR); } catch (e) { /* schon weg */ } }
        const fresh = Goals.newlyDone(before, core.goals());
        log.info('coach: Fahrt ' + s.km + ' km, Wertung ' + s.score + (fresh.length ? ', neu: ' + fresh.map((b) => b.title).join(', ') : ''));
        core.say(fresh.length ? 'Neues Abzeichen: ' + fresh.map((b) => b.title).join(', ') + '!' : 'Fahrt gespeichert: ' + s.km.toFixed(1) + ' km, Wertung ' + s.score, fresh.length ? 'good' : 'info');
    });
    core.endTrip = () => {
        const s = coach.endTrip(Date.now());
        if (!s) core.say('Fahrt zu kurz - nicht gespeichert');
        return s;
    };
    core.clear = () => {
        const list = core.trips();
        list.length = 0; core.last = null; core.rev++;
        if (!core.demo()) saveTrips();
        core.say('Verlauf geloescht');
    };

    car.onSample((d, t) => coach.feed(d, t), () => { coach.trip = null; coach.events.length = 0; coach.clock = 0; });
    let n = 0;
    setInterval(() => {
        const now = Date.now();
        coach.tick(now);
        if (core.notice && now > core.notice.until) core.notice = null;
        if (++n % 30 === 0 && coach.trip && !core.demo()) {
            try { writeWhole(CUR, JSON.stringify({ savedAt: now, trip: coach.snapshot() })); } catch (e) { log.warn('coach: Zwischenstand ' + e); }
        }
    }, 1000);
    log.info('coach ' + VERSION + ': ' + trips.length + ' Fahrten geladen');
    return core;
}

/* ---------------- Zeichnen ---------------- */
const wrapCache = new Map();
function wrap(cv, text, size, width, font) {
    const key = text + '|' + size + '|' + width + '|' + font;
    let lines = wrapCache.get(key);
    if (lines) return lines;
    lines = [];
    let line = '';
    for (const w of String(text).split(' ')) {
        const tryLine = line ? line + ' ' + w : w;
        if (line && cv.textWidth(tryLine, size, { font }) > width) { lines.push(line); line = w; } else line = tryLine;
    }
    if (line) lines.push(line);
    if (wrapCache.size > 200) wrapCache.clear();
    wrapCache.set(key, lines);
    return lines;
}
const scoreColor = (t, s) => (!G.isNum(s) ? t.dim : s >= 85 ? GOOD : s >= 70 ? t.accent2 : s >= 50 ? t.warn : t.crit);
const tipColor = (t, kind) => (kind === 'good' ? GOOD : kind === 'warn' ? t.warn : t.accent2);
const p2 = (n) => (n < 10 ? '0' : '') + n;
const clock = (s) => Math.floor(s / 60) + ':' + p2(Math.floor(s % 60));
const dateOf = (ms) => { const d = new Date(ms); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.'; };
const timeOf = (ms) => { const d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const MODE_LABEL = { eco: 'Eco', balanced: 'Ausgewogen', sport: 'Sportlich' };

mgu.run({
    background(bg) { return makeCore(bg); },

    async start(ctx) {
        const { ui, log } = ctx;
        const core = ctx.background || makeCore(ctx);
        const coach = core.coach;
        let page = 0;

        /* ---------- Bausteine ---------- */
        function ring(cv, t, cx, cy, r, th, v, color) {
            cv.arc(cx, cy, r - th / 2, r + th / 2, 0, 360, t.track);
            if (G.isNum(v) && v > 0) cv.arc(cx, cy, r - th / 2, r + th / 2, 0, Math.min(359.9, v * 3.6), color, { round: true });
        }
        function miniBar(cv, t, x, y, w, label, v, lsize) {
            const ls = lsize || 20;
            cv.text(label.toUpperCase(), x, y + ls, ls, t.dim, { font: 'bold', spacing: 1 });
            cv.text(G.isNum(v) ? String(v) : '--', x + w, y + ls + 2, ls + 6, scoreColor(t, v), { align: 'right', font: 'num' });
            const by = y + ls + 9, bw = w;
            cv.roundRect(x, by, bw, 8, 4, t.track);
            if (G.isNum(v) && v > 0) cv.roundRect(x, by, Math.max(8, bw * v / 100), 8, 4, scoreColor(t, v));
        }
        function tipBox(cv, t, x, y, w, h, tip) {
            const c = tipColor(t, tip.kind);
            cv.roundRect(x, y, w, h, 10, withAlpha(c, 0.12));
            cv.fillRect(x, y + 8, 5, h - 16, c);
            const lines = wrap(cv, tip.text, 26, w - 44, 'label');
            const y0 = y + h / 2 - (Math.min(lines.length, 3) - 1) * 16 + 9;
            lines.slice(0, 3).forEach((l, i) => cv.text(l, x + 24, y0 + i * 32, 26, i === 0 ? t.text : mix(t.text, t.dim, 0.3)));
        }

        /* ---------- Seite 1: Live ---------- */
        function drawLive(cv, t) {
            const v = coach.view(Date.now()), tr = v.trip, sc = v.scores;
            // Wertung
            G.panel(cv, t, 24, 44, 420, 468, tr ? 'Diese Fahrt' : 'Bereit');
            const cx = 234, cy = 262, total = sc ? sc.total : core.last && !tr ? core.last.score : null;
            ring(cv, t, cx, cy, 138, 22, total, scoreColor(t, total));
            cv.text(G.isNum(total) ? String(total) : '--', cx, cy + 34, 104, G.isNum(total) ? t.text : t.dim, { align: 'center', font: 'num' });
            cv.text(tr ? Coach.grade(total).toUpperCase() : core.last ? 'LETZTE FAHRT' : 'FAEHRT GLEICH LOS', cx, cy + 74, 20, scoreColor(t, tr ? total : null), { align: 'center', font: 'bold', spacing: 2 });
            const info = tr ? tr.km.toFixed(1) + ' km  ·  ' + clock(tr.dur) + ' min  ·  Schnitt ' + (tr.move > 0 ? Math.round(tr.km / (tr.move / 3600)) : 0) + ' km/h'
                : 'Startet automatisch beim Losfahren';
            cv.text(info, cx, 488, 22, t.dim, { align: 'center' });
            G.pill(cv, t, 444 - 24 - 196, 60, 196, 30, (core.autoMode() ? 'AUTO · ' : '') + MODE_LABEL[core.mode()].toUpperCase(), { color: core.mode() === 'sport' ? t.crit : core.mode() === 'eco' ? GOOD : t.accent2, size: 16, spacing: 1 });

            // Wasserglas (von oben): der Wasserberg wandert dorthin, wohin das Wasser schwappt
            G.panel(cv, t, 468, 44, 440, 468, 'Wasserglas');
            const gx = 688, gy = 248, R = 118, gl = v.glass, rim = v.rim;
            const k = Math.min(1.15, gl.mag / rim), danger = k > 0.8, spilling = Date.now() < gl.spillUntil - 1200;
            cv.circle(gx, gy, R + 10, spilling ? withAlpha(t.crit, 0.55) : withAlpha(t.tick, 0.45));
            cv.circle(gx, gy, R, t.bg);
            cv.circle(gx, gy, R * Math.sqrt(gl.level), withAlpha(WATER, 0.22 + 0.1 * gl.level));
            // der Wasserberg (Radius 0.42 R) beruehrt den Rand genau an der Verschuett-Grenze
            const kk = Math.min(1, k), mm = gl.mag > 1e-6 ? gl.mag : 1;
            const ox = gl.x / mm * kk * R * 0.58, oy = gl.y / mm * kk * R * 0.58;
            cv.arc(gx, gy, R - 3, R, 0, 360, withAlpha(danger ? t.warn : t.tick, danger ? 0.9 : 0.5));
            cv.circle(gx + ox, gy + oy, R * 0.42, withAlpha(danger ? t.warn : WATER, 0.45));
            cv.circle(gx + ox, gy + oy, R * 0.2, withAlpha('#ffffff', danger ? 0.5 : 0.3));
            cv.circle(gx, gy, 4, t.dim);
            cv.text('VORNE', gx, gy - R - 20, 16, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            const spills = tr ? tr.ev.spill || 0 : 0;
            cv.text('VERSCHUETTET', 492, 432, 18, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(String(spills), 492, 484, 48, spills ? t.warn : GOOD, { font: 'num' });
            cv.text('SAUBERE SERIE', 884, 432, 18, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
            cv.text(tr ? clock(tr.streak) : '-:--', 884, 484, 48, tr && tr.streak > 300 ? GOOD : t.text, { align: 'right', font: 'num' });
            if (tr && tr.bestStreak > 60) cv.text('BESTE ' + clock(tr.bestStreak), 688, 484, 18, t.dim, { align: 'center', font: 'bold', spacing: 1 });

            // Coach: Tipp, Kategorien, Ereignisse
            G.panel(cv, t, 932, 44, 644, 468, 'Coach');
            const tip = core.notice || v.tip || {
                text: !tr ? 'Gute Fahrt! Ich bewerte, wie sanft, vorausschauend und motorschonend du faehrst.'
                    : sc && sc.cats ? (() => { const w = worstOf(sc.cats); return w && sc.cats[w] < 85 ? Coach.POTENTIAL[w] : 'Sauber unterwegs - weiter so!'; })() : 'Faehrt sich gut an.',
                kind: 'info' };
            tipBox(cv, t, 956, 92, 596, 112, tip);
            const cats = Coach.CATS;
            cats.forEach(([key, label], i) => {
                const col = i % 2, row = Math.floor(i / 2);
                miniBar(cv, t, 956 + col * 310, 222 + row * 56, 286, label, sc ? sc.cats[key] : null, 18);
            });
            // letzte Ereignisse (rechts unten, neben "Leerlauf")
            const ev = v.events.slice(0, 2);
            ev.forEach((e, i) => {
                const ago = Math.max(0, Math.round((coach.clock - e.t) / 1000));
                cv.text((e.positive ? '+ ' : '! ') + e.text + (G.isNum(e.value) && e.value && e.type !== 'streak' && e.type !== 'idle' ? ' ' + e.value + (e.value < 3 ? ' g' : '') : ''),
                    1266, 404 + i * 30, 18, e.positive ? GOOD : t.warn, { font: 'bold' });
                cv.text(ago < 60 ? ago + ' s' : Math.round(ago / 60) + ' min', 1552, 404 + i * 30, 18, t.dim, { align: 'right' });
            });
            if (!ev.length) cv.text(tr ? 'Noch keine Ereignisse' : '', 1266, 404, 18, t.dim);
            G.button(cv, t, 1552 - 220, 456, 220, 40, 'Fahrt beenden', tr ? () => act(true) : null, { key: 'end', busy: !tr });
        }
        function worstOf(cats) {
            let w = null;
            for (const k in cats) if (cats[k] !== null && (w === null || cats[k] < cats[w])) w = k;
            return w;
        }

        /* ---------- Seite 2: Fahrt ---------- */
        let tripCache = { of: null, s: null };
        function drawTrip(cv, t) {
            const v = coach.view(Date.now());
            let s = null, live = false;
            if (v.trip && v.scores) {
                // Zusammenfassung nur neu, wenn die Wertung neu ist (1x pro Sekunde)
                if (tripCache.of !== v.scores) tripCache = { of: v.scores, s: Object.assign(Coach.summarize(v.trip, coach.opt, coach.clock), { score: v.scores.total, cats: v.scores.cats }) };
                s = tripCache.s; live = true;
            } else s = core.last;
            G.panel(cv, t, 24, 44, 560, 468, live ? 'Kategorien (laufend)' : 'Kategorien');
            if (!s) { cv.text('Noch keine Fahrt aufgezeichnet.', 48, 140, 24, t.dim); }
            Coach.CATS.forEach(([key, label], i) => miniBar(cv, t, 48, 100 + i * 56, 512, label, s ? s.cats[key] : null, 20));

            G.panel(cv, t, 608, 44, 460, 468, 'Ereignisse');
            const rows = [['Harte Bremsungen', 'brake'], ['Starkes Beschleunigen', 'accel'], ['Schnelle Kurven', 'corner'], ['Wasserglas verschuettet', 'spill'],
                ['Untertourig unter Last', 'lug'], ['Hohe Drehzahl', 'over'], ['Kalter Motor belastet', 'cold'], ['Langer Leerlauf', 'idle'], ['Rollphasen (gut)', 'coast']];
            rows.forEach(([label, k], i) => {
                const n = s ? s.ev[k] || 0 : null, y = 126 + i * 42, good = k === 'coast';
                if (i % 2) cv.fillRect(620, y - 29, 436, 42, withAlpha('#ffffff', 0.03));
                cv.text(label, 632, y, 22, good ? GOOD : t.text);
                cv.text(n === null ? '--' : String(n), 1044, y + 2, 30, n === null ? t.dim : good ? (n ? GOOD : t.dim) : n ? t.warn : GOOD, { align: 'right', font: 'num' });
            });

            G.panel(cv, t, 1092, 44, 484, 468, live ? 'Laufende Fahrt' : s ? 'Letzte Fahrt  ' + dateOf(s.start) + ' ' + timeOf(s.start) : 'Fahrt');
            if (!s) return;
            cv.text(String(s.score), 1116, 168, 88, scoreColor(t, s.score), { font: 'num' });
            cv.text(Coach.grade(s.score).toUpperCase(), 1270, 124, 22, scoreColor(t, s.score), { font: 'bold', spacing: 2 });
            cv.text(MODE_LABEL[s.mode] || '', 1270, 158, 20, t.dim);
            const kv = [['Strecke', s.km.toFixed(1) + ' km'], ['Dauer', (s.min < 10 ? s.min.toFixed(1) : s.min.toFixed(0)) + ' min'], ['Schnitt / Spitze', s.avg + ' / ' + s.vmax + ' km/h'],
                ['Vorausschau', s.ant + ' %'], ['Im Lastbereich', s.bandPct === null ? '--' : s.bandPct + ' %'], ['Leerlauf', s.idlePct + ' %'], ['Beste Serie', clock(s.bestStreak) + ' min']];
            kv.forEach(([k, val], i) => {
                const y = 214 + i * 30;
                cv.text(k, 1116, y, 20, t.dim);
                cv.text(val, 1552, y, 20, t.text, { align: 'right', font: 'bold' });
            });
            const w = s.worst || worstOf(s.cats);
            if (w && s.cats[w] < 90) {
                cv.text('POTENZIAL: ' + (Coach.CATS.find((c) => c[0] === w) || [0, ''])[1].toUpperCase(), 1116, 444, 18, t.warn, { font: 'bold', spacing: 1.5 });
                wrap(cv, Coach.POTENTIAL[w], 19, 436, 'label').slice(0, 2).forEach((l, i) => cv.text(l, 1116, 470 + i * 24, 19, t.text));
            } else cv.text('Kaum Luft nach oben - stark gefahren!', 1116, 460, 20, GOOD, { font: 'bold' });
        }

        /* ---------- Seite 3: Verlauf ---------- */
        let chartKey = '', chartData = null;
        function drawHistory(cv, t) {
            const list = core.trips(), gl = core.goals();
            const key = list.length + '|' + core.rev + '|' + core.demo();
            if (key !== chartKey) {
                chartKey = key;
                const last = list.slice(-30), pts = last.map((s, i) => [i + 1, s.score]), avg = [];
                let acc = 0;
                last.forEach((s, i) => { acc += s.score; if (i >= 5) acc -= last[i - 5].score; if (i >= 4) avg.push([i + 1, acc / 5]); });
                chartData = { pts, avg, n: last.length, best: list.reduce((m, s) => Math.max(m, s.score), 0) };
            }
            G.panel(cv, t, 24, 44, 1000, 468, 'Wertung der letzten ' + Math.max(chartData.n, 1) + ' Fahrten');
            G.chart(cv, t, 48, 96, 952, 392, { xMin: 1, xMax: Math.max(5, chartData.n), yMin: 0, yMax: 100, yStep: 20, xStep: Math.max(1, Math.ceil(chartData.n / 10)),
                series: [{ pts: chartData.pts, color: t.accent2, width: 3, fill: 0.12 }, { pts: chartData.avg, color: GOOD, width: 2, dash: true }],
                marks: [{ y: 80, color: GOOD, label: 'Ziel 80' }], empty: 'Noch keine Fahrten - der Verlauf fuellt sich nach der ersten Fahrt' });
            if (chartData.pts.length) cv.text('— Wertung   - - Schnitt aus 5', 996, 84, 16, t.dim, { align: 'right' });

            G.panel(cv, t, 1048, 44, 528, 468, 'Statistik');
            const wk = gl.week, pw = gl.prevWeek;
            cv.text('LETZTE 7 TAGE', 1072, 110, 18, t.dim, { font: 'bold', spacing: 2 });
            cv.text(wk.score === null ? '--' : String(wk.score), 1072, 176, 64, scoreColor(t, wk.score), { font: 'num' });
            if (wk.score !== null && pw.score !== null) {
                const d = wk.score - pw.score;
                cv.text((d > 0 ? '+' : '') + d + ' zur Vorwoche', 1184, 150, 20, d > 0 ? GOOD : d < 0 ? t.warn : t.dim, { font: 'bold' });
            }
            cv.text(wk.trips + ' Fahrten  ·  ' + wk.km + ' km', 1184, 176, 20, t.text);
            const T = gl.totals;
            cv.text('GESAMT', 1072, 224, 18, t.dim, { font: 'bold', spacing: 2 });
            cv.text(T.trips + ' Fahrten  ·  ' + Math.round(T.km) + ' km  ·  ' + Math.round(T.min / 60) + ' h  ·  Bestwert ' + (chartData.best || '--'), 1072, 254, 20, t.text);
            cv.fillRect(1072, 274, 480, 1, withAlpha(t.tick, 0.4));
            const recent = list.slice(-5).reverse();
            G.table(cv, t, 1072, 288, 480, [{ label: 'Datum', w: 150 }, { label: 'km', w: 90, align: 'right' }, { label: 'min', w: 80, align: 'right' }, { label: 'Wertung', w: 160, align: 'right' }],
                recent.map((s) => [dateOf(s.start) + ' ' + timeOf(s.start), s.km.toFixed(1), String(Math.round(s.min)), { text: String(s.score), color: scoreColor(t, s.score) }]),
                { rowH: 38, size: 20, empty: 'Noch leer' });
            G.button(cv, t, 1552 - 220, 56, 220, 36, 'Verlauf loeschen', () => act(true), { key: 'clear', confirm: true, color: t.crit });
        }

        /* ---------- Seite 4: Ziele ---------- */
        function drawGoals(cv, t) {
            const gl = core.goals(), L = gl.level;
            G.panel(cv, t, 24, 44, 1552, 100, null);
            cv.text('LEVEL ' + L.n, 48, 84, 20, t.dim, { font: 'bold', spacing: 2 });
            cv.text(L.name, 48, 124, 36, t.text, { font: 'bold' });
            const bx = 420, bw = 860;
            cv.roundRect(bx, 92, bw, 14, 7, t.track);
            cv.roundRect(bx, 92, Math.max(14, bw * L.progress), 14, 7, GOOD);
            cv.text(L.xp + ' XP', bx, 132, 18, t.text, { font: 'bold' });
            cv.text(L.to ? 'noch ' + Math.round(L.to - L.xp) + ' XP bis ' + L.nextName : 'Hoechstes Level erreicht', bx + bw, 132, 18, t.dim, { align: 'right' });
            const done = gl.badges.filter((b) => b.done).length;
            cv.text(done + ' / ' + gl.badges.length, 1552, 106, 40, done ? GOOD : t.dim, { align: 'right', font: 'num' });
            cv.text('ABZEICHEN', 1552, 130, 16, t.dim, { align: 'right', font: 'bold', spacing: 2 });

            G.panel(cv, t, 24, 160, 1552, 352, null);
            gl.badges.forEach((b, i) => {
                const col = i % 5, row = Math.floor(i / 5), x = 40 + col * 306, y = 176 + row * 108;
                const cx = x + 34, cy = y + 40;
                if (b.done) {
                    cv.circle(cx, cy, 28, withAlpha(GOOD, 0.85));
                    cv.line(cx - 12, cy + 1, cx - 3, cy + 10, 5, '#ffffff'); cv.line(cx - 3, cy + 10, cx + 13, cy - 9, 5, '#ffffff');
                } else {
                    cv.arc(cx, cy, 24, 30, 0, 360, t.track);
                    if (b.progress > 0.01) cv.arc(cx, cy, 24, 30, 0, Math.min(359.9, b.progress * 360), t.accent2, { round: true });
                    cv.text(Math.round(b.progress * 100) + '', cx, cy + 7, 18, t.dim, { align: 'center', font: 'bold' });
                }
                cv.text(b.title, x + 76, y + 30, 21, b.done ? t.text : mix(t.text, t.dim, 0.4), { font: 'bold' });
                wrap(cv, b.desc, 16, 214, 'label').slice(0, 2).forEach((l, j) => cv.text(l, x + 76, y + 54 + j * 20, 16, t.dim));
                cv.text(b.done && b.at ? 'seit ' + dateOf(b.at) : b.detail, x + 76, y + 98, 15, b.done ? GOOD : t.dim, { font: 'bold' });
            });
        }

        /* ---------- Rahmen, Seiten, Tasten ---------- */
        const PAGES = ['Live', 'Fahrt', 'Verlauf', 'Ziele'];
        const DRAW = [drawLive, drawTrip, drawHistory, drawGoals];
        // Mit dem GPU-Renderer ruft das Kit render() bis zu 60x pro Sekunde auf. Live braucht hoechstens 30 Bilder/s
        // (Wasserglas), Fahrt aendert sich 1x pro Sekunde, Verlauf / Ziele nur nach einer Fahrt: sonst nichts tun
        // (ein ausgelassenes Bild kostet nichts, das Kit schaut nach 16 ms wieder).
        const GAP = [33, 1000, 250, 1000];
        let lastDraw = 0, lastKey = '', settingsRev = 0;
        ctx.settings.onChange(() => { settingsRev++; });
        ctx.onLayout(() => { lastKey = ''; });
        async function render(force) {
            const now = Date.now();
            const key = page + '|' + core.rev + '|' + core.demo() + '|' + (core.notice ? core.notice.until : 0) + '|' + settingsRev + '|' + !!coach.trip;
            if (force !== true && key === lastKey && now - lastDraw < GAP[page]) return;
            lastKey = key; lastDraw = now;
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            DRAW[page](cv, t);
            G.frame(cv, t, PAGES, page, [core.demo() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }
        const ACTION = ['Fahrt beenden', null, 'Verlauf loeschen', null];
        let clearArmed = null;
        const actionLabel = () => {
            const a = ACTION[page];
            ui.visible('BTN_ACTION', !!a);
            if (a) ui.text('BTN_ACTION', page === 2 && clearArmed ? 'Ja, loeschen' : a);
        };
        const go = (p) => { page = (p + PAGES.length) % PAGES.length; actionLabel(); return render(true); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_PREV', () => go(page - 1));
        ctx.onTab((i) => i !== page && go(i));
        // Fahrt beenden (Live) / Verlauf loeschen (Verlauf, zweimal druecken): auf der Seite oder in der Leiste
        function act(fromPage) {
            if (page === 0) { core.endTrip(); return render(true); }
            if (page === 2) {
                if (fromPage === true) { core.clear(); return render(true); }     // der Knopf auf der Seite hat schon nachgefragt
                if (!clearArmed) { clearArmed = setTimeout(() => { clearArmed = null; actionLabel(); }, 5000); return actionLabel(); }
                clearTimeout(clearArmed); clearArmed = null; core.clear(); actionLabel(); return render(true);
            }
            return null;
        }
        ui.onClick('BTN_ACTION', () => act(false));
        ctx.hideButton('BTN_ACTION');
        actionLabel();
        // ohne GPU-Renderer (Software, PNG-Bilder) 15 Bilder/s
        ctx.loop('MAIN', 15, render);
        render(true).then(() => log.info('Fahrstil-Coach ' + VERSION + ': erstes Bild')).catch((e) => log.warn('erstes Bild: ' + e));
    },
});

module.exports = { driveModeOf, demoTrips };
