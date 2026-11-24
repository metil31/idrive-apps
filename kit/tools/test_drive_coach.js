'use strict';
// Fahrstil-Coach: Wertung, Ereignisse, Fahrten, Wasserglas, Ziele und Rechenzeit auf kuenstlichen Fahrten.
//   node kit/tools/test_drive_coach.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'drive_coach');
const Coach = require(path.join(APP, 'coach'));
const Goals = require(path.join(APP, 'goals'));

let failed = 0;
const check = (name, fn) => {
    try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
};

/**
 * Fahrt aus Abschnitten: [{ s: Dauer, v0, v1 (km/h), lat (g), rpm, torque, oil, glatt }]. Laengsbeschleunigung
 * aus der Tempoaenderung; Signale alle 20 ms (50 Hz) wie ein Schauer "bei Aenderung".
 */
function drive(coach, parts, t0) {
    let t = t0 || 1e12;
    for (const p of parts) {
        const n = Math.round(p.s * 50), a = (p.v1 - p.v0) / 3.6 / p.s / 9.80665;
        for (let i = 0; i < n; i++) {
            const v = p.v0 + (p.v1 - p.v0) * i / n;
            const lat = typeof p.lat === 'function' ? p.lat(i / 50) : p.lat || 0;
            coach.feed({ speed: v, rpm: p.rpm || 1800, gLong: p.gLong !== undefined ? p.gLong : a, gLat: lat, torque: p.torque, oil: p.oil === undefined ? 90 : p.oil }, t);
            t += 20;
        }
    }
    return t;
}
const calm = (km) => {
    const parts = [{ s: 25, v0: 0, v1: 50, torque: 150 }];
    for (let i = 0; i < km / 2; i++) {
        parts.push({ s: 60, v0: 50, v1: 80, torque: 140 }, { s: 30, v0: 80, v1: 80, torque: 90, lat: (x) => 0.12 * Math.sin(x / 6) });
        parts.push({ s: 25, v0: 80, v1: 50, torque: 0, rpm: 1300 });     // rollen lassen: -0.034 g
    }
    parts.push({ s: 18, v0: 50, v1: 0, torque: 0, rpm: 1000 });            // sanft ausrollen bis zum Halt
    return parts;
};
const rough = () => {
    const parts = [];
    for (let i = 0; i < 8; i++) {
        parts.push({ s: 5, v0: 0, v1: 80, torque: 390, rpm: 3900 });      // 0.45 g, hoch gedreht
        parts.push({ s: 6, v0: 80, v1: 80, torque: 200, lat: (x) => 0.55 * Math.sin(x * 2.2) });   // Slalom
        parts.push({ s: 3.5, v0: 80, v1: 0, torque: 0 });                  // 0.65 g Bremsung
        parts.push({ s: 2, v0: 0, v1: 0, rpm: 800 });
    }
    return parts;
};
const mk = (o) => { const c = new Coach(Object.assign({ mode: 'balanced', tripEndMin: 3 }, o)); const trips = []; c.on('trip', (s) => trips.push(s)); return { c, trips }; };

check('ruhige Fahrt: hohe Wertung, keine Ereignisse, gutes Rollen', () => {
    const { c } = mk();
    drive(c, calm(12));
    const s = c.endTrip();
    assert(s, 'Fahrt gespeichert');
    assert(s.score >= 85, 'Wertung ' + s.score + ' ' + JSON.stringify(s.cats));
    ['brake', 'accel', 'corner', 'spill', 'lug', 'over', 'cold'].forEach((k) => assert.strictEqual(s.ev[k], 0, k + ' = ' + s.ev[k]));
    assert(s.ant >= 80, 'Vorausschau ' + s.ant);
    assert(s.ev.coast >= 3, 'Rollphasen ' + s.ev.coast);
    assert(Math.abs(s.km - 12.9) < 1.5, 'km ' + s.km);
});

