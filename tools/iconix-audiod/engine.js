'use strict';
/*
 * Sound Drive – Audio-Kern (nur Node, Node-8-kompatibel)
 *
 * Synthese (synth.js) + Abspielprogramm (aplay/pacat/pw-cat/gst) + Taktgeber. Wird genutzt von:
 *   - tools/iconix-audiod/iconix-audiod.js  (Root-Dienst, Socket-Server)
 *   - apps/iconix_sounds/audio_link.js      (Rückfall: Ton direkt aus der App, wenn der Dienst fehlt)
 * Kanonische Quelle: shared/engine.js – Kopien erzeugt `npm run sync`.
 *
 *   const eng = new Engine({ log: fn, onStatus: st => ... });
 *   eng.configure(cfg); eng.params({ rpm, load, speed, overrun }); eng.test(); eng.start(); eng.stop();
 *
 * Umgebungsvariablen: ICONIX_RATE, ICONIX_LEAD_MS, ICONIX_BUFFER_US, ICONIX_PLAYER, ICONIX_DEVICE
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Synth = require('./synth');

// Uhr für Abstände und Fristen: läuft gleichmäßig weiter, auch wenn das Head Unit die Uhrzeit stellt (sonst gälten die
// Fahrdaten bei einem Sprung als veraltet und der Ton setzte kurz aus). Startwert beliebig, aber groß (0 heißt "nie").
const clock = { now: function () { const t = process.hrtime(); return 1e9 + t[0] * 1000 + Math.floor(t[1] / 1e6); } };

// Synthese-Rate: 48 kHz wie die SmartX-Kanäle des Head Units (24-kHz-Kanäle bekommen je 2 Frames gemittelt)
const RATE = Number(process.env.ICONIX_RATE) || 48000;
const TICK_MS = 10;          // 100 Wakeups/s, solange Ton läuft – kleine Blöcke erlauben knappen Vorlauf
const IDLE_TICK_MS = 200;    // ohne Ton nur 5 Wakeups/s; neue Fahrzeugdaten oder Testsound wecken sofort
// so viel Audio liegt höchstens vor (muss > TICK_MS + Jitter des Head Units sein). 160 ms gibt Reserve,
// wenn Node auf dem Head Unit kurz hängt (GC, andere Apps) – sonst knackt/stottert es (Underrun).
const LEAD_MS = Number(process.env.ICONIX_LEAD_MS) || 160;
// Mit Rückmeldung des Players (alsa_play.py meldet gespielte Frames): so viel Ton steht höchstens an
// (ALSA-Puffer + Pipe). Das ist die Verzögerung zwischen Fahrzeugdaten und Lautsprecher.
// Untergrenze 60 ms (siehe FB_LEAD_START für den Start und die Anpassung).
const FB_LEAD_MS = Number(process.env.ICONIX_FB_LEAD_MS) || 60;
const FB_LEAD_MAX = 200;
// Start großzügig (Head Unit beim Hochfahren ausgelastet -> sonst Aussetzer/Quietschen), danach alle 10 s
// ohne Aussetzer 10 ms knapper bis zur Untergrenze; bei einem Aussetzer sofort +30 ms.
// Die Untergrenze merkt sich, wo es zu knapp war (Vorlauf beim Aussetzer + 20 ms): Früher ging es nach jedem Aussetzer
// wieder bis 60 ms hinunter – bis zum nächsten, also rund alle 30 s einer (62 in 33 min). Sie sinkt nur alle
// FB_FLOOR_MS ohne Aussetzer um 10 ms.
const FB_LEAD_START = 100;
const FB_FLOOR_MS = 600000;
const BUFFER_US = Number(process.env.ICONIX_BUFFER_US) || 200000; // Puffer des Abspielprogramms
const STALE_MS = 1500;       // ohne Daten -> ausblenden
const IDLE_STOP_MS = Number(process.env.ICONIX_IDLE_STOP_MS) || 30000;  // so lange still -> Abspielprogramm beenden (gibt das Audiogerät frei); kurz = Neustart bei jedem Halt
const MAX_CHUNK = 4096;
// SmartX: Puffer des Kanals. Zählt zum Vorlauf (kein zusätzlicher Verzug), gibt dem Player aber Luft; nimmt der Kanal
// ihn nicht, gilt der kleinere (alsa_play.py)
const SMARTX_BUFFER_US = Number(process.env.ICONIX_SMARTX_BUFFER_US) || 60000;
const SMARTX_RETRY_MS = 3000; // SmartX-Kanal ließ sich nicht öffnen -> so oft erneut probieren

// ---------------------------------------------------------------------------
// Abspielprogramme
// ---------------------------------------------------------------------------
const BACKENDS = [
  {
    name: 'aplay', bin: 'aplay',
    args: function (r) {
      const a = ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(r), '-c', '2', '--buffer-time=' + BUFFER_US, '--period-time=' + Math.round(BUFFER_US / 4)];
      if (process.env.ICONIX_DEVICE) a.push('-D', process.env.ICONIX_DEVICE);
      a.push('-');
      return a;
    }
  },
  {
    name: 'pacat', bin: 'pacat',
    args: function (r) { return ['--playback', '--raw', '--format=s16le', '--rate=' + r, '--channels=2', '--latency-msec=' + Math.round(BUFFER_US / 1000)]; }
  },
  {
    name: 'pw-cat', bin: 'pw-cat',
    args: function (r) { return ['--playback', '--format', 's16', '--rate', String(r), '--channels', '2', '-']; }
  },
  {
    name: 'paplay', bin: 'paplay',
    args: function (r) { return ['--raw', '--format=s16le', '--rate=' + r, '--channels=2', '--latency-msec=' + Math.round(BUFFER_US / 1000)]; }
  },
  {
    name: 'sox', bin: 'play',
    args: function (r) { return ['-q', '-t', 'raw', '-r', String(r), '-e', 'signed', '-b', '16', '-c', '2', '-']; }
  },
  {
    name: 'ffplay', bin: 'ffplay',
    args: function (r) { return ['-nodisp', '-loglevel', 'error', '-f', 's16le', '-ar', String(r), '-ac', '2', '-i', '-']; }
  },
  {
    name: 'gstreamer', bin: 'gst-launch-1.0',
    args: function (r) {
      return ['-q', 'fdsrc', 'fd=0', '!', 'rawaudioparse', 'format=pcm', 'pcm-format=s16le',
        'sample-rate=' + r, 'num-channels=2', '!', 'audioconvert', '!', 'audioresample', '!', 'autoaudiosink'];
    }
  }
];

function findBin(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter)
    .concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin']);
  for (let i = 0; i < dirs.length; i++) {
    if (!dirs[i]) continue;
    const p = path.join(dirs[i], bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* weiter */ }
  }
  return null;
}

