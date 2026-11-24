'use strict';
/*
 * iconix-audiod – Audio-Dienst für Sound Drive (EXPERIMENTELL)
 *
 * Läuft als systemd-Dienst (Root-Tool des mgu-store) auf dem Head Unit mit dessen Node 8.
 * Empfängt von der App über Unix-Sockets Drehzahl/Last/Tempo und Einstellungen und gibt den Sound
 * über engine.js aus (Synthese + aplay/pacat/pw-cat/gst).
 *
 * Erreichbarkeit für die App (die ohne Root läuft):
 *   - Sockets: /run/iconix-audiod/audiod.sock (systemd RuntimeDirectory) und /tmp/iconix-audiod.sock
 *     (/tmp ist auf dem Head Unit ein gemeinsames tmpfs aller Prozesse – das Kit legt dort seine Frames ab)
 *   - Statusdatei /tmp/iconix-audiod.json (alle 2 s), damit die App auch ohne Socket sieht, dass der Dienst läuft
 *
 * Kommandozeile (auch am PC nutzbar):
 *   node iconix-audiod.js                     Dienst starten
 *   node iconix-audiod.js --probe             verfügbare Abspielprogramme anzeigen
 *   node iconix-audiod.js --play-test         9 s Test-Sweep direkt abspielen
 *   node iconix-audiod.js --wav out.wav [--profile v8] [--seconds 10] [--volume 0.8]
 *
 * Umgebungsvariablen:
 *   ICONIX_AUDIOD_SOCKET  zusätzlicher/ersetzender Socket-Pfad (Tests: Named Pipe unter Windows)
 *   ICONIX_STATUS_FILE    Pfad der Statusdatei (Standard /tmp/iconix-audiod.json)
 *   sowie die von engine.js (ICONIX_PLAYER, ICONIX_DEVICE, ICONIX_RATE, ICONIX_LEAD_MS, ICONIX_BUFFER_US)
 *
 * Nur Node-8-kompatible Syntax verwenden.
 */
const fs = require('fs');
const net = require('net');
const cp = require('child_process');
const path = require('path');
const Synth = require('./synth');
const Profiles = require('./profiles');
const E = require('./engine');

const VERSION = '1.0.8';
const SOCKETS = process.env.ICONIX_AUDIOD_SOCKET
  ? [process.env.ICONIX_AUDIOD_SOCKET]
  : ['/run/iconix-audiod/audiod.sock', '/tmp/iconix-audiod.sock'];
const STATUS_FILE = process.env.ICONIX_STATUS_FILE || '/tmp/iconix-audiod.json';

// ALSA-Scan als nummerierte Zeilen (Nummer = Einstellung "Gerät N")
function scanLines(st) {
  if (!st.scan) return [st.scanError ? 'ALSA-Scan: ' + st.scanError : 'ALSA-Scan: läuft noch …'];
  if (!st.scan.length) return ['ALSA-Scan: keine Geräte' + (st.scanError ? ' (' + st.scanError + ')' : '')];
  let n = 0;
  return ['ALSA-Geräte (Nummer = Einstellung "Gerät N"):'].concat(st.scan.map(function (x) {
    if (x.ok) return '  ' + (++n) + ') ' + x.name + ' – lässt sich öffnen';
    if (x.silent) return '  -  ' + x.name + ' – stumm (verwirft den Ton)';
    return '  -  ' + x.name + ' – ' + String(x.error || 'Fehler').replace(/^(open|set_params): /, '');
  }));
}

function log(msg) { console.log(new Date().toISOString() + ' iconix-audiod: ' + msg); }

