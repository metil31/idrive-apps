'use strict';
/**
 * Autostart von Sound Drive ohne Auto: Die Plattform startet nur den Hintergrund (impl.background), niemand öffnet die
 * App. Fahrzeugdienst und Audiomanager sind anfangs noch nicht bereit, der Audio-Dienst kommt erst später dazu.
 * Geprüft: Danach kommen Einstellungen und Drehzahl beim (hier nachgebildeten) Dienst an, der Tonweg wird verbunden und
 * der Ton freigegeben (hold aus); beim Beenden wird der Tonweg getrennt.
 *
 *   node kit/tools/test_autostart.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const SOCK = process.platform === 'win32' ? '\\\\.\\pipe\\iconix-autostart-' + process.pid : path.join(os.tmpdir(), 'iconix-autostart-' + process.pid + '.sock');
process.env.ICONIX_AUDIOD_SOCKET = SOCK;
process.env.ICONIX_STATUS_FILE = path.join(os.tmpdir(), 'iconix-autostart-none.json');
process.env.ICONIX_FALLBACK_MS = '600000';   // kein Ton aus der App selbst

let impl = null;
const load = Module._load;
Module._load = function (r) { return r === './kit/mgu' ? { run(x) { impl = x; } } : load.apply(this, arguments); };
require(path.join(ROOT, 'apps/iconix_sounds/main.js'));

const lines = [], log = {};
['info', 'warn', 'error', 'debug'].forEach((k) => { log[k] = (m) => lines.push(String(m)); });
const app = new EventEmitter(); app.startReason = 'AUTOSTART';
const handlers = {}, tries = {};
const am = { conns: [], id: 2, down: true };
const signals = {
  watch: async (iface, inst, h) => {
    tries[iface] = (tries[iface] || 0) + 1;
    if (/vehicle\.CDS$/.test(iface) && tries[iface] === 1) return { error: 'Error: init timeout', shutdown() {} };
    handlers[iface] = h;
    return { shutdown() {} };
  },
  proxy: async (iface) => { if (am.down) throw new Error('not available yet'); return { iface }; },
  call: async (p, m, x) => {
    if (m === 'getListMainConnections') return { listConnections: am.conns.map((c) => Object.assign({}, c)) };
    if (m === 'getListMainSinks') return { listMainSinks: [{ sinkID: 1, volume: 20 }] };
    if (m === 'getListMainSources') return { listMainSources: [] };
    if (m === 'connect') { am.conns.push({ mainConnectionID: am.id, sourceID: x.sourceID, sinkID: x.sinkID, connectionState: 2 }); return { amError: 'E_OK', mainConnectionID: am.id++ }; }
    if (m === 'disconnect') { am.conns = am.conns.filter((c) => c.mainConnectionID !== x.mainConnectionID); return { amError: 'E_OK' }; }
    return {};
  }
};
const got = { config: [], params: [] };
const server = net.createServer((s) => {
  let rx = ''; s.setEncoding('utf8'); s.on('error', () => {});
  s.on('data', (d) => { rx += d; const l = rx.split('\n'); rx = l.pop(); l.filter(Boolean).forEach((x) => { const m = JSON.parse(x); if (got[m.op]) got[m.op].push(m); }); });
  s.write(JSON.stringify({ op: 'status', version: '99.0.0', backend: 'x', playing: true, wants: true }) + '\n');
});
async function until(what, fn, ms) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('nicht erreicht: ' + what + '\n' + lines.join('\n')); await new Promise((ok) => setTimeout(ok, 25)); }
  console.log('ok   ' + what);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iconix-autostart-'));
  // Einstellungen aus app.json, wie sie das Kit liefert
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8')), values = {};
  spec.settings.forEach((x) => { values[x.key] = x.default; });
  const settings = { get: (k) => values[k], set(k, v) { values[k] = v; }, onChange() {} };
  await impl.background({ app, log, settings, signals, spec, dataDir: dir });
  // Head Unit noch nicht so weit: kein Dienst, kein Audiomanager, kein Drehzahl-Dienst
  await new Promise((ok) => setTimeout(ok, 700));
  assert.ok(!handlers['de.bmw.infotainment.vehicle.CDS'] && !am.conns.length);
  server.listen(SOCK);
  await until('Drehzahl-Abo wird nachgeholt', () => handlers['de.bmw.infotainment.vehicle.CDS'], 8000);
  const rpm = setInterval(() => handlers['de.bmw.infotainment.vehicle.CDS'].statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 3200 + Math.round(Math.random() * 40) }), 60);
  await until('Audio-Dienst verbunden, Einstellungen da', () => got.config.length, 8000);
  await until('Drehzahl kommt beim Dienst an', () => got.params.some((m) => m.rpm > 700), 5000);
  am.down = false;
  await until('Tonweg verbunden', () => am.conns.length === 1, 6000);
  await until('Ton freigegeben', () => got.config.length && got.config[got.config.length - 1].cfg.hold === false, 6000);
  assert.ok(got.config[got.config.length - 1].cfg.enabled, 'Sound an');
  await until('Zeiten stehen im Log', () => ['App (AUTOSTART)', 'erste Drehzahl', 'Audio-Dienst verbunden', 'Tonweg hörbar', 'Ton läuft'].every((t) => lines.some((l) => l.indexOf('iconix: Start: ' + t) === 0)), 3000);
  clearInterval(rpm);
  app.emit('shutdown');
  await until('Beenden gibt den Tonweg frei', () => am.conns.length === 0, 200);
  console.log('Autostart-Test bestanden');
  process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