// Python finden: PATH, dann die Store-Tools unter /var/opt (mgu-python bringt Python 3.12 mit)
let pythonCache;
function findPython() {
  // nur einen Treffer merken: beim Hochfahren kann Python noch fehlen, dann beim nächsten Versuch wieder suchen
  if (pythonCache) return pythonCache;
  if (process.env.ICONIX_PYTHON) { pythonCache = process.env.ICONIX_PYTHON; return pythonCache; }
  const names = ['python3', 'python3.12', 'python'];
  for (let i = 0; i < names.length; i++) { const p = findBin(names[i]); if (p) { pythonCache = p; return p; } }
  const rels = ['current/bin/python3', 'current/bin/python3.12', 'current/python3', 'current/python/bin/python3',
    'current/usr/bin/python3', 'bin/python3'];
  let dirs = [];
  try { dirs = fs.readdirSync('/var/opt'); } catch (e) { dirs = []; }
  dirs.sort(function (a, b) { return (/python/.test(b) ? 1 : 0) - (/python/.test(a) ? 1 : 0); });
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < rels.length; j++) {
      const p = path.join('/var/opt', dirs[i], rels[j]);
      try { fs.accessSync(p, fs.constants.X_OK); pythonCache = p; return p; } catch (e) { /* weiter */ }
    }
  }
  return null;
}

function hasLibasound() {
  const dirs = ['/usr/lib', '/lib', '/usr/lib64', '/lib64', '/usr/lib/x86_64-linux-gnu'];
  for (let i = 0; i < dirs.length; i++) { if (fs.existsSync(path.join(dirs[i], 'libasound.so.2'))) return true; }
  return false;
}

const ALSA_SCRIPT = path.join(__dirname, 'alsa_play.py');
// Geräte, die "auto" der Reihe nach probiert (das erste, das sich öffnen lässt, gewinnt)
const AUTO_DEVICES = ['default', 'plughw:0,0', 'plughw:0,1'];

// ---------------------------------------------------------------------------
// SmartX-Kanäle (Intel IAS SmartXbar): jeder Kanal hat in /dev/shm "smartx_<Kanal>_p_connection".
// Geschrieben wird über ALSA "plug:smartx:<Kanal>"; hörbar erst, wenn der Audiomanager die Quelle verbindet
// (macht die App, car_route.js). Format steht im Namen: _CF_24_ = 24 kHz, MONO = 1 Kanal.
// ---------------------------------------------------------------------------
function smartxEndpoints() {
  let names = [];
  try { names = fs.readdirSync('/dev/shm'); } catch (e) { names = []; }
  const out = [];
  names.forEach(function (n) {
    const m = /^smartx_(.+)_p_connection$/.exec(n);
    if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
  });
  return out.sort();
}
function isSmartx(d) { return /(^|:)smartx:/.test(d || ''); }
/** "smartx:<Name>" -> "plug:smartx:<Kanal>" (exakter Kanal oder erster, der mit <Name>_ beginnt). */
function resolveSmartx(d, list) {
  if (!/^smartx:/.test(d || '')) return d;
  const want = d.slice(7);
  list = list || smartxEndpoints();
  let hit = list.indexOf(want) >= 0 ? want : null;
  if (!hit) {
    const base = want.replace(/_CF_\d+.*$/, '');
    hit = list.filter(function (n) { return n.indexOf(base + '_') === 0 || n === base; })[0] || null;
  }
  if (!hit) hit = /_CF_\d+/.test(want) ? want : want + '_CF_48_STEREO'; // unbekannt: so probieren
  return 'plug:smartx:' + hit;
}
/** Ausgabeformat eines Geräts: SmartX-Kanäle nach Namen, sonst Synthese-Rate Stereo. */
function formatOf(dev) {
  const m = /smartx:.*_CF_(\d+)/.exec(dev || '');
  const k = m ? Number(m[1]) : 0;
  const rate = k === 24 ? 24000 : (k === 16 ? 16000 : RATE);
  return { rate: rate, ch: /smartx:.*MONO/i.test(dev || '') ? 1 : 2 };
}

/**
 * Abspielwege in Reihenfolge. opts.device: ALSA-Gerät für den Python-Player ('auto' = AUTO_DEVICES).
 */
function candidates(opts) {
  opts = opts || {};
  const out = [];
  if (process.env.ICONIX_PLAYER) {
    // "cmd arg arg" oder JSON-Array '["/pfad mit leerzeichen/cmd","arg"]'
    const raw = process.env.ICONIX_PLAYER.trim();
    let parts;
    try { parts = raw.charAt(0) === '[' ? JSON.parse(raw) : null; } catch (e) { parts = null; }
    if (!parts) parts = raw.split(/\s+/).filter(Boolean);
    parts = parts.map(function (s) { return String(s).replace('{rate}', String(RATE)); });
    out.push({ name: 'custom', path: parts[0], argv: parts.slice(1) });
  }
  // ALSA über Python + ctypes (das Head Unit hat libasound und mgu-python, aber kein aplay)
  const py = findPython();
  // SmartX-Kanal: nur genau dieser Weg, kein Rückfall auf andere Geräte (würde fremde Wiedergabe stören)
  if (isSmartx(opts.device) && !process.env.ICONIX_PLAYER) {
    if (!py || !fs.existsSync(ALSA_SCRIPT)) return out;
    const f = formatOf(opts.device);
    out.push({ name: 'alsa:' + opts.device, path: py, argv: [ALSA_SCRIPT, 'play', opts.device, String(f.rate), String(SMARTX_BUFFER_US), String(f.ch)],
      device: opts.device, fmt: f, smartx: true, pos: true });
    return out;
  }
  if (py && fs.existsSync(ALSA_SCRIPT) && (hasLibasound() || process.env.ICONIX_ALSA_FORCE)) {
    const dev = opts.device && opts.device !== 'auto' ? [opts.device] : AUTO_DEVICES;
    dev.forEach(function (d) {
      // "name@/pfad/zur/alsa.conf" = Gerät aus BMWs eigener ALSA-Konfiguration (ALSA_CONFIG_PATH)
      const at = d.indexOf('@/');
      const name = at > 0 ? d.slice(0, at) : d, cfg = at > 0 ? d.slice(at + 1) : null;
      out.push({ name: 'alsa:' + d, path: py, argv: [ALSA_SCRIPT, 'play', name, String(RATE), String(BUFFER_US)], device: d, pos: true,
        env: cfg ? { ALSA_CONFIG_PATH: cfg } : null });
    });
  }
  BACKENDS.forEach(function (b) {
    const p = findBin(b.bin);
    if (p) out.push({ name: b.name, path: p, argv: b.args(RATE) });
  });
  return out;
}

/**
 * ALSA-Geräte auflisten und testweise öffnen (Python-Skript "list").
 * extra: zusätzliche Gerätenamen (z. B. aus BMWs ALSA-Konfiguration); cfg: ALSA_CONFIG_PATH oder null.
 * cb(err, { devices: [{ name, desc, ok, silent, error }] })
 */
