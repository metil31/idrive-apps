'use strict';
/**
 * Tests für Iconix Sounds 0.6: Audiomanager-Tonweg (car_route.js) gegen einen nachgebauten Audiomanager
 * und die SmartX-Ausgabe des Dienstes (engine.js: Kanal auflösen, Format, Umrechnung).
 *
 *   node kit/tools/test_iconix_route.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CarRoute = require(path.join(ROOT, 'apps/iconix_sounds/car_route.js'));
const E = require(path.join(ROOT, 'tools/iconix-audiod/engine.js'));
const Clock = require(path.join(ROOT, 'apps/iconix_sounds/clock.js'));
/** Uhr von App und Dienst stellen (null = nichts ändern); gibt die vorherige zurück. */
function setClock(fn) { const old = Clock.now; if (fn) { Clock.now = fn; E.clock.now = fn; } return old; }

// ---- nachgebauter Audiomanager ------------------------------------------------
function fakeAm(opts) {
  opts = opts || {};
  const am = { conns: opts.conns || [], nextId: 50, calls: [], avail: {}, vol: 20, state: opts.state };
  const signals = {
    proxy: async (iface, inst) => {
      assert.strictEqual(inst, '1');
      if (opts.noProxy) throw new Error('no SOME/IP config');
      return { iface };
    },
    call: async (p, method, params) => {
      am.calls.push(method + ' ' + JSON.stringify(params));
      if (method === 'getListMainConnections') return { listConnections: am.conns.map((c) => Object.assign({}, c)) };
      if (method === 'getListMainSources') return { listMainSources: opts.sources || [{ sourceID: 287, name: 'CarLifeMedia' }, { sourceID: 1048, name: 'OAPGenericOverlay' }] };
      if (method === 'getListMainSinks') return { listMainSinks: [{ sinkID: 1024, name: 'MediaSink_Front' }, { sinkID: 1, name: 'MainSink', volume: am.vol }] };
      if (method === 'hookSourceAvailablityStatusChange') { am.avail[params.sourceID] = params.availability.availability; return {}; }
      if (method === 'connect') {
        if (opts.refuse) return { amError: 'E_NOT_POSSIBLE', mainConnectionID: null };
        const id = am.nextId++;
        am.conns.push({ mainConnectionID: id, sourceID: params.sourceID, sinkID: params.sinkID, connectionState: am.state != null ? am.state : 2 });
        if (opts.volJump) am.vol += opts.volJump;     // das Auto hebt die Lautstärke für die "Durchsage" an
        return { amError: 'E_OK', mainConnectionID: id };
      }
      if (method === 'disconnect') { am.conns = am.conns.filter((c) => c.mainConnectionID !== params.mainConnectionID); if (opts.volJump) am.vol -= opts.volJump; return { amError: 'E_OK' }; }
      throw new Error('unbekannt ' + method);
    }
  };
  return { am, signals };
}
const quiet = { info() {}, warn() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iconix-route-'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Overlay-Mix verbindet 1048 -> 1024 ohne Verfügbarkeitsmeldung und trennt wieder', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, tmp);
  r.want('overlay', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[1048, 1024]]);
  assert.strictEqual(am.avail[1048], undefined);
  assert.ok(fs.existsSync(path.join(tmp, 'iconix_route.json')));
  r.want('overlay', false);
  await r._step();
  assert.strictEqual(am.conns.length, 0);
  assert.strictEqual(r.state, 'aus');
  assert.ok(!fs.existsSync(path.join(tmp, 'iconix_route.json')));
});

test('CarLife exklusiv meldet 287 verfügbar, übernimmt fremde 287-Verbindung, meldet beim Trennen unverfügbar', async () => {
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 7, sourceID: 287, sinkID: 1, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('carlife', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[287, 1024]]);
  assert.strictEqual(am.avail[287], 'A_AVAILABLE');
  r.want('carlife', false);
  await r._step();
  assert.strictEqual(am.avail[287], 'A_UNAVAILABLE');
});

test('Wegwechsel trennt den alten Weg zuerst', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  r.want('carlifeNav', true); await r._step();
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[288, 1024]]);
});

test('bestehende passende Verbindung wird übernommen, verschwundene neu aufgebaut', async () => {
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 9, sourceID: 1048, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  assert.strictEqual(r.conn.id, 9);
  assert.ok(!am.calls.some((c) => c.indexOf('connect {') === 0));
  am.conns = [];          // z. B. vom System getrennt
  r.lastVerify = 0; await r._step();
  assert.strictEqual(r.conn, null);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.strictEqual(am.conns.length, 1);
});

test('Ablehnung und fehlendes SOME/IP werden als Fehler angezeigt, ohne zu werfen', async () => {
  const a = fakeAm({ refuse: true });
  const r = new CarRoute(a.signals, quiet, null);
  r.want('carlife', true); await r._step();
  assert.strictEqual(r.state, 'Fehler');
  assert.ok(/E_NOT_POSSIBLE/.test(r.short()), r.short());
  assert.strictEqual(a.am.avail[287], 'A_UNAVAILABLE');
  const b = fakeAm({ noProxy: true });
  const r2 = new CarRoute(b.signals, quiet, null);
  r2.want('overlay', true); await r2._step();
  assert.ok(/nicht erreichbar/.test(r2.short()), r2.short());
  const r3 = new CarRoute(null, quiet, null);
  r3.want('overlay', true); await r3._step();
  assert.strictEqual(r3.state, 'Fehler');
});

test('Wege ohne Audiomanager machen keine Aufrufe', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('carplay', true); await r._step();
  r.want('alsa', true); await r._step();
  assert.strictEqual(am.calls.length, 0);
  assert.ok(/ohne Audiomanager/.test(r.short()));
});

test('liegengebliebene eigene Verbindung desselben Boots wird beim Start getrennt', async () => {
  const boot = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; } })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iconix-route2-'));
  fs.writeFileSync(path.join(dir, 'iconix_route.json'), JSON.stringify({ mainConnectionID: 33, bootId: boot }));
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 33, sourceID: 287, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, dir);
  r.want('overlay', true); await r._step();
  if (boot) assert.ok(!am.conns.some((c) => c.mainConnectionID === 33));
  else assert.ok(am.conns.some((c) => c.mainConnectionID === 33)); // ohne Boot-ID (Windows) nichts anfassen
});

test('Diagnose listet Verbindungen, Quellen und Senken', async () => {
  const { signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  const lines = (await r.diagLines()).join('\n');
  assert.ok(/1048->1024 CONNECTED/.test(lines), lines);
  assert.ok(/287 CarLifeMedia/.test(lines) && /1024 MediaSink_Front/.test(lines), lines);
});

test('SmartX: Kanal auflösen, Format aus dem Namen, kein Rückfall auf andere Geräte', () => {
  assert.strictEqual(E.resolveSmartx('smartx:Media_Overlay_Converter_Source_CF_24_MONO', ['Media_Overlay_Converter_Source_CF_24_MONO']),
    'plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO');
  assert.strictEqual(E.resolveSmartx('smartx:Media_Overlay_Converter_Source_CF_24_MONO', ['Media_Overlay_Converter_Source_CF_48_STEREO']),
    'plug:smartx:Media_Overlay_Converter_Source_CF_48_STEREO');
  assert.strictEqual(E.resolveSmartx('smartx:CarLifeNavigation', []), 'plug:smartx:CarLifeNavigation_CF_48_STEREO');
  assert.strictEqual(E.resolveSmartx('plughw:0,0', []), 'plughw:0,0');
  assert.deepStrictEqual(E.formatOf('plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO'), { rate: 24000, ch: 1 });
  assert.deepStrictEqual(E.formatOf('plug:smartx:CarLifeMedia_CF_48_STEREO'), { rate: 48000, ch: 2 });
  process.env.ICONIX_PYTHON = process.execPath; // irgendein vorhandenes Programm als "Python"
  const c = E.candidates({ device: 'plug:smartx:CarLifeMedia_CF_48_STEREO' });
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].argv.slice(1), ['play', 'plug:smartx:CarLifeMedia_CF_48_STEREO', '48000', '60000', '2']);
  const m = E.candidates({ device: 'plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO' });
  assert.deepStrictEqual(m[0].argv.slice(3), ['24000', '60000', '1']);
});

test('Umrechnung 48 -> 24 kHz: Tiefpass gegen Aliasing, tiefe Töne bleiben', () => {
  const tone = (hz, n) => { const f = new Float32Array(n * 2); for (let i = 0; i < n; i++) f[i * 2] = f[i * 2 + 1] = 0.5 * Math.sin(2 * Math.PI * hz * i / 48000); return f; };
  const rms = (b) => { let s = 0; const m = b.length / 2; for (let i = m / 2; i < m; i++) { const v = b.readInt16LE(i * 2) / 32767; s += v * v; } return Math.sqrt(s / (m / 2)); };
  const n = 9600;
  const low = E.toPcmFmt(tone(500, n), n, { rate: 24000, ch: 1 }, new E.Decimator(2));
  const high = E.toPcmFmt(tone(18000, n), n, { rate: 24000, ch: 1 }, new E.Decimator(2)); // würde als 6 kHz zurückfallen
  assert.strictEqual(low.length, n); // n/2 Frames x 2 Byte
  assert.ok(rms(low) > 0.3, 'tiefer Ton bleibt: ' + rms(low));
  assert.ok(rms(high) < 0.005, '18 kHz wird unterdrückt: ' + rms(high));
  // Zustand über Blöcke: zwei halbe Blöcke = ein ganzer
  const dec = new E.Decimator(2), t = tone(500, n);
  const a = E.toPcmFmt(t.subarray(0, n), n / 2, { rate: 24000, ch: 1 }, dec);
  const b = E.toPcmFmt(t.subarray(n), n / 2, { rate: 24000, ch: 1 }, dec);
  assert.ok(Buffer.concat([a, b]).equals(low));
  assert.strictEqual(E.toPcmFmt(t, n, { rate: 48000, ch: 2 }).length, n * 4);
});