check('ruppige Fahrt: niedrige Wertung, je Manoever genau ein Ereignis', () => {
    const { c } = mk();
    drive(c, rough());
    const s = c.endTrip();
    assert(s, 'Fahrt gespeichert');
    assert(s.score < 55, 'Wertung ' + s.score);
    assert.strictEqual(s.ev.brake, 8, 'Bremsungen ' + s.ev.brake);
    assert.strictEqual(s.ev.accel, 8, 'Beschleunigungen ' + s.ev.accel);
    assert(s.ev.corner >= 8, 'Kurven ' + s.ev.corner);
    assert(s.ev.spill >= 4, 'Wasserglas ' + s.ev.spill);
    assert(s.ev.over >= 1, 'Drehzahl ' + s.ev.over);
});

check('Sportlich ist bei derselben zuegigen Fahrt nachsichtiger als Eco', () => {
    const fast = [{ s: 9, v0: 0, v1: 100, torque: 300, rpm: 3000 }, { s: 60, v0: 100, v1: 100, torque: 150 }, { s: 9, v0: 100, v1: 0, torque: 0 }];
    const r = {};
    ['eco', 'balanced', 'sport'].forEach((m) => { const { c } = mk({ mode: m }); drive(c, fast.concat(fast, fast)); r[m] = c.endTrip().score; });
    assert(r.sport > r.balanced && r.balanced > r.eco, JSON.stringify(r));
});

check('Signal-Schauer (viele Werte zur selben Zeit) aendern nichts', () => {
    const a = mk(), b = mk();
    let t = 1e12;
    for (let i = 0; i < 3000; i++) {
        const d = { speed: 30 + 20 * Math.sin(i / 300), rpm: 1700, gLong: 0.05 * Math.cos(i / 300), gLat: 0.1, torque: 100, oil: 90 };
        a.c.feed(d, t);
        for (let k = 0; k < 5; k++) b.c.feed(d, t);   // derselbe Wert fuenfmal
        t += 20;
    }
    assert.deepStrictEqual(a.c.endTrip(), b.c.endTrip());
});

check('Fahrtende nach Stillstand, kurze Fahrten verworfen, Signalverlust beendet', () => {
    const { c, trips } = mk({ tripEndMin: 2 });
    let t = drive(c, calm(4));
    assert(c.trip, 'Fahrt laeuft im Stand weiter');
    t = drive(c, [{ s: 100, v0: 0, v1: 0, rpm: 0 }], t);            // Start-Stopp: Motor aus
    assert(c.trip, 'nach 100 s noch dieselbe Fahrt');
    t = drive(c, [{ s: 30, v0: 0, v1: 0, rpm: 0 }], t);
    assert(!c.trip && trips.length === 1, 'nach 2 min Stand beendet');
    assert(trips[0].end < t - 100000, 'Ende = Beginn des Stillstands');
    t = drive(c, [{ s: 10, v0: 0, v1: 20 }, { s: 5, v0: 20, v1: 0 }], t + 5000);
    t = drive(c, [{ s: 130, v0: 0, v1: 0 }], t);
    assert.strictEqual(trips.length, 1, 'kurze Fahrt nicht gespeichert');
    t = drive(c, calm(2), t);
    c.tick(t + 95000);
    assert.strictEqual(trips.length, 2, 'ohne Signale nach 90 s beendet');
});

check('Wasserglas: gleichmaessig 0.3 g bremsen bleibt drin, ruppiger Wechsel schwappt ueber', () => {
    const a = mk();
    drive(a.c, [{ s: 10, v0: 0, v1: 60 }, { s: 6, v0: 60, v1: 60, gLong: 0 }, { s: 6, v0: 60, v1: 10, gLong: -0.3 }, { s: 6, v0: 10, v1: 10, gLong: 0 }]);
    assert.strictEqual(a.c.trip.ev.spill || 0, 0, 'gleichmaessig verschuettet');
    const b = mk();
    drive(b.c, [{ s: 10, v0: 0, v1: 60 }, { s: 8, v0: 60, v1: 60, gLong: 0, lat: (x) => (Math.floor(x / 0.6) % 2 ? 0.3 : -0.3) }]);
    assert((b.c.trip.ev.spill || 0) >= 1, 'Ruck-Wechsel nicht erkannt');
});

