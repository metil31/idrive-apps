'use strict';
/**
 * Sound Drive – Ende-zu-Ende-Test des Audio-Dienstes (engine.js) mit echtem Kindprozess.
 *
 *   node kit/tools/test_engine_e2e.js
 *
 * engine.js startet wie im Auto "python alsa_play.py play <SmartX-Kanal> 24000 <Puffer> 1". Hier ersetzt ein
 * kleines Python-Skript die Soundkarte: Es "spielt" in Echtzeit ab (24 kHz, Puffer wie angefragt), blockiert bei
 * vollem Puffer, meldet Aussetzer wie ALSA und gibt "P <gespielte Frames>" zurück – genau wie alsa_play.py.
 * Geprüft: Ton startet, Format 24 kHz mono, Verzögerung (anstehender Ton) bleibt beim Vorlauf, kaum Aussetzer,
 * Stumm/Datenende geben das Gerät frei, Rechenzeit des Dienstes.
 * Braucht Python 3 (ICONIX_PYTHON oder python3/python im PATH).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-e2e-'));
['engine.js', 'synth.js', 'profiles.js'].forEach((f) => fs.copyFileSync(path.join(ROOT, 'tools/iconix-audiod', f), path.join(dir, f)));
const LOG = path.join(dir, 'player.log');
fs.writeFileSync(path.join(dir, 'alsa_play.py'), `
import os, sys, time
# Ersatz für alsa_play.py "play": Soundkarte in Echtzeit, Rückmeldung P <Frames>, Aussetzer wie ALSA
dev, rate, buf_us, ch = sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
fb = 2 * ch
bufn = rate * buf_us // 1000000
sys.stderr.write('alsa_play: spielt auf %s mit %d Hz, %d Kanal/Kanäle, Puffer %d ms, Periode %d ms, Echtzeit ja\\n' % (dev, rate, ch, buf_us // 1000, buf_us // 4000))
sys.stderr.flush()
log = open(os.environ['FAKE_LOG'], 'w')
total = 0; base = 0; t0 = None; pend = b''
def played():
    if t0 is None: return 0
    return min(total, base + int((time.monotonic() - t0) * rate))
while True:
    data = os.read(0, 8192)
    if not data: break
    data = pend + data
    n = len(data) // fb
    pend = data[n * fb:]
    now = time.monotonic()
    if t0 is None:
        t0 = now
    p = played()
    if total > 0 and p >= total:          # Puffer leer gelaufen
        sys.stderr.write('underrun!!!\\n'); sys.stderr.flush()
        base = total; t0 = now; p = total
    while n > 0:                          # wie snd_pcm_writei: so viel wie Platz ist, sonst warten
        room = bufn - (total - played())
        if room <= 0:
            time.sleep(0.002)
            continue
        w = min(room, n)
        total += w
        n -= w
    p = played()
    log.write('%.4f %d %d\\n' % (time.monotonic(), total, p)); log.flush()
    os.write(1, ('P %d\\n' % p).encode())
`);

function findPython() {
  if (process.env.ICONIX_PYTHON) return process.env.ICONIX_PYTHON;
  for (const n of ['python3', 'python']) {
    try { if (/Python 3/.test(cp.execFileSync(n, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))) return n; } catch (e) { /* weiter */ }
  }
  return null;
}
const py = findPython();
if (!py) { console.log('übersprungen: kein Python 3'); process.exit(0); }
process.env.ICONIX_PYTHON = py;
process.env.FAKE_LOG = LOG;
process.env.ICONIX_IDLE_STOP_MS = '3000';   // im Auto 30 s, hier kürzer

const E = require(path.join(dir, 'engine.js'));
const logs = [];
const eng = new E.Engine({ log: (m) => logs.push(m) });
eng.configure({ profile: 'supra', volume: 0.8, enabled: true, device: 'smartx:Media_Overlay_Converter_Source_CF_24_MONO' });
eng.start();

