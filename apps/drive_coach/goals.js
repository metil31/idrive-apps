'use strict';
/**
 * goals.js - Ziele (Abzeichen), Level und Wochenstatistik aus der Fahrtenliste. Reine Rechnung, kein Kit.
 *
 *   Goals.evaluate(trips, now) -> { level, badges: [{ id, title, desc, done, at, progress (0..1), detail }], week, prevWeek, totals }
 *
 * trips: Zusammenfassungen aus coach.js (aelteste zuerst). Die Auswertung laeuft nur nach einer neuen Fahrt
 * oder beim Start (nicht pro Bild); bei 300 Fahrten ein paar tausend Rechenschritte.
 */

const DAY = 86400000;
const LEVELS = [
    [0, 'Fahrschueler'], [150, 'Einsteiger'], [500, 'Fortgeschritten'], [1200, 'Routinier'], [2500, 'Profi'],
    [4500, 'Experte'], [8000, 'Meister'], [14000, 'Grossmeister'], [24000, 'Legende'],
];
const counted = (s) => s.km >= 5;

// [id, Titel, Beschreibung, Ziel, Fortschritt(trips, totals) -> Zahl]
const BADGES = [
    ['first', 'Erste Fahrt', 'Eine Fahrt aufgezeichnet', 1, (t) => t.length],
    ['gentle', 'Sanfter Fuss', 'Fahrt ab 5 km ohne harte Bremsung', 1, (t) => t.filter((s) => counted(s) && !s.ev.brake).length],
    ['glass', 'Wasserglas-Meister', 'Fahrt ab 15 min ohne Verschuetten', 1, (t) => t.filter((s) => s.min >= 15 && !s.ev.spill).length],
    ['ninety', '90er Club', 'Wertung 90+ auf einer Fahrt ab 5 km', 1, (t) => t.filter((s) => counted(s) && s.score >= 90).length],
    ['row5', 'Fuenfer-Serie', '5 Fahrten in Folge mit 80+', 5, (t) => bestRun(t, (s) => s.score >= 80)],
    ['cold', 'Kaltstart-Profi', '10 Kaltstarts, Motor geschont', 10, (t) => t.filter((s) => s.coldClean).length],
    ['seer', 'Hellseher', 'Vorausschau 85 %+ auf 10 km+', 1, (t) => t.filter((s) => s.km >= 10 && s.ant >= 85).length],
    ['clean100', '100 saubere km', 'km auf Fahrten mit 85+', 100, (t) => sum(t.filter((s) => s.score >= 85), 'km')],
    ['km1000', 'Vielfahrer', '1000 km mit dem Coach', 1000, (t, T) => T.km],
    ['zen', 'Zen-Modus', '20 min ohne ein Ereignis', 1200, (t) => max(t, 'bestStreak')],
    ['curves', 'Kurvenkuenstler', '30 Kurven, keine zu schnell', 1, (t) => t.filter((s) => s.curves >= 30 && !s.ev.corner).length],
    ['idle', 'Leerlauf-Sparer', '10 Fahrten mit < 3 % Leerlauf', 10, (t) => t.filter((s) => counted(s) && s.idlePct < 3).length],
    ['week', 'Gruene Woche', '7 Tage: 3+ Fahrten, Schnitt 80+', 1, (t) => (weekWindows(t) ? 1 : 0)],
    ['long', 'Langstrecke', 'Eine Fahrt ab 200 km mit 80+', 1, (t) => t.filter((s) => s.km >= 200 && s.score >= 80).length],
    ['perfect', 'Perfektionist', 'Wertung 97+ auf 10 km+', 1, (t) => t.filter((s) => s.km >= 10 && s.score >= 97).length],
];