function scanAlsa(extra, cfg, cb) {
  if (typeof extra === 'function') { cb = extra; extra = []; cfg = null; }
  const py = findPython();
  if (!py) return cb(new Error('kein Python gefunden'));
  if (!fs.existsSync(ALSA_SCRIPT)) return cb(new Error('alsa_play.py fehlt'));
  const env = cfg ? Object.assign({}, process.env, { ALSA_CONFIG_PATH: cfg }) : process.env;
  cp.execFile(py, [ALSA_SCRIPT, 'list'].concat(extra || []), { timeout: 30000, maxBuffer: 1 << 20, env: env }, function (e, stdout, stderr) {
    let res = null;
    try { res = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (x) { res = null; }
    if (!res) return cb(new Error((e && e.message) || String(stderr).trim().slice(0, 160) || 'keine Antwort'));
    cb(null, res);
  });
}

// ---------------------------------------------------------------------------
// PCM-Ausgabe über ein Kindprozess-Abspielprogramm
// ---------------------------------------------------------------------------
function Output(onState, log, opts) {
  this.onState = onState || function () {};
  this.log = log || function () {};
  this.opts = opts || {};
  this.list = candidates(this.opts);
  this.bad = {};
  this.child = null;
  this.backend = null;
  this.blocked = false;
  this.underruns = 0; this.xruns = 0; this.perMs = null;
  this.error = this.list.length ? null : (isSmartx(this.opts.device) ? 'Python/alsa_play.py fehlt für SmartX' : 'kein Abspielprogramm gefunden – siehe Audio-Diagnose');
  this.lastErr = '';
  this.fmt = { rate: RATE, ch: 2 };
  this.played = null;
  this.sent = 0; this.opened = false; this.openMs = null;
}

Output.prototype.start = function () {
  if (this.child) return true;
  const self = this, log = this.log;
  const b = this.list.filter(function (x) { return !self.bad[x.name]; })[0];
  if (!b) {
    this.error = this.list.length ? 'alle Abspielprogramme fehlgeschlagen' + (this.lastErr ? ': ' + this.lastErr : '') : this.error;
    this.onState();
    return false;
  }
  log('starte ' + b.name + ' ' + b.path + ' ' + b.argv.join(' '));
  let child;
  try {
    child = cp.spawn(b.path, b.argv, { stdio: ['pipe', b.pos ? 'pipe' : 'ignore', 'pipe'], env: b.env ? Object.assign({}, process.env, b.env) : process.env });
  } catch (e) {
    this.bad[b.name] = true; this.lastErr = e.message; this.onState();
    return false;
  }
  const startedAt = clock.now();
  this.child = child;
  this.backend = b.name;
  this.fmt = b.fmt || { rate: RATE, ch: 2 };
  this.dec = new Decimator(Math.round(RATE / (this.fmt.rate || RATE)));
  this.blocked = false;
  this.error = null;
  // gespielte Frames (Ausgaberate) laut Player; null = Player meldet nichts -> Takt nach Uhr
  this.played = b.pos ? 0 : null;
  this.startedAt = startedAt; this.gotPos = false;
  // Das erste Öffnen eines SmartX-Kanals nach dem Hochfahren kann lange dauern (andere maßen bis 52 s)
  this.opened = !b.pos; this.openMs = null; this.sent = 0;
  if (b.pos && child.stdout) {
    let rest = '';
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', function (d) {
      if (self.child !== child) return;
      const lines = (rest + d).split('\n'); rest = lines.pop();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].charAt(0) === 'P') { const v = Number(lines[i].slice(2)); if (isFinite(v)) { self.played = v; self.gotPos = true; self._open(); break; } }
      }
    });
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (d) {
    const line = String(d).trim().split('\n').pop();
    if (!line) return;
    // aplay meldet Aussetzer als "underrun!!! (at least X ms long)" – zählen statt als Fehler werten
    if (/underrun|xrun/i.test(line)) {
      self.underruns++;
      if (!/Stille nachgelegt/.test(line)) self.xruns++;   // Puffer der Soundkarte leer (Player kam zu spät), sonst fehlte Nachschub
      if (self.underruns <= 5 || self.underruns % 50 === 0) log(b.name + ': ' + line + ' (#' + self.underruns + ')');
      return;
    }
    const mb = /Puffer (\d+) ms/.exec(line);
    if (mb) { if (self.child === child) self._open(); const mp = /Periode (\d+) ms/.exec(line); self.perMs = mp ? Number(mp[1]) : null; self.bufMs = Number(mb[1]); const mr = /Echtzeit (.*)$/.exec(line); self.rt = mr ? mr[1] : null; log(b.name + ': ' + line); return; }
    self.lastErr = line.slice(0, 120); log(b.name + ': ' + line);
  });
  child.stdin.on('error', function () { /* EPIPE -> exit folgt */ });
  child.stdin.on('drain', function () { self.blocked = false; });
  // ließ sich das Programm gar nicht starten, kommt nur 'error' und kein 'exit' – sonst gälte es für immer als laufend
  child.on('error', function (e) { self.lastErr = e.message; if (!child.pid) gone('-', e.code || e.message); });
  child.on('exit', gone);
  function gone(code, sig) {
    log(b.name + ' beendet, code ' + code + ' signal ' + sig);
    if (self.child === child) {
      self.child = null;
      self.backend = null;
      if (!self.stopping && clock.now() - startedAt < 3000) {
        self.bad[b.name] = true; // startet nicht -> nächstes Programm probieren
        self.error = b.name + ' fehlgeschlagen' + (self.lastErr ? ': ' + self.lastErr : '');
      }
      self.stopping = false;
      self.onState();
    }
  }
  this.onState();
  return true;
};

/** Kanal ist offen: merken, wie lange es gedauert hat. */
Output.prototype._open = function () {
  if (this.opened) return;
  this.opened = true; this.openedAt = clock.now(); this.openMs = this.openedAt - this.startedAt;
  if (this.openMs > 3000) this.log(this.backend + ': Kanal öffnete erst nach ' + this.openMs + ' ms');
  this.onState();
};

Output.prototype.stop = function () {
  if (!this.child || this.stopping) return;
  this.stopping = true;
  try { this.child.stdin.end(); } catch (e) { /* egal */ }
  const c = this.child;
  setTimeout(function () { try { c.kill('SIGTERM'); } catch (e) { /* egal */ } }, 300);
};

/** Frames (in Synthese-Rate), die zusammen ein Ausgabe-Frame ergeben (2 bei 24-kHz-Kanälen). */
Output.prototype.step = function () { return Math.max(1, Math.round(RATE / (this.fmt.rate || RATE))); };

Output.prototype.write = function (buf) {
  if (!this.child || this.blocked) return false;
  this.sent += buf.length / (2 * (this.fmt.ch === 1 ? 1 : 2));   // Frames in Ausgaberate, seit dem Start dieses Players
  const ok = this.child.stdin.write(buf);
  if (!ok) this.blocked = true;
  return true;
};