check('kalter Motor: hohe Drehzahl bei 40 Grad Oel wird erkannt, warm nicht', () => {
    const { c } = mk();
    drive(c, [{ s: 10, v0: 0, v1: 40, oil: 40, rpm: 1800 }, { s: 20, v0: 40, v1: 70, oil: 40, rpm: 3200, torque: 200 }, { s: 60, v0: 70, v1: 70, oil: 90, rpm: 3200, torque: 120 }, { s: 20, v0: 70, v1: 0, oil: 90 }]);
    const s = c.endTrip();
    assert.strictEqual(s.ev.cold, 1, 'kalt ' + s.ev.cold);
    assert(s.cats.care < 100 && s.coldStart && !s.coldClean, JSON.stringify(s.cats) + ' ' + s.coldStart + ' ' + s.coldClean);
    const w = mk();
    drive(w.c, [{ s: 10, v0: 0, v1: 40, oil: 40, rpm: 1800 }, { s: 60, v0: 40, v1: 60, oil: 45, rpm: 2000 }, { s: 20, v0: 60, v1: 0, oil: 60 }]);
    const s2 = w.c.endTrip();
    assert(s2.coldClean && s2.cats.care === 100, 'geschont ' + JSON.stringify(s2));
});

check('untertourig unter Last und Lastbereich', () => {
    const { c } = mk();
    drive(c, [{ s: 10, v0: 0, v1: 30 }, { s: 30, v0: 30, v1: 45, rpm: 1000, torque: 320 }, { s: 60, v0: 45, v1: 70, rpm: 2000, torque: 200 }, { s: 20, v0: 70, v1: 0, torque: 0 }]);
    const s = c.endTrip();
    assert.strictEqual(s.ev.lug, 1, 'lug ' + s.ev.lug);
    assert(s.bandPct > 50 && s.bandPct < 85, 'Lastbereich ' + s.bandPct);
});

check('laufende Fahrt speichern und nach Neustart fortsetzen', () => {
    const a = mk();
    const t = drive(a.c, calm(4));
    const snap = JSON.parse(JSON.stringify(a.c.snapshot()));
    const b = mk();
    b.c.restore(snap);
    drive(b.c, calm(4), t + 1000);
    const s = b.c.endTrip();
    assert(s.km > 8, 'km ' + s.km);
});

check('Tipps: Ereignis-Tipp, Sperrzeit fuer denselben Tipp, abschaltbar', () => {
    const { c } = mk();
    const tips = [];
    c.on('tip', (x) => tips.push(x.key));
    drive(c, rough().slice(0, 8));
    assert(tips.indexOf('brake') >= 0 && tips.filter((k) => k === 'brake').length === 1, tips.join(','));
    const off = mk({ tips: false });
    let n = 0; off.c.on('tip', () => n++);
    drive(off.c, rough().slice(0, 8));
    assert.strictEqual(n, 0);
});