// ---- Synthese (synth.js v2) ----------------------------------------------------
const Synth = require(path.join(ROOT, 'tools/iconix-audiod/synth.js'));
const Profiles = require(path.join(ROOT, 'tools/iconix-audiod/profiles.js'));
function drive(id, sr, secs, fn) {
  const s = new Synth(sr);
  s.configure({ profile: id, volume: 1, intensity: 0.7 });
  s._setProfile(id); s.pending = null; s._reset();
  const blk = Math.round(sr / 100), f = new Float32Array(blk * 2), out = new Float32Array(Math.round(secs * sr));
  let peak = 0;
  for (let pos = 0; pos + blk <= out.length; pos += blk) {
    s.setParams(fn(pos / sr));
    peak = Math.max(peak, s.render(f, blk));
    for (let i = 0; i < blk; i++) out[pos + i] = f[i * 2];
  }
  return { out, peak };
}
function bandShare(x, sr, hz) { // Energieanteil oberhalb hz (einfache DFT über Stichproben-Frequenzen)
  let hi = 0, tot = 0;
  for (let f = 20; f < sr / 2; f *= 1.06) {
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i += 1) { const w = 2 * Math.PI * f * i / sr; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); }
    const p = (re * re + im * im) * f; tot += p; if (f > hz) hi += p;
  }
  return hi / tot;
}

test('alle Profile: kein NaN, kein Übersteuern, kaum Energie über 2 kHz (nichts Schrilles)', () => {
  for (const id of Profiles.ids) {
    const r = drive(id, 24000, 5, (t) => t < 1 ? { rpm: 800, load: 0.05, speed: 0 } : { rpm: 1200 + 3500 * (t - 1) / 4, load: 1, speed: 30 + 60 * t / 5 });
    assert.ok(r.out.every((v) => v === v), id + ': NaN');
    assert.ok(r.peak <= 1 && r.peak > 0.05, id + ': Spitze ' + r.peak);
    const share = bandShare(r.out.subarray(r.out.length - 4800), 24000, 2000);
    assert.ok(share < 0.08, id + ': ' + (share * 100).toFixed(1) + ' % über 2 kHz');
  }
});

test('Verbrenner: Grundton = Zündfrequenz der virtuellen Drehzahl (Profil-Abbildung)', () => {
  const s = new Synth(24000);
  s.configure({ profile: 'supra', carIdle: 800, carRedline: 4800 });
  s._setProfile('supra');
  const p = Profiles.get('supra');
  assert.strictEqual(s._virtualRpm(800), p.idleRpm);
  assert.strictEqual(s._virtualRpm(4800), p.maxRpm);
  assert.ok(p.maxRpm <= 6500, 'Drehzahlband nur leicht gestreckt');
  // Zündfrequenz eines Reihensechsers bei 3000 U/min = 150 Hz: dort deutlich mehr Energie als bei 1000 Hz
  const r = drive('supra', 24000, 1.2, () => ({ rpm: 800 + (3000 - 800) / (6500 - 800) * 4000, load: 0.8, speed: 80 }));
  const x = r.out.subarray(4800);
  const at = (f) => { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { const w = 2 * Math.PI * f * i / 24000; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } return Math.hypot(re, im); };
  assert.ok(at(150) > 5 * at(1000), 'Zündfrequenz dominiert: ' + at(150).toFixed(1) + ' vs ' + at(1000).toFixed(1));
});

test('Schub leiser als Last, ohne Übersteuern', () => {
  const r = drive('v8', 24000, 9, (t) => t < 6 ? { rpm: 1100 + 3700 * t / 6, load: 1, speed: 80 } : { rpm: 4800 - 3200 * (t - 6) / 3, load: 0, overrun: true, speed: 90 });
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const wot = rms(r.out.subarray(24000 * 3, 24000 * 6)), ovr = rms(r.out.subarray(24000 * 6.3));
  assert.ok(ovr < wot * 0.75 && ovr > wot * 0.1, 'Schub ' + ovr.toFixed(3) + ' vs Last ' + wot.toFixed(3));
  assert.ok(r.peak <= 1);
});

test('keine Knackser: niedrige Drehzahl unter Last, Schaltknicke, Gas weg (Spitzenfaktor im Hochpass)', () => {
  for (const id of Profiles.ids.filter((i) => Profiles.get(i).kind !== 'electric')) {
    const r = drive(id, 24000, 6, (t) => {
      if (t < 4) { const g = t % 1; return { rpm: 1300 + 800 * g, load: g < 0.22 ? 0.25 : 1, speed: 50 }; }
      return { rpm: 2600, load: t < 4.05 ? 1 : 0, overrun: t > 4.05, speed: 80 };
    });
    // Hochpass über die ganze Fahrt (Filter eingeschwungen), Spitze/RMS je 50 ms ab 0,5 s
    const hp = new Synth.Biquad().set('hp', 1000, 0.7, 24000), y = r.out.map((v) => hp.run(v));
    let worst = 0;
    for (let w = 12000; w + 1200 <= y.length; w += 1200) {
      let pk = 0, ss = 0;
      for (let i = w; i < w + 1200; i++) { ss += y[i] * y[i]; if (Math.abs(y[i]) > pk) pk = Math.abs(y[i]); }
      const rms = Math.sqrt(ss / 1200);
      if (rms > 1e-5) worst = Math.max(worst, pk / rms);
    }
    assert.ok(worst < 8, id + ': Spitzenfaktor ' + worst.toFixed(1) + ' (Knackser?)');
  }
});

test('keine Patscher, kein Mechanik-Klicken, kein Turbo- oder Ansaugrauschen, kein Zischen', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/synth.js'), 'utf8');
  assert.ok(!/popRate|popHeat|fBov|mechEnv|turboGain|fTurbo|inGain|fHelm|fHiss|hissT|HISS_AMT/.test(src));
  assert.ok(Profiles.list.every((p) => p.popRate === undefined && p.turbo === undefined && p.intake === undefined && p.bov === undefined));
});

test('Rauschen nur als Hauch: mindestens 36 dB unter dem Motorton', () => {
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  for (const id of Profiles.ids.filter((i) => Profiles.get(i).kind !== 'electric')) {
    const p = Profiles.get(id), rasp = p.rasp, fn = (t) => ({ rpm: 1100 + 3500 * t / 4, load: 1, speed: 60 });
    const full = drive(id, 24000, 4, fn).out;
    p.rasp = 0; const clean = drive(id, 24000, 4, fn).out; p.rasp = rasp;
    const db = 20 * Math.log10(rms(full.map((v, i) => v - clean[i])) / rms(clean));
    assert.ok(db < -36, id + ': Rauschen ' + db.toFixed(1) + ' dB');
  }
});

test('Rechenzeit bei 24 kHz im Rahmen (Head Unit)', () => {
  const s = new Synth(24000); s.configure({ profile: 'v10', volume: 1 }); s._setProfile('v10');
  const f = new Float32Array(960), t0 = process.hrtime.bigint();
  for (let k = 0; k < 250; k++) { s.setParams({ rpm: 1000 + (k % 50) * 76, load: 0.8, speed: 80 }); s.render(f, 480); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  assert.ok(ms < 40, ms.toFixed(1) + ' ms pro Sekunde Audio');
});

test('Dienst rendert für einen 24-kHz-Mono-Kanal halb so viele Frames mit 2 Byte', () => {
  const eng = new E.Engine({ log() {} });
  const writes = [];
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    write(b) { writes.push(b.length); return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  eng.t0 = Clock.now() - 100; eng.written = 0;
  eng._tick();
  const bytes = writes.reduce((a, b) => a + b, 0);
  assert.ok(eng.written % 2 === 0 && eng.written > 0);
  assert.strictEqual(bytes, eng.written / 2 * 2);
  assert.strictEqual(eng.status().wants, true);
});

test('Regelkreis mit Rückmeldung des Players: Vorlauf begrenzt (Start 100 ms), auch wenn der Kanal hängt', () => {
  const eng = new E.Engine({ log() {} });
  let bytes = 0;
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    played: 0, write(b) { bytes += b.length; return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  eng.t0 = Clock.now() - 5000; eng.written = 0;
  for (let i = 0; i < 20; i++) eng._tick();               // Kanal spielt nichts ab (z. B. noch nicht verbunden)
  const queuedMs = (bytes / 2) / 24000 * 1000;
  assert.ok(queuedMs <= E.FB_LEAD_START + 1 && queuedMs > 50, 'Warteschlange ' + queuedMs.toFixed(0) + ' ms');
  eng.out.played = bytes / 2;                                // alles gespielt -> genau ein Vorlauf wird nachgelegt
  const before = bytes; eng._tick();
  assert.ok(Math.abs((bytes - before) / 2 / 24 - E.FB_LEAD_START) < 2, 'nachgelegt ' + ((bytes - before) / 48).toFixed(0) + ' ms');
});

test('Lautstärke: sanftere Kurve und Kompressor heben Konstantfahrt an, Vollgas übersteuert nicht', () => {
  const lvl = (vol, load) => { const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: vol, enabled: true }); s._setProfile('turbo4');
    const f = new Float32Array(4800); let pk = 0, sum = 0, n = 0;
    for (let k = 0; k < 60; k++) { s.setParams({ rpm: 2200, load, speed: 80 }); s.render(f, 2400); if (k > 30) for (let i = 0; i < 4800; i += 2) { const v = Math.abs(f[i]); pk = Math.max(pk, v); sum += v * v; n++; } }
    return { pk, rms: Math.sqrt(sum / n) }; };
  const cruise = lvl(0.6, 0.15), full = lvl(1, 1);
  assert.ok(cruise.rms > 0.03, 'Konstantfahrt bei 60 %: RMS ' + cruise.rms.toFixed(3));
  assert.ok(full.pk <= 1, 'Vollgas: Spitze ' + full.pk.toFixed(2));
});

test('Runterschalten: Zwischengas (Drehzahl springt hoch, Moment negativ) klingt nach Gasstoß, nicht nach Schub', () => {
  const VehicleFeed = require(path.join(ROOT, 'apps/iconix_sounds/vehicle_feed.js'));
  const feed = new VehicleFeed(null, { info() {}, warn() {} }, () => ({ loadSource: 'auto', maxTorque: 400, carIdle: 800 }));
  const out = [];
  feed.on('sample', (x) => out.push(x));
  const realNow = setClock(null);
  let t = 1e12;
  setClock(() => t);
  try {
    feed.v.torque = -20; feed.v.torqueAt = t; feed.v.speed = 60; feed.v.speedAt = t;
    for (let i = 0; i < 10; i++) { t += 50; feed.v.rpm = 1800; feed.v.torqueAt = t; feed._sample(); }   // Schub
    assert.ok(out[out.length - 1].overrun, 'vorher Schub');
    for (let i = 0; i < 6; i++) { t += 50; feed.v.rpm = 1800 + 200 * (i + 1); feed.v.torqueAt = t; feed._sample(); } // Zwischengas
    const blip = out[out.length - 1];
    assert.ok(!blip.overrun && blip.load > 0.2, 'beim Zwischengas: overrun ' + blip.overrun + ', Last ' + blip.load.toFixed(2));
    for (let i = 0; i < 12; i++) { t += 50; feed.v.rpm = 3000; feed.v.torqueAt = t; feed._sample(); }   // wieder Schub
    assert.ok(out[out.length - 1].overrun, 'danach wieder Schub');
  } finally { setClock(realNow); }
});

test('Autostart: App hat einen Hintergrund-Einstieg (background) und app.json autostart', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/background\(bg\)\s*\{\s*return startCore\(bg\)/.test(src));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8')).autostart, true);
});

