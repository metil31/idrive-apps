'use strict';
/**
 * Sound Drive – Belastungstest des Klangs in allen Lagen (ohne Auto).
 *
 *   node kit/tools/iconix_soak.js [--quick]
 *
 * Für jedes Profil × Fahrmodus (ohne, Eco, Comfort, Sport, Sport+) × Lautstärke (0, 30, 80, 100 %) × Klang (Standard,
 * maximal, minimal: Bass, Bellen, Tempo-Lautstärke, Startsound) fährt der
 * Synth eine lange, gemischte Fahrt: Kaltstart aus 0 U/min, Leerlauf, Anfahren mit Hochschalten, Kickdown,
 * Gaswegnehmen bei hoher Drehzahl, Schub, Runterschalten mit Zwischengas, Konstantfahrt, Stopp,
 * Abwürgen (0 U/min), Datenlücke, Profilwechsel und Fahrmodus-Wechsel mitten im Ton, Stumm/Ton an,
 * Absenken (Telefon) an/aus, Extremwerte (Drehzahl über der Abregelung, Last > 1, negative Werte).
 *
 * Geprüft wird je Lauf: kein NaN/Inf, Spitze ≤ 1, kein Knacken (Spitze im Hochpass gegen die lautesten Fenster der
 * Umgebung), Lautstärke 0 = Stille, Stumm blendet aus, bei 0 U/min Stille, Rechenzeit. Exit-Code 1 bei einem Fehler.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const Synth = require(path.join(ROOT, 'tools/iconix-audiod/synth.js'));
const Profiles = require(path.join(ROOT, 'tools/iconix-audiod/profiles.js'));

const SR = 24000, BLK = 240;              // 10-ms-Blöcke wie der Dienst
const quick = process.argv.indexOf('--quick') >= 0;
const MODES = quick ? [null, 'sport'] : [null, 'eco', 'comfort', 'sport', 'sportplus'];
const VOLS = quick ? [0, 1] : [0, 0.3, 0.8, 1];
// Klang-Einstellungen: Standard und beide Extreme (Bass, Bellen, Tempo-Lautstärke, Startsound)
const TONES = [
  ['Standard', {}],
  ['Klang maximal', { bassDb: 6, barkPct: 1.5, speedVol: 6 }],
  ['Klang minimal', { bassDb: -6, barkPct: 0.5, speedVol: 0, startSound: false }]
].slice(0, quick ? 2 : 3);

// Fahrt als Abschnitte: [Dauer s, Funktion(t im Abschnitt) -> params, Aktion beim Start, Name, Prüfung]
function trip(id) {
  const other = Profiles.ids[(Profiles.ids.indexOf(id) + 3) % Profiles.ids.length];
  return [
    [0.6, () => ({ rpm: 0, load: 0, speed: 0 }), null, 'Motor aus', 'silent'],
    [1.0, (t) => ({ rpm: Math.min(800, t * 2000), load: 0.1, speed: 0 }), null, 'Anlassen'],
    [1.5, () => ({ rpm: 800, load: 0.04, speed: 0 }), null, 'Leerlauf'],
    [6.0, (t) => { const g = Math.floor(t / 1.5), u = t - g * 1.5, sh = g > 0 && u < 0.2;
      return { rpm: sh ? 3900 - 1300 * u / 0.2 : 1500 + 2400 * u / 1.5, load: sh ? 0.2 : 1, speed: 15 + 14 * t }; }, null, 'Hochschalten'],
    [1.2, (t) => ({ rpm: 2200 + 2000 * Math.min(1, t / 0.4), load: 1, speed: 100 }), null, 'Kickdown'],
    [2.5, (t) => ({ rpm: 4200 - 1800 * t / 2.5, load: 0, overrun: true, speed: 110 }), null, 'Gas weg / Schub'],
    [1.0, (t) => ({ rpm: 2400 + 1100 * Math.min(1, t / 0.25), load: t < 0.25 ? 0.05 : 0, overrun: t >= 0.25, speed: 90 }), null, 'Runterschalten'],
    [2.0, () => ({ rpm: 2000, load: 0.25, speed: 100 }), (s) => s.configure({ duck: true }), 'Telefon (abgesenkt)'],
    [1.5, () => ({ rpm: 2000, load: 0.25, speed: 100 }), (s) => s.configure({ duck: false }), 'Telefon vorbei'],
    [1.5, () => ({ rpm: 2600, load: 0.5, speed: 110 }), (s) => s.configure({ profile: other }), 'Profilwechsel'],
    [1.5, () => ({ rpm: 2600, load: 0.5, speed: 110 }), (s) => s.configure({ profile: id }), 'Profil zurück'],
    [1.5, () => ({ rpm: 3000, load: 0.7, speed: 120 }), (s) => s.configure({ mode: 'sportplus' }), 'Modus Sport+'],
    [1.5, () => ({ rpm: 3000, load: 0.7, speed: 120 }), (s, m) => s.configure({ mode: m }), 'Modus zurück'],
    [1.2, () => ({ rpm: 2500, load: 0.3, speed: 90 }), (s) => s.configure({ enabled: false }), 'Stumm', 'fadeout'],
    [1.2, () => ({ rpm: 2500, load: 0.3, speed: 90 }), (s) => s.configure({ enabled: true }), 'Ton an'],
    [2.5, null, null, 'Datenlücke (keine Werte)'],
    [1.0, () => ({ rpm: 9000, load: 3, speed: 400 }), null, 'Extremwerte hoch'],
    [1.0, () => ({ rpm: -50, load: -1, speed: -5 }), null, 'Extremwerte negativ'],
    [1.0, () => ({ rpm: NaN, load: undefined, speed: null }), null, 'kaputte Werte'],
    [3.0, (t) => ({ rpm: 1800 - 1000 * t / 3, load: 0.05, speed: 40 - 13 * t }), null, 'Ausrollen, Stopp'],
    [1.0, (t) => ({ rpm: Math.max(0, 800 - t * 3000), load: 0, speed: 0 }), null, 'Abwürgen'],
    [0.8, () => ({ rpm: 0, load: 0, speed: 0 }), null, 'Motor aus (Ende)', 'silent']
  ];
}

function hp(x) { // Hochpass ~700 Hz (2. Ordnung), wo Klicks hervortreten
  const w = 2 * Math.PI * 700 / SR, a = Math.exp(-w), out = new Float32Array(x.length);
  let y1 = 0, x1 = 0, y2 = 0, x2 = 0;
  for (let i = 0; i < x.length; i++) { y1 = a * (y1 + x[i] - x1); x1 = x[i]; y2 = a * (y2 + y1 - x2); x2 = y1; out[i] = y2; }
  return out;
}

/** Knackser suchen: 5-ms-Fenster, Spitze im Hochpass gegen die lauteren 10 % der Fenster 150 ms davor/danach.
 * (Der Median wäre bei regelmäßigen Zündimpulsen, die auf jedes 2./3. Fenster fallen, zu niedrig – ein echter
 * Knackser ragt auch über die lautesten Zündimpulse seiner Umgebung heraus.) */
