'use strict';
/*
 * Sound Drive – Fahrzeugdaten über SOME/IP (ctx.signals des idrive7-apps-Kits)
 *
 * Signale und Skalierung laut idrive7-apps (live_data/signals.js, README Abschnitt 7):
 *   Drehzahl  CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft      * 0.25      (65535 = ungültig)
 *   Tempo     Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity        * 0.015625  (65535 = ungültig)
 *   Moment    FES.statusActualValueTorque2.actualValueTorqueCrankshaft    * 0.5 - 1023.5 Nm (4095 = ungültig)
 *   Gaspedal  AcceleratorPedal.AngleAcceleratorPedal.actualValueAngleAcceleratorPedal * 0.025 % (UNBESTÄTIGT)
 *
 * Abgeglichen mit idrive7-apps: kit/runtime/signals.js (watch ist async, liefert das Struct mit Rohwerten,
 * abonniert die Felder – kein Polling nötig) und kit/runtime/car.js (Faktoren, ungültige Rohwerte).
 * Die ersten Rohwerte werden geloggt (data/iconix_sounds.log).
 */
const EventEmitter = require('events');
const Clock = require('./clock');

const IF = {
  CDS: 'de.bmw.infotainment.vehicle.CDS',
  V2: 'de.bmw.infotainment.vehicle.Vehicle2',
  FES: 'de.bmw.infotainment.drivingexcitement.FES',
  PEDAL: 'de.bmw.powertrain.AcceleratorPedal'
};
const FRESH_MS = 1500;
// Das Tempo kommt nur bei Änderung: länger gültig, sonst stünde bei gleichmäßiger Fahrt 0 km/h da
const SPEED_FRESH_MS = 8000;
// Beim Autostart (Head Unit fährt noch hoch) kann ein Fahrzeugdienst fehlen. Das Kit versucht ein Abo nur einmal – darum
// hier wiederholen, sonst bliebe es still, bis die App neu startet. Abstände in ms, der letzte gilt danach weiter.
const RETRY_MS = [3000, 5000, 10000, 20000, 60000];
// Abo steht, aber es kam noch nie eine Drehzahl: nach so langer Zeit neu abonnieren (danach immer seltener)
const SILENT_MS = [30000, 60000, 120000, 300000];
// Vorhersage: die Drehzahl um so viel voraus schätzen (Steigung der letzten ~250 ms), wie Ton im Puffer steht –
// so wirkt der Sound weniger verzögert. Begrenzt, damit Schaltknicke nicht überschießen.
const PREDICT_S = 0.04, PREDICT_MAX = 250;

function pick(v, member) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v[member] === 'number') return v[member];
  return null;
}
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

/**
 * Fahrerlebnisschalter (FES.statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience) -> Fahrmodus.
 * Zahlen wie im Kit-Projekt (apps/redline/hud.js): 1-3, 15, 16, 23, 28 Sport/Boost; 4-6, 10 Comfort/Adaptiv;
 * 7-9 Eco Pro; 17-22 Hybrid/Elektro (wie Comfort). Texte: SPORT_PLUS -> sportplus.
 */
function driveModeOf(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!isNaN(n)) return (n >= 1 && n <= 3) || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport'
    : (n >= 7 && n <= 9) ? 'eco' : (n >= 4 && n <= 6) || n === 10 || (n >= 17 && n <= 22) ? 'comfort' : null;
  const w = String(raw).toUpperCase();
  return /SPORT.?PLUS|SPORT\+|BOOST/.test(w) ? 'sportplus' : /SPORT/.test(w) ? 'sport' : /ECO/.test(w) ? 'eco'
    : /COMFORT|ADAPTIV|HYBRID|ELECTRIC|TRAFFIC/.test(w) ? 'comfort' : null;
}

class VehicleFeed extends EventEmitter {
  /**
   * @param signals  ctx.signals (Kit)
   * @param log      ctx.log
   * @param getCfg   () => { loadSource, maxTorque, carIdle }
   */
  constructor(signals, log, getCfg) {
    super();
    this.signals = signals;
    this.log = log;
    this.getCfg = getCfg;
    this.v = { rpm: 0, rpmAt: 0, speed: 0, speedAt: 0, torque: 0, torqueAt: 0, pedal: 0, pedalAt: 0 };
    this.rpmHist = [];
    this.load = 0;
    this.watches = [];
    this.logged = {};
    this.mode = null;
  }