test('Vorlauf: Start 100 ms, Aussetzer +30 ms, ruhig wieder knapper – aber nicht wieder bis zum nächsten Aussetzer', () => {
  const eng = new E.Engine({ log() {} });
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    played: 0, underruns: 0, write() { return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  const realNow = setClock(null); let t = realNow();
  setClock(() => t);
  try {
    eng._tick();
    assert.strictEqual(eng.fbLead, E.FB_LEAD_START);
    eng.out.underruns = 1; eng.lastParams = t; eng._tick();
    assert.strictEqual(eng.fbLead, E.FB_LEAD_START + 30);
    for (let i = 0; i < 40; i++) { t += 11000; eng.lastParams = t; eng._tick(); }
    assert.strictEqual(eng.fbLead, E.FB_LEAD_START + 20, 'bleibt über dem Wert, der zu knapp war');
    // ohne Aussetzer sinkt die Untergrenze langsam (alle 10 min) bis zum Minimum
    for (let i = 0; i < 60 * 12; i++) { t += 11000; eng.lastParams = t; eng._tick(); }
    assert.strictEqual(eng.fbLead, E.FB_LEAD_MS);
    // 33 Minuten Fahrt, Head Unit hängt alle 20 s kurz 85 ms: früher rund alle 30 s ein Aussetzer, jetzt eine Handvoll
    const e2 = new E.Engine({ log() {} }); e2.out = Object.assign({}, eng.out, { underruns: 0 }); e2.synth.configure({ enabled: true });
    for (let s = 0; s < 33 * 60; s++) { t += 1000; e2.lastParams = t; if (s % 20 === 19 && (e2.fbLead || 100) < 85) e2.out.underruns++; e2._tick(); }
    assert.ok(e2.out.underruns <= 3, 'Aussetzer in 33 min: ' + e2.out.underruns);
  } finally { setClock(realNow); }
});

test('Player: Stille-Schutz gegen Leerlaufen und Stille zu Beginn (alsa_play.py)', () => {
  const py = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/alsa_play.py'), 'utf8');
  assert.ok(/select\.select\(\[fd\]/.test(py) && /snd_pcm_writei\(h, zeros, fill_n\)/.test(py));
  assert.ok(/os\.write\(1, \('P %d/.test(py), 'Rückmeldung der gespielten Frames');
});

test('Absenken: Telefon senkt ab, Navigation und Musik nicht, wieder laut wenn weg', async () => {
  const sources = [{ sourceID: 1048, name: 'OAPGenericOverlay' }, { sourceID: 10, name: 'Tuner_FM' }, { sourceID: 40, name: 'TEL_HandsFree' },
    { sourceID: 41, name: 'Navigation_Prompt' }, { sourceID: 12, name: 'USB_Media' }];
  const { am, signals } = fakeAm({ sources, conns: [{ mainConnectionID: 3, sourceID: 10, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  await r._step(); await r._pollDuck();
  assert.strictEqual(r.ducked, false, 'Radio allein: nicht absenken');
  am.conns.push({ mainConnectionID: 4, sourceID: 40, sinkID: 1, connectionState: 2 });
  await r._pollDuck();
  assert.strictEqual(r.ducked, true);
  assert.ok(/TEL_HandsFree/.test(r.duckBy));
  am.conns = am.conns.filter((c) => c.sourceID !== 40);
  am.conns.push({ mainConnectionID: 5, sourceID: 41, sinkID: 1, connectionState: 2 }); // Navi-Ansage: Ton bleibt
  await r._pollDuck();
  assert.strictEqual(r.ducked, false, 'Navigation darf nicht absenken');
  r.setDuck(false); am.conns.push({ mainConnectionID: 6, sourceID: 40, sinkID: 1, connectionState: 2 });
  r.lastDuck = 0; await r._step();
  assert.strictEqual(r.ducked, false, 'Einstellung aus: nie absenken');
  assert.ok(CarRoute.duckName('Phone') && CarRoute.duckName('PDC_Warning') && !CarRoute.duckName('CarLifeMedia') && !CarRoute.duckName('Radio_DAB'));
  assert.ok(!CarRoute.duckName('Navigation_Prompt') && !CarRoute.duckName('NaviGuidance') && !CarRoute.duckName('TTS') && !CarRoute.duckName('TrafficAnnouncement'));
});

test('Absenken im Klang: rund -12 dB', () => {
  const run = (duck) => { const s = new Synth(24000); s.configure({ profile: 'supra', volume: 0.8, enabled: true, duck }); s._setProfile('supra');
    const f = new Float32Array(4800); let sum = 0, n = 0;
    for (let k = 0; k < 50; k++) { s.setParams({ rpm: 2500, load: 0.4, speed: 80 }); s.render(f, 2400); if (k > 25) for (let i = 0; i < 4800; i += 2) { sum += f[i] * f[i]; n++; } }
    return Math.sqrt(sum / n); };
  const db = 20 * Math.log10(run(true) / run(false));
  assert.ok(db < -9 && db > -15, 'abgesenkt um ' + db.toFixed(1) + ' dB');
});

test('Einstellungen: Telefon/Ansagen-Option, Experten- und Motor-Gruppe, Gerät nur bei Tonweg 7', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const by = Object.fromEntries(j.settings.map((x) => [x.key, x]));
  assert.strictEqual(by.duck.default, true);
  assert.strictEqual(by.route.group, 'Experten');
  assert.deepStrictEqual(by.alsaDevice.when, { route: 'alsa' });
  assert.strictEqual(by.carRedline.group, 'Motor anpassen');
  assert.ok(!by.dialVolume);
});

test('Profile: Auswahl (Standard Power Four), kein Sechser/Dezent/Elektro mehr', () => {
  assert.strictEqual(Profiles.DEFAULT, 'turbo4');
  assert.deepStrictEqual(Profiles.ids, ['turbo4', 'supra', 'boxer', 'boxer6', 'turbo5', 'v8', 'v10', 'v12']);
  assert.strictEqual(Profiles.get('subtle').id, 'turbo4', 'alte gespeicherte Auswahl fällt auf den Standard zurück');
  assert.ok(Profiles.list.every((p) => p.kind === 'combustion' && p.desc));
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const opt = j.settings.find((x) => x.key === 'profile');
  assert.deepStrictEqual(opt.options.map((o) => o[0]), Profiles.ids);
  assert.strictEqual(opt.default, 'turbo4');
  assert.strictEqual(j.title, 'Sound Drive');
});

test('Gaswegnehmen nach Vollgas: in keinem Profil ein Zischen (keine Höhen-Spitze nach dem Lastwechsel)', () => {
  // Anteil über 1,5 kHz direkt nach dem Gaswegnehmen darf nicht höher sein als unter Last davor
  const hiRms = (x, a, b) => { let y = 0, p = 0, e = 0; const k = Math.exp(-2 * Math.PI * 1500 / 24000);
    for (let i = a - 2400; i < b; i++) { y = k * (y + x[i] - p); p = x[i]; if (i >= a) e += y * y; } return Math.sqrt(e / (b - a)); };
  for (const id of Profiles.ids) {
    const out = drive(id, 24000, 5, (t) => t < 3 ? { rpm: 2000 + 1500 * t / 3, load: 1, speed: 80 } : { rpm: 3500 - 400 * (t - 3), load: 0, overrun: true, speed: 80 }).out;
    const before = hiRms(out, 24000 * 2.5, 24000 * 3), after = hiRms(out, 24000 * 3.02, 24000 * 3.5);
    assert.ok(after <= before * 1.05 + 1e-4, id + ': Höhen nach Gas weg ' + after.toFixed(4) + ' vs unter Last ' + before.toFixed(4));
  }
});

test('Bei hoher Drehzahl lauter als bei niedriger (gleiche Last)', () => {
  const rms = (a) => Math.sqrt(a.reduce((x, v) => x + v * v, 0) / a.length);
  const lo = rms(drive('turbo4', 24000, 2, () => ({ rpm: 1600, load: 0.3, speed: 60 })).out.subarray(24000));
  const hi = rms(drive('turbo4', 24000, 2, () => ({ rpm: 4200, load: 0.3, speed: 60 })).out.subarray(24000));
  assert.ok(hi > lo * 1.25, 'hoch ' + hi.toFixed(3) + ' vs niedrig ' + lo.toFixed(3));
});

test('Drehrad bleibt beim Auto: Kit hält den Controller nicht (MGU_NO_GRAB), App greift nicht zu', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/^process\.env\.MGU_NO_GRAB = '1';/m.test(src));
  assert.ok(!/controller\.grab\(true\)|controller\.onInput\(/.test(src));
});

test('Oberfläche: alles Bedienbare links von x = 1140 (geteilte Ansicht verdeckt rechts)', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const all = UI.hits(Profiles.list).concat(UI.hitsDiag());
  all.forEach((h) => assert.ok(h.x + h.w <= 1140, h.key + ' reicht bis ' + (h.x + h.w)));
});

test('Oberfläche: Profil-Knöpfe zwei je Reihe, groß, bis unten; Lautstärke senkrecht rechts', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const all = UI.hits(Profiles.list, true), chips = all.filter((h) => h.act === 'profile');
  assert.strictEqual(new Set(chips.slice(0, 2).map((c) => c.y)).size, 1, 'erste Reihe: zwei Knöpfe');
  assert.ok(chips[2].y > chips[0].y, 'dritter Knopf in der nächsten Reihe');
  chips.forEach((c) => assert.ok(c.w >= 400 && c.h >= 85, c.key + ' ' + c.w + 'x' + c.h));
  const last = chips[chips.length - 1];
  assert.ok(last.y + last.h >= 500 && last.y + last.h <= 516, 'unterste Reihe reicht bis unten: ' + (last.y + last.h));
  const vp = all.find((h) => h.key === 'vol+'), vm = all.find((h) => h.key === 'vol-');
  assert.ok(vp.x > chips[1].x + chips[1].w && vm.x === vp.x && vp.y < vm.y, 'Lautstärke als Leiste rechts: + oben, − unten');
  [vp, vm].forEach((h) => assert.ok(h.w >= 80 && h.w === h.h, 'quadratisch: ' + h.w + 'x' + h.h));
  // schmale Ansicht: alles noch bedienbar groß
  UI.hits(Profiles.list, false).forEach((h) => assert.ok(h.w >= 80 && h.h >= 60 && h.x + h.w <= 1140, h.key));
  assert.strictEqual(chips.length, 8, 'acht Sounds = vier volle Reihen');
});

test('Lautstärke-Regler: antippen und ziehen', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  for (const wide of [true, false]) {
    const all = UI.hits(Profiles.list, wide), vp = all.find((h) => h.key === 'vol+'), vm = all.find((h) => h.key === 'vol-');
    const cx = vp.x + vp.w / 2, top = vp.y + vp.h + 10, bot = vm.y - 10;
    const hi = UI.volAt(cx, top, wide), lo = UI.volAt(cx, bot, wide), mid = UI.volAt(cx, (top + bot) / 2, wide);
    assert.ok(hi > 0.9 && lo < 0.1 && mid > 0.3 && mid < 0.7, 'oben laut, unten leise: ' + [hi, mid, lo].map((v) => v.toFixed(2)));
    assert.strictEqual(UI.volAt(cx, vp.y + 5, wide), -1, '[+] gehört nicht zum Regler');
    assert.strictEqual(UI.volAt(vp.x - 60, top + 40, wide), -1, 'neben dem Regler: nichts');
    assert.strictEqual(UI.volAt(cx, 0, wide, true), 1, 'beim Ziehen über den Rand: begrenzt');
    assert.strictEqual(UI.volAt(cx, 999, wide, true), 0);
    // keine Überschneidung mit den Knöpfen
    assert.ok(!UI.hitAt(Profiles.list, cx, (top + bot) / 2, false, wide), 'Regler-Mitte ist kein Knopf');
  }
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/ctx\.onTouch\(/.test(src) && /UI\.volAt\(/.test(src), 'Ziehen über ctx.onTouch');
  assert.ok(/Math\.round\(f \* 20\) \* 5/.test(src), 'rastet in 5-%-Schritten (Auswahl in den Einstellungen)');
});

test('Lautstärke: 100 % klingt wie früher 150 %', () => {
  const run = (vol) => { const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: vol, enabled: true }); s._setProfile('turbo4');
    const f = new Float32Array(4800); let sum = 0, n = 0;
    for (let k = 0; k < 50; k++) { s.setParams({ rpm: 2200, load: 0.15, speed: 80 }); s.render(f, 2400); if (k > 25) for (let i = 0; i < 4800; i += 2) { sum += f[i] * f[i]; n++; } }
    return Math.sqrt(sum / n); };
  const v100 = run(1), v66 = run(2 / 3);
  assert.ok(Math.abs(20 * Math.log10(v100 / v66)) > 1.5, 'über 66 % (= früher 100 %) noch lauter');
  assert.ok(v66 > 0.05, 'früher 100 % jetzt bei 66 %: ' + v66.toFixed(3));
});

test('Fahrmodus: Schalter-Werte werden erkannt, Eco leiser und dumpfer, Sport lauter und offener', () => {
  const VehicleFeed = require(path.join(ROOT, 'apps/iconix_sounds/vehicle_feed.js'));
  const M = VehicleFeed.driveModeOf;
  assert.strictEqual(M(2), 'sport'); assert.strictEqual(M(28), 'sport'); assert.strictEqual(M(8), 'eco'); assert.strictEqual(M(5), 'comfort');
  assert.strictEqual(M(10), 'comfort'); assert.strictEqual(M(19), 'comfort'); assert.strictEqual(M('SPORT_PLUS'), 'sportplus');
  assert.strictEqual(M('ECO_PRO'), 'eco'); assert.strictEqual(M(''), null); assert.strictEqual(M(undefined), null);
  const run = (mode) => { const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: 0.45, enabled: true, mode }); s._setProfile('turbo4');   // normale Lautstärke (bei 80 % ist kein Platz mehr nach oben)
    const f = new Float32Array(480); let sum = 0, n = 0;
    for (let k = 0; k < 400; k++) { s.setParams({ rpm: 2500, load: 0.4, speed: 80 }); s.render(f, 240); if (k > 250) for (let i = 0; i < 480; i += 2) { sum += f[i] * f[i]; n++; } }
    return Math.sqrt(sum / n); };
  const eco = run('eco'), com = run('comfort'), sp = run('sport'), none = run(null);
  assert.ok(eco < com * 0.8, 'Eco leiser: ' + eco.toFixed(3) + ' vs ' + com.toFixed(3));
  assert.ok(sp > com * 1.12, 'Sport lauter: ' + sp.toFixed(3) + ' vs ' + com.toFixed(3));
  assert.ok(Math.abs(none - com) < 1e-6, 'ohne Fahrmodus wie Comfort');
});

test('Fahrmodus-Wechsel mitten im Ton: weich, ohne Knacken', () => {
  const s = new Synth(24000); s.configure({ profile: 'supra', volume: 1, enabled: true, mode: 'eco' }); s._setProfile('supra');
  const f = new Float32Array(480), out = [];
  for (let k = 0; k < 300; k++) { if (k === 150) s.configure({ mode: 'sportplus' }); s.setParams({ rpm: 3000, load: 0.6, speed: 90 }); s.render(f, 240); for (let i = 0; i < 480; i += 2) out.push(f[i]); }
  let maxStep = 0; for (let i = 24000 * 1.4; i < 24000 * 1.7; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  let ref = 0; for (let i = 24000 * 1.0; i < 24000 * 1.3; i++) ref = Math.max(ref, Math.abs(out[i] - out[i - 1]));
  assert.ok(maxStep < ref * 2.5, 'Sprung ' + maxStep.toFixed(3) + ' vs vorher ' + ref.toFixed(3));
});

test('Breite Ansicht: Knöpfe nutzen die ganze Breite, schmale bleibt links von 1140', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const wide = UI.hits(Profiles.list, true), narrow = UI.hits(Profiles.list, false);
  assert.ok(Math.max(...wide.map((h) => h.x + h.w)) > 1500 && Math.max(...wide.map((h) => h.x + h.w)) <= 1588);
  assert.ok(Math.max(...narrow.map((h) => h.x + h.w)) <= 1140);
  assert.ok(UI.hitAt(Profiles.list, 1500, 110, false, true), 'Tippen rechts trifft in breiter Ansicht');
  assert.ok(!UI.hitAt(Profiles.list, 1500, 110, false, false), 'in schmaler Ansicht nicht');
});

test('Oberfläche in allen Zuständen: nichts ragt über den Rand, keine leeren Texte', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const long = 'Overlay-Mix: verbunden · leiser (Telefon/PDC) · SmartX · 24 kHz · spielt · 12 Aussetzer';
  const states = [];
  for (const wide of [false, true]) for (const mode of [null, 'eco', 'sport', 'sportplus']) for (const enabled of [true, false])
    for (const diag of [null, { lines: Array.from({ length: 30 }, (_, i) => 'Zeile ' + i + ' ' + 'x'.repeat(90)), page: 1 }])
      states.push({ profiles: Profiles.list, profile: 'turbo5', rpm: 7000, redline: 4800, speed: 250, volume: 1, enabled, sport: true, demo: true, mode, wide, diag, audio: { ok: false, text: long } });
  for (const st of states) {
    const limit = st.wide ? 1600 : 1140;
    const g = { rect() {}, rrect() {}, line() {}, arc() {}, text(t, x, y, size, col, align) {
      assert.ok(t !== undefined && t !== null && String(t) !== 'undefined', 'Text undefined');
      const w = String(t).length * size * 0.5, x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      assert.ok(x0 >= 0 && x0 + w <= limit + 4, 'Text ragt hinaus: ' + JSON.stringify(String(t).slice(0, 40)) + ' bis ' + Math.round(x0 + w) + ' (Grenze ' + limit + ')');
      assert.ok(y > 0 && y <= 520, 'Text außerhalb der Höhe: ' + t);
    } };
    UI.draw(g, st);
  }
});

