'use strict';
/*
 * Sound Drive – Tonweg zu den Fahrzeuglautsprechern über den BMW-Audiomanager (GENIVI AM)
 *
 * Ton, der in einen SmartX-Kanal geschrieben wird (ALSA "plug:smartx:<Kanal>"), ist erst hörbar, wenn der
 * Audiomanager die passende Quelle mit einer Lautsprecher-Senke verbindet. Diese Verbindung fordert die App
 * hier an (SOME/IP, app.json "signals": org.genivi.am.*), den Ton selbst schreibt der Dienst iconix-audiod.
 *
 * Wege (ROUTES) zum Ausprobieren im Auto – Quellen-/Senken-Nummern so, wie sie andere Projekte für das
 * iDrive 7 dokumentiert haben (M850i-amn/idrive7-apps, loenne007/idrive-enginesound, Moonride):
 *   287  CarLifeMedia (SmartXbar-Eingang für CarLife, außerhalb Chinas frei)   -> exklusiv, Musik pausiert
 *   1048 OAPGenericOverlay (Kanal Media_Overlay_Converter_Source, 24 kHz mono) -> Mix über der Musik
 *   288  CarLifeNavigation                                                      -> Mix wie eine Navi-Ansage
 *   1024 MediaSink_Front, 1 MainSink
 *
 * Eigene Verbindungen werden mit der Boot-ID in dataDir/iconix_route.json gemerkt; nach einem App-Neustart
 * im selben Boot wird eine liegengebliebene eigene Verbindung zuerst getrennt.
 *
 * Nur Node-8-kompatible Syntax.
 */
const fs = require('fs');
const path = require('path');
const Clock = require('./clock');
const AudioLink = require('./audio_link');

const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const INSTANCE = '1';
const SINK_FRONT = 1024, SINK_MAIN = 1;
const CHECK_MS = 500;       // Takt der Steuerung (kurz: nach einer Pause soll der Sound schnell zurück sein)
const VERIFY_MS = 5000;     // so oft prüfen, ob die eigene Verbindung noch besteht
const RETRY_MS = 1500;      // nach einem Fehler (z. B. E_NOT_POSSIBLE während einer CarPlay-Ansage) so schnell erneut
const CALL_MS = 5000;