  start() {
    if (!this.signals || typeof this.signals.watch !== 'function') {
      this.log.warn('iconix: ctx.signals.watch nicht verfügbar – keine Fahrzeugdaten');
      return;
    }
    this._watch(IF.CDS, {
      statusEngineSpeed2: v => {
        const raw = pick(v, 'actualValueRPMEngineCrankshaft');
        this._first('rpm', v);
        if (raw === null || raw === 65535) return;
        this.v.rpm = raw * 0.25; this.v.rpmAt = Clock.now();
        this._sample();
      }
    });
    this._watch(IF.V2, {
      statusCarSpeed2: v => {
        const raw = pick(v, 'speedVehicleCentreOfGravity');
        this._first('speed', v);
        if (raw === null || raw === 65535) return;
        this.v.speed = raw * 0.015625; this.v.speedAt = Clock.now();
      }
    });
    this._watch(IF.FES, {
      statusFESVehicleDynamicSwitchHMI: v => {
        const raw = v && typeof v === 'object' ? v.actualValueModeDrivingExperience : v;
        this._first('mode', v);
        const m = driveModeOf(raw);
        if (m && m !== this.mode) { this.mode = m; this.emit('mode', m); }
      },
      statusActualValueTorque2: v => {
        const raw = pick(v, 'actualValueTorqueCrankshaft');
        this._first('torque', v);
        if (raw === null || raw >= 4095) return; // 12 Bit, 4095 = kein Wert (car.js)
        this.v.torque = raw * 0.5 - 1023.5; this.v.torqueAt = Clock.now();
      }
    });
    this.startAt = Clock.now();
    this._watchSilent(0);
    // Gaspedal nur bei Bedarf abonnieren (siehe _pedalNeeded): jedes Abo kostet beim Hochfahren des Head Units Zeit,
    // und mit Motormoment (FES) wird das Pedal nicht gebraucht
    if (this.getCfg().loadSource === 'pedal') this._watchPedal();
  }

  _watchPedal() {
    if (this.pedalOn) return;
    this.pedalOn = true;
    this.log.info('iconix: Gaspedal wird als Lastquelle abonniert');
    this._watch(IF.PEDAL, {
      AngleAcceleratorPedal: v => {
        const raw = pick(v, 'actualValueAngleAcceleratorPedal');
        this._first('pedal', v);
        if (raw === null) return;
        const pct = raw * 0.025;
        if (pct < -2 || pct > 102) return;
        this.v.pedal = clamp(pct, 0, 100); this.v.pedalAt = Clock.now();
      }
    });
  }

  stop() {
    this.stopped = true;
    if (this.silentTimer) clearTimeout(this.silentTimer);
    this.watches.forEach(w => { try { if (w && w.shutdown) w.shutdown(); } catch (e) { /* egal */ } });
    this.watches = [];
  }