function levelAt(cfg, params, secs) {
  const s = new Synth(24000); s.configure(Object.assign({ profile: 'turbo4', volume: 0.8, enabled: true }, cfg)); s._setProfile(cfg.profile || 'turbo4');
  const f = new Float32Array(480); let sum = 0, n = 0; const N = Math.round((secs || 3) * 100);
  for (let k = 0; k < N; k++) { s.setParams(params); s.render(f, 240); if (k > N / 2) for (let i = 0; i < 480; i += 2) { sum += f[i] * f[i]; n++; } }
  return Math.sqrt(sum / n);
}

test('Tempo-Lautstärke: bei 130 km/h um die eingestellten dB lauter, in der Stadt gleich, abschaltbar', () => {
  const p = (v) => ({ rpm: 2200, load: 0.3, speed: v });
  const db = (a, b) => 20 * Math.log10(a / b);
  const city4 = levelAt({ speedVol: 4 }, p(40)), city0 = levelAt({ speedVol: 0 }, p(40));
  // bei 50 % Lautstärke (oben begrenzt der Begrenzer, dann wirkt die Anhebung schwächer)
  const hwy4 = levelAt({ speedVol: 4, volume: 0.5 }, p(135)), hwy0 = levelAt({ speedVol: 0, volume: 0.5 }, p(135)), hwy6 = levelAt({ speedVol: 6, volume: 0.5 }, p(135));
  assert.ok(Math.abs(db(city4, city0)) < 0.2, 'Stadt unverändert: ' + db(city4, city0).toFixed(2) + ' dB');
  assert.ok(Math.abs(db(hwy4, hwy0) - 4) < 0.8, 'Autobahn +4 dB: ' + db(hwy4, hwy0).toFixed(2));
  assert.ok(db(hwy6, hwy4) > 1.2, 'Stark lauter als Mittel');
});