// device: Kanal für den Dienst. "smartx:<Name>" löst der Dienst gegen die Kanäle in /dev/shm auf
// (exakter Name oder erster Kanal, der mit <Name>_ beginnt) und öffnet "plug:smartx:<Kanal>".
const ROUTES = {
  overlay:     { label: 'Overlay-Mix', source: 1048, sink: SINK_FRONT, mark: false, device: 'smartx:Media_Overlay_Converter_Source_CF_24_MONO' },
  carlife:     { label: 'CarLife exklusiv', source: 287, sink: SINK_FRONT, mark: true, device: 'smartx:CarLifeMedia_CF_48_STEREO' },
  carlifeNav:  { label: 'CarLife-Navi-Mix', source: 288, sink: SINK_FRONT, mark: true, device: 'smartx:CarLifeNavigation' },
  overlayMain: { label: 'Overlay MainSink', source: 1048, sink: SINK_MAIN, mark: false, device: 'smartx:Media_Overlay_Converter_Source_CF_24_MONO' },
  carlifeMain: { label: 'CarLife MainSink', source: 287, sink: SINK_MAIN, mark: true, device: 'smartx:CarLifeMedia_CF_48_STEREO' },
  carplay:     { label: 'CarPlay-Kanal', source: null, sink: null, mark: false, device: 'smartx:CarPlayMain_CF_48_STEREO' },
  alsa:        { label: 'ALSA direkt', source: null, sink: null, mark: false, device: null }
};
const DEFAULT_ROUTE = 'overlay';
// Absenken (Ducking): solange eine dieser Quellen verbunden ist, wird der Motorsound leiser – Telefon,
// Sprachassistent, Parkpiepser, Warngongs. Navigation und Verkehrsdurchsagen bewusst NICHT (Ton bleibt).
// Namen aus dem Audiomanager (getListMainSources); Musikquellen zählen nicht.
const DUCK_RE = /phone|tel|call|hfp|handsfree|siri|assist|sds|pdc|park|chime|gong|warn|alert|ecall|bcall/i;
const NO_DUCK_RE = /media|radio|tuner|usb|a2dp|music|audio_stream|carlife|overlay|iconix|navi|guidance|tts|prompt|announce|traffic/i;
const DUCK_POLL_MS = 1500;
// Lautstärkeknopf: Das Auto behandelt unsere Quelle wie eine Durchsage – solange sie verbunden ist, regelt der Knopf
// sie statt der Musik (so beschrieben von loenne007/idrive-enginesound). Die Lautstärke, die der Knopf bewegt, steht
// bei der Haupt-Senke (1). Ändert sie sich, tritt der Motorsound zur Seite (stumm, Verbindung frei), der Knopf gehört
// wieder der Musik; nach KNOB_REST_MS ohne Drehen kommt der Sound zurück.
// Die Lautstärke selbst setzt die App nie (setVolume, setConnectionVolumeStep): Im Auto ließ sich danach die Musik
// nicht mehr lauter drehen (loenne007/idrive-enginesound 1.2.5/1.2.6).
const KNOB_POLL_MS = 200, KNOB_REST_MS = 900;
// Größere Sprünge zwischen zwei Abfragen macht das Auto (Ansage: 34 -> 23, danach zurück), keine Hand am Knopf
const KNOB_STEP_MAX = 7;
// kommt oder geht eine andere Verbindung (Navi-Ansage, Telefon), gehören Änderungen so lange dem Auto
const KNOB_OTHERS_MS = 2500;
// älter darf der letzte gelesene Wert nicht sein, um einen Dreh daraus abzuleiten
const KNOB_GAP_MS = 3000;
// Beim Verbinden/Trennen unseres Kanals stellt das Auto die Lautstärke der Haupt-Senke selbst um (eine Durchsage ist
// nie leiser als die Musik). Das ist kein Knopf: nach jedem eigenen Wechsel so lange nur den neuen Wert merken.
const KNOB_SETTLE_MS = 2500;
// Eine Verbindung gilt als hörbar, sobald sie CS_CONNECTED meldet (im Auto ~6 s nach connect) – spätestens nach 8 s.
const AUDIBLE_AFTER_MS = 8000;
const CS = ['CS_UNKNOWN', 'CS_CONNECTING', 'CS_CONNECTED', 'CS_DISCONNECTING', 'CS_DISCONNECTED', 'CS_SUSPENDED'];

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; }
}
function okReply(r) {
  const e = r && typeof r === 'object' ? r.amError : r;
  return e === undefined || e === 'E_OK' || e === 0 || e === 'E_ALREADY_EXISTS';
}
function errOf(r) {
  const e = r && typeof r === 'object' ? r.amError : r;
  return e === undefined ? null : String(e);
}
/** Erstes Array im Ergebnis (listMainConnections, listConnections, listMainSources ...). */
function listOf(r, prefer) {
  if (Array.isArray(r)) return r;
  if (!r || typeof r !== 'object') return [];
  for (let i = 0; i < prefer.length; i++) if (Array.isArray(r[prefer[i]])) return r[prefer[i]];
  const k = Object.keys(r).filter(function (x) { return Array.isArray(r[x]); })[0];
  return k ? r[k] : [];
}
function csName(v) { return typeof v === 'number' ? (CS[v] || String(v)) : String(v); }

class CarRoute {
  /**
   * @param signals  kit/runtime/signals (proxy, call); ohne native SOME/IP bleibt alles aus
   * @param log      ctx.log
   * @param dataDir  Ordner für iconix_route.json
   */
  constructor(signals, log, dataDir) {
    this.signals = signals;
    this.log = log || console;
    this.file = dataDir ? path.join(dataDir, 'iconix_route.json') : null;
    this.am = null; this.amr = null; this.proxyErr = null;
    this.routeId = DEFAULT_ROUTE;
    this.wanted = false;
    this.conn = null;           // { id, routeId, source, sink }
    this.state = 'aus';
    this.connState = null;
    this.lastError = null;
    this.busy = false;
    this.nextTry = 0; this.lastVerify = 0;
    this.timer = null;
    this.cleanupDone = false;
    this.duckOn = true;         // Einstellung "Bei Telefon/Ansagen leiser"
    this.ducked = false; this.duckBy = null;
    this.duckBusy = false; this.lastDuck = 0;
    this.srcNames = {}; this.srcAt = 0;
    this.knobOn = true;         // Einstellung "Lautstärkeknopf regelt die Musik"
    this.knobVol = null; this.knobAt = 0; this.knobBusy = false; this.knobTimer = null; this.knobErr = null;
    this.knobSig = null; this.knobQuiet = 0; this.knobIgnored = 0; this.knobTurns = 0; this.knobWake = null; this.knobReadAt = 0;
    this.others = null; this.othersAt = 0;   // andere aktive Verbindungen (Musik, Ansagen) und wann sie sich änderten
    this.warned = null; this.warnedAt = 0;
    this.stopped = false; this.unavail = 0;
    this.orphans = []; this.sweepAt = 0;     // Verbindungen, deren Trennen fehlschlug (Nummern)
    this.onChange = null;       // fn(): hörbar/gehalten hat sich geändert (die App schaltet den Ton weich)
    this.lastAudible = null;
  }