// Float32 interleaved -> S16LE Buffer (Int16Array-Sicht statt writeInt16LE pro Sample;
// x86 und ARM des Head Units sind little-endian). Buffer.alloc liefert immer byteOffset 0.
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function toPcm(f32, frames) {
  const n = frames * 2;
  const buf = Buffer.alloc(n * 2);
  if (LITTLE) {
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, n);
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      i16[i] = v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      buf.writeInt16LE(v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0), i * 2);
    }
  }
  return buf;
}

/**
 * Dezimierer für Kanäle mit niedrigerer Rate (z. B. 48 -> 24 kHz): Tiefpass 4. Ordnung (Butterworth) bei
 * 42 % der Zielrate, dann jedes step-te Sample. Ohne diesen Filter fallen Anteile oberhalb der halben
 * Zielrate als falsche, hohe Töne zurück (Aliasing). Zustand bleibt über Blöcke erhalten (je Kanal).
 */
function Decimator(step) {
  this.step = Math.max(1, step | 0);
  this.ph = 0;
  const fc = RATE / this.step * 0.42;
  this.f = [0, 1].map(function () { return [new Synth.Biquad().set('lp', fc, 0.5412, RATE), new Synth.Biquad().set('lp', fc, 1.3066, RATE)]; });
}

/**
 * Float32 Stereo (Synthese-Rate) -> S16LE im Ausgabeformat (Rate, 1 oder 2 Kanäle). dec: Decimator mit
 * Zustand (sonst ein neuer, dann ohne Übergang zwischen Blöcken).
 */
function toPcmFmt(f32, frames, fmt, dec) {
  const step = Math.max(1, Math.round(RATE / (fmt.rate || RATE))), ch = fmt.ch === 1 ? 1 : 2;
  if (step === 1 && ch === 2) return toPcm(f32, frames);
  if (!dec || dec.step !== step) dec = new Decimator(step);
  const m = Math.floor((frames + dec.ph) / step);
  const buf = Buffer.alloc(m * ch * 2);
  const q = function (v) { return v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0); };
  const fL = dec.f[0], fR = dec.f[1];
  let j = 0, ph = dec.ph;
  for (let i = 0; i < frames; i++) {
    let l = f32[i * 2], r = f32[i * 2 + 1];
    if (ch === 1) { l = (l + r) * 0.5; if (step > 1) l = fL[1].run(fL[0].run(l)); }
    else if (step > 1) { l = fL[1].run(fL[0].run(l)); r = fR[1].run(fR[0].run(r)); }
    if (++ph >= step) {
      ph = 0;
      if (j < m) {
        if (ch === 1) buf.writeInt16LE(q(l), j * 2);
        else { buf.writeInt16LE(q(l), j * 4); buf.writeInt16LE(q(r), j * 4 + 2); }
      }
      j++;
    }
  }
  dec.ph = ph;
  return j === m ? buf : buf.slice(0, Math.min(j, m) * ch * 2);
}

// Test-Sweep: Leerlauf -> Vollgas bis Abregeldrehzahl -> Schub -> Teillast
function sweepAt(t, cfg) {
  const idle = cfg.carIdle || 800, red = cfg.carRedline || 4800;
  if (t < 0.8) return { rpm: idle, load: 0.05, speed: 0, overrun: false };
  if (t < 4.0) { const x = (t - 0.8) / 3.2; return { rpm: idle + (red - idle) * x, load: 1, speed: 120 * x, overrun: false }; }
  if (t < 5.5) { const x = (t - 4.0) / 1.5; return { rpm: red - (red - 1500) * x, load: 0, speed: 120 - 20 * x, overrun: true }; }
  if (t < 7.5) { const x = (t - 5.5) / 2; return { rpm: 1500 + 2000 * x, load: 0.5, speed: 100 + 20 * x, overrun: false }; }
  const x = Math.min(1, (t - 7.5) / 1.5);
  return { rpm: 3500 - (3500 - idle) * x, load: 0, speed: 120 * (1 - x), overrun: x < 0.9 };
}

// Geräte, die sich öffnen lassen und nicht stumm sind ("null" schluckt den Ton)
function isSilent(d) { return !!d.silent || /^null(@|:|$)/.test(d.name); }
function usable(scan) {
  return ((scan && scan.devices) || []).filter(function (x) { return x.ok && !isSilent(x); });
}

// ---------------------------------------------------------------------------
// Engine: Synth + Ausgabe + Taktgeber
// ---------------------------------------------------------------------------
function Engine(opts) {
  opts = opts || {};
  const self = this;
  this.log = opts.log || function () {};
  this.onStatus = opts.onStatus || function () {};
  this.synth = new Synth(RATE);
  this.device = opts.device || process.env.ICONIX_ALSA_DEVICE || 'auto';  // ALSA-Gerät oder 'auto' / 'scanN'
  this.scan = null;      // Ergebnis von scanAlsa
  this.devTest = null;   // laufender Gerätetest { list, i, until, prev }
  this.out = new Output(function () { self._changed(); }, this.log, { device: this._resolve(this.device) });
  this.wantSound = false; this.lastRetry = 0;
  this.lastParams = 0;
  this.testUntil = 0; this.testStart = 0;
  this.silentSince = 0;
  this.t0 = 0; this.written = 0;
  this.lastTick = clock.now(); this.late = 0; this.gapMs = 0;   // verspätete Takte, längste Pause zwischen zwei Takten
  this.fbFloor = FB_LEAD_MS; this.fbFloorAt = 0;
  this.f32 = new Float32Array(MAX_CHUNK * 2);
  this.timer = null;
}

Engine.prototype.configure = function (cfg) {
  this.synth.configure(cfg);
  // Testsound hat "Stumm" kurz aufgehoben, und jetzt schaltet jemand den Ton an: nach dem Test nicht wieder stumm
  if (this._testUnmuted && this.synth.cfg.enabled) this._testUnmuted = false;
  if (cfg && cfg.device && cfg.device !== this.device && !this.devTest) this.setDevice(cfg.device);
  this._changed();
};

// 'scanN' = das N-te Gerät, das sich beim Scan öffnen ließ (so in der Diagnose nummeriert)
Engine.prototype._resolve = function (d) {
  if (/^smartx:/.test(d || '')) return resolveSmartx(d);
  const m = /^scan(\d+)$/.exec(d || '');
  if (!m) return d || 'auto';
  const ok = usable(this.scan);
  const hit = ok[Number(m[1]) - 1];
  return hit ? hit.name : 'auto';
};

Engine.prototype.setDevice = function (d) {
  const self = this;
  // "Gerät N" braucht den ALSA-Scan – der läuft nicht mehr beim Start, also hier bei Bedarf
  if (/^scan\d+$/.test(d || '') && !this.scan) {
    if (!this.scanning) { this.scanning = true; this.scanDevices(function () { self.scanning = false; self.setDevice(d); }); }
    this.device = d;
    return;
  }
  this.device = d || 'auto';
  const old = this.out;
  this.out = new Output(function () { self._changed(); }, this.log, { device: this._resolve(this.device) });
  this.out.underruns = old.underruns || 0; this.out.xruns = old.xruns || 0;
  old.stop();
  this.log('Ausgabegerät: ' + this.device + ' -> ' + this._resolve(this.device));
  this._changed();
};