function sum(a, k) { let x = 0; for (let i = 0; i < a.length; i++) x += a[i][k] || 0; return x; }
function max(a, k) { let x = 0; for (let i = 0; i < a.length; i++) if ((a[i][k] || 0) > x) x = a[i][k]; return x; }
function bestRun(a, ok) { let best = 0, run = 0; for (let i = 0; i < a.length; i++) { if (!counted(a[i])) continue; run = ok(a[i]) ? run + 1 : 0; if (run > best) best = run; } return best; }
/** Gab es irgendein 7-Tage-Fenster mit 3+ Fahrten und Schnitt 80+? (zwei Zeiger, O(n)) */
function weekWindows(a) {
    let j = 0, n = 0, s = 0;
    for (let i = 0; i < a.length; i++) {
        n++; s += a[i].score;
        while (a[i].start - a[j].start > 7 * DAY) { n--; s -= a[j].score; j++; }
        if (n >= 3 && s / n >= 80) return true;
    }
    return false;
}
/** Zeitpunkt, zu dem ein Abzeichen erreicht wurde (erste Fahrt, nach der der Fortschritt das Ziel erreicht). */
function reachedAt(trips, goal, fn) {
    // binaere Suche ueber Praefixe (Fortschritt waechst monoton mit mehr Fahrten)
    let lo = 0, hi = trips.length - 1, at = null;
    const T = (k) => totals(trips.slice(0, k + 1));
    while (lo <= hi) {
        const mid = (lo + hi) >> 1, p = trips.slice(0, mid + 1);
        if (fn(p, T(mid)) >= goal) { at = trips[mid].end || trips[mid].start; hi = mid - 1; } else lo = mid + 1;
    }
    return at;
}

function xpOf(s) { return Math.max(0, s.km) * Math.max(0, s.score - 40) / 10; }
function totals(t) {
    const T = { trips: t.length, km: 0, min: 0, xp: 0, events: 0 };
    for (let i = 0; i < t.length; i++) {
        const s = t[i];
        T.km += s.km; T.min += s.min; T.xp += xpOf(s);
        T.events += (s.ev.brake || 0) + (s.ev.accel || 0) + (s.ev.corner || 0);
    }
    T.km = Math.round(T.km * 10) / 10;
    return T;
}
function level(xp) {
    let i = 0;
    while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++;
    const next = LEVELS[i + 1];
    return { n: i + 1, name: LEVELS[i][1], xp: Math.round(xp), from: LEVELS[i][0], to: next ? next[0] : null,
        progress: next ? (xp - LEVELS[i][0]) / (next[0] - LEVELS[i][0]) : 1, nextName: next ? next[1] : null };
}
/** km-gewichteter Schnitt, Fahrten und km im Zeitraum [from, to). */
function period(t, from, to) {
    let n = 0, km = 0, w = 0;
    for (let i = 0; i < t.length; i++) {
        const s = t[i];
        if (s.start < from || s.start >= to) continue;
        n++; km += s.km; w += s.score * Math.max(s.km, 1);
    }
    let wk = 0;
    for (let i = 0; i < t.length; i++) if (t[i].start >= from && t[i].start < to) wk += Math.max(t[i].km, 1);
    return { trips: n, km: Math.round(km), score: n ? Math.round(w / wk) : null };
}

function evaluate(trips, now) {
    trips = trips || [];
    now = now || Date.now();
    const T = totals(trips);
    const badges = BADGES.map(([id, title, desc, goal, fn]) => {
        const v = fn(trips, T), done = v >= goal;
        return { id, title, desc, goal, value: v, done, progress: Math.min(1, v / goal),
            at: done ? reachedAt(trips, goal, fn) : null,
            detail: goal > 1 ? Math.min(Math.round(id === 'zen' ? v / 60 : v), id === 'zen' ? 20 : goal) + ' / ' + (id === 'zen' ? '20 min' : goal) : done ? 'geschafft' : 'offen' };
    });
    return { level: level(T.xp), badges, totals: T, week: period(trips, now - 7 * DAY, now + 1), prevWeek: period(trips, now - 14 * DAY, now - 7 * DAY) };
}

/** Abzeichen, die durch die letzte Fahrt neu dazugekommen sind. */
function newlyDone(before, after) {
    const had = {};
    before.badges.forEach((b) => { if (b.done) had[b.id] = true; });
    return after.badges.filter((b) => b.done && !had[b.id]);
}

module.exports = { evaluate, newlyDone, level, totals, xpOf, BADGES, LEVELS };