  static routes() { return ROUTES; }
  static route(id) { return ROUTES[id] || ROUTES[DEFAULT_ROUTE]; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._step(), CHECK_MS);
    this.knobTimer = setInterval(() => this._knobTick(), KNOB_POLL_MS);
    this._step();
  }

  /** App wird beendet: Verbindung freigeben (sonst hält das Auto die Musik abgesenkt und der nächste Start erbt sie). */
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.knobTimer) clearInterval(this.knobTimer);
    if (this.knobWake) clearTimeout(this.knobWake);
    this.timer = this.knobTimer = this.knobWake = null;
    this.wanted = false;
    // beim Trennen nicht aufgeben: bis zu drei Versuche (die Plattform lässt ~200 ms)
    const again = (n) => (n > 0 && this.orphans.length && this.am ? this._sweep().catch(() => again(n - 1)) : Promise.resolve());
    return this.conn && this.am ? this._disconnect().catch(() => {}).then(() => again(3)) : again(3);
  }

  /** Lautstärkeknopf der Musik überlassen an/aus (Einstellung). */
  setKnob(on) { this.knobOn = !!on; if (!on) this.knobAt = 0; }

  /** Gerade gedreht (oder vor < KNOB_REST_MS): Motorsound macht Platz. */
  knobHeld() { return this.knobOn && this.knobAt > 0 && Clock.now() - this.knobAt < KNOB_REST_MS; }

  /**
   * Hört man unseren Kanal gerade? Wege ohne Audiomanager immer; sonst nur mit bestehender Verbindung, die
   * verbunden meldet (oder seit AUDIBLE_AFTER_MS besteht) und solange der Knopf nicht gerade gedreht wird.
   */
  audible() {
    if (!this.needsAm()) return true;
    if (!this.conn || this.knobHeld()) return false;
    return this.connState === 'CS_CONNECTED' || Clock.now() - (this.conn.at || 0) > AUDIBLE_AFTER_MS;
  }

  _changed() {
    const a = this.audible();
    if (a !== this.lastAudible) { this.lastAudible = a; if (this.onChange) { try { this.onChange(a); } catch (e) { /* egal */ } } }
  }

  /** Lautstärke der Haupt-Senke lesen; jede Änderung = Knopf gedreht. Nur solange unser Weg gewünscht ist. */
  async _knobTick() {
    this._changed();
    // nur mit bestehender Verbindung oder während der Pause (weiter drehen verlängert sie) – keine Abfragen beim Hochfahren
    if (!this.knobOn || !this.needsAm() || !(this.conn || this.knobHeld()) || this.knobBusy) return;
    this.knobBusy = true;
    try {
      if (!(await this._proxies())) return;
      const sinks = listOf(await this._call(this.am, 'getListMainSinks', {}, 1500), ['listMainSinks']);
      const s1 = sinks.filter((x) => x.sinkID === SINK_MAIN)[0];
      const v = s1 ? Number(s1.volume) : NaN;
      this.knobErr = s1 ? null : 'Haupt-Senke 1 fehlt';
      // eigener Verbindungswechsel (verbunden, Zustand, getrennt)? dann eine Weile nur beobachten
      const now = Clock.now(), sig = this.conn ? this.conn.id + ':' + this.connState : '-';
      if (sig !== this.knobSig) { this.knobSig = sig; this.knobQuiet = now + KNOB_SETTLE_MS; }
      // Als Knopfdreh zählt eine Änderung
      //  - während der Pause immer (weiter gedreht verlängert sie; auch während der Beruhigung nach unserem Trennen –
      //    sonst käme der Sound 1,5 s nach dem ersten Dreh zurück, obwohl noch gedreht wird), und
      //  - sonst bei hörbarer Verbindung nach der Beruhigung (hörbar = CS_CONNECTED oder ohne Zustandsmeldung nach
      //    AUDIBLE_AFTER_MS – sonst wäre der Knopf bei einem Auto ohne Zustand wieder beim Motorsound).
      // Der Sprung des Autos beim Trennen kann die Pause einmal verlängern, aber keine Schleife auslösen: Nach dem
      // Wiederverbinden zählt erst nach der Beruhigung wieder etwas.
      const counts = this.knobHeld() || (now >= this.knobQuiet && this.audible());
      if (isFinite(v)) {
        // nach einer Lücke (Audiomanager antwortete nicht) ist der alte Wert nichts wert: nur neu merken
        if (now - this.knobReadAt > KNOB_GAP_MS) this.knobVol = null;
        this.knobReadAt = now;
        const moved = this.knobVol !== null && v !== this.knobVol;
        const step = moved ? Math.abs(v - this.knobVol) : 0;
        // in der Pause zählt nur die Größe: unser eigenes Trennen kann andere Verbindungen im Zustand ändern
        const hand = moved && counts && (this.knobHeld() ? step <= KNOB_STEP_MAX : await this._byHand(step));
        if (moved && !hand) this.knobIgnored++;
        if (hand) {
          const was = this.knobHeld();
          this.knobAt = Clock.now();
          // genau nach der Ruhezeit weitermachen, nicht erst mit dem nächsten Takt
          if (this.timer) {
            if (this.knobWake) clearTimeout(this.knobWake);
            this.knobWake = setTimeout(() => { this.knobWake = null; this._changed(); this._step(); }, KNOB_REST_MS + 20);
          }
          if (!was) {
            this.knobTurns++;
            this.log.info('iconix: Lautstärkeknopf gedreht (' + this.knobVol + ' -> ' + v + ') – Motorsound macht der Musik Platz');
            this._changed();
            setTimeout(() => this._step(), 100);   // erst ausblenden (App), dann Verbindung freigeben
          }
        }
        this.knobVol = v;
      }
    } catch (e) { this.knobErr = String(e && e.message || e).slice(0, 60); } finally { this.knobBusy = false; }
  }

  /** Andere aktive Verbindungen (ohne unsere) merken; true = sie haben sich geändert. */
  _noteOthers(list) {
    const own = this.conn ? this.conn.source : CarRoute.route(this.routeId).source;
    const sig = list.filter((c) => c.source !== own && (!c.state || c.state === 'CS_CONNECTED' || c.state === 'CS_CONNECTING'))
      .map((c) => c.source).sort((a, b) => a - b).join(',');
    const changed = this.others !== null && sig !== this.others;
    if (changed) this.othersAt = Clock.now();
    this.others = sig;
    return changed;
  }

  /** Hat eine Hand am Knopf gedreht, oder hat das Auto die Lautstärke umgestellt (Ansage beginnt oder endet)? */
  async _byHand(step) {
    if (step > KNOB_STEP_MAX) return false;
    try { if (this._noteOthers(await this._connections())) return false; } catch (e) { /* Liste nicht lesbar: nach der Größe */ }
    return Clock.now() - this.othersAt > KNOB_OTHERS_MS;
  }

  /** Gewünschten Weg und ob gerade Ton gebraucht wird setzen; die Steuerung folgt im nächsten Takt. */
  want(routeId, on) {
    const id = ROUTES[routeId] ? routeId : DEFAULT_ROUTE;
    if (id !== this.routeId) { this.routeId = id; this.nextTry = 0; this.lastError = null; }
    if (!!on !== this.wanted) { this.wanted = !!on; this.nextTry = 0; }
  }

  /** Absenken an/aus (Einstellung). */
  setDuck(on) { this.duckOn = !!on; if (!on) { this.ducked = false; this.duckBy = null; } }

  /** Ist eine Quelle, bei der abgesenkt wird (nur nach Namen; eigene Quelle und Musik zählen nicht)? */
  static duckName(name) { return !!name && DUCK_RE.test(name) && !NO_DUCK_RE.test(name); }

  /** Andere aktive Verbindungen prüfen: Telefon, Navi-Ansage, Parkpiepser ... -> ducked. */
  async _pollDuck() {
    if (this.duckBusy) return;
    this.duckBusy = true; this.lastDuck = Clock.now();
    try {
      if (!(await this._proxies())) return;
      const c0 = this.conn;      // vor der Abfrage merken: wird inzwischen neu verbunden, gilt die Liste dafür nicht
      const list = await this._connections();
      // eigene Verbindung weg (z. B. CarPlay-Navi hat den Overlay-Platz übernommen)? sofort merken -> stumm
      if (c0 && c0 === this.conn && !this.busy && !list.some((x) => (c0.id != null && x.id === c0.id) || (x.source === c0.source && x.sink === c0.sink))) {
        this.log.warn('iconix: AM-Verbindung ' + c0.id + ' ist weg – verbinde neu');
        this.conn = null; this.connState = null; this.nextTry = 0; this.state = 'verbinde';
        this._save(); this._changed();
      } else if (c0 && c0 === this.conn) {
        const hit0 = list.filter((x) => (c0.id != null && x.id === c0.id) || (x.source === c0.source && x.sink === c0.sink))[0];
        if (hit0 && hit0.state && hit0.state !== this.connState) { this.log.info('iconix: AM-Verbindung ' + hit0.id + ': ' + hit0.state); this.connState = hit0.state; this._changed(); }
      }
      this._noteOthers(list);
      if (!this.duckOn) return;
      const own = this.conn ? this.conn.source : null;
      const active = list.filter((c) => c.source !== own && (!c.state || c.state === 'CS_CONNECTED' || c.state === 'CS_CONNECTING'));
      // Namen der Quellen nachladen, wenn eine unbekannt ist (höchstens alle 30 s)
      if (active.some((c) => !(c.source in this.srcNames)) && Clock.now() - this.srcAt > 30000) {
        this.srcAt = Clock.now();
        try {
          const src = listOf(await this._call(this.am, 'getListMainSources', {}, 3000), ['listMainSources']);
          src.forEach((x) => { this.srcNames[x.sourceID] = String(x.name || ''); });
        } catch (e) { this.srcAt = Clock.now() - 27000; /* in 3 s noch einmal: ohne Namen kein Absenken */ }
      }
      const hit = active.filter((c) => CarRoute.duckName(this.srcNames[c.source]))[0];
      const by = hit ? this.srcNames[hit.source] + ' (' + hit.source + ')' : null;
      if (!!hit !== this.ducked) this.log.info('iconix: ' + (hit ? 'leiser wegen ' + by : 'wieder normal laut'));
      this.ducked = !!hit; this.duckBy = by;
    } catch (e) { /* Liste nicht lesbar: Zustand lassen */ } finally { this.duckBusy = false; }
  }

  needsAm() { const r = ROUTES[this.routeId]; return !!(r && r.source != null); }

  /** Kurzer Text für die Statuszeile. */
  short() {
    const r = CarRoute.route(this.routeId);
    if (!this.needsAm()) return r.label + ' (ohne Audiomanager)';
    let s = r.label + ': ' + this.state;
    if (this.state === 'verbunden' && this.connState && this.connState !== 'CS_CONNECTED') s += ' (' + this.connState + ')';
    if (this.lastError && this.state !== 'verbunden') s += ' – ' + this.lastError;
    if (this.ducked) s += ' · leiser (Telefon/PDC)';
    return s;
  }

  async _proxies() {
    if (this.am && this.amr) return true;
    if (!this.signals || !this.signals.proxy) { this.proxyErr = 'kein SOME/IP'; return false; }
    try {
      for (const x of [['am', AM], ['amr', AMR]]) {
        if (this[x[0]]) continue;
        this[x[0]] = await this.signals.proxy(x[1], INSTANCE);
        // erst nach diesem Abo nimmt die Schnittstelle Aufrufe an, wenn der Dienst beim Hochfahren später kommt
        if (this.signals.onAvailable) Promise.resolve(this.signals.onAvailable(this[x[0]], () => {})).catch(() => {});
      }
      this.proxyErr = null;
      return true;
    } catch (e) {
      this.proxyErr = 'Audiomanager nicht erreichbar: ' + (e && e.message || e);
      return false;
    }
  }

  async _call(p, method, params, ms) {
    try {
      const r = await this.signals.call(p, method, params || {}, ms || CALL_MS);
      this.unavail = 0;
      return r;
    } catch (e) {
      // Verbindung zum Audiomanager bleibt tot (Dienst beim Hochfahren neu gestartet): neu aufbauen
      if (/unavailable/i.test(String(e && e.message || e)) && ++this.unavail >= 5) {
        this.unavail = 0;
        this.log.warn('iconix: Audiomanager antwortet nicht – baue die Verbindung neu auf');
        [this.am, this.amr].forEach((x) => { try { if (x && x.shutdown) Promise.resolve(x.shutdown()).catch(() => {}); } catch (x2) { /* egal */ } });
        this.am = null; this.amr = null;
      }
      throw e;
    }
  }

  async _connections() {
    const r = await this._call(this.am, 'getListMainConnections', {});
    return listOf(r, ['listMainConnections', 'listConnections']).map(function (c) {
      return { id: c.mainConnectionID, source: c.sourceID, sink: c.sinkID, state: c.connectionState !== undefined ? csName(c.connectionState) : null };
    });
  }

  async _mark(source, on) {
    await this._call(this.amr, 'hookSourceAvailablityStatusChange', {
      sourceID: source, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 }
    });
  }

  _save() {
    if (!this.file) return;
    try {
      if (this.conn) fs.writeFileSync(this.file, JSON.stringify({ mainConnectionID: this.conn.id, source: this.conn.source, sink: this.conn.sink, bootId: bootId() }));
      else fs.unlinkSync(this.file);
    } catch (e) { /* egal */ }
  }

  /** Eine im selben Boot liegengebliebene eigene Verbindung trennen (App wurde neu gestartet). */
  async _cleanup() {
    this.cleanupDone = true;
    if (!this.file) return;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { saved = null; }
    if (!saved || saved.mainConnectionID == null) return;
    if (saved.bootId && saved.bootId === bootId()) {
      try {
        await this._call(this.am, 'disconnect', { mainConnectionID: saved.mainConnectionID });
        this.log.info('iconix: alte eigene AM-Verbindung ' + saved.mainConnectionID + ' getrennt');
      } catch (e) { /* schon weg */ }
    }
    try { fs.unlinkSync(this.file); } catch (e) { /* egal */ }
  }

  async _step() {
    if (this.stopped) return;
    const now = Clock.now();
    if ((this.duckOn || this.knobOn) && this.conn && now - this.lastDuck >= DUCK_POLL_MS) this._pollDuck();
    else if (!this.wanted && this.ducked) { this.ducked = false; this.duckBy = null; }
    if (this.busy) return;
    if (this.orphans.length && now - this.sweepAt > RETRY_MS) {
      this.sweepAt = now; this.busy = true;
      try { if (await this._proxies()) await this._sweep(); } catch (e) { /* nächstes Mal */ } finally { this.busy = false; }
    }
    const target = this.wanted && this.needsAm() && !this.knobHeld() ? this.routeId : null;
    const r = target ? ROUTES[target] : null;
    // nichts zu tun?
    if (!target && !this.conn) {
      if (!this.wanted) this.lastError = null;
      this.state = this.knobHeld() ? 'Pause (Lautstärkeknopf)' : this.lastError ? 'Fehler' : 'aus';
      return;
    }
    if (target && this.conn && this.conn.routeId === target && now - this.lastVerify < (this.connState === 'CS_CONNECTED' ? VERIFY_MS : CHECK_MS - 100)) return;
    if (target && !this.conn && now < this.nextTry) return;
    this.busy = true;
    try {
      if (!(await this._proxies())) { this.state = 'Fehler'; this.lastError = this.proxyErr; this.nextTry = now + RETRY_MS; return; }
      if (!this.cleanupDone) await this._cleanup();
      // falscher Weg oder nicht mehr gewünscht -> trennen
      if (this.conn && (!target || this.conn.routeId !== target)) await this._disconnect();
      if (!target) { this.state = this.knobHeld() ? 'Pause (Lautstärkeknopf)' : 'aus'; return; }
      if (this.conn) await this._verify();
      else await this._connect(target, r);
    } catch (e) {
      this.lastError = String(e && e.message || e).slice(0, 80);
      this.state = 'Fehler';
      this.nextTry = Clock.now() + RETRY_MS;
      // während einer Ansage lehnt das Auto jeden Versuch ab: dieselbe Meldung nur alle 15 s ins Log
      if (this.lastError !== this.warned || now - this.warnedAt > 15000) { this.warned = this.lastError; this.warnedAt = now; this.log.warn('iconix: Audiomanager: ' + this.lastError); }
    } finally {
      this.busy = false;
    }
  }

  async _connect(id, r) {
    this.state = 'verbinde';
    // belegte Verbindungen derselben Quelle übernehmen (Quelle 287/288 nutzt außerhalb Chinas niemand sonst)
    let list = [];
    try { list = await this._connections(); } catch (e) { list = []; }
    const same = list.filter(function (c) { return c.source === r.source; });
    for (let i = 0; i < same.length; i++) {
      if (same[i].sink === r.sink) {
        // besteht schon (z. B. von einem früheren Lauf): übernehmen
        this.conn = { id: same[i].id, routeId: id, source: r.source, sink: r.sink, at: Clock.now() - (same[i].state === 'CS_CONNECTING' ? 0 : AUDIBLE_AFTER_MS) };
        this.connState = same[i].state;
        this.state = 'verbunden'; this.lastError = null; this.lastVerify = Clock.now();
        this._save(); this._changed();
        this.log.info('iconix: AM-Verbindung ' + same[i].id + ' (' + r.source + ' -> ' + r.sink + ') übernommen');
        return;
      }
      try { await this._call(this.am, 'disconnect', { mainConnectionID: same[i].id }); } catch (e) { /* egal */ }
      this.log.info('iconix: fremde AM-Verbindung ' + same[i].id + ' der Quelle ' + r.source + ' getrennt');
    }
    if (r.mark) await this._mark(r.source, true);
    const res = await this._call(this.am, 'connect', { sourceID: r.source, sinkID: r.sink });
    if (!okReply(res)) {
      if (r.mark) { try { await this._mark(r.source, false); } catch (e) { /* egal */ } }
      throw new Error('connect ' + r.source + '->' + r.sink + ' abgelehnt: ' + errOf(res));
    }
    let cid = res && res.mainConnectionID;
    // ID (bei E_ALREADY_EXISTS fehlt sie) und Zustand gleich aus der Liste – hörbar ist sie erst ab CS_CONNECTED
    this.connState = null;
    try {
      const hit = (await this._connections()).filter(function (c) { return (cid != null && c.id === cid) || (c.source === r.source && c.sink === r.sink); })[0];
      if (hit) { if (cid == null) cid = hit.id; this.connState = hit.state; }
    } catch (e) { /* egal */ }
    this.conn = { id: cid, routeId: id, source: r.source, sink: r.sink, at: Clock.now() };
    this.state = 'verbunden'; this.lastError = null; this.lastVerify = Clock.now();
    this._save(); this._changed();
    this.log.info('iconix: AM verbunden ' + r.source + ' -> ' + r.sink + ' (' + r.label + '), mainConnectionID ' + cid + ', amError ' + errOf(res));
  }

  async _verify() {
    this.lastVerify = Clock.now();
    let list;
    try { list = await this._connections(); } catch (e) { return; } // Liste nicht lesbar: so lassen
    const c = this.conn;
    if (!c) return;                       // inzwischen schon als verloren erkannt (_pollDuck)
    const hit = list.filter(function (x) { return (c.id != null && x.id === c.id) || (x.source === c.source && x.sink === c.sink); })[0];
    if (!hit) {
      this.log.warn('iconix: AM-Verbindung ' + c.id + ' ist weg – verbinde neu');
      this.conn = null; this.connState = null; this.nextTry = 0; this.state = 'verbinde';
      this._save(); this._changed();
      return;
    }
    if (hit.state !== this.connState) this.log.info('iconix: AM-Verbindung ' + hit.id + ': ' + hit.state);
    this.connState = hit.state;
    this._changed();
  }

  async _disconnect() {
    const c = this.conn;
    if (!c) return;
    this.conn = null; this.connState = null;
    this._save(); this._changed();
    if (c.id != null) {
      try { await this._call(this.am, 'disconnect', { mainConnectionID: c.id }); } catch (e) {
        // sonst bliebe sie im Auto offen: Musik leise, Knopf beim Motorsound – später erneut trennen
        this.log.warn('iconix: AM disconnect: ' + e);
        this.orphans.push(c.id);
      }
    }
    const r = ROUTES[c.routeId];
    if (r && r.mark) {
      let left = [];
      try { left = (await this._connections()).filter(function (x) { return x.source === c.source; }); } catch (e) { left = []; }
      if (!left.length) { try { await this._mark(c.source, false); } catch (e) { /* egal */ } }
    }
    this.log.info('iconix: AM getrennt ' + c.source + ' -> ' + c.sink);
  }

  /** Verbindungen trennen, deren Trennen fehlschlug. Vergebene Nummern prüfen: nur, wenn sie noch unsere Quelle hat. */
  async _sweep() {
    const ids = this.orphans.slice();
    const list = await this._connections();
    for (let i = 0; i < ids.length; i++) {
      const x = list.filter((y) => y.id === ids[i])[0];
      const ours = x && Object.keys(ROUTES).some((k) => ROUTES[k].source === x.source) && !(this.conn && this.conn.id === x.id);
      if (ours) await this._call(this.am, 'disconnect', { mainConnectionID: x.id });   // wirft: bleibt in der Liste
      this.orphans = this.orphans.filter((y) => y !== ids[i]);
      if (ours) this.log.info('iconix: AM-Verbindung ' + x.id + ' nachträglich getrennt');
    }
  }

  /**
   * Für die Suche nach einer Quelle, die den Lautstärkeknopf nicht übernimmt: Quellen mit Klasse, die Eigenschaften der
   * Klassen und die Senken ins Log (QR-Log), je App-Start einmal. Nur lesend; fehlende Aufrufe werden übergangen.
   */
  async _logCar(src) {
    if (this.loggedCar) return;
    this.loggedCar = true;
    const put = (t) => AudioLink.logLong(this.log, t);
    const props = (a) => (Array.isArray(a) ? a.map((p) => (p && typeof p === 'object' ? Object.keys(p).map((k) => String(p[k]).replace(/^(CP|SP|MSP)_/, '')).join('=') : String(p))).join(' ') : '');
    put('AM-Quellen ' + src.map((x) => x.sourceID + ' ' + x.name + (x.sourceClassID !== undefined ? ' K' + x.sourceClassID : '')).join(', '));
    const each = async (m, key, what, params, fn) => {
      try { const l = listOf(await this._call(this.am, m, params, 3000), [key]); put(what + ' ' + (l.map(fn).join(', ') || 'keine')); } catch (e) { put(what + ': ' + String(e && e.message || e).slice(0, 120)); }
    };
    await each('getListSourceClasses', 'listSourceClasses', 'AM-Klassen', {}, (c) => 'K' + c.sourceClassID + ' ' + c.name + ' [' + props(c.listClassProperties) + ']');
    await each('getListMainSourceSoundProperties', 'listSourceProperties', 'AM-Eigenschaften unserer Quelle', { sourceID: 1048 }, (p) => props([p]));
    await each('getListMainSinks', 'listMainSinks', 'AM-Senken', {}, (x) => x.sinkID + ' ' + (x.name || '') + (x.sinkClassID !== undefined ? ' K' + x.sinkClassID : '') + ' vol ' + x.volume);
    await each('getListMainConnections', 'listConnections', 'AM-Verbindungen', {}, (c) => c.sourceID + '->' + c.sinkID + ' ' + csName(c.connectionState));
  }

  /** Zeilen für die Audio-Diagnose: Weg, Verbindung, Quellen und Senken des Audiomanagers. */
  async diagLines() {
    const r = CarRoute.route(this.routeId);
    const out = ['--- Tonweg (Audiomanager) ---', 'Weg: ' + r.label + (r.source != null ? ' · Quelle ' + r.source + ' -> Senke ' + r.sink : '') +
      (r.device ? ' · Kanal ' + r.device.replace(/^smartx:/, '') : '')];
    out.push('Status: ' + this.short() + (this.conn ? ' · ID ' + this.conn.id : ''));
    out.push('Lautstärkeknopf: ' + (!this.knobOn ? 'regelt den Motorsound (wie im Auto vorgesehen)' : 'regelt die Musik – Motorsound macht beim Drehen Platz') +
      (this.knobVol !== null ? ' · Senke 1: ' + this.knobVol : '') + (this.knobTurns ? ' · ' + this.knobTurns + 'x gedreht' : '') + (this.knobIgnored ? ' · ' + this.knobIgnored + ' Änderungen durchs Auto ignoriert' : '') + (this.knobErr ? ' · ' + this.knobErr : ''));
    out.push('Absenken: ' + (!this.duckOn ? 'aus' : this.ducked ? 'aktiv wegen ' + this.duckBy : 'bereit (Telefon, PDC, Gong – nicht bei Navigation)'));
    if (!(await this._proxies())) { out.push(this.proxyErr); return out; }
    const fmt = (a, idKey) => a.map(function (x) { return x[idKey] + ' ' + (x.name || ''); }).join(', ');
    try {
      const conns = await this._connections();
      out.push('Verbindungen: ' + (conns.length ? conns.map(function (c) { return c.id + ': ' + c.source + '->' + c.sink + (c.state ? ' ' + c.state.replace('CS_', '') : ''); }).join(', ') : 'keine'));
    } catch (e) { out.push('Verbindungen: ' + e); }
    try {
      const src = listOf(await this._call(this.am, 'getListMainSources', {}, 3000), ['listMainSources']);
      out.push('Quellen: ' + (fmt(src, 'sourceID') || 'keine'));
      await this._logCar(src);
    } catch (e) { out.push('Quellen: ' + e); }
    try {
      const snk = listOf(await this._call(this.am, 'getListMainSinks', {}, 3000), ['listMainSinks']);
      out.push('Senken: ' + (fmt(snk, 'sinkID') || 'keine'));
    } catch (e) { out.push('Senken: ' + e); }
    return out;
  }
}

module.exports = CarRoute;
module.exports.ROUTES = ROUTES;
module.exports.DEFAULT_ROUTE = DEFAULT_ROUTE;
module.exports.DUCK_POLL_MS = DUCK_POLL_MS;
module.exports.KNOB_REST_MS = KNOB_REST_MS;
module.exports.KNOB_SETTLE_MS = KNOB_SETTLE_MS;
module.exports.AUDIBLE_AFTER_MS = AUDIBLE_AFTER_MS;