test('Startsound: Motor aus -> an spielt Anlassen, Hochdrehen, Leerlauf; aus = kein Ablauf', () => {
  const run = (startSound) => { const s = new Synth(24000); s.configure({ profile: 'supra', volume: 0.8, enabled: true, startSound }); s._setProfile('supra');
    const f = new Float32Array(480); let maxRpm = 0, pk = 0, crank = 0;
    for (let k = 0; k < 400; k++) { const t = k / 100; s.setParams({ rpm: t < 1 ? 0 : 820, load: 0.04, speed: 0 }); pk = Math.max(pk, s.render(f, 240));
      if (t > 1 && t < 4) maxRpm = Math.max(maxRpm, s.rpm); if (t > 1.05 && t < 1.2) crank = Math.max(crank, s.rpm); }
    return { maxRpm, pk, crank, endRpm: s.rpm }; };
  const on = run(true), off = run(false), idle = Profiles.get('supra').idleRpm;
  assert.ok(on.maxRpm > idle * 1.2 && on.maxRpm < idle * 1.6, 'kurzes Hochdrehen: ' + Math.round(on.maxRpm));
  assert.ok(on.crank < 320, 'Anlassen mit Starterdrehzahl: ' + Math.round(on.crank));
  assert.ok(Math.abs(on.endRpm - idle) < 60, 'danach Leerlauf: ' + Math.round(on.endRpm));
  assert.ok(off.maxRpm < idle * 1.15, 'ohne Startsound kein Hochdrehen: ' + Math.round(off.maxRpm));
  assert.ok(on.pk <= 1);
  // läuft der Motor schon, wenn die App startet: kein Startsound
  const s = new Synth(24000); s.configure({ profile: 'supra', volume: 0.8, enabled: true }); s._setProfile('supra');
  const f = new Float32Array(480); let mx = 0;
  for (let k = 0; k < 200; k++) { s.setParams({ rpm: 820, load: 0.04, speed: 0 }); s.render(f, 240); mx = Math.max(mx, s.rpm); }
  assert.ok(mx < idle * 1.15, 'Motor lief schon: kein Startsound');
});

test('Klang-Regler: Bass und Bellen wirken', () => {
  // Bass: Verhältnis 20–140 Hz zu 140–600 Hz (Frequenzanalyse). Der Kompressor hält die Gesamtlautstärke,
  // das Verhältnis Bass/Mitten verschiebt sich – das hört man als mehr oder weniger Bass.
  const lowShare = (cfg) => { const s = new Synth(24000); s.configure(Object.assign({ profile: 'turbo4', volume: 0.5, enabled: true }, cfg)); s._setProfile('turbo4');
    const f = new Float32Array(480), x = [];
    for (let q = 0; q < 300; q++) { s.setParams({ rpm: 1800, load: 0.5, speed: 80 }); s.render(f, 240); if (q > 150) for (let i = 0; i < 480; i += 2) x.push(f[i]); }
    const band = (lo, hi) => { let en = 0; for (let fr = lo; fr < hi; fr += 5) { let re = 0, im = 0; for (let i = 0; i < x.length; i += 2) { const w = 2 * Math.PI * fr * i / 24000; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } en += re * re + im * im; } return en; };
    return band(20, 140) / band(140, 600); };
  const lb = lowShare({}), lp6 = lowShare({ bassDb: 6 }), lm6 = lowShare({ bassDb: -6 });
  assert.ok(lp6 > lb * 1.8 && lm6 < lb * 0.55, 'Bass/Mitten: ' + lm6.toFixed(2) + ' < ' + lb.toFixed(2) + ' < ' + lp6.toFixed(2));
  // Bellen: Anteil 250–1200 Hz gegenüber 40–250 Hz steigt deutlich
  const midShare = (cfg) => { const s = new Synth(24000); s.configure(Object.assign({ profile: 'turbo4', volume: 0.4, enabled: true }, cfg)); s._setProfile('turbo4');
    const f = new Float32Array(480), x = [];
    for (let q = 0; q < 300; q++) { s.setParams({ rpm: 3200, load: 0.8, speed: 90 }); s.render(f, 240); if (q > 150) for (let i = 0; i < 480; i += 2) x.push(f[i]); }
    const band = (lo, hi, st) => { let en = 0; for (let fr = lo; fr < hi; fr += st) { let re = 0, im = 0; for (let i = 0; i < x.length; i += 2) { const w = 2 * Math.PI * fr * i / 24000; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } en += re * re + im * im; } return en; };
    return band(250, 1200, 6) / band(40, 250, 4); };
  const m50 = midShare({ barkPct: 0.5 }), m150 = midShare({ barkPct: 1.5 });
  assert.ok(m150 > m50 * 1.6, 'Bellen 50 % ' + m50.toFixed(3) + ' vs 150 % ' + m150.toFixed(3));
});

test('Einstellungen der neuen Funktionen vorhanden', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const by = Object.fromEntries(j.settings.map((x) => [x.key, x]));
  assert.strictEqual(by.speedVol.default, 4); assert.strictEqual(by.startSound.default, true);
  ['bassDb', 'bark'].forEach((k) => assert.strictEqual(by[k].group, 'Klang anpassen'));
  assert.ok(!by.hiss, 'kein Zischen-Regler mehr');
});

test('Lautstärkeknopf: Drehen gibt den Knopf der Musik (Motorsound stumm, Verbindung frei), nach Ruhe zurück', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  const changes = [];
  r.onChange = (a) => changes.push(a);
  r.want('overlay', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.ok(r.audible(), 'verbunden + CS_CONNECTED = hörbar');
  await r._knobTick();                       // Ausgangswert lesen (nach eigenem Verbinden: kurze Ruhezeit)
  r.knobQuiet = 0;                           // Ruhezeit vorbei
  am.vol = 23;                               // Knopf gedreht
  await r._knobTick();
  assert.ok(r.knobHeld(), 'Knopf gedreht erkannt');
  assert.ok(!r.audible(), 'Motorsound stumm');
  assert.ok(changes.includes(false));
  await r._step();
  assert.strictEqual(am.conns.length, 0, 'Verbindung freigegeben -> Knopf regelt wieder die Musik');
  assert.ok(/Pause/.test(r.state));
  am.vol = 25; await r._knobTick();          // weiter gedreht: bleibt frei
  await r._step();
  assert.strictEqual(am.conns.length, 0);
  r.knobAt = Clock.now() - 2000;              // 2 s Ruhe
  await r._step();
  assert.strictEqual(am.conns.length, 1, 'nach Ruhe wieder verbunden');
  assert.ok(r.audible());
  // Einstellung aus: Drehen ändert nichts (Knopf regelt dann den Motorsound, wie im Auto vorgesehen)
  r.setKnob(false); r.knobQuiet = 0; am.vol = 30; await r._knobTick(); await r._step();
  assert.ok(!r.knobHeld() && am.conns.length === 1);
});

test('Hörbar erst ab CS_CONNECTED (Auto braucht ~6 s); verlorene Verbindung sofort stumm', async () => {
  const { am, signals } = fakeAm({ state: 1 });  // CS_CONNECTING
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  await r._step();
  assert.ok(r.conn && !r.audible(), 'verbindet noch: stumm');
  am.conns.forEach((c) => { c.connectionState = 2; });
  r.lastVerify = 0; await r._step();
  assert.ok(r.audible(), 'jetzt verbunden: hörbar');
  am.conns = [];                              // CarPlay-Navi übernimmt den Overlay-Platz
  await r._pollDuck();
  assert.ok(!r.conn && !r.audible(), 'Verbindung weg -> stumm, bis neu verbunden');
  await r._step();
  assert.ok(r.conn, 'gleich neu verbunden (kurze Wartezeit)');
  // ohne CS_CONNECTED-Meldung: spätestens nach AUDIBLE_AFTER_MS hörbar
  const r2 = new CarRoute(fakeAm({ state: 1 }).signals, quiet, null);
  r2.want('overlay', true); await r2._step();
  r2.conn.at = Clock.now() - CarRoute.AUDIBLE_AFTER_MS - 10;
  assert.ok(r2.audible());
  // Wege ohne Audiomanager sind immer hörbar
  const r3 = new CarRoute(fakeAm().signals, quiet, null); r3.want('carplay', true);
  assert.ok(r3.audible());
});

test('Synth: hold blendet weich aus und wieder ein, ohne Knacken', () => {
  const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: 0.8, enabled: true }); s._setProfile('turbo4');
  const f = new Float32Array(480), out = [];
  for (let k = 0; k < 300; k++) { if (k === 100) s.configure({ hold: true }); if (k === 200) s.configure({ hold: false });
    s.setParams({ rpm: 2500, load: 0.4, speed: 80 }); s.render(f, 240); for (let i = 0; i < 480; i += 2) out.push(f[i]); }
  let held = 0; for (let i = 24000 * 1.6; i < 24000 * 2; i++) held = Math.max(held, Math.abs(out[i]));
  let back = 0; for (let i = 24000 * 2.6; i < 24000 * 3; i++) back = Math.max(back, Math.abs(out[i]));
  assert.ok(held < 0.003 && back > 0.1, 'gehalten ' + held.toFixed(4) + ', zurück ' + back.toFixed(3));
  let step = 0; for (let i = 24000 * 0.95; i < 24000 * 1.3; i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
  let ref = 0; for (let i = 24000 * 0.5; i < 24000 * 0.9; i++) ref = Math.max(ref, Math.abs(out[i] - out[i - 1]));
  assert.ok(step <= ref * 1.5, 'kein Sprung beim Ausblenden');
});

test('Motor aus: Drehzahl 0 kommt nur einmal – App sendet bis 2 min weiter, laufender Motor ohne Daten nicht', () => {
  const AudioLink = require(path.join(ROOT, 'apps/iconix_sounds/audio_link.js'));
  const l = new AudioLink(quiet, 'test');
  const sent = []; l.connected = true; l.send = (m) => { sent.push(m); return true; };
  const realNow = setClock(null); let t = 1e12; setClock(() => t);
  try {
    l.params({ rpm: 0, load: 0, speed: 0, overrun: false, at: t });
    t += 60000; l.lastSend = 0; l._tick();
    assert.ok(sent.length >= 2 && sent[sent.length - 1].rpm === 0, 'Motor aus: Lebenszeichen nach 60 s');
    t += 70000; const n = sent.length; l.lastSend = 0; l._tick();
    assert.strictEqual(sent.length, n, 'nach über 2 min nicht mehr');
    l.params({ rpm: 2500, load: 0.5, speed: 80, overrun: false, at: t });
    t += 3000; const m = sent.length; l.lastSend = 0; l._tick();
    assert.strictEqual(sent.length, m, 'laufender Motor ohne neue Daten: nicht weiter senden (sonst hinge der Ton)');
  } finally { setClock(realNow); }
});