Engine.prototype.scanDevices = function (cb) {
  const self = this;
  // schon von der Diagnose ermittelt (eigener Prozess)? sonst hier – das dauert und unterbricht kurz den Ton
  let sx = this.smartx || null;
  if (!sx) { try { sx = probeSmartx(); } catch (e) { sx = null; } this.smartx = sx; }
  const extra = sx ? sx.pcmNames : [];
  // Durchläufe: normale ALSA-Konfiguration, dann jede ALSA_CONFIG_PATH der BMW-Audio-Prozesse
  const runs = [null].concat(sx ? sx.alsaConfigEnv : []);
  const all = [];
  let firstErr = null;
  const next = function (i) {
    if (i >= runs.length) return done();
    scanAlsa(extra, runs[i], function (err, res) {
      if (err) { if (!firstErr) firstErr = err.message; }
      else (res.devices || []).forEach(function (d) {
        if (runs[i]) d.name = d.name + '@' + runs[i];
        all.push(d);
      });
      next(i + 1);
    });
  };
  const done = function () {
    self.scan = all.length ? { devices: all } : { devices: [], error: firstErr || 'keine Geräte' };
    self.log('ALSA-Scan: ' + JSON.stringify(self.scan));
    // ein Gerät "scanN" erst jetzt auflösbar
    if (/^scan/.test(self.device)) self.setDevice(self.device);
    self._changed();
    if (cb) cb(self.scan);
  };
  next(0);
};

/** Spielt den Testsound nacheinander auf jedem Gerät, das sich öffnen ließ (je 4 s). */
Engine.prototype.testDevices = function () {
  const self = this;
  const run = function () {
    const list = usable(self.scan).map(function (x) { return x.name; });
    if (!list.length) { self.log('Gerätetest: kein Gerät ließ sich öffnen'); self._changed(); return; }
    self.devTest = { list: list, i: -1, prev: self.device };
    self._nextTestDevice();
  };
  if (this.scan) run(); else this.scanDevices(run);
};

Engine.prototype._nextTestDevice = function () {
  const t = this.devTest;
  if (!t) return;
  t.i++;
  if (t.i >= t.list.length) {
    const prev = t.prev;
    this.devTest = null;
    this.testUntil = 0;
    this.setDevice(prev);
    return;
  }
  this.setDevice(t.list[t.i]);
  this.testStart = clock.now(); this.testUntil = this.testStart + 4000;
  t.until = this.testUntil;
  this._changed();
};
Engine.prototype.params = function (p) { this.synth.setParams(p); this.lastParams = clock.now(); this.wake(); };
Engine.prototype.test = function () {
  this.testStart = clock.now(); this.testUntil = this.testStart + 9000;
  // nach einem Fehler beim Testsound alle Abspielprogramme erneut probieren
  this.out.bad = {};
  this.out.list = candidates({ device: this._resolve(this.device) });
  this.out.error = this.out.list.length ? null : (isSmartx(this.out.opts.device) ? 'Python/alsa_play.py fehlt für SmartX' : 'kein Abspielprogramm gefunden – siehe Audio-Diagnose');
  this._changed();
  this.wake();
};

Engine.prototype.status = function () {
  const out = this.out;
  return {
    ok: !out.error,
    backend: out.backend || (out.list[0] && !out.error ? out.list[0].name : null),
    rate: RATE, playing: !!out.child && out.opened !== false, opening: !!out.child && out.opened === false, openMs: out.openMs, error: out.error, profile: this.synth.pending || this.synth.cfg.profile,
    underruns: out.underruns || 0, xruns: out.xruns || 0, perMs: out.child ? out.perMs : null, late: this.late, gapMs: this.gapMs, bufMs: out.child ? out.bufMs || null : null, rt: out.child ? out.rt || null : null, ducked: !!this.synth.cfg.duck, leadMs: out.played != null && out.child ? (this.fbLead || FB_LEAD_MS) : LEAD_MS,
    players: out.list.map(function (b) { return b.name; }),
    device: this.device, resolved: out.opts.device, python: findPython(),
    wants: !!this.wantSound, outRate: out.fmt.rate, outCh: out.fmt.ch,
    scan: this.scan ? (this.scan.devices || []).map(function (d) { return { name: d.name, ok: d.ok && !isSilent(d), silent: isSilent(d), error: d.error }; }) : null,
    scanError: this.scan && this.scan.error,
    devTest: this.devTest ? { device: this.devTest.list[this.devTest.i], i: this.devTest.i + 1, n: this.devTest.list.length } : null
  };
};

Engine.prototype._changed = function () { try { this.onStatus(this.status()); } catch (e) { /* egal */ } };

Engine.prototype.start = function () {
  if (this.timer || this.running) return;
  this.running = true;
  this.lastTick = clock.now();
  this._loop();
};

// Taktgeber: 10 ms, solange Ton läuft oder gewünscht ist, sonst 200 ms (spart im Stand/ohne Daten fast alles)
Engine.prototype._busy = function () {
  return !!(this.out.child || this.wantSound || this.devTest || clock.now() < this.testUntil);
};
Engine.prototype._loop = function () {
  const self = this;
  this.timer = null;
  if (!this.running) return;
  this._tick();
  this.timer = setTimeout(function () { self._loop(); }, this._busy() ? TICK_MS : IDLE_TICK_MS);
};
/** Sofort einen Takt auslösen, wenn der Taktgeber gerade im langsamen Modus ist. */
Engine.prototype.wake = function () {
  if (!this.running || this._busy()) return;
  if (this.timer) clearTimeout(this.timer);
  this._loop();
};

Engine.prototype.stop = function () {
  this.running = false;
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  this.out.stop();
};