check('Ziele: Abzeichen, Serie, Woche, Level, neue Abzeichen', () => {
    const day = 86400000, now = Date.UTC(2026, 10, 15);
    const trip = (i, score, km, extra) => Object.assign({ start: now - (10 - i) * day, end: now - (10 - i) * day + 1, km, min: km * 1.5, score, cats: {}, ev: { brake: 0, spill: 0, corner: 0 },
        ant: 80, idlePct: 2, coldClean: false, bestStreak: 600, curves: 0 }, extra || {});
    const list = [trip(0, 70, 8), trip(1, 82, 8), trip(2, 84, 9), trip(3, 88, 12), trip(4, 91, 6), trip(5, 86, 7)];
    const g = Goals.evaluate(list, now);
    const B = {}; g.badges.forEach((b) => { B[b.id] = b; });
    assert(B.first.done && B.ninety.done && B.row5.done && B.week.done && !B.km1000.done, JSON.stringify(g.badges.map((b) => [b.id, b.done])));
    assert.strictEqual(B.row5.at, list[5].end, 'erreicht mit der 5. guten Fahrt in Folge');
    assert.strictEqual(B.km1000.detail, Math.round(g.totals.km) + ' / 1000');
    assert(g.level.n >= 1 && g.level.xp > 0);
    const before = Goals.evaluate(list.slice(0, 4), now), fresh = Goals.newlyDone(before, g).map((b) => b.id);
    assert(fresh.indexOf('ninety') >= 0 && fresh.indexOf('row5') >= 0 && fresh.indexOf('first') < 0, fresh.join(','));
    assert.strictEqual(Goals.level(0).name, 'Fahrschueler');
    assert.strictEqual(Goals.level(1e9).to, null);
});

check('Fahrmodus des Autos -> Coach-Modus', () => {
    const orig = Module._load;
    Module._load = function (r) { if (/kit[\\/]/.test(r) || r.indexOf('./kit/') === 0) return r.indexOf('mgu') >= 0 ? { run() {} } : {}; return orig.apply(this, arguments); };
    let m;
    try { m = require(path.join(APP, 'main.js')); } finally { Module._load = orig; }
    const f = m.driveModeOf;
    assert.strictEqual(f('SPORT_DYNAMIC'), 'sport'); assert.strictEqual(f(1), 'sport'); assert.strictEqual(f(7), 'eco');
    assert.strictEqual(f('ECO_PRO_EFFICIENT'), 'eco'); assert.strictEqual(f('COMFORT'), 'balanced'); assert.strictEqual(f(4), 'balanced');
    assert.strictEqual(f(null), null); assert.strictEqual(f('SIGNAL_UNBEFUELLT'), null);
    assert.strictEqual(m.demoTrips(Date.now()).length, 26);
});

check('Version app.json = main.js; Einstellungen passen zur App', () => {
    const app = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    assert(main.indexOf("const VERSION = '" + app.version + "'") >= 0, 'VERSION');
    const keys = app.settings.map((s) => s.key);
    (main.match(/settings\.get\('([a-zA-Z]+)'\)/g) || []).map((x) => x.slice(14, -2)).forEach((k) => assert(keys.indexOf(k) >= 0, 'Einstellung fehlt: ' + k));
    assert(fs.existsSync(path.join(APP, 'icon.png')));
    // die Schriften des Kits haben keine Umlaute: kein ae/oe/ue-Zeichen in den Texten
    ['main.js', 'coach.js', 'goals.js', 'app.json'].forEach((f) => assert(!/[äöüÄÖÜß]/.test(fs.readFileSync(path.join(APP, f), 'utf8')), 'Umlaut in ' + f));
});

check('Rechenzeit: 1 Stunde Fahrt mit 50 Signalen/s', () => {
    const { c } = mk();
    const parts = [];
    for (let i = 0; i < 60; i++) parts.push({ s: 30, v0: 30, v1: 90, torque: 200, lat: (x) => 0.2 * Math.sin(x) }, { s: 30, v0: 90, v1: 30, torque: 0 });
    const t0 = process.hrtime();
    drive(c, parts);
    for (let i = 0; i < 3600; i++) c.view(1e12 + i * 1000);
    const dt = process.hrtime(t0), ms = dt[0] * 1e3 + dt[1] / 1e6;
    const per = ms * 1000 / (3600 * 50);
    console.log('     ' + ms.toFixed(0) + ' ms fuer 180000 Signale + 3600 Wertungen = ' + per.toFixed(2) + ' us pro Signal (PC)');
    assert(per < 20, 'zu langsam: ' + per.toFixed(2) + ' us');
});

console.log(failed ? '\n' + failed + ' Test(s) fehlgeschlagen' : '\nAlle Coach-Tests bestanden');
process.exit(failed ? 1 : 0);