test('Oberfläche im Auto (Kit führt den Bildschirm): kein doppelter Titel, breite Ansicht ist Standard', () => {
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const texts = [];
  const g = { rect() {}, rrect() {}, line() {}, arc() {}, text(t) { texts.push(String(t)); } };
  UI.draw(g, { profiles: Profiles.list, profile: 'turbo4', rpm: 900, speed: 0, volume: 0.8, enabled: true, own: true, wide: true, audio: { ok: true, text: 'x' } });
  assert.ok(!texts.includes('Sound Drive'), 'Titel steht schon im Kopf des Kits');
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const by = Object.fromEntries(j.settings.map((x) => [x.key, x]));
  assert.strictEqual(by.narrow.default, false, 'breite Ansicht ist Standard (neuer Schlüssel, alter gespeicherter Wert greift nicht)');
  assert.ok(!by.wide);
  assert.strictEqual(by.knobMusic.default, true);
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/hideButton\('BTN_PROFILE'\)/.test(src), 'untere Leiste ohne "Sound wechseln"');
  assert.ok(/cv\.clear\(UI\.colors\.bg\)/.test(src), 'ganze Fläche gefüllt (kein grauer Streifen)');
  assert.ok(/cv\.tabInfo = TAB_INFO/.test(src) && /tabs: \['Sound'\]/.test(src), 'eigener Reiter: zurück aus den Einstellungen');
  // im Auto verdeckt der Kopf des Kits die oberen 38 px der Seite: dort darf nichts stehen
  const tops = [];
  const g2 = { rect() {}, rrect(x, y) { if (y > 0) tops.push(y); }, line(x1, y1, x2, y2) { tops.push(Math.min(y1, y2)); },
    arc(cx, cy, r) { tops.push(cy - r - 10); }, text(t, x, y, size) { tops.push(y - size); } };
  for (const diag of [null, { lines: ['a', 'b'], page: 0 }]) UI.draw(g2, { profiles: Profiles.list, profile: 'turbo4', rpm: 900, speed: 0, volume: 0.8,
    enabled: true, own: true, wide: true, sport: true, demo: true, mode: 'sport', diag, audio: { ok: true, text: 'x' } });
  assert.ok(Math.min(...tops) >= 44, 'oberste Kante ' + Math.min(...tops) + ' (muss unter 38 + Rand liegen)');
});

test('Dienst: Profilwechsel kurz vor dem Start des Players geht nicht verloren (24-kHz-Umbau)', () => {
  const eng = new E.Engine({ log() {} });
  eng.configure({ profile: 'turbo4', volume: 0.5, enabled: true });
  eng.synth._setProfile('turbo4'); eng.synth.pending = null;
  eng.configure({ profile: 'v10' });                 // App schickt die Einstellungen ...
  assert.strictEqual(eng.synth.pending, 'v10');
  eng._rebuildSynth(24000);                          // ... dann startet der Player (24-kHz-Kanal)
  assert.strictEqual(eng.synth.cfg.profile, 'v10');
  assert.strictEqual(eng.status().profile, 'v10');
});

test('Lautstärkeknopf: Lautstärke-Sprung des Autos beim Verbinden/Trennen ist kein Knopf (keine Schleife)', async () => {
  const { am, signals } = fakeAm({ volJump: 5 });
  const r = new CarRoute(signals, quiet, null);
  const expire = () => { r.knobQuiet = 0; };
  r.want('overlay', true);
  await r._step();                                    // verbinden -> Auto hebt Senke 1 an
  await r._knobTick(); expire(); await r._knobTick();
  assert.ok(!r.knobHeld() && am.conns.length === 1, 'eigenes Verbinden löst keine Pause aus');
  am.vol += 2; await r._knobTick();                   // echter Knopfdreh
  assert.ok(r.knobHeld(), 'echter Dreh erkannt');
  await r._step();                                    // trennen -> Auto senkt Senke 1
  assert.strictEqual(am.conns.length, 0);
  await r._knobTick();                                // Sprung durchs Trennen: verlängert höchstens die Pause
  r.knobAt = Clock.now() - 2000;
  await r._step();                                    // wieder verbinden -> Auto hebt an
  assert.strictEqual(am.conns.length, 1, 'nach Ruhe wieder verbunden');
  for (let i = 0; i < 4; i++) { await r._knobTick(); expire(); }
  await r._step();
  assert.ok(!r.knobHeld() && am.conns.length === 1 && r.audible(), 'bleibt verbunden – keine Schleife');
  assert.ok(r.knobIgnored >= 1, 'Sprünge des Autos gezählt (' + r.knobIgnored + ')');
});

test('Lautstärkeknopf: Ansage (großer Sprung oder neue Verbindung) ist kein Dreh – der Sound bleibt', async () => {
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 1, sourceID: 12, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  await r._step(); await r._pollDuck(); await r._knobTick(); r.knobQuiet = 0;
  am.vol = 9; await r._knobTick();                    // Log aus dem Auto: 34 -> 23
  assert.ok(!r.knobHeld(), 'großer Sprung = Auto');
  am.vol = 20; await r._knobTick();
  assert.ok(!r.knobHeld());
  am.conns.push({ mainConnectionID: 9, sourceID: 77, sinkID: 1024, connectionState: 2 });   // Ansage, kleine Änderung
  am.vol = 18; await r._knobTick();
  assert.ok(!r.knobHeld(), 'neue Verbindung = Ansage');
  r.othersAt = 0; am.vol = 19; await r._knobTick();   // danach ein echter Dreh
  assert.ok(r.knobHeld());
});

test('Synth: Drehzahl kommt nur 10x je Sekunde – der Ton klettert ohne Stufen und ohne Überschwingen', () => {
  const s = new Synth(24000); s.configure({ profile: 'boxer', volume: 0.4, enabled: true, carIdle: 800, carRedline: 4800 }); s._setProfile('boxer');
  const f = new Float32Array(480), v = [];
  const truth = (t) => (t < 1 ? 1500 : t < 4 ? 1500 + 800 * (t - 1) : 3900);
  for (let k = 0; k < 600; k++) { if (k % 10 === 0) s.setParams({ rpm: truth(k / 100), load: 0.5, speed: 60 }); s.render(f, 240); v.push(s.rpm); }
  let jerk = 0; for (let i = 150; i < 390; i++) jerk += Math.abs((v[i] - v[i - 1]) - (v[i - 1] - v[i - 2]));
  assert.ok(jerk / 240 < 3, 'Stufigkeit ' + (jerk / 240).toFixed(1) + ' (ohne Fortschreiben ~7)');
  const lag = s._virtualRpm(truth(3)) - v[300];
  assert.ok(Math.abs(lag) < 60, 'hängt kaum nach: ' + lag.toFixed(0));
  assert.ok(Math.max(...v) - s._virtualRpm(3900) < 120 && Math.abs(v[599] - s._virtualRpm(3900)) < 2, 'kein Überschwingen, ruhiger Endwert');
});

test('Power Four: oben kräftiger als in der Mitte und nicht nur ein Ton', () => {
  const run = (rpm) => { const s = new Synth(24000); s.configure({ profile: 'turbo4', volume: 0.4, enabled: true, carIdle: 800, carRedline: 4800, speedVol: 0 }); s._setProfile('turbo4');
    const f = new Float32Array(4800); let lp = 0, e = 0, lo = 0; const k = 1 - Math.exp(-2 * Math.PI * 130 / 24000);
    for (let i = 0; i < 40; i++) { s.setParams({ rpm, load: 0.9, speed: 60 }); s.render(f, 2400); if (i > 20) for (let j = 0; j < 4800; j += 2) { lp += (f[j] - lp) * k; lo += lp * lp; e += f[j] * f[j]; } }
    return { rms: Math.sqrt(e), low: lo / e }; };
  const m = run(3000), h = run(4500);
  assert.ok(h.rms > m.rms, 'oben lauter: ' + h.rms.toFixed(1) + ' > ' + m.rms.toFixed(1));
  assert.ok(h.low > 0.25, 'Fülle unter der Zündfrequenz: ' + h.low.toFixed(2));
});

test('Autostart: Fahrzeugdienst beim Hochfahren noch nicht bereit – Abo wird wiederholt', async () => {
  const VehicleFeed = require(path.join(ROOT, 'apps/iconix_sounds/vehicle_feed.js'));
  const real = global.setTimeout, waits = [];
  global.setTimeout = (fn, ms) => { waits.push({ fn, ms }); return { unref() {} }; };
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((ok) => setImmediate(ok)); };
  const fire = async (ms) => { const i = waits.findIndex((w) => w.ms === ms); assert.ok(i >= 0, 'Timer ' + ms + ' aus ' + waits.map((w) => w.ms)); waits.splice(i, 1)[0].fn(); await settle(); };
  try {
    const tries = {}, shut = [], h = {};
    const signals = { watch: async (iface, inst, hd) => {
      tries[iface] = (tries[iface] || 0) + 1;
      if (iface === VehicleFeed.IF.FES) return { error: 'Error: no SOME/IP config for x' };
      if (iface === VehicleFeed.IF.CDS && tries[iface] === 1) return { error: 'Error: init timeout', shutdown: () => shut.push('kaputt') };
      if (iface === VehicleFeed.IF.CDS && tries[iface] === 2) throw new Error('boom');
      Object.assign(h, hd);
      return { shutdown: () => shut.push(iface) };
    } };
    const feed = new VehicleFeed(signals, quiet, () => ({ loadSource: 'auto', maxTorque: 400, carIdle: 800 }));
    feed.start(); await settle();
    assert.deepStrictEqual(shut, ['kaputt'], 'halbes Abo aufgeräumt');
    await fire(VehicleFeed.RETRY_MS[0]); await fire(VehicleFeed.RETRY_MS[1]);
    assert.strictEqual(tries[VehicleFeed.IF.CDS], 3, 'bis es klappt');
    assert.strictEqual(tries[VehicleFeed.IF.FES], 1, 'fehlende Schnittstelle nicht wiederholen');
    // steht, liefert aber nie eine Drehzahl -> neu abonnieren; danach Ruhe
    await fire(VehicleFeed.SILENT_MS[0]);
    assert.strictEqual(tries[VehicleFeed.IF.CDS], 4);
    assert.ok(shut.includes(VehicleFeed.IF.CDS), 'altes Abo beendet (keine doppelten Meldungen)');
    h.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 3200 });
    await fire(VehicleFeed.SILENT_MS[1]);
    assert.strictEqual(tries[VehicleFeed.IF.CDS], 4, 'mit Daten kein weiteres Abo');
    feed.stop();
  } finally { global.setTimeout = real; }
});