const t0 = Date.now(), cpu0 = process.cpuUsage();
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };
// Verzögerung von der Synthese bis zum Lautsprecher = geschrieben, aber noch nicht gespielt (Leitung + Puffer)
const delays = [];
const probe = setInterval(() => {
  const o = eng.out;
  if (o.child && o.played != null && o.gotPos && Date.now() - t0 > 2000) delays.push((eng.written / o.step() - o.played) / 24);
}, 25);
const feed = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  if (t < 7) eng.params({ rpm: 1500 + 2500 * ((t % 3) / 3), load: t % 3 < 2 ? 1 : 0, speed: 80, overrun: t % 3 >= 2 });
}, 40);

setTimeout(() => {
  // während der Fahrt
  const st = eng.status();
  ok(st.playing && /smartx/.test(st.backend || ''), 'Ton läuft über den SmartX-Player (' + st.backend + ')');
  ok(st.outRate === 24000 && st.outCh === 1, 'Format 24 kHz mono');
  ok(st.bufMs === 60, 'Puffergröße vom Player übernommen (' + st.bufMs + ' ms)');
  ok(st.rt === 'ja', 'Echtzeit-Meldung des Players übernommen (' + st.rt + ')');
}, 5000);

setTimeout(() => {
  clearInterval(feed); clearInterval(probe);
  const cpu = process.cpuUsage(cpu0), secs = (Date.now() - t0) / 1000;
  const rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ').map(Number));
  if (process.env.E2E_DEBUG) { console.log(rows.length + ' Zeilen', rows.slice(0, 3), rows.slice(-3)); console.log(logs.join('\n')); }
  const tStart = rows.length ? rows[0][0] : 0;
  const q = rows.filter((r) => r[0] - tStart > 2).map((r) => (r[1] - r[2]) / 24);  // ms anstehend nach dem Schreiben
  q.sort((a, b) => a - b);
  const p50 = q[Math.floor(q.length * 0.5)], p95 = q[Math.floor(q.length * 0.95)], max = q[q.length - 1];
  const lead = eng.fbLead || E.FB_LEAD_START;
  console.log('     im Soundkarten-Puffer: Median ' + p50.toFixed(0) + ' ms, 95 % ' + p95.toFixed(0) + ' ms, max ' + max.toFixed(0) + ' ms (Vorlauf ' + lead + ' ms)');
  delays.sort((a, b) => a - b);
  const d50 = delays[Math.floor(delays.length * 0.5)], d95 = delays[Math.floor(delays.length * 0.95)];
  console.log('     Verzögerung Synthese -> Lautsprecher (Leitung + Puffer): Median ' + d50.toFixed(0) + ' ms, 95 % ' + d95.toFixed(0) + ' ms');
  ok(p95 <= 66, 'Soundkarten-Puffer bleibt bei ~60 ms (zählt zum Vorlauf)');
  ok(d95 <= lead + 25 && d50 >= 20, 'Gesamtverzögerung bleibt beim Vorlauf (95 % ≤ Vorlauf + 25 ms)');
  const under = eng.status().underruns;
  ok(under <= 3, 'kaum Aussetzer (' + under + ')');
  const ms = (cpu.user + cpu.system) / 1000 / secs;
  console.log('     Rechenzeit des Dienstes: ' + ms.toFixed(1) + ' ms je Sekunde');
  ok(ms < 150, 'Rechenzeit im Rahmen (PC)');
}, 8000);

// nach dem Ende der Daten: ausblenden und Gerät nach IDLE_STOP freigeben
setTimeout(() => {
  const st = eng.status();
  ok(!st.wants, 'ohne Fahrzeugdaten kein Ton mehr gewünscht');
  ok(!st.playing, 'Player nach der Stille beendet (Gerät frei)');
  eng.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* egal */ }
  console.log(fails ? fails + ' Test(s) fehlgeschlagen' : 'Alle Ende-zu-Ende-Tests bestanden');
  process.exit(fails ? 1 : 0);
}, 19500);