function findClicks(out, pos, vol, marks) {
  const h = hp(out), win = 120, n = Math.floor(pos / win), pk = new Float32Array(n);
  for (let w = 0; w < n; w++) { let m = 0; for (let i = w * win; i < (w + 1) * win; i++) m = Math.max(m, Math.abs(h[i])); pk[w] = m; }
  const p90 = (a, b) => { const v = Array.from(pk.subarray(Math.max(0, a), Math.min(n, b))).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length * 0.9)] : 0; };
  let clicks = 0, first = '';
  for (let w = 30; w < n - 30; w++) {
    const ref = Math.max(p90(w - 30, w - 1), p90(w + 2, w + 31));
    if (ref > 2e-4 && pk[w] > 2.0 * ref && pk[w] > 0.01 * Math.max(vol, 0.1)) {
      clicks++;
      if (!first) { const at = w * win; const seg = marks.find((m) => at >= m[0] && at < m[1]); first = (at / SR).toFixed(2) + ' s (' + (seg ? seg[2] : '?') + ', x' + (pk[w] / ref).toFixed(1) + ')'; }
    }
  }
  return { n: clicks, first };
}

// Selbsttest: ein künstlicher Knackser (kurzer Sprung, wie die früher gemeldeten Pops) muss erkannt werden
{
  const s = new Synth(SR); s.configure({ profile: 'turbo4', volume: 0.8, enabled: true }); s._setProfile('turbo4');
  const f = new Float32Array(BLK * 2), out = new Float32Array(SR * 3);
  for (let p = 0; p < out.length; p += BLK) { s.setParams({ rpm: 2200, load: 0.3, speed: 80 }); s.render(f, BLK); for (let i = 0; i < BLK; i++) out[p + i] = f[i * 2]; }
  const clean = findClicks(out, out.length, 0.8, []).n;
  for (let i = 0; i < 24; i++) out[SR * 2 + i] += 0.08 * (1 - i / 24);   // klein, etwa so laut wie die früher gemeldeten Pops
  const hit = findClicks(out, out.length, 0.8, []).n;
  if (clean || !hit) { console.log('FAIL Selbsttest der Knackser-Erkennung: sauber ' + clean + ', mit Knackser ' + hit); process.exit(1); }
  console.log('Selbsttest: künstlicher Knackser erkannt, saubere Fahrt ohne Treffer');
}