test('Autostart: Beenden gibt den Tonweg frei; springende Uhrzeit stört nicht', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  assert.strictEqual(am.conns.length, 1);
  await r.stop(); await r._step();
  assert.strictEqual(am.conns.length, 0, 'Verbindung getrennt und nicht neu aufgebaut');
  // die Uhrzeit springt (vor und zurück): Tonweg, Fahrdaten und Dienst merken nichts davon
  const f = fakeAm(), r2 = new CarRoute(f.signals, quiet, null), eng = new E.Engine({ log() {} }), real = Date.now;
  try {
    r2.want('overlay', true); await r2._step(); await r2._knobTick();
    eng.configure({ enabled: true, volume: 0.5 }); eng.params({ rpm: 2000, load: 0.5, speed: 50 }); eng._tick();
    for (const jump of [7200000, -7200000, 3000]) {
      Date.now = () => real() + jump;
      await r2._step(); await r2._knobTick(); eng._tick();
      assert.ok(r2.audible() && f.am.conns.length === 1 && !r2.knobHeld(), 'Tonweg nach Sprung ' + jump);
      assert.ok(!eng.synth.stale && eng.late === 0, 'Dienst nach Sprung ' + jump);
    }
  } finally { Date.now = real; }
});

test('Dienst: Python beim Hochfahren noch nicht da – wird später gefunden', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/engine.js'), 'utf8');
  const fn = /function findPython\(\) \{[\s\S]*?\n\}/.exec(src)[0];
  let there = false;
  const find = new Function('findBin', 'fs', 'path', 'process', 'let pythonCache;' + fn + 'return findPython;')(
    (n) => (there && n === 'python3' ? '/x/python3' : null), { readdirSync: () => [], accessSync() { throw new Error('x'); }, constants: fs.constants }, path, { env: {} });
  assert.strictEqual(find(), null);
  there = true;
  assert.strictEqual(find(), '/x/python3');
});

test('Autostart: Paket, Zeiten im Log und in der Diagnose', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/mark\('app'/.test(src) && /mark\('data'/.test(src) && /mark\('route'/.test(src) && /mark\('play'/.test(src) && /c\.startInfo\(\)/.test(src));
  assert.ok(/host\.app\.on\('shutdown'/.test(src));
  const b = fs.readFileSync(path.join(ROOT, 'kit/tools/build.py'), 'utf8');
  assert.ok(/pkg\['mguAppStartType'\] = 'autostart'/.test(b));
});

test('Dienst: langsames Öffnen des Kanals (nach dem Hochfahren) – kein Stau, keine bleibende Verzögerung', () => {
  const eng = new E.Engine({ log() {} });
  const o = new E.Output(() => {}, () => {}, { device: 'x' });
  let pipe = 0;                                         // was der Player noch nicht gelesen hat (Frames)
  o.child = { stdin: { write: (b) => { pipe += b.length / 2; return pipe < 32768; } } };
  o.fmt = { rate: 24000, ch: 1 }; o.backend = 'x'; o.error = null; o.played = 0; o.gotPos = false; o.sent = 0; o.opened = false;
  eng.out = o;
  eng.synth.configure({ enabled: true, volume: 0.5 });
  const realNow = setClock(null); let t = realNow(); setClock(() => t);
  const run = (ms, player) => { for (let i = 0; i < ms / 10; i++) { t += 10; eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false }); eng._tick(); if (player) player(); } };
  try {
    o.startedAt = t; eng.lastTick = t;
    run(20000);                                         // 20 s bis der Kanal offen ist
    assert.ok(pipe <= 24 * 110, 'nur der Vorlauf wartet: ' + Math.round(pipe / 24) + ' ms');
    assert.ok(eng.status().opening && !eng.status().playing);
    o._open();
    assert.strictEqual(o.openMs, 20000);
    run(3000, () => { pipe = Math.max(0, pipe - 240); o.played = o.sent - pipe; o.gotPos = true; o.blocked = false; });
    const lat = (o.sent - o.played) / 24;
    assert.ok(lat <= 130, 'Verzögerung danach ' + Math.round(lat) + ' ms');
    assert.ok(eng.status().playing && !eng.status().opening);
    // selbst mit Stau (Player ohne Rückmeldung, dann doch): wird wieder abgebaut
    const e2 = new E.Engine({ log() {} }), p = Object.assign(new E.Output(() => {}, () => {}, { device: 'x' }), { fmt: { rate: 24000, ch: 1 }, backend: 'x', error: null, played: 0, gotPos: false, opened: true, openedAt: t, startedAt: t });
    let q = 0; p.child = { stdin: { write: (b) => { q += b.length / 2; return true; } } };
    e2.out = p; e2.synth.configure({ enabled: true }); e2.lastTick = t;
    for (let i = 0; i < 300; i++) { t += 10; e2.params({ rpm: 2000, load: 0.5, speed: 50 }); e2._tick(); }
    assert.ok(q > 24000, 'Takt nach Uhr staut');
    for (let i = 0; i < 600; i++) { t += 10; q = Math.max(0, q - 240); p.played = p.sent - q; p.gotPos = true; e2.params({ rpm: 2000, load: 0.5, speed: 50 }); e2._tick(); }
    assert.ok(q / 24 < 130, 'Stau abgebaut: ' + Math.round(q / 24) + ' ms');
  } finally { setClock(realNow); }
});

test('Dienst: läuft in der CPU-Gruppe der Standarddienste, nicht vor der Bedienoberfläche', () => {
  const u = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/iconix-audiod.service'), 'utf8');
  assert.ok(/^Slice=standard\.slice$/m.test(u) && !/^Nice=-/m.test(u) && /^LimitRTPRIO=10$/m.test(u));
  const py = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/alsa_play.py'), 'utf8');
  assert.ok(/os\.stat\('\/run\/smartx'\)/.test(py) && !/getpwnam/.test(py), 'Besitzer wie der Ordner');
});

test('Autostart: Audiomanager beim Hochfahren tot – Verbindung wird neu aufgebaut', async () => {
  const { am, signals } = fakeAm();
  let built = 0, dead = true, subs = 0; const proxy = signals.proxy, call = signals.call;
  signals.proxy = async (a, b) => { built++; if (built > 2) dead = false; return proxy(a, b); };
  signals.onAvailable = async () => { subs++; };
  signals.call = async (...x) => { if (dead) throw new Error('Service unavailable for call ' + x[1] + '()'); return call(...x); };
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  for (let i = 0; i < 8 && !am.conns.length; i++) { r.nextTry = 0; await r._step(); }
  assert.strictEqual(am.conns.length, 1, 'verbunden nach neuem Aufbau');
  assert.strictEqual(subs, 4, 'Verfügbarkeit abonniert');
});

test('Klang: laut heißt nicht verzerrt – Begrenzer stellt leiser, statt Wellen abzuschneiden', () => {
  const run = (volume, mode, speed) => { const s = new Synth(24000); s.configure({ profile: 'boxer', volume, mode, enabled: true, startSound: false }); s._setProfile('boxer');
    const f = new Float32Array(480), a = new Synth.Biquad().set('hp', 1500, 0.54, 24000), b = new Synth.Biquad().set('hp', 1500, 1.3, 24000); let hi = 0, e = 0, lim = 0, n = 0;
    for (let k = 0; k < 600; k++) { if (k % 6 === 0) s.setParams({ rpm: 1400 + 5 * k, load: 0.85, speed }); s.render(f, 240);
      if (k > 60) for (let i = 0; i < 480; i += 2) { const y = b.run(a.run(f[i])); hi += y * y; e += f[i] * f[i]; if (Math.abs(f[i]) > 0.8) lim++; n++; } }
    return { db: 10 * Math.log10(hi / e), lim: lim / n }; };
  for (const [v, m, sp] of [[0.5, null, 60], [0.6, null, 60], [0.45, 'sport', 130], [1, null, 60]]) {
    const r = run(v, m, sp), clean = run(0.2, m, 60);   // Vergleich: derselbe Klang leise (Sport ist von sich aus offener)
    assert.ok(r.db < clean.db + 2.5, (v * 100) + ' % ' + (m || '') + ': Höhen ' + r.db.toFixed(1) + ' dB, sauber ' + clean.db.toFixed(1));
    if (v <= 0.6) assert.ok(r.lim < 0.2, 'am Begrenzer ' + (100 * r.lim).toFixed(1) + ' %');
  }
});

test('Tonweg: fehlgeschlagenes Trennen wird nachgeholt (sonst bliebe die Musik leise und der Knopf beim Motorsound)', async () => {
  const { am, signals } = fakeAm();
  const call = signals.call; let broken = 0;
  signals.call = async (p, m, x) => { if (m === 'disconnect' && broken-- > 0) throw new Error('timeout'); return call(p, m, x); };
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  broken = 2; r.want('overlay', false);
  await r._step(); assert.strictEqual(am.conns.length, 1, 'Trennen schlug fehl');
  for (let i = 0; i < 3; i++) { r.sweepAt = 0; await r._step(); }
  assert.strictEqual(am.conns.length, 0, 'nachgeholt'); assert.strictEqual(r.orphans.length, 0);
  // fremde Verbindung mit derselben Nummer bleibt unangetastet
  am.conns.push({ mainConnectionID: 77, sourceID: 12, sinkID: 1024, connectionState: 2 }); r.orphans = [77]; r.sweepAt = 0;
  await r._step(); assert.strictEqual(am.conns.length, 1); assert.strictEqual(r.orphans.length, 0);
  // beim Beenden
  r.want('overlay', true); await r._step(); broken = 1; await r.stop();
  assert.ok(!am.conns.some((c) => c.sourceID === 1048), 'Beenden trennt trotz Fehler');
});

test('Diagnose: Tonquellen vollständig im Log (QR-Log schneidet nach 300 Zeichen ab), einmal je Start', async () => {
  const sources = Array.from({ length: 60 }, (x, i) => ({ sourceID: 1000 + i, name: 'QuelleMitLangemNamen_' + i, sourceClassID: i % 5 }));
  const { signals } = fakeAm({ sources }); const call = signals.call;
  signals.call = async (p, m, x) => (m === 'getListSourceClasses' ? { listSourceClasses: [{ sourceClassID: 3, name: 'Interrupt', listClassProperties: [{ classProperty: 'CP_X', value: 1 }] }] } : call(p, m, x));
  const lines = [], r = new CarRoute(signals, { info: (m) => lines.push(m), warn() {} }, null);
  await r.diagLines(); await r.diagLines();
  const all = lines.join(' ');
  sources.forEach((s) => assert.strictEqual(all.split(s.sourceID + ' ' + s.name + ' K').length, 2, s.name));
  assert.ok(lines.every((l) => l.length < 290), 'längste Zeile ' + Math.max(...lines.map((l) => l.length)));
  assert.ok(/AM-Klassen K3 Interrupt \[X=1\]/.test(all), all.slice(-400));
  assert.ok(/AM-Eigenschaften unserer Quelle: unbekannt/.test(all), 'fehlender Aufruf stört nicht');
  const am = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8')).signals['org.genivi.am.commandinterface.CommandControl']._methods;
  assert.ok(am.every((m) => /^(connect|disconnect|getList)/.test(m)), 'nur lesen und verbinden, keine Lautstärke setzen');
});

test('App: "background" gibt es nur einmal (der zweite Eintrag gewänne still)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.strictEqual(src.split(/\n  background\(bg\)/).length - 1, 1);
});