Engine.prototype._tick = function () {
  const now = clock.now(), synth = this.synth, out = this.out;
  // zählt Wakeups, die so spät kamen, dass der Vorlauf aufgebraucht war
  if (out.child && this.ticking) this.gapMs = Math.max(this.gapMs, now - this.lastTick);
  this.ticking = !!out.child;
  if (out.child && now - this.lastTick > (out.played != null ? (this.fbLead || FB_LEAD_START) : LEAD_MS)) this.late++;
  this.lastTick = now;
  if (this.devTest && now >= this.devTest.until) this._nextTestDevice();
  const testing = now < this.testUntil;
  if (testing) {
    synth.setParams(sweepAt((now - this.testStart) / 1000, synth.cfg));
    synth.stale = false;
  } else {
    synth.stale = now - this.lastParams > STALE_MS;
  }
  // Testsound auch bei "Stumm" hörbar machen
  const wantSound = (synth.cfg.enabled || testing) && (!synth.stale || testing);
  if (testing && !synth.cfg.enabled) { synth.cfg.enabled = true; this._testUnmuted = true; }
  if (!testing && this._testUnmuted) { synth.cfg.enabled = false; this._testUnmuted = false; }

  this.wantSound = wantSound;
  if (wantSound) this.silentSince = 0;
  else if (!this.silentSince) this.silentSince = now;

  // SmartX-Kanal ließ sich nicht öffnen (z. B. noch nicht da): regelmäßig neu auflösen und erneut probieren
  if (wantSound && !out.child && out.error && isSmartx(out.opts.device) && now - this.lastRetry > SMARTX_RETRY_MS) {
    this.lastRetry = now;
    if (this._resolve(this.device) !== out.opts.device) { this.setDevice(this.device); return; }
    out.bad = {}; out.list = candidates(out.opts);
    if (out.list.length) out.error = null;
  }
  if (wantSound && !out.child && !out.error) {
    if (out.start()) { this.t0 = now; this.written = 0; }
  }
  if (out.child && !out.stopping && this.silentSince && now - this.silentSince > IDLE_STOP_MS && synth.gain < 0.001) {
    this.log('still – gebe Audiogerät frei');
    out.stop();
  }
  if (!out.child || out.stopping) return;

  const step = out.step();
  let due;
  // Player meldet 1,5 s nach dem Öffnen noch nichts (alte alsa_play.py?) -> zurück zum Takt nach Uhr statt still zu
  // bleiben. Nicht, solange er den Kanal noch öffnet: Sonst liefe die Pipe voll (über 1 s Ton) und alles käme danach
  // dauerhaft verspätet.
  if (out.played === 0 && !out.gotPos && out.opened !== false && out.startedAt && now - (out.openedAt || out.startedAt) > 1500) {
    out.played = null; this.t0 = now; this.written = 0;
    this.log(out.backend + ': keine Rückmeldung vom Player – Takt nach Uhr');
  }
  if (out.played != null) {
    // Regelkreis: nur nachschreiben, was bis zum Ziel-Vorlauf fehlt (geschrieben − gespielt = was ansteht)
    // Vorlauf anpassen: Aussetzer -> mehr Reserve, lange keine -> wieder knapper
    if (this.fbLead == null) { this.fbLead = Math.max(FB_LEAD_MS, FB_LEAD_START); this.fbUnder = out.underruns || 0; this.fbCalm = now; }
    if ((out.underruns || 0) > this.fbUnder) {
      this.fbUnder = out.underruns; this.fbCalm = now;
      this.fbFloor = Math.min(FB_LEAD_MAX, Math.max(this.fbFloor, this.fbLead + 20)); this.fbFloorAt = now;
      if (this.fbLead < FB_LEAD_MAX) { this.fbLead = Math.min(FB_LEAD_MAX, this.fbLead + 30); this.log('Aussetzer – Vorlauf jetzt ' + this.fbLead + ' ms'); }
    } else {
      if (this.fbFloor > FB_LEAD_MS && now - this.fbFloorAt > FB_FLOOR_MS) { this.fbFloor = Math.max(FB_LEAD_MS, this.fbFloor - 10); this.fbFloorAt = now; }
      if (now - this.fbCalm > 10000 && this.fbLead > this.fbFloor) { this.fbLead = Math.max(this.fbFloor, this.fbLead - 10); this.fbCalm = now; }
    }
    // Was ansteht: alles, was dieser Player je bekam (out.sent, wird nie zurückgesetzt), minus was er gespielt hat.
    // Nie negativ (Rundung): sonst schriebe der Dienst über den Vorlauf hinaus vor – mehr Verzögerung.
    const queued = Math.max(0, (out.sent != null ? out.sent : this.written / step) - out.played);
    due = Math.floor((this.fbLead / 1000 * RATE / step - queued)) * step;
  } else {
    due = Math.floor((now - this.t0 + LEAD_MS) / 1000 * RATE) - this.written;
    if (due > RATE / 2) { this.t0 = now; this.written = 0; due = Math.floor(LEAD_MS / 1000 * RATE); } // Resync nach Hänger
  }
  // Kanal mit niedrigerer Rate (24 kHz): Synthese direkt in dieser Rate – halbe Rechenzeit, kein Umrechnen
  const direct = step > 1 && RATE % step === 0;
  if (direct && synth.sr !== RATE / step) this._rebuildSynth(RATE / step);
  else if (!direct && synth.sr !== RATE) this._rebuildSynth(RATE);
  while (due >= step && !out.blocked && out.child) {
    let n = Math.min(due, MAX_CHUNK);
    n -= n % step;
    if (direct) {
      const m = n / step;
      this.synth.render(this.f32, m);
      out.write(toPcmFmt(this.f32, m, { rate: RATE, ch: out.fmt.ch }));
    } else {
      this.synth.render(this.f32, n);
      out.write(toPcmFmt(this.f32, n, out.fmt, out.dec));
    }
    this.written += n; due -= n;
  }
};

/** Synth mit anderer Abtastrate neu anlegen; Einstellungen und Fahrzeugdaten bleiben erhalten. */
Engine.prototype._rebuildSynth = function (rate) {
  const old = this.synth, s = new Synth(rate);
  s.configure(Object.assign({}, old.cfg));
  // ein angefordertes, noch nicht übernommenes Profil (pending) gilt – sonst spielte nach dem Start das alte weiter
  s._setProfile(old.pending || old.cfg.profile); s._reset();
  s.target = Object.assign({}, old.target); s.stale = old.stale;
  // Motorstart gerade erkannt, während der Player startet: Startsound nicht verlieren
  s.offTime = old.offTime; s.startT = old.startT;
  this.synth = s;
  this.log('Synthese mit ' + rate + ' Hz');
};

// ---------------------------------------------------------------------------
// Audio-Diagnose: was gibt es auf diesem Gerät, um Ton auszugeben?
// (aus Sicht des aufrufenden Prozesses – App ohne Root bzw. Dienst als root)
// ---------------------------------------------------------------------------
const AUDIO_RE = /(^a?play|^paplay|^ffplay|audio|snd|alsa|pcm|pulse|pipewire|^gst|tinyalsa|tinyplay|tinymix|avb|sound|mixer|gong|chime|speaker|mediaengine|mediaapp)/i;