  // signals.watch ist async und liefert { iface, available, proxy, error, shutdown }
  _watch(iface, handlers, attempt) {
    const n = attempt || 0;
    const again = () => {
      if (this.stopped) return;
      const t = setTimeout(() => { if (!this.stopped) this._watch(iface, handlers, n + 1); }, RETRY_MS[Math.min(n, RETRY_MS.length - 1)]);
      if (t.unref) t.unref();
    };
    // dauerhaft nicht da (Auto/Vorschau ohne diese Schnittstelle): nicht wiederholen
    const never = e => /no SOME\/IP config|native module not available|^preview$/.test(String(e));
    if (iface === IF.CDS) this.cds = handlers;
    let p;
    try { p = this.signals.watch(iface, '1', handlers, this.log); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(w => {
      if (!w) return;
      if (w.error) {
        if (n < 3 || n % 10 === 0) this.log.warn('iconix: ' + iface + ' nicht verfügbar' + (n ? ' (Versuch ' + (n + 1) + ')' : '') + ': ' + w.error);
        try { if (w.shutdown) w.shutdown(); } catch (e) { /* egal */ }   // halb eingerichtetes Abo nicht stehen lassen
        if (!never(w.error)) again();
        return;
      }
      if (this.stopped) { try { if (w.shutdown) w.shutdown(); } catch (e) { /* egal */ } return; }
      this.watches.push(w);
      if (iface === IF.CDS) this.cdsWatch = w;
      this.log.info('iconix: ' + iface + ' abonniert' + (n ? ' (Versuch ' + (n + 1) + ')' : ''));
    }).catch(e => { this.log.warn('iconix: watch ' + iface + ' fehlgeschlagen: ' + (e && e.message)); again(); });
  }

  // Abo der Drehzahl steht, liefert aber nie etwas (Dienst beim Abonnieren noch nicht bereit): neu abonnieren
  _watchSilent(n) {
    this.silentTimer = setTimeout(() => {
      if (this.stopped || this.v.rpmAt) return;
      const old = this.cdsWatch;
      if (old) {
        this.log.warn('iconix: noch keine Drehzahl – abonniere neu (' + (n + 1) + ')');
        this.cdsWatch = null;
        this.watches = this.watches.filter(w => w !== old);
        try { if (old.shutdown) old.shutdown(); } catch (e) { /* egal */ }
        this._watch(IF.CDS, this.cds);
      }
      this._watchSilent(n + 1);
    }, SILENT_MS[Math.min(n, SILENT_MS.length - 1)]);
    if (this.silentTimer.unref) this.silentTimer.unref();
  }

  // die ersten Rohwerte ins Log schreiben (zur Kontrolle der Skalierung)
  _first(name, v) {
    const n = this.logged[name] || 0;
    if (n < 3) {
      this.logged[name] = n + 1;
      try { this.log.info('iconix: raw ' + name + ' = ' + JSON.stringify(v)); } catch (e) { /* egal */ }
    }
  }

  fresh(key) { return Clock.now() - this.v[key + 'At'] < FRESH_MS; }

  /** Tempo jetzt (km/h) – unabhängig von der Drehzahl: beim Segeln (Motor aus) kommen keine Drehzahl-Meldungen. */
  speed() { return Clock.now() - this.v.speedAt < SPEED_FRESH_MS ? this.v.speed : 0; }

  _sample() {
    const cfg = this.getCfg();
    const now = Clock.now();
    const rpm = this.v.rpm;
    let load = 0, overrun = false, src = cfg.loadSource;
    // Pedal erst abonnieren, wenn es gebraucht wird: Motor läuft, aber kein Motormoment kommt (Auto ohne FES-Moment)
    if (!this.pedalOn && (src === 'pedal' || (src === 'auto' && rpm > 300 && !this.fresh('torque') && now - (this.startAt || now) > 5000))) this._watchPedal();

    if (src === 'auto') src = this.fresh('torque') ? 'torque' : (this.fresh('pedal') ? 'pedal' : 'rpm');
    // Drehzahlanstieg der letzten ~250 ms (U/min pro s) – für alle Lastquellen
    this.rpmHist.push([now, rpm]);
    while (this.rpmHist.length > 2 && now - this.rpmHist[0][0] > 250) this.rpmHist.shift();
    const h0 = this.rpmHist[0];
    const dt = (now - h0[0]) / 1000;
    const slope = dt > 0.05 ? (rpm - h0[1]) / dt : 0;

    if (src === 'torque' && this.fresh('torque')) {
      load = clamp(this.v.torque / (cfg.maxTorque || 400), 0, 1);
      overrun = this.v.torque < -3 && rpm > cfg.carIdle + 300;
    } else if (src === 'pedal' && this.fresh('pedal')) {
      load = this.v.pedal / 100;
      overrun = this.v.pedal < 1 && rpm > cfg.carIdle + 400;
    } else {
      // Ersatz: Drehzahlanstieg
      load = clamp(slope / 1500, 0, 1);
      overrun = slope < -300 && rpm > cfg.carIdle + 400;
    }
    // Runterschalten: Das Getriebe gibt Zwischengas, die Drehzahl springt hoch, das Moment bleibt aber klein oder
    // negativ (Schub). Ohne Ausgleich klang das wie Schub. Schneller Drehzahlanstieg = Gasstoß -> Last und kein Schub.
    if (slope > 900 && rpm > cfg.carIdle + 200) {
      // laufender Gasstoß: den stärkeren Wert halten; ein abgelaufener zählt nicht mehr (vor dem Verlängern prüfen)
      const prev = this.blipUntil > now ? this.blip || 0 : 0;
      this.blipUntil = now + 250;
      this.blip = Math.max(prev, clamp((slope - 900) / 2500, 0.25, 0.75));
    }
    if (this.blipUntil > now) { load = Math.max(load, this.blip); overrun = false; } else this.blip = 0;
    // leicht glätten, damit Lastsprünge nicht knacken (steigend schneller als fallend)
    this.load += (load - this.load) * (load > this.load ? 0.6 : 0.4);

    const ahead = clamp(slope * PREDICT_S, -PREDICT_MAX, PREDICT_MAX);
    this.emit('sample', {
      rpm: Math.max(0, rpm + ahead),
      load: this.load,
      speed: this.speed(),
      overrun: overrun,
      src: src,
      at: now
    });
  }
}

module.exports = VehicleFeed;
module.exports.IF = IF;
module.exports.RETRY_MS = RETRY_MS;
module.exports.SILENT_MS = SILENT_MS;
module.exports.driveModeOf = driveModeOf;