// ---------------------------------------------------------------------------
// Dienst
// ---------------------------------------------------------------------------
function runDaemon() {
  // der Player darf auch diesem Prozess Echtzeit-Priorität geben (alsa_play.py: realtime_parent)
  process.env.ICONIX_RT_PARENT = '1';
  const clients = new Set();
  const servers = [];
  let lastLine = '', lastSent = 0, diagBusy = false;

  const engine = new E.Engine({ log: log, onStatus: function () { broadcast(false); } });

  function status() {
    const s = engine.status();
    s.op = 'status'; s.version = VERSION; s.via = 'daemon'; s.at = Date.now();
    s.sockets = servers.filter(function (x) { return x.ok; }).map(function (x) { return x.path; });
    return s;
  }
  function broadcast(onlyIfChanged) {
    const line = JSON.stringify(status()) + '\n';
    const now = E.clock.now();
    if (onlyIfChanged && line.replace(/"at":\d+,?/, '') === lastLine.replace(/"at":\d+,?/, '') && now - lastSent < 5000) return;
    lastLine = line; lastSent = now;
    clients.forEach(function (c) { try { c.write(line); } catch (e) { /* egal */ } });
  }
  // Statusdatei: nur bei Änderung schreiben, sonst alle 5 s als Lebenszeichen (die App wertet < 10 s als "läuft")
  let lastFile = '', lastFileAt = 0;
  function writeStatusFile() {
    try {
      const st = status(), cmp = JSON.stringify(Object.assign({}, st, { at: 0 })), now = E.clock.now();
      if (cmp === lastFile && now - lastFileAt < 5000) return;
      lastFile = cmp; lastFileAt = now;
      const tmp = STATUS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st));
      try { fs.chmodSync(tmp, 420 /* 0644 */); } catch (e) { /* egal */ }
      fs.renameSync(tmp, STATUS_FILE);
    } catch (e) { /* /tmp nicht beschreibbar: egal */ }
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'params') engine.params(m);
    else if (m.op === 'config') { engine.configure(m.cfg); }
    else if (m.op === 'test') { log('Testsound'); engine.test(); }
    else if (m.op === 'scan') { log('ALSA-Scan'); engine.scanDevices(function () { broadcast(false); }); }
    else if (m.op === 'testdevices') { log('Gerätetest'); engine.testDevices(); }
    else if (m.op === 'hello') log('App verbunden: ' + m.id + ' ' + m.version);
    else if (m.op === 'diag') {
      if (diagBusy) return;
      diagBusy = true;
      // In einem eigenen Prozess: Das Durchsuchen von /proc und der Konfigurationen dauert auf dem Head Unit über 300 ms –
      // im Dienst selbst setzte der Ton so lange aus.
      cp.execFile(process.execPath, [__filename, '--diag-json'], { timeout: 20000, maxBuffer: 1 << 23 }, function (e, stdout) {
      diagBusy = false;
      let lines;
      try {
        const x = JSON.parse(stdout), sx = x.smartx, r = x.audio, eps = x.endpoints;
        engine.smartx = sx;
        log('SmartX: ' + JSON.stringify(sx));
        log('Diagnose: ' + JSON.stringify(r));
        lines = ['--- Ausgabe ---', 'Gerät: ' + engine.device + ' -> ' + engine.status().resolved,
          'SmartX-Kanäle (Wiedergabe): ' + (eps.length ? eps.join(', ') : 'keine in /dev/shm')].concat(E.smartxLines(sx)).concat(['--- Allgemein (root) ---'], E.diagLines(r, []));
      } catch (x) { lines = ['Diagnose fehlgeschlagen: ' + (e && e.message || x.message)]; }
      const msg = JSON.stringify({ op: 'diag', lines: lines }) + '\n';
      clients.forEach(function (c) { try { c.write(msg); } catch (x) { /* egal */ } });
      // ALSA-Geräte erst jetzt prüfen (beim ersten Öffnen der Diagnose); das Ergebnis kommt mit dem nächsten Status
      if (!engine.scan && !engine.scanning) { engine.scanning = true; engine.scanDevices(function () { engine.scanning = false; broadcast(false); }); }
      });
    }
  }

  function listen(p) {
    const entry = { path: p, ok: false };
    servers.push(entry);
    const isPipe = p.indexOf('\\\\.\\pipe\\') === 0;
    if (!isPipe) {
      try { fs.mkdirSync(path.dirname(p), 493 /* 0755 */); } catch (e) { /* gibt es schon */ }
      try { fs.unlinkSync(p); } catch (e) { /* gab keinen */ }
    }
    const server = net.createServer(function (sock) {
      clients.add(sock);
      sock.setEncoding('utf8');
      let rx = '';
      sock.on('data', function (d) {
        rx += d;
        let i;
        while ((i = rx.indexOf('\n')) >= 0) {
          const line = rx.slice(0, i); rx = rx.slice(i + 1);
          if (!line) continue;
          try { onMessage(JSON.parse(line)); } catch (e) { /* kaputte Zeile ignorieren */ }
        }
        if (rx.length > 65536) rx = '';
      });
      sock.on('error', function () { /* close folgt */ });
      sock.on('close', function () { clients.delete(sock); });
      try { sock.write(JSON.stringify(status()) + '\n'); } catch (e) { /* egal */ }
    });
    server.on('error', function (e) { log('Socket ' + p + ': ' + e.message); });
    server.listen(p, function () {
      entry.ok = true;
      if (!isPipe) { try { fs.chmodSync(p, 438 /* 0666: die App läuft ohne Root */); } catch (e) { log('chmod ' + p + ': ' + e.message); } }
      log('lauscht auf ' + p);
    });
    entry.server = server;
  }

  SOCKETS.forEach(listen);
  engine.start();
  // Kein ALSA-Scan beim Start: Er öffnet bis zu 80 Geräte (Python + libasound) und bremste das Hochfahren des Head
  // Units. Gescannt wird erst, wenn ihn jemand braucht: Audio-Diagnose, "Geräte testen" oder Ausgabegerät "Gerät N".
  const st = engine.status();
  log('Version ' + VERSION + ' – ' + (st.players.length ? 'Ausgabe: ' + st.players.join(', ') : st.error));

  setInterval(function () { broadcast(true); }, 1000);
  writeStatusFile();
  setInterval(writeStatusFile, 2000);

  function shutdown() {
    log('beende');
    engine.stop();
    servers.forEach(function (s) {
      try { s.server.close(); } catch (e) { /* egal */ }
      if (s.path.indexOf('\\\\.\\pipe\\') !== 0) { try { fs.unlinkSync(s.path); } catch (e) { /* egal */ } }
    });
    try { fs.unlinkSync(STATUS_FILE); } catch (e) { /* egal */ }
    setTimeout(function () { process.exit(0); }, 400);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', function (e) { log('Fehler: ' + (e && e.stack || e)); });
}