function probeAudio(opts) {
  opts = opts || {};
  const ls = function (d) { try { return fs.readdirSync(d); } catch (e) { return null; } };
  const read = function (f, n) { try { return fs.readFileSync(f, 'utf8').slice(0, n || 4000); } catch (e) { return null; } };
  const can = function (p, mode) { try { fs.accessSync(p, mode); return true; } catch (e) { return false; } };
  const uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  const r = { at: Date.now() };
  r.uid = process.getuid ? process.getuid() : null;
  r.players = candidates().map(function (b) { return b.name + ' ' + b.path; });
  r.python = findPython();
  r.alsaScript = fs.existsSync(ALSA_SCRIPT);
  // ALSA-Geräte im Kernel
  r.devSnd = ls('/dev/snd');
  r.devSndWritable = (r.devSnd || []).filter(function (n) { return /^pcm.*p$/.test(n) && can('/dev/snd/' + n, fs.constants.W_OK); });
  r.cards = read('/proc/asound/cards', 1500);
  r.pcm = read('/proc/asound/pcm', 1500);
  // OSS-Emulation: dorthin könnte Node ohne Abspielprogramm direkt schreiben
  r.oss = ['/dev/dsp', '/dev/dsp0', '/dev/audio'].filter(function (p) { return fs.existsSync(p); })
    .map(function (p) { return p + (can(p, fs.constants.W_OK) ? ' (schreibbar)' : ' (kein Zugriff)'); });
  // Bibliotheken
  const libs = [];
  ['/usr/lib', '/lib', '/usr/lib64', '/lib64', '/usr/lib/x86_64-linux-gnu'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { if (/^lib(asound|pulse|pipewire|tinyalsa|gstreamer|avb|ias)/i.test(n)) libs.push(n); });
  });
  r.libs = uniq(libs).slice(0, 30);
  // Programme mit Audio-Bezug
  const bins = [];
  (process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin'])
    .forEach(function (d) { if (d) (ls(d) || []).forEach(function (n) { if (AUDIO_RE.test(n)) bins.push(n); }); });
  r.bins = uniq(bins).sort().slice(0, 60);
  // laufende Prozesse mit Audio-Bezug
  const procs = [];
  (ls('/proc') || []).forEach(function (p) {
    if (!/^\d+$/.test(p)) return;
    const c = read('/proc/' + p + '/comm', 64);
    if (c && AUDIO_RE.test(c)) procs.push(c.trim());
  });
  r.procs = uniq(procs).sort().slice(0, 40);
  // BMW-SOME/IP-Schnittstellen mit Audio-Bezug (Katalog des Geräts)
  if (opts.someip !== false) {
    const cat = process.env.MGU_SOMEIP_CATALOG || '/etc/oap/someip/someip-interfaces.json';
    let txt = null;
    try { txt = fs.readFileSync(cat, 'utf8'); } catch (e) { r.someipError = e.code || String(e); }
    if (txt) {
      const re = /"(de\.bmw\.[A-Za-z0-9_.]*?(?:[Aa]udio|[Ss]ound|[Gg]ong|[Cc]hime|[Tt]one|ASD|[Aa]coustic|[Vv]olume|[Ss]peaker)[A-Za-z0-9_.]*)"/g;
      const names = [];
      let m;
      while ((m = re.exec(txt)) && names.length < 400) names.push(m[1]);
      r.someip = uniq(names).sort().slice(0, 60);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// SmartX-/ALSA-Erkundung (sinnvoll als root): Wer hält die Soundkarte, welche virtuellen
// Geräte definiert BMW (Intel IAS SmartX), mit welcher ALSA-Konfiguration arbeiten die Audio-Prozesse?
// ---------------------------------------------------------------------------
const AUDIO_PROC_RE = /^(AlsaRoutingAdap|AudioManager|mediaengine|mediaapp|avb_streamhandl|AVBSourceSinkCo|handsfreeaudio|smartx|ias)/i;
const PCM_NAME_RE = /^[ \t]*pcm\.!?"?([A-Za-z0-9_.-]+)"?\s*[{=]/gm;

function probeSmartx() {
  const ls = function (d) { try { return fs.readdirSync(d); } catch (e) { return null; } };
  const read = function (f, n) { try { return fs.readFileSync(f, 'utf8').slice(0, n || 200000); } catch (e) { return null; } };
  const uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  const r = { owners: [], configs: [], pcmNames: [], plugins: [], files: [], shm: [], sockets: [], procs: [], alsaConfigPaths: [], alsaConfigEnv: [] };

  // 1) Wer hält welches PCM-Gerät? (/proc/asound/card0/pcmXp/sub0/status: owner_pid)
  (ls('/proc/asound/card0') || []).filter(function (n) { return /^pcm\d+[pc]$/.test(n); }).forEach(function (n) {
    const st = read('/proc/asound/card0/' + n + '/sub0/status', 2000) || '';
    const hw = read('/proc/asound/card0/' + n + '/sub0/hw_params', 2000) || '';
    const info = read('/proc/asound/card0/' + n + '/info', 2000) || '';
    const pid = (/owner_pid\s*:\s*(\d+)/.exec(st) || [])[1];
    const comm = pid ? (read('/proc/' + pid + '/comm', 64) || '').trim() : '';
    const name = (/^name:\s*(.*)$/m.exec(info) || [])[1] || '';
    const rate = (/^rate:\s*(\d+)/m.exec(hw) || [])[1];
    const fmt = (/^format:\s*(\S+)/m.exec(hw) || [])[1];
    const ch = (/^channels:\s*(\d+)/m.exec(hw) || [])[1];
    r.owners.push(n + (name ? ' "' + name.trim() + '"' : '') + ': ' + (pid ? 'belegt von ' + comm + ' (' + pid + ')' : (/closed/.test(st) ? 'frei' : st.split('\n')[0].trim() || '?')) +
      (rate ? ' ' + rate + ' Hz ' + (fmt || '') + ' ' + (ch || '') + 'ch' : ''));
  });

  // 2) ALSA-Konfiguration und Plugins
  const cfgFiles = ['/etc/asound.conf', '/usr/share/alsa/alsa.conf'];
  ['/usr/share/alsa/alsa.conf.d', '/etc/alsa/conf.d', '/etc/alsa', '/usr/share/alsa/pcm', '/usr/share/alsa/cards'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { if (/\.conf$/.test(n)) cfgFiles.push(path.join(d, n)); });
  });
  ['/usr/lib/alsa-lib', '/usr/lib64/alsa-lib', '/usr/lib/x86_64-linux-gnu/alsa-lib', '/lib/alsa-lib'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { r.plugins.push(n.replace(/^libasound_module_/, '').replace(/\.so$/, '')); });
  });

  // 3) Dateien mit SmartX/IAS/Audio-Bezug in /etc, /opt, /usr/share (2 Ebenen), Shared Memory, Sockets
  const FILE_RE = /(smartx|ias[_-]|audio|asound|routing|alsa)/i;
  ['/etc', '/opt', '/usr/share', '/var/opt', '/mnt/dataro/data'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) {
      const p = path.join(d, n);
      if (FILE_RE.test(n)) r.files.push(p);
      if (/^(smartx|ias|audio|alsa)/i.test(n)) (ls(p) || []).slice(0, 30).forEach(function (m) { r.files.push(path.join(p, m)); });
    });
  });
  r.files = uniq(r.files).slice(0, 80);
  r.files.filter(function (f) { return /\.(conf|cfg)$/i.test(f) && /asound|alsa|smartx|ias/i.test(f); }).forEach(function (f) { cfgFiles.push(f); });
  r.shm = (ls('/dev/shm') || []).filter(function (n) { return /(smartx|ias|audio|alsa|pcm|avb|sound)/i.test(n); }).slice(0, 40);
  ['/run', '/tmp', '/var/run', '/run/ias', '/run/smartx', '/tmp/smartx'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { if (/(smartx|ias|audio|alsa|avb|sound)/i.test(n)) r.sockets.push(path.join(d, n)); });
  });
  r.sockets = uniq(r.sockets).slice(0, 40);

  // 4) Audio-Prozesse: Startbefehl, ALSA-/SmartX-Umgebung, offene Audio-Dateien
  (ls('/proc') || []).forEach(function (pid) {
    if (!/^\d+$/.test(pid)) return;
    const comm = (read('/proc/' + pid + '/comm', 64) || '').trim();
    if (!AUDIO_PROC_RE.test(comm)) return;
    const cmd = (read('/proc/' + pid + '/cmdline', 2000) || '').split('\0').filter(Boolean).join(' ');
    const env = (read('/proc/' + pid + '/environ', 20000) || '').split('\0')
      .filter(function (e) { return /^(ALSA_|SMARTX|IAS|AUDIO|LD_LIBRARY_PATH|AM_)/i.test(e); });
    env.forEach(function (e) {
      const m = /^ALSA_CONFIG_PATH=(.+)$/.exec(e);
      if (m) {
        r.alsaConfigEnv.push(m[1]);
        m[1].split(':').forEach(function (p) { if (p) { r.alsaConfigPaths.push(p); cfgFiles.push(p); } });
      }
    });
    const fds = [];
    (ls('/proc/' + pid + '/fd') || []).forEach(function (fd) {
      let t = null;
      try { t = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch (e) { t = null; }
      if (t && /(\/dev\/snd|\/dev\/shm|smartx|ias|asound|socket:)/.test(t) && !/^socket:/.test(t)) fds.push(t);
    });
    r.procs.push({ pid: pid, comm: comm, cmd: cmd.slice(0, 300), env: env.slice(0, 10), fds: uniq(fds).slice(0, 20) });
  });
  r.alsaConfigPaths = uniq(r.alsaConfigPaths);
  r.alsaConfigEnv = uniq(r.alsaConfigEnv);

  // 5) pcm-Namen aus allen gefundenen Konfigurationen
  const names = [];
  uniq(cfgFiles).forEach(function (f) {
    const txt = read(f);
    if (!txt) return;
    r.configs.push(f);
    let m;
    PCM_NAME_RE.lastIndex = 0;
    while ((m = PCM_NAME_RE.exec(txt)) && names.length < 200) names.push(m[1]);
  });
  r.pcmNames = uniq(names).filter(function (n) { return !/^(front|rear|center_lfe|side|surround\d+|iec958|spdif|modem|phoneline|hdmi|dsnoop|null)$/.test(n); }).slice(0, 60);
  return r;
}