let fails = 0, runs = 0, cpu = 0, audioSec = 0;
const issues = [];
for (const id of Profiles.ids) {
  for (const mode of MODES) {
    for (const vol of VOLS) for (const [toneName, tone] of TONES) {
      runs++;
      const s = new Synth(SR);
      s.configure(Object.assign({ profile: id, volume: vol, intensity: 0.7, enabled: true, mode, carIdle: 800, carRedline: 4800 }, tone));
      s._setProfile(id); s.pending = null; s._reset();
      const segs = trip(id), total = segs.reduce((a, g) => a + g[0], 0);
      const out = new Float32Array(Math.ceil(total * SR) + BLK), f = new Float32Array(BLK * 2), marks = [];
      let pos = 0, bad = false, peak = 0, staleSince = 0;
      const t0 = process.hrtime();
      for (const [dur, fn, act, name, check] of segs) {
        if (act) act(s, mode);
        const start = pos, n = Math.round(dur * SR);
        for (let k = 0; k < n; k += BLK) {
          if (fn) { s.setParams(fn(k / SR)); s.stale = false; staleSince = 0; } else { staleSince += BLK; s.stale = staleSince > SR * 1.5; }
          const pk = s.render(f, BLK);
          if (!(pk <= 1)) bad = true;
          peak = Math.max(peak, pk);
          for (let i = 0; i < BLK; i++) { const v = f[i * 2]; if (v !== v || !isFinite(v)) bad = true; out[pos + i] = v; }
          pos += BLK;
        }
        marks.push([start, pos, name, check]);
      }
      const dt = process.hrtime(t0); cpu += dt[0] * 1000 + dt[1] / 1e6; audioSec += pos / SR;
      const tag = id + ' / ' + (mode || 'ohne Modus') + ' / ' + Math.round(vol * 100) + ' % / ' + toneName;
      const fail = (msg) => { fails++; issues.push(tag + ': ' + msg); };
      if (bad) fail('NaN/Inf oder Spitze > 1');
      if (vol === 0 && peak > 1e-6) fail('Lautstärke 0, aber Spitze ' + peak.toFixed(4));
      // Abschnitts-Prüfungen
      for (const [a, b, name, check] of marks) {
        let pk = 0; const from = a + Math.round((b - a) * 0.5);
        for (let i = from; i < b; i++) pk = Math.max(pk, Math.abs(out[i]));
        if (check === 'silent' && pk > 0.002) fail(name + ': nicht still (Spitze ' + pk.toFixed(4) + ')');
        if (check === 'fadeout' && pk > 0.003) fail(name + ': blendet nicht aus (Spitze ' + pk.toFixed(4) + ')');
      }
      // Knacken: 5-ms-Fenster, Spitze im Hochpass gegen die lauteren 10 % der Fenster 150 ms davor/danach.
      // (Der Median wäre bei regelmäßigen Zündimpulsen, die auf jedes 2./3. Fenster fallen, zu niedrig – ein echter
      // Knackser ragt auch über die lautesten Zündimpulse seiner Umgebung heraus.)
      if (vol > 0) { const c = findClicks(out, pos, vol, marks); if (c.n) fail(c.n + ' Knackser, zuerst bei ' + c.first); }
      // Ton vorhanden, wenn Lautstärke > 0
      let e = 0;
      for (let i = 0; i < pos; i++) e += out[i] * out[i];
      if (vol > 0 && e === 0) fail('stumm, obwohl Lautstärke > 0');
    }
  }
}
const perSec = cpu / audioSec;
console.log(runs + ' Fahrten, ' + audioSec.toFixed(0) + ' s Ton, Rechenzeit ' + perSec.toFixed(1) + ' ms je Sekunde Ton (24 kHz)');
if (perSec > 40) { fails++; issues.push('Rechenzeit zu hoch: ' + perSec.toFixed(1) + ' ms/s'); }
issues.slice(0, 400).forEach((m) => console.log('FAIL ' + m));
if (issues.length > 40) console.log('… und ' + (issues.length - 40) + ' weitere');
console.log(fails ? fails + ' Fehler' : 'Alles in Ordnung: kein NaN, keine Übersteuerung, kein Knacken, Stille wo sie sein soll');
process.exit(fails ? 1 : 0);