test('Tempo: läuft beim Segeln (Motor aus, keine Drehzahl-Meldungen) weiter', () => {
  const VehicleFeed = require(path.join(ROOT, 'apps/iconix_sounds/vehicle_feed.js'));
  const h = {};
  const feed = new VehicleFeed({ watch: async (i, n, x) => { Object.assign(h, x); return {}; } }, quiet, () => ({ loadSource: 'auto', maxTorque: 400, carIdle: 800 }));
  feed.start();
  const realNow = setClock(null); let t = 2e12; setClock(() => t);
  try {
    h.statusCarSpeed2({ speedVehicleCentreOfGravity: 80 / 0.015625 });
    h.statusEngineSpeed2({ actualValueRPMEngineCrankshaft: 0 });
    t += 3000; assert.strictEqual(feed.speed(), 80, 'gleichmäßige Fahrt: Wert bleibt');
    h.statusCarSpeed2({ speedVehicleCentreOfGravity: 75 / 0.015625 });
    assert.strictEqual(feed.speed(), 75, 'ohne Drehzahl-Meldung aktuell');
    t += 9000; assert.strictEqual(feed.speed(), 0, 'lange keine Daten');
  } finally { setClock(realNow); }
});

test('Tonweg: veraltete Verbindungsliste wirft eine neue Verbindung nicht weg; Pause wird angezeigt', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  const call = signals.call; let release;
  signals.call = async (p, m, x) => { if (m !== 'getListMainConnections') return call(p, m, x); await new Promise((ok) => { release = ok; }); return { listConnections: [] }; };
  const poll = r._pollDuck();                          // Abfrage läuft ...
  while (!release) await new Promise((ok) => setImmediate(ok));
  signals.call = call;
  await r._disconnect(); await r._step();              // ... inzwischen getrennt und neu verbunden
  const fresh = r.conn;
  release(); await poll;
  assert.ok(fresh && r.conn === fresh, 'neue Verbindung bleibt');
  r.knobAt = Clock.now(); await r._step(); await r._step();
  assert.ok(/Pause/.test(r.state), 'Zustand in der Pause: ' + r.state);
  // übernommene Verbindung, die noch aufgebaut wird: noch nicht hörbar
  const f2 = fakeAm({ conns: [{ mainConnectionID: 4, sourceID: 1048, sinkID: 1024, connectionState: 1 }] });
  const r2 = new CarRoute(f2.signals, quiet, null); r2.want('overlay', true); await r2._step();
  assert.ok(r2.conn && !r2.audible());
});

test('Dienst: nicht startbares Abspielprogramm gilt nicht als laufend; Startsound übersteht den Player-Start', async () => {
  const o = new E.Output(() => {}, () => {}, {});
  o.list = [{ name: 'fehlt', path: path.join(tmp, 'gibt-es-nicht'), argv: [] }];
  o.error = null; o.start();
  for (let i = 0; i < 50 && o.child; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(!o.child && o.bad.fehlt && /fehlgeschlagen/.test(o.error || ''), String(o.error));
  const eng = new E.Engine({ log() {} });
  eng.synth.offTime = 5; eng.synth.setParams({ rpm: 700, load: 0, speed: 0 });
  assert.strictEqual(eng.synth.startT, 0);
  eng._rebuildSynth(24000);
  assert.strictEqual(eng.synth.startT, 0, 'Startsound läuft weiter');
});

test('Synth: schnell zurück zum laufenden Profil – der angefangene Wechsel wird verworfen', () => {
  const s = new Synth(24000); s.configure({ profile: 'turbo4', enabled: true }); s._setProfile('turbo4');
  s.configure({ profile: 'v10' });
  assert.strictEqual(s.pending, 'v10');
  s.configure({ profile: 'turbo4' });                 // noch vor dem Ausblenden zurück
  assert.strictEqual(s.pending, null);
  const f = new Float32Array(4800);
  for (let k = 0; k < 20; k++) { s.setParams({ rpm: 2000, load: 0.3, speed: 50 }); s.render(f, 2400); }
  assert.strictEqual(s.cfg.profile, 'turbo4', 'es bleibt der gewählte Sound');
});

test('Dienst: Ton während des Testsounds eingeschaltet bleibt danach an', () => {
  const eng = new E.Engine({ log() {} });
  eng.configure({ profile: 'turbo4', enabled: false });
  eng.test();
  eng._tick();                                        // Test hebt "Stumm" auf
  assert.ok(eng.synth.cfg.enabled && eng._testUnmuted);
  eng.configure({ enabled: true });                   // Nutzer schaltet den Ton an
  eng.testUntil = 0; eng._tick();                     // Test vorbei
  assert.ok(eng.synth.cfg.enabled, 'nicht wieder stumm');
  // ohne Einschalten: nach dem Test wieder stumm wie vorher
  eng.configure({ enabled: false }); eng.test(); eng._tick(); eng.testUntil = 0; eng._tick();
  assert.ok(!eng.synth.cfg.enabled);
  eng.stop();
});

test('App: Tool älter als die App wird angezeigt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  const m = /function olderVersion\(a, b\) \{[\s\S]*?\n\}/.exec(src);
  const olderVersion = new Function(m[0] + '; return olderVersion;')();
  assert.ok(olderVersion('1.0.4', '1.0.5') && olderVersion('1.0.9', '1.0.10') && !olderVersion('1.0.5', '1.0.5') && !olderVersion('1.1.0', '1.0.9'));
  assert.ok(/veraltet – bitte auf/.test(src));
});

test('Profile: Namen, Bauart, Umstellung gelöschter Sounds', () => {
  const names = Profiles.list.map((p) => p.name);
  assert.deepStrictEqual(names, ['Power Four', 'Supra', 'Flat Four', 'Flat Six', 'Rally Five', 'Muscle V8', 'Track V10', 'Grand V12']);
  assert.ok(!/turbo/i.test(Profiles.list.map((p) => p.name + p.desc).join()), 'kein "Turbo" in Namen und Beschreibungen');
  const UI = require(path.join(ROOT, 'apps/iconix_sounds/ui.js'));
  const texts = [];
  const g = { rect() {}, rrect() {}, line() {}, arc() {}, text(t) { texts.push(String(t)); } };
  UI.draw(g, { profiles: Profiles.list, profile: 'boxer6', rpm: 2950, speed: 87, volume: 0.8, enabled: true, wide: true, audio: { ok: true, text: 'x' } });
  assert.ok(texts.includes('Boxer · 6 Zylinder') && !texts.some((t) => /turbo/i.test(t)), 'Bauart: ' + texts.filter((t) => /Zylinder/.test(t)));
  // Mitte des Drehzahlmessers: Tempo, keine ausgeschriebene Drehzahl
  assert.ok(texts.includes('87') && texts.includes('km/h') && !texts.some((t) => /2950|1\/min/.test(t)), texts.join('|'));
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8'));
  const ps = app.settings.find((x) => x.key === 'profile');
  assert.deepStrictEqual(ps.options.map((o) => o[0]), Profiles.ids);
  assert.deepStrictEqual(ps.aliases, { diesel4: 'turbo4', turbo4s: 'turbo4' }, 'gelöschte Sounds werden umgestellt');
  assert.strictEqual(app.screens[0].barEqual, true, 'untere Leiste: gleich große Knöpfe');
});

test('Lautstärkeknopf: Weiterdrehen nach dem Trennen hält die Pause (Sound kommt nicht mitten im Drehen zurück)', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  await r._step(); await r._knobTick(); r.knobQuiet = 0;
  am.vol = 24; await r._knobTick();                   // erster Dreh
  await r._step();                                    // Verbindung frei -> Beruhigungszeit beginnt
  assert.strictEqual(am.conns.length, 0);
  await r._knobTick();                                // Zustand "getrennt" gemerkt (Beruhigung läuft)
  assert.ok(Clock.now() < r.knobQuiet, 'Beruhigung läuft');
  r.knobAt = Clock.now() - 600;                        // 0,6 s nach dem ersten Dreh ...
  am.vol = 27; await r._knobTick();                   // ... wird weiter gedreht
  assert.ok(Clock.now() - r.knobAt < 100, 'Weiterdrehen zählt auch während der Beruhigung');
  await r._step();
  assert.strictEqual(am.conns.length, 0, 'bleibt frei, solange gedreht wird');
});

test('Lautstärkeknopf: Auto ohne Verbindungszustand – Drehen wird trotzdem erkannt, sobald der Ton hörbar ist', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true);
  await r._step();
  am.conns.forEach((c) => { delete c.connectionState; });
  r.connState = null; r.conn.at = Clock.now() - CarRoute.AUDIBLE_AFTER_MS - 10;
  assert.ok(r.audible(), 'nach 8 s hörbar');
  await r._knobTick(); r.knobQuiet = 0;
  am.vol = 23; await r._knobTick();
  assert.ok(r.knobHeld(), 'Dreh erkannt, Knopf gehört der Musik');
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  }
  if (fail) { console.log(fail + ' Test(s) fehlgeschlagen'); process.exit(1); }
  console.log('Alle Iconix-Tonweg-Tests bestanden');
})();
