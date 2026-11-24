'use strict';
/**
 * Iconix Sounds – Suche nach Knacksern/"Pops" (kurze Pegelspitzen) in einer realistischen Fahrt.
 *
 *   node kit/tools/iconix_popscan.js [profil ...] [--quiet]
 *
 * Fährt jedes Profil wie der Simulator: Leerlauf, Anfahren mit Hochschalten (Lastknick beim Schalten),
 * Gaswegnehmen bei hoher Drehzahl, Schub, erneutes Gasgeben, Konstantfahrt. In 5-ms-Fenstern wird die
 * Spitze (im Hochpass > 700 Hz, wo Klicks hervortreten) mit dem lauteren Median der 150 ms davor bzw. danach verglichen; Fenster über SPIKE (Faktor) gelten als Pop.
 * Gibt je Profil die Anzahl und die Zeitpunkte (mit Fahrphase) aus. Exit-Code 1, wenn welche gefunden wurden.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const Synth = require(path.join(ROOT, 'tools/iconix-audiod/synth.js'));
const Profiles = require(path.join(ROOT, 'tools/iconix-audiod/profiles.js'));

const args = process.argv.slice(2).filter((a) => a !== '--quiet');
const quiet = process.argv.indexOf('--quiet') >= 0;
const ids = args.length ? args : Profiles.ids.filter((id) => Profiles.get(id).kind !== 'electric');
const SR = 24000, SPIKE = 3.2;

// Fahrt mit Schaltvorgängen (Lastknick 0.25 für 0,22 s wie im Simulator) und Lastwechseln
function scenario(t) {
  if (t < 2) return [{ rpm: 800, load: 0.04, speed: 0, overrun: false }, 'Leerlauf'];
  if (t < 9) {
    const u = t - 2, gear = Math.floor(u / 1.75), g = u - gear * 1.75;
    const shifting = g < 0.22 && gear > 0;
    const rpm = shifting ? 3800 - 1200 * (g / 0.22) : 1500 + 2300 * (g / 1.75);
    return [{ rpm, load: shifting ? 0.25 : 1, speed: 20 + 15 * u, overrun: false }, shifting ? 'Schalten' : 'Vollgas'];
  }
  if (t < 12) return [{ rpm: 4300 - 2000 * (t - 9) / 3, load: 0, speed: 120, overrun: true }, 'Schub'];
  if (t < 14) return [{ rpm: 2300 + 600 * (t - 12) / 2, load: 0.9, speed: 120, overrun: false }, 'Gasgeben'];
  if (t < 15) return [{ rpm: 2900, load: 0.05, speed: 120, overrun: false }, 'Gas weg'];
  return [{ rpm: 2000, load: 0.3, speed: 100, overrun: false }, 'Konstant'];
}

let total = 0;
for (const id of ids) {
  const s = new Synth(SR);
  s.configure({ profile: id, volume: 1, intensity: 0.7 });
  s._setProfile(id); s.pending = null; s._reset();
  const blk = 120, f = new Float32Array(blk * 2), secs = 18, n = SR * secs, x = new Float32Array(n), phase = [];
  for (let pos = 0; pos < n; pos += blk) {
    const [p, name] = scenario(pos / SR);
    s.setParams(p); s.render(f, blk);
    for (let i = 0; i < blk; i++) x[pos + i] = f[i * 2];
    phase.push(name);
  }
  // Klicks verstecken sich unter dem Bass: im Hochpass (> ~700 Hz, 2. Ordnung) suchen
  const hp = new Synth.Biquad().set('hp', 700, 0.7, SR), y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = hp.run(x[i]);
  const W = SR * 0.005, pk = [];
  for (let w = 0; w + W <= n; w += W) { let m = 0; for (let i = w; i < w + W; i++) m = Math.max(m, Math.abs(y[i])); pk.push(m); }
  const hits = [];
  const R = 30; // ±150 ms
  for (let i = R; i < pk.length - R; i++) {
    // Bezug: der lautere der beiden Mediane davor/danach – ein Anstieg (Gas geben) ist kein Pop
    const mb = pk.slice(i - R, i).sort((a, b) => a - b)[R >> 1], ma = pk.slice(i + 1, i + R + 1).sort((a, b) => a - b)[R >> 1];
    const med = Math.max(mb, ma);
    if (pk[i] > 0.004 && pk[i] > SPIKE * med) hits.push([(i * 0.005).toFixed(2), phase[Math.floor(i * W / blk)], (pk[i] / med).toFixed(1)]);
  }
  total += hits.length;
  console.log(id.padEnd(7) + ' ' + hits.length + ' Pops' + (quiet || !hits.length ? '' : ': ' + hits.slice(0, 12).map((h) => h[0] + ' s ' + h[1] + ' x' + h[2]).join(', ')));
}
process.exitCode = total ? 1 : 0;