// ---------------------------------------------------------------------------
// Werkzeuge
// ---------------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && process.argv[i + 1].indexOf('--') !== 0 ? process.argv[i + 1] : def;
}

function renderWav(file) {
  const RATE = E.RATE;
  const profile = arg('--profile', Profiles.DEFAULT);
  const seconds = Number(arg('--seconds', '9'));
  const synth = new Synth(RATE);
  synth.configure({
    profile: profile, volume: Number(arg('--volume', '0.8')),
    intensity: Number(arg('--intensity', '0.7'))
  });
  synth._setProfile(Profiles.get(profile).id); synth.pending = null;
  const frames = Math.floor(seconds * RATE);
  const pcm = Buffer.alloc(frames * 4);
  const block = 512, f32 = new Float32Array(block * 2);
  let peak = 0;
  for (let pos = 0; pos < frames; pos += block) {
    const n = Math.min(block, frames - pos);
    synth.setParams(E.sweepAt(pos / RATE, synth.cfg));
    peak = Math.max(peak, synth.render(f32, n));
    E.toPcm(f32, n).copy(pcm, pos * 4);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
  console.log(file + ': ' + Profiles.get(profile).name + ', ' + seconds + ' s, Spitze ' + peak.toFixed(3));
}

function playTest() {
  const engine = new E.Engine({ log: log });
  engine.configure({ profile: arg('--profile', Profiles.DEFAULT), volume: 0.7 });
  if (!engine.status().players.length) { console.error('Kein Abspielprogramm: ' + engine.status().error); process.exit(1); }
  engine.test();
  engine.start();
  setTimeout(function () { engine.stop(); setTimeout(function () { process.exit(0); }, 500); }, 9500);
}

if (require.main === module) {
  if (process.argv.indexOf('--probe') >= 0) {
    const list = E.candidates();
    console.log(list.length ? list.map(function (b) { return b.name + '  ' + b.path + ' ' + b.argv.join(' '); }).join('\n') : 'Kein Abspielprogramm gefunden.');
  } else if (process.argv.indexOf('--diag-json') >= 0) {
    process.stdout.write(JSON.stringify({ smartx: E.probeSmartx(), audio: E.probeAudio(), endpoints: E.smartxEndpoints() }));
  } else if (process.argv.indexOf('--wav') >= 0) {
    renderWav(arg('--wav', 'iconix.wav'));
  } else if (process.argv.indexOf('--play-test') >= 0) {
    playTest();
  } else {
    runDaemon();
  }
}

module.exports = { sweepAt: E.sweepAt, toPcm: E.toPcm, candidates: E.candidates };