function smartxLines(r) {
  const out = [];
  const add = function (label, val) {
    let s = label + ': ' + val;
    while (s.length > 68) { const cut = s.lastIndexOf(', ', 68); const i = cut > 20 ? cut + 1 : 68; out.push(s.slice(0, i)); s = '   ' + s.slice(i).replace(/^\s+/, ''); }
    out.push(s);
  };
  const list = function (a) { return a && a.length ? a.join(', ') : 'keine'; };
  out.push('--- BMW-Audiosystem (SmartX) ---');
  r.owners.forEach(function (o) { add('PCM', o); });
  add('ALSA-Konfig', list(r.configs));
  add('pcm-Namen', list(r.pcmNames));
  add('ALSA-Plugins', list(r.plugins));
  if (r.alsaConfigPaths.length) add('ALSA_CONFIG_PATH', list(r.alsaConfigPaths));
  add('Shared Memory', list(r.shm));
  add('Sockets', list(r.sockets));
  r.procs.forEach(function (p) {
    add(p.comm + ' (' + p.pid + ')', p.cmd || '-');
    if (p.env.length) add('   Umgebung', list(p.env));
    if (p.fds.length) add('   offen', list(p.fds));
  });
  add('Dateien', list(r.files));
  return out;
}

/** Kurze Textzeilen für die Anzeige (ASCII, max. ~68 Zeichen). */
function diagLines(r, extra) {
  const out = [];
  const add = function (label, val) {
    let s = label + ': ' + val;
    while (s.length > 68) { const cut = s.lastIndexOf(', ', 68); const i = cut > 20 ? cut + 1 : 68; out.push(s.slice(0, i)); s = '   ' + s.slice(i).replace(/^\s+/, ''); }
    out.push(s);
  };
  const list = function (a, none) { return a && a.length ? a.join(', ') : (none || 'keine'); };
  (extra || []).forEach(function (l) { out.push(l); });
  add('Nutzer', r.uid === 0 ? 'root' : 'uid ' + r.uid);
  add('Abspielprogramme', list(r.players));
  add('Python', (r.python || 'nicht gefunden') + (r.alsaScript ? ' · alsa_play.py da' : ' · alsa_play.py fehlt'));
  add('/dev/snd', r.devSnd ? list(r.devSnd) : 'fehlt');
  if (r.devSnd) add('beschreibbar', list(r.devSndWritable));
  if (r.cards) add('Soundkarten', r.cards.split('\n').filter(function (l) { return /^\s*\d+ \[/.test(l); }).map(function (l) { return l.trim(); }).join(' | ') || r.cards.trim().slice(0, 60));
  add('OSS', list(r.oss));
  add('Bibliotheken', list(r.libs));
  add('Programme', list(r.bins));
  add('Prozesse', list(r.procs));
  add('SOME/IP', r.someip ? list(r.someip.map(function (n) { return n.replace(/^de\.bmw\.(infotainment\.|infrastructure\.)?/, ''); })) : 'nicht lesbar (' + (r.someipError || '?') + ')');
  return out;
}

module.exports = {
  clock: clock,
  probeAudio: probeAudio, diagLines: diagLines, scanAlsa: scanAlsa, findPython: findPython,
  probeSmartx: probeSmartx, smartxLines: smartxLines, usable: usable,
  Engine: Engine, Output: Output, candidates: candidates, toPcm: toPcm, toPcmFmt: toPcmFmt, Decimator: Decimator, sweepAt: sweepAt,
  smartxEndpoints: smartxEndpoints, resolveSmartx: resolveSmartx, formatOf: formatOf, isSmartx: isSmartx,
  RATE: RATE, TICK_MS: TICK_MS, LEAD_MS: LEAD_MS, FB_LEAD_MS: FB_LEAD_MS, FB_LEAD_START: FB_LEAD_START, FB_LEAD_MAX: FB_LEAD_MAX, FB_FLOOR_MS: FB_FLOOR_MS, MAX_CHUNK: MAX_CHUNK
};
