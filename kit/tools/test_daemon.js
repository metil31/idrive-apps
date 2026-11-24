'use strict';
/**
 * Sound Drive – Test des ganzen Audio-Dienstes (iconix-audiod.js) als eigener Prozess, über seinen Socket wie die App.
 *
 *   node kit/tools/test_daemon.js
 *
 * Der Dienst läuft in einem Temp-Ordner mit einem Python-Ersatz für alsa_play.py (spielt in Echtzeit ab, meldet
 * Frames). Geprüft: startet schnell und ohne ALSA-Scan (der bremste das Hochfahren), meldet Status, nimmt
 * Einstellungen und Fahrzeugdaten an, spielt, Testsound, Diagnose (startet erst dann den Scan), kaputte Nachrichten
 * stören nicht, beendet sich sauber.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-daemon-'));
['iconix-audiod.js', 'engine.js', 'synth.js', 'profiles.js'].forEach((f) => fs.copyFileSync(path.join(ROOT, 'tools/iconix-audiod', f), path.join(dir, f)));
fs.writeFileSync(path.join(dir, 'alsa_play.py'), `
import os, sys, time, json
if sys.argv[1] == 'list':
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scan.marker'), 'w').write('scan')
    print(json.dumps({'devices': [{'name': 'default', 'desc': '', 'ok': True, 'silent': False, 'error': None}]}))
    sys.exit(0)
dev, rate, buf_us, ch = sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
fb = 2 * ch
bufn = rate * buf_us // 1000000
sys.stderr.write('alsa_play: spielt auf %s mit %d Hz, %d Kanal/Kanäle, Puffer %d ms, Periode %d ms, Echtzeit ja\\n' % (dev, rate, ch, buf_us // 1000, buf_us // 4000))
sys.stderr.flush()
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
    if t0 is None: t0 = time.monotonic()
    while n > 0:
        room = bufn - (total - played())
        if room <= 0:
            time.sleep(0.002); continue
        w = min(room, n); total += w; n -= w
    os.write(1, ('P %d\\n' % played()).encode())
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

const sock = process.platform === 'win32' ? '\\\\.\\pipe\\sd-daemon-' + process.pid : path.join(dir, 'audiod.sock');
const statusFile = path.join(dir, 'status.json');
const env = Object.assign({}, process.env, { ICONIX_PYTHON: py, ICONIX_AUDIOD_SOCKET: sock, ICONIX_STATUS_FILE: statusFile, ICONIX_IDLE_STOP_MS: '3000' });
const t0 = Date.now();
const d = cp.spawn(process.execPath, [path.join(dir, 'iconix-audiod.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
d.stdout.on('data', (b) => { out += b; });
d.stderr.on('data', (b) => { out += b; });

let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const statuses = [], diags = [];
let client = null, rx = '';
const send = (m) => client.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = () => statuses[statuses.length - 1] || {};

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      await new Promise((res, rej) => {
        const c = net.connect(sock, () => { client = c; res(); });
        c.on('error', rej);
      });
      return true;
    } catch (e) { await sleep(100); }
  }
  return false;
}

(async () => {
  const connected = await connect();
  ok(connected, 'Dienst erreichbar über den Socket nach ' + (Date.now() - t0) + ' ms');
  if (!connected) { console.log(out); process.exit(1); }
  client.setEncoding('utf8');
  client.on('data', (s) => {
    rx += s; let i;
    while ((i = rx.indexOf('\n')) >= 0) {
      const line = rx.slice(0, i); rx = rx.slice(i + 1);
      try { const m = JSON.parse(line); if (m.op === 'status') statuses.push(m); else if (m.op === 'diag') diags.push(m); } catch (e) { /* egal */ }
    }
  });
  await sleep(300);
  ok(statuses.length > 0 && statuses[0].version, 'Status beim Verbinden (Version ' + (statuses[0] || {}).version + ')');
  await sleep(2500);
  ok(!fs.existsSync(path.join(dir, 'scan.marker')), 'kein ALSA-Scan beim Start (bremste das Hochfahren)');
  ok(fs.existsSync(statusFile), 'Statusdatei geschrieben');

  send({ op: 'hello', id: 'test', version: '1' });
  client.write('das ist kein JSON\n{"op":\n');           // kaputte Nachrichten
  send({ op: 'config', cfg: { profile: 'turbo5', volume: 0.6, enabled: true, device: 'smartx:Media_Overlay_Converter_Source_CF_24_MONO' } });
  const feed = setInterval(() => send({ op: 'params', rpm: 2200, load: 0.4, speed: 70, overrun: false }), 40);
  await sleep(1500);
  ok(last().playing && last().profile === 'turbo5', 'spielt nach Einstellungen und Fahrzeugdaten (' + last().backend + ', playing ' + last().playing + ', Profil ' + last().profile + ')');
  ok(last().outRate === 24000 && last().rt === 'ja', 'Overlay-Format 24 kHz, Player mit Echtzeit');
  clearInterval(feed);

  send({ op: 'diag' });
  await sleep(2500);
  ok(diags.length > 0 && diags[0].lines.some((l) => /SmartX/.test(l)), 'Diagnose antwortet');
  ok(fs.existsSync(path.join(dir, 'scan.marker')), 'ALSA-Scan erst mit der Diagnose');
  ok(Array.isArray(last().scan) && last().scan.length === 1, 'Scan-Ergebnis im Status');

  send({ op: 'test' });
  await sleep(1000);
  ok(last().playing && last().wants, 'Testsound spielt (auch ohne Fahrzeugdaten)');
  await sleep(9500 + 3500);
  ok(!last().playing, 'nach Testsound und Stille Player beendet');

  const tKill = Date.now();
  d.kill('SIGTERM');
  await new Promise((r) => d.on('exit', r));
  ok(Date.now() - tKill < 3000, 'beendet sich sauber');
  ok(!/Fehler:|TypeError|ReferenceError/.test(out), 'keine Fehler im Protokoll');
  if (fails) console.log(out.split('\n').slice(-25).join('\n'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* egal */ }
  console.log(fails ? fails + ' Test(s) fehlgeschlagen' : 'Alle Dienst-Tests bestanden');
  process.exit(fails ? 1 : 0);
})();
