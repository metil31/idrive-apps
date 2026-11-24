/*
 * Sound Drive – Motor-/Elektro-Sound-Synthese, Version 2 (physikalisch informiert)
 *
 * Läuft im Audio-Dienst auf dem Head Unit (Node 8) und in der App (Rückfall). Nur ES2017-Syntax.
 *
 *   var s = new IconixSynth(48000);
 *   s.configure({ profile: 'six', volume: 0.7 });
 *   s.setParams({ rpm: 2500, load: 0.6, speed: 80, overrun: false });
 *   s.render(float32InterleavedStereo, frames);   // -> Spitzenwert
 *
 * Aufbau Verbrenner (nach Baldan et al. 2015 "Physically informed car engine sound synthesis" und den
 * offenen Umsetzungen engine-sound-lab / ice-engine-simulator – Ideen und Größenordnungen, kein Code):
 *
 *   Kurbelwelle (720°-Zyklus, Zündwinkel je Zylinder laut Zündfolge, Leerlauf-Ungleichförmigkeit)
 *     -> je Zündung ein Abgas-Druckimpuls: weicher Anstieg, schneller Abfall (Vorauslass) + Nachlauf,
 *        Breite aus Drehzahl, Schärfe aus Last, Streuung von Zyklus zu Zyklus und von Zylinder zu Zylinder
 *     -> zwei Krümmerbänke (Rohr-Waveguides, ungleiche Längen) -> Sammler -> Hauptrohr (Waveguide mit
 *        invertierter Reflexion am offenen Ende) -> Schalldämpferkammer (Kammmodell) -> Dämpfer-Tiefpass
 *        -> Abstrahlung (Fluss + gefilterte Ableitung) -> Gleichanteil weg
 *   + Körperschall: tiefpassgefilterte Zündimpulse (das dumpfe Brummen, das über die Karosserie kommt)
 *   Keine Knackser: Impulse beginnen weich (Anstieg >= 0,7 ms, im Innenraum hört man keine Einzelschläge),
 *   Lastwechsel werden geglättet, kein Mechanik-Klicken, keine Schubumluft, kein Turbo-Rauschen;
 *   nur ein Hauch Rauschen in den Impulsen (Textur), kein Ansaugrauschen.
 *   -> Innenraum: Bassanhebung (Karosserie-Dröhnen 60–90 Hz), Tiefpass ~2–3 kHz (Karosserie dämmt Höhen),
 *      weiche Sättigung, Schutz-Tiefpass 6,5 kHz (nichts darüber -> kein Aliasing, nichts Schrilles)
 *
 * Warum so: Motorsound besteht aus Druckimpulsen, nicht aus Dauertönen; reine Sinus-Obertöne klingen
 * synthetisch und pfeifen. Im Innenraum dominieren tiefe Ordnungen, Höhen über ~2 kHz sind stark gedämpft.
 * Halbordnungen (Brummen) entstehen von selbst aus Zündfolge, Bänken und Zylinder-Streuung.
 *
 * Kosten: pro Sample ein paar aktive Impulse, 4 Verzögerungsleitungen, ~8 Biquads – Steuergrößen nur alle
 * CR = 32 Samples. Keine Allokationen in den Audio-Schleifen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./profiles'));
  else root.IconixSynth = factory(root.IconixProfiles);
})(typeof self !== 'undefined' ? self : this, function (Profiles) {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var CR = 32;               // Control-Rate
  var INV32 = 1 / 4294967296;
  var C_EXH = 520;           // Schallgeschwindigkeit im heißen Abgas (m/s)
  var MAXP = 24;             // gleichzeitige Impulse
  var HEADROOM = 0.85;
  // Kompressor (wie bei Active Sound Design): leise Passagen (Gleiten, Schub, Leerlauf) bis +6 dB lauter,
  // Vollgas bleibt gleich. Pegel bezogen auf Lautstärke 100 %; Verhältnis 3:1 oberhalb COMP_T (leise bis ~+10 dB).
  // oben im Drehzahlband lauter (wie ein echter Motor im Innenraum): bis +RPM_LIFT bei Höchstdrehzahl, nach dem Kompressor
  var RPM_LIFT = 1.0;
  // Lautstärke 100 % = früher 150 % (Boost): der Überschuss über 1 geht vor den Kompressor
  var VOL_SCALE = 1.5;
  // Fahrmodus (Fahrerlebnisschalter): wie aggressiv der Sound ist. -1 = Eco (dezent, dumpf), 0 = Comfort,
  // 1 = Sport (lauter, offener, bellender), 1,4 = Sport+. Übergang weich über ~1 s.
  var MODE_AGG = { eco: -1, comfort: 0, sport: 1, sportplus: 1.4 };
  // Lautstärke steigt mit dem Tempo (Wind- und Abrollgeräusche): ab 50 km/h, volle Anhebung (cfg.speedVol dB) ab 130 km/h
  var SPD_FROM = 50, SPD_FULL = 130;
  // Startsound beim Motorstart: Anlassen (Starter dreht den Motor), Anspringen mit Hochdrehen, Absinken auf Leerlauf
  // Kurz und an der echten Drehzahl: 0,25 s Anlasser, danach folgt der Sound sofort dem Motor, nur mit einem
  // kleinen, abklingenden Hochdrehen (sonst wirkt der Start verzögert, weil eine feste Kurve die echte überdeckt)
  var START_CRANK = 0.25, START_END = 1.1;
  // Fortschreiben der Drehzahl zwischen zwei Meldungen: höchstens RPM_AHEAD, keine Steigung über RPM_GLITCH (U/min je s)
  var RPM_AHEAD = 180, RPM_GLITCH = 9000, RPM_RATE_MAX = 2500;   // schnellere Wechsel (Schalten) nur gebremst fortschreiben: sonst schwingt der Ton über
  var DUCK_GAIN = 0.25;      // abgesenkt (Telefon, Ansage): ~-12 dB
  var LIM_FROM = 0.9, LIM_SLOPE = 0.45;
  var COMP_T = 0.15, COMP_EXP = 0.667, COMP_MAKEUP = 3.0;

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function finite(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  // weicher Begrenzer oberhalb 0,8 (statt hartem Abschneiden bei 1)
  function softLimit(s) { var a = s < 0 ? -s : s, y = 0.85 + 0.13 * Math.tanh((a - 0.85) / 0.13); return s < 0 ? -y : y; }
  function val(v, d) { return v == null ? d : v; }
  function smooth(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }

  // ---------------------------------------------------------------------------
  // Bausteine
  // ---------------------------------------------------------------------------
  /** Biquad (RBJ-Kochbuch), transponierte Direktform II. */
  function Biquad() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  Biquad.prototype.set = function (type, f, q, sr, db) {
    f = clamp(f, 10, sr * 0.45);
    var w = TWO_PI * f / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    var A = Math.pow(10, (db || 0) / 40), b0, b1, b2, a0, a1, a2, sq;
    if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
    else { // lowshelf
      sq = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) - (A - 1) * cs + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sq);
      a0 = (A + 1) + (A - 1) * cs + sq; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sq;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  };
  Biquad.prototype.run = function (x) {
    var y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  };
  Biquad.prototype.reset = function () { this.z1 = 0; this.z2 = 0; };

  /** Verzögerungsleitung (Zweierpotenz, lineare Interpolation). read(d) = Wert von vor d Samples. */
  function Delay(maxSamples) {
    var n = 1; while (n < maxSamples + 4) n <<= 1;
    this.buf = new Float32Array(n); this.mask = n - 1; this.size = n; this.w = 0;
  }
  Delay.prototype.read = function (d) {
    var p = this.w - d + this.size, i = p | 0, f = p - i, m = this.mask, b = this.buf;
    return b[i & m] + (b[(i + 1) & m] - b[i & m]) * f;
  };
  Delay.prototype.write = function (x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; };
  Delay.prototype.reset = function () { this.buf.fill(0); };

  function onePole(f, sr) { return 1 - Math.exp(-TWO_PI * f / sr); }

  // deterministische Zahl in [-1, 1] je Zylinder (fester "Charakter")
  function hash(i, salt) {
    var x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }

  // ---------------------------------------------------------------------------
  // Profil vorbereiten (einmal je Profil)
  // ---------------------------------------------------------------------------
  function prepare(p) {
    if (p._prep) return p._prep;
    var r = { n: 0 };
    if (p.kind === 'electric') {
      var n = Math.min(p.voices.length, 8), ord = new Float64Array(n), amp = new Float64Array(n), det = new Float64Array(n), sum = p.sub || 0;
      for (var i = 0; i < n; i++) { ord[i] = p.voices[i][0]; amp[i] = p.voices[i][1]; det[i] = p.voices[i][2] || 0; sum += amp[i]; }
      r = { n: n, ord: ord, amp: amp, det: det, norm: sum > 0 ? 1 / sum : 1 };
    } else {
      // Zündereignisse: Winkel (Anteil am 720°-Zyklus) aufsteigend, Bank, fester Charakter je Zylinder
      var ev = p.layout.map(function (e, k) { return { a: (e[0] % 720) / 720, bank: e[1] ? 1 : 0, k: k }; })
        .sort(function (x, y) { return x.a - y.a; });
      var N = ev.length;
      r.n = N;
      r.ang = new Float64Array(N); r.bank = new Int8Array(N);
      r.trim = new Float64Array(N); r.uAmp = new Float64Array(N); r.uTime = new Float64Array(N); r.hdr = new Float64Array(N);
      var mean = 0, k2;
      for (k2 = 0; k2 < N; k2++) {
        r.ang[k2] = ev[k2].a; r.bank[k2] = ev[k2].bank;
        r.trim[k2] = 1 + hash(k2, 1) * 0.03;            // ±3 % fest
        r.uAmp[k2] = hash(k2, 2); r.uTime[k2] = hash(k2, 3);
        r.hdr[k2] = hash(k2, 4) * (p.headerSpread || 0); // ungleiche Krümmerlängen (m)
        mean += r.uAmp[k2];
      }
      mean /= N;
      for (k2 = 0; k2 < N; k2++) r.uAmp[k2] -= mean;   // ohne Gleichanteil: verschiebt nur die Balance
      r.cylVol = (p.displacement || 3) / N;
    }
    p._prep = r;
    return r;
  }

  // ---------------------------------------------------------------------------
  function Synth(sampleRate) {
    this.sr = sampleRate || 48000;
    this.cfg = {
      enabled: true, profile: Profiles.DEFAULT,
      volume: 0.6, intensity: 0.7, sport: false, duck: false, mode: null, hold: false,
      speedVol: 4, startSound: true, bassDb: 0, barkPct: 1,
      carIdle: 800, carRedline: 4800
    };
    this.target = { rpm: 800, load: 0, speed: 0, overrun: false };
    this.stale = false;
    this.pending = null;
    this.rpm = 800; this.load = 0; this.speed = 0;
    this.gain = 0; this.vol = 0; this.amp = 0; this.ampStep = 0;
    this.seed = 0x2545F491;
    this.cnt = 0;

    var sr = this.sr;
    function k(sec) { return 1 - Math.exp(-CR / (sr * sec)); }
    this.kRel = Math.exp(-CR / (sr * 0.3)); this.kCompUp = k(0.25);
    this.prePk = 0; this.pkEnv = 0; this.kPk = Math.exp(-CR / (sr * 0.25)); this.cEnv = 0; this.comp = COMP_MAKEUP;
    // Drehzahl zwischen den Meldungen des Autos (nur 10–20 je Sekunde): Tonzeit, Zeit der letzten Meldung, Steigung, Abstand
    this.now = 0; this.rpmAt = -1; this.rpmRate = 0; this.rpmGap = 0;
    this.offTime = -1; this.startT = -1; this.runG = 0; this.kRun = k(0.08);      // Startsound: Motor-aus-Dauer (-1 = läuft/unbekannt), Zeit im Ablauf
    this.agg = 0; this.aggCab = 0; this.kAgg = k(1.0); this.barkMul = 1;
    this.kR = k(0.025); this.kL = k(0.04); this.kS = k(0.2); this.kG = k(0.12); this.kGd = k(0.07); this.kV = k(0.1);

    // Impuls-Pool
    this.pR = new Float64Array(MAXP); this.pE1 = new Float64Array(MAXP); this.pE2 = new Float64Array(MAXP);
    this.pKr = new Float64Array(MAXP); this.pK1 = new Float64Array(MAXP); this.pK2 = new Float64Array(MAXP);
    this.pAmp = new Float64Array(MAXP); this.pTail = new Float64Array(MAXP); this.pNz = new Float64Array(MAXP);
    this.pWait = new Int32Array(MAXP); this.pBank = new Int8Array(MAXP); this.pOn = new Uint8Array(MAXP);
    this.pHigh = 0;

    // Rohre (max. 60 ms)
    var maxD = Math.ceil(sr * 0.06);
    this.hdr0 = new Delay(maxD); this.hdr1 = new Delay(maxD); this.pipe = new Delay(maxD); this.cham = new Delay(maxD);

    // Filter
    this.fMuff = new Biquad(); this.fCabin = new Biquad(); this.fCabin2 = new Biquad(); this.fBoom = new Biquad();
    this.fGuard = new Biquad(); this.fGuard2 = new Biquad(); this.fDc = new Biquad();
    this.fElec = new Biquad(); this.fElec2 = new Biquad();
    this.fBass = new Biquad();
    this.fGuard.set('lp', 6500, 0.71, sr); // nach dem Innenraum-Tiefpass reicht 2. Ordnung
    this.fDc.set('hp', 24, 0.7, sr);

    this._setProfile(this.cfg.profile);
    this._reset();
  }

  Synth.prototype._setProfile = function (id) {
    var p = Profiles.get(id), sr = this.sr;
    this.profile = p;
    this.cfg.profile = p.id;
    this.prep = prepare(p);
    var d = p.drive || 1.2;
    this.drive = d; this.driveNorm = (1 + d) / d;
    // feste Filter des Profils
    this._setBoom();
    this.fCabin.set('lp', p.cabinHz || 2600, 0.6, sr); this.aggCab = 0; // Fahrmodus-Anpassung setzt die Regelung neu
    this.fCabin2.set('peak', 1100, 0.9, sr, p.midDb || 0);
    if (p.kind !== 'electric') {
      var P = this.prep;
      this.dH0 = Math.max(2, 2 * (p.headerM || 0.75) * sr / C_EXH);
      this.dH1 = Math.max(2, 2 * (p.headerM || 0.75) * (p.headerRatio || 1.07) * sr / C_EXH);
      this.dPipe = 2 * (p.pipeM || 3) * sr / C_EXH;
      this.dCham = 2 * (p.chamberM || 0.38) * sr / C_EXH;
      this.kHdrLp = onePole(3200, sr); this.kPipeLp = onePole(p.pipeLp || 2200, sr); this.kChamLp = onePole(3500, sr);
      this.kRadLp = onePole(2000, sr); this.kNz = onePole(2000, sr);
      this.kVib = onePole(p.vibHz || 120, sr);
      this.bark = p.bark != null ? p.bark : 0.8; this.exMix = p.exhaust != null ? p.exhaust : 0.6; this.vibMix = p.vib != null ? p.vib : 1.5;
      // Krümmerverzögerung je Zylinder in Samples (ungleiche Längen)
      this.hdrWait = new Int32Array(P.n);
      for (var i = 0; i < P.n; i++) this.hdrWait[i] = Math.max(0, Math.round(P.hdr[i] / C_EXH * sr));
    } else {
      this.fElec2.set('lp', 3000, 0.7, sr);
    }
  };

  /** Dröhn-Anhebung des Profils und Einstellung "Bass" (dB). */
  Synth.prototype._setBoom = function () {
    var p = this.profile;
    this.bassSet = this.cfg.bassDb;
    this.fBoom.set('lowshelf', p.boomHz || 80, 0.7, this.sr, p.boomDb || 4);
    // Einstellung "Bass": eigener Filter HINTER der Sättigung (davor würde die Sättigung die Anhebung plattdrücken)
    this.useBass = this.cfg.bassDb !== 0;
    if (this.useBass) this.fBass.set('lowshelf', 110, 0.7, this.sr, this.cfg.bassDb);
  };

  Synth.prototype._reset = function () {
    this.phase = 0; this.dist = this.prep && this.prep.ang ? this.prep.ang[0] + 1e-6 : 0; this.next = 0;
    this.pOn.fill(0); this.pHigh = 0;
    this.hdr0.reset(); this.hdr1.reset(); this.pipe.reset(); this.cham.reset();
    this.hLp0 = 0; this.hLp1 = 0; this.pLp = 0; this.pLp2 = 0; this.cLp = 0; this.radLp = 0; this.yPrev = 0;
    this.nz1 = 0; this.nz2 = 0;
    this.cycVar = 0; this.bump = 0; this.vib1 = 0; this.vib2 = 0; this.combS = 0.2;
    this.wob = 0; this.wobT = 0;
    this.fBass.reset();
    var fl = [this.fMuff, this.fCabin, this.fCabin2, this.fBoom, this.fGuard, this.fGuard2, this.fDc,
      this.fElec, this.fElec2];
    for (var i = 0; i < fl.length; i++) fl[i].reset();
    this.ePh = new Float64Array(8); this.eInc = new Float64Array(8); this.eW = new Float64Array(8); this.eN = 0;
    this.subPh = 0; this.subInc = 0; this.subW = 0; this.lfoPh = 0; this.eLevel = 0;
  };

  Synth.prototype.rand = function () {
    var x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x | 0;
    return (x >>> 0) * INV32 * 2 - 1;
  };
  Synth.prototype.gauss = function () { return (this.rand() + this.rand() + this.rand()) * 0.577; };

  Synth.prototype.configure = function (c) {
    if (!c) return;
    for (var k in c) {
      if (!Object.prototype.hasOwnProperty.call(c, k) || k === 'profile') continue;
      if (Object.prototype.hasOwnProperty.call(this.cfg, k)) this.cfg[k] = c[k];
    }
    this.cfg.volume = clamp(finite(+this.cfg.volume, 0.8), 0, 1);
    this.cfg.intensity = clamp(finite(+this.cfg.intensity, 0.7), 0, 1);
    this.cfg.carIdle = clamp(finite(+this.cfg.carIdle, 800), 300, 2000);
    this.cfg.carRedline = clamp(finite(+this.cfg.carRedline, 4800), this.cfg.carIdle + 500, 12000);
    this.cfg.speedVol = clamp(finite(+this.cfg.speedVol, 4), 0, 8);
    this.cfg.bassDb = clamp(finite(+this.cfg.bassDb, 0), -8, 8);
    this.cfg.barkPct = clamp(finite(+this.cfg.barkPct, 1), 0.3, 1.6);
    if (this.cfg.bassDb !== this.bassSet && this.profile) this._setBoom();
    if (c.profile) {
      var want = Profiles.get(c.profile).id;
      // zurück zum laufenden Profil, bevor der Wechsel ausgeblendet war: Wechsel verwerfen (sonst käme das andere)
      if (want === this.cfg.profile) this.pending = null;
      else if (want !== this.pending) this.pending = want;
    }
  };

  Synth.prototype.setParams = function (p) {
    if (!p) return;
    var r = finite(+p.rpm, -1);
    // Motorstart: Motor stand mindestens 0,3 s (unter 150 U/min), jetzt dreht er -> Startsound
    if (r >= 300 && this.offTime >= 0.3 && this.cfg.startSound && this.profile && this.profile.kind !== 'electric') this.startT = 0;
    if (r >= 0 && r < 150) { if (this.offTime < 0) this.offTime = 0; } else if (r >= 150) this.offTime = -1;
    var nr = clamp(finite(+p.rpm, this.target.rpm), 0, 12000);
    if (nr !== this.target.rpm) {
      // Steigung aus zwei Meldungen; schnellere Sprünge (Schaltvorgang, Aussetzer der Daten) nicht fortschreiben
      var dt = this.rpmAt >= 0 ? this.now - this.rpmAt : 0, rate = 0;
      if (dt > 0.015 && dt < 0.3 && nr > 300 && this.target.rpm > 300) {
        rate = (nr - this.target.rpm) / dt;
        if (Math.abs(rate) > RPM_GLITCH) rate = 0;
        else if (rate * this.rpmRate > 0) rate = 0.7 * rate + 0.3 * this.rpmRate;
        this.rpmGap = this.rpmGap > 0 ? this.rpmGap * 0.85 + dt * 0.15 : dt;
      }
      this.rpmRate = rate; this.rpmAt = this.now; this.target.rpm = nr;
    }
    this.target.load = clamp(finite(+p.load, this.target.load), 0, 1);
    this.target.speed = clamp(finite(+p.speed, this.target.speed), 0, 400);
    this.target.overrun = !!p.overrun;
  };

  // Drehzahl jetzt: zwischen zwei Meldungen die Steigung fortschreiben (höchstens bis zur nächsten erwarteten), danach
  // zurück zum letzten Wert. Sonst klettert der Ton beim Beschleunigen in Stufen – das klingt rau.
  Synth.prototype._rpmNow = function () {
    var r = this.target.rpm;
    if (this.rpmRate === 0 || this.rpmAt < 0) return r;
    var age = this.now - this.rpmAt, win = Math.min(this.rpmGap, 0.1);
    var d = clamp(this.rpmRate, -RPM_RATE_MAX, RPM_RATE_MAX) * Math.min(age, win) * 0.9;
    if (age > win) { d *= 1 - (age - win) / 0.12; if (age > win + 0.12) { d = 0; this.rpmRate = 0; } }
    return Math.max(0, r + clamp(d, -RPM_AHEAD, RPM_AHEAD));
  };

  // echte Drehzahl -> virtuelle Drehzahl des Profils
  Synth.prototype._virtualRpm = function (real) {
    var p = this.profile, c = this.cfg;
    if (real < 100) return 0;
    var x = (real - c.carIdle) / (c.carRedline - c.carIdle);
    return clamp(p.idleRpm + x * (p.maxRpm - p.idleRpm), p.idleRpm * 0.6, p.maxRpm * 1.03);
  };

  // ---------------------------------------------------------------------------
  // Control-Rate
  // ---------------------------------------------------------------------------
  Synth.prototype._control = function () {
    var c = this.cfg, sr = this.sr;
    this.now += CR / sr;
    if (this.pending && this.gain < 0.01) {
      this._setProfile(this.pending);
      this.pending = null;
      this._reset();
    }
    var p = this.profile;
    // hold: Tonweg gerade nicht hörbar (verbindet, weg, Lautstärkeknopf gedreht) -> weich aus, danach weich ein
    var tgtGain = (c.enabled && !c.hold && !this.stale && !this.pending) ? 1 : 0;
    // Lautstärkekurve v^1,5 (vorher v²): 60 % klingen jetzt wie früher ~70 %
    var vk = (p.gain || 1) * (c.sport ? 1.3 : 1);
    // über 100 % (Boost): der Überschuss geht VOR den Kompressor -> leise Stellen lauter, Spitzen begrenzt
    var vc = Math.pow(c.volume * VOL_SCALE, 1.5), boost = vc > 1 ? vc : 1;
    var aggT = MODE_AGG[c.mode] || 0;
    this.agg += (aggT - this.agg) * this.kAgg;
    var tgtVol = (vc > 1 ? 1 : vc) * vk * boost * (c.duck ? DUCK_GAIN : 1) * (1 + (this.agg < 0 ? 0.3 : 0.2) * this.agg);
    // Hüllkurve des Pegels (Spitze je Block, ~300 ms Abklingen) -> Kompressionsfaktor
    this.pkEnv = this.prePk > this.pkEnv ? this.prePk : this.pkEnv * this.kPk;   // Spitze vor der Lautstärke (für den Begrenzer)
    var lev = this.prePk * vk * HEADROOM * boost; this.prePk = 0;
    this.cEnv = lev > this.cEnv ? lev : this.cEnv * this.kRel;
    var cg = (this.cEnv > COMP_T ? Math.pow(COMP_T / this.cEnv, COMP_EXP) : 1) * COMP_MAKEUP;
    this.comp += (cg - this.comp) * (cg < this.comp ? 0.5 : this.kCompUp);
    if (this.offTime >= 0) this.offTime += CR / sr;
    var rpmT = p.kind === 'electric' ? 0 : this._virtualRpm(this._rpmNow()), loadT = this.target.load;
    if (this.startT >= 0) {
      var st = this.startT, idle = p.idleRpm;
      if (st < START_CRANK) { rpmT = 230 + 50 * Math.sin(st * 40); loadT = 0.12; }            // Starter dreht
      else { var d = (st - START_CRANK) / (START_END - START_CRANK), fl = Math.exp(-3.5 * d);       // springt an
        rpmT = Math.max(rpmT, idle * (1 + 0.45 * fl)); loadT = Math.max(loadT, 0.55 * fl); }
      this.startT += CR / sr;
      if (this.startT >= START_END || this.target.rpm < 100) this.startT = -1;
    }
    this.rpm += (rpmT - this.rpm) * this.kR;
    this.load += (loadT - this.load) * this.kL;
    this.speed += (this.target.speed - this.speed) * this.kS;
    this.gain += (tgtGain - this.gain) * (tgtGain < this.gain ? this.kGd : this.kG); // ausblenden schneller als einblenden
    this.vol += (tgtVol - this.vol) * this.kV;
    var xr = p.kind === 'electric' ? 0 : clamp(this.rpm / p.maxRpm, 0, 1);
    var spd = clamp((this.speed - SPD_FROM) / (SPD_FULL - SPD_FROM), 0, 1), spdG = Math.pow(10, c.speedVol / 20) - 1;
    // Motor springt an (Drehzahl aus Stille): ~80 ms einblenden – der Kompressor steht nach Stille auf voller
    // Verstärkung und misst den Pegel währenddessen schon mit, sonst käme der erste Zündimpuls als Knall durch
    this.runG += ((p.kind === 'electric' || this.rpm > 30 ? 1 : 0) - this.runG) * this.kRun;
    var newAmp = this.gain * this.vol * HEADROOM * this.comp * this.runG * (1 + RPM_LIFT * xr * Math.sqrt(xr)) * (1 + spdG * smooth(spd));
    // Begrenzer: zu laute Stellen als Ganzes leiser stellen, statt die Wellen abzuschneiden (das klingt rau, wie Kratzen).
    // Über LIM_FROM wächst die Spitze nur noch mit LIM_SLOPE: Lautes bleibt lauter als Leises (Last/Schub, Sport/Comfort).
    var pk = newAmp * this.pkEnv;
    if (pk > LIM_FROM) newAmp = (LIM_FROM + (pk - LIM_FROM) * LIM_SLOPE) / this.pkEnv;
    if (newAmp < 1e-5 && tgtGain === 0) newAmp = 0;
    this.ampStep = (newAmp - this.amp) / CR;
    if (p.kind === 'electric') this._controlElec(); else this._controlComb();
  };

  Synth.prototype._controlComb = function () {
    var p = this.profile, P = this.prep, c = this.cfg, sr = this.sr;
    // Sport wirkt vor allem unter Last (im Leerlauf und beim Ausrollen würden schärfere Impulse knacken), Eco immer
    var rpm = this.rpm, load = this.load;
    var agg = this.agg > 0 ? this.agg * clamp(0.2 + 0.8 * (this.target.overrun ? 0 : load), 0, 1) : this.agg;
    var inten = clamp(c.intensity * (1 + 0.35 * agg), 0.1, 1.3);
    this.barkMul = clamp(1 + 0.5 * agg, 0.5, 1.7) * c.barkPct;
    // Innenraum-Tiefpass mit dem Fahrmodus: Eco dumpfer, Sport offener (nur neu setzen, wenn er sich merklich ändert)
    // "Auspuff-Bellen" (barkPct): wie weit Schalldämpfer und Innenraumfilter öffnen und wie viel Auspuff im Klang ist
    var bk = c.barkPct, open = Math.pow(bk, 0.8);
    var cabF = (p.cabinHz || 2600) * (1 + 0.2 * agg) * Math.pow(bk, 0.6);
    if (Math.abs(cabF - this.aggCab) > 15) { this.aggCab = cabF; this.fCabin.set('lp', cabF, 0.6, sr); }
    this.exMixEff = this.exMix * (0.55 + 0.45 * bk);
    var x = clamp(rpm / p.maxRpm, 0, 1.1);
    this.x = x;
    // Kurbelwinkel je Sample (Anteil am 720°-Zyklus), Leerlauf-Ungleichförmigkeit
    this.dph = rpm > 30 ? rpm / 120 / sr : 0;
    this.rip = 0.05 * clamp(Math.pow(p.idleRpm / Math.max(rpm, 1), 2), 0, 1) * (p.idleRip || 1);
    // Impulsform: Vorauslass-Fenster in Grad -> Zeitkonstanten
    var trev = 60 / Math.max(rpm, 200);
    var tb = (p.blowdown || 62) / 360 * trev;
    var d1 = clamp(tb / 2.2, 0.00035, 0.009);
    var d2 = clamp(150 / 360 * trev * 0.5, 0.0012, 0.03);
    var d1Red = clamp((p.blowdown || 62) / 360 * (60 / p.maxRpm) / 2.2, 0.00035, 0.009);
    var effLoad = this.target.overrun ? 0 : load;
    // unter Last härter (schnellerer Anstieg) -> heller; im Schub/Teillast weich und dunkel
    var soft = 1 + 8 * Math.pow(1 - Math.min(1, effLoad * (0.4 + 0.6 * inten)), 2);
    // im Innenraum keine scharfen Einzelschläge: Anstieg mindestens 0,7 ms, bei niedriger Drehzahl länger
    var rise = Math.max((0.00012 + 0.00022 * Math.sqrt(P.cylVol / 0.5)) * soft, 0.0008 + 0.0016 * clamp(1 - x * 1.6, 0, 1));
    this.kr = Math.exp(-1 / (sr * rise)); this.k1 = Math.exp(-1 / (sr * d1)); this.k2 = Math.exp(-1 / (sr * d2));
    // Pegel: feste Ladung in kürzerem Impuls = höherer Spitzenfluss (gedämpft, damit es oben nicht schreit)
    var flow = Math.pow(d1Red / d1, p.flowExp || 0.55);
    // Schub: kein Verbrennen, nur Pump-/Strömungsimpulse – leiser und dumpf, aber hörbar (Schubblubbern)
    // Grundpegel ohne Last steigt mit der Drehzahl (Strömung, Mechanik) – sonst ist es oben ohne Gas fast still
    var base = 0.18 + 0.32 * Math.pow(clamp((x - 0.2) / 0.6, 0, 1), 1.2);
    var comb = this.target.overrun ? Math.max(val(p.pump, 0.45) * (0.75 + 0.5 * Math.min(x, 1)), base * 0.9) : base + (1 - base) * Math.pow(load, 0.85 * (1 - 0.3 * agg));
    // Lastsprünge (Schalten, Gas weg, Schub) glätten – sonst knackt der Übergang; Gas geben schneller als Gas weg
    this.combS += (comb - this.combS) * (1 - Math.exp(-CR / (sr * (comb > this.combS ? 0.05 : 0.08))));
    comb = this.combS;
    var cylF = Math.pow(P.cylVol / 0.5, 0.35) / Math.sqrt(Math.max(1, P.n) / 4) * clamp(rpm / 250, 0, 1);
    // ohne Last sind die Impulse weich (dunkel) und verlieren Pegel – oben im Drehzahlband ausgleichen
    var noLoadLift = 1 + 1.8 * clamp(1 - effLoad * 6, 0, 1) * clamp((x - 0.25) / 0.6, 0, 1);
    // oben im Drehzahlband verlieren die kurzen Impulse hörbare Energie (gemessen: bei 90 % der Höchstdrehzahl ~1/3
    // des Pegels von 30 %) – vor dem Kompressor ausgleichen, damit es oben lauter statt leiser wird
    var rpmComp = 1 + 2.4 * Math.pow(clamp((x - 0.3) / 0.6, 0, 1), 1.2);
    this.pulseAmp = comb * flow * cylF * noLoadLift * rpmComp;
    this.noiseAmt = val(p.rasp, 0.05) * (0.01 + 0.99 * effLoad * effLoad) * (0.3 + 0.7 * Math.min(x, 1));
    // Zylinder-Ungleichheit unter Last (bringt Halbordnungen = Brummen)
    this.unevW = (p.unev || 0) * Math.min(load, 1) * (0.3 + 0.7 * Math.pow(Math.min(x, 1), 2)) * (0.5 + inten);
    this.idleW = clamp(Math.pow(1 - (x - 0.06) / 0.35, 2), 0, 1) * (x < 0.41 ? 1 : 0);
    // Rohre: Schalldämpfer öffnet etwas mit Last (Klappe)
    this.pipeFb = val(p.pipeFb, 0.3); this.hdrFb = val(p.hdrFb, 0.25); this.chamFb = val(p.chamberFb, 0.3);
    this.fMuff.set('lp', (p.mufflerHz || 1200) * (1 + 0.3 * agg) * open * (0.75 + 0.5 * effLoad * inten + 0.15 * Math.min(x, 1) * (1 - effLoad)) * (0.85 + 0.3 * Math.min(x, 1)), p.mufflerQ || 0.7, sr);
  };

  Synth.prototype._controlElec = function () {
    var p = this.profile, P = this.prep, sr = this.sr, spd = this.speed, load = this.load;
    var f = p.baseHz * Math.pow(2, spd / p.octaveKmh);
    this.eN = P.n;
    for (var i = 0; i < P.n; i++) {
      var dt = f * P.ord[i] * (1 + P.det[i]) / sr;
      if (dt > 0.2) { this.eN = i; break; }
      this.eInc[i] = dt; this.eW[i] = P.amp[i] * P.norm;
    }
    this.subInc = f * 0.5 / sr; this.subW = (p.sub || 0) * P.norm;
    this.fElec.set('lp', clamp(p.cutoff * (0.4 + 0.8 * load * this.cfg.intensity) + spd * p.cutoffPerKmh, 120, 2600), 0.9, sr);
    this.lfoPh += p.lfoHz * CR / sr; if (this.lfoPh >= 1) this.lfoPh -= Math.floor(this.lfoPh);
    var lfo = 1 - p.lfoDepth * (0.5 + 0.5 * Math.sin(TWO_PI * this.lfoPh));
    this.eLevel = (0.3 + 0.7 * load) * lfo * (this.target.overrun ? 0.7 : 1);
  };

  // ---------------------------------------------------------------------------
  // Zündung: einen Impuls in den Pool legen
  // ---------------------------------------------------------------------------
  Synth.prototype._fire = function (k) {
    var P = this.prep, p = this.profile, i, slot = -1;
    for (i = 0; i < MAXP; i++) if (!this.pOn[i]) { slot = i; break; }
    // Zyklus-Streuung: langsame Drift + schnelles Zittern, im Leerlauf stärker
    var vScale = (p.variance || 1) * (0.25 + 0.75 * this.idleW);
    this.cycVar = 0.9 * this.cycVar + 0.436 * this.gauss() * 0.16 * vScale;
    var v = 1 + this.cycVar + 0.05 * vScale * this.gauss();
    var a = this.pulseAmp * P.trim[k] * (1 + 0.7 * this.unevW * P.uAmp[k]) * clamp(v, 0.7, 1.3);
    // Kurbel-Stoß im Leerlauf (Drehzahl schwankt mit jeder Verbrennung)
    this.bump = clamp(this.bump + (v - 1) * 0.035 * (0.3 + this.idleW), -0.12, 0.12);
    if (slot >= 0) {
      this.pOn[slot] = 1; this.pR[slot] = 1; this.pE1[slot] = 1; this.pE2[slot] = 1;
      this.pKr[slot] = this.kr; this.pK1[slot] = this.k1; this.pK2[slot] = this.k2;
      this.pAmp[slot] = a; this.pTail[slot] = 0.25; this.pNz[slot] = this.noiseAmt;
      this.pWait[slot] = this.hdrWait[k]; this.pBank[slot] = P.bank[k];
      if (slot >= this.pHigh) this.pHigh = slot + 1;
    }
  };

  // ---------------------------------------------------------------------------
  // Audio-Schleife Verbrenner
  // ---------------------------------------------------------------------------
  Synth.prototype._blockComb = function (out, off, n) {
    var P = this.prep, N = P.n, ang = P.ang;
    var pOn = this.pOn, pR = this.pR, pE1 = this.pE1, pE2 = this.pE2, pKr = this.pKr, pK1 = this.pK1, pK2 = this.pK2;
    var pAmp = this.pAmp, pTail = this.pTail, pNz = this.pNz, pWait = this.pWait, pBank = this.pBank;
    var hdr0 = this.hdr0, hdr1 = this.hdr1, pipe = this.pipe, cham = this.cham;
    var dH0 = this.dH0, dH1 = this.dH1, dPipe = this.dPipe, dCham = this.dCham;
    var kH = this.kHdrLp, kP = this.kPipeLp, kC = this.kChamLp, kRad = this.kRadLp, kNz = this.kNz;
    var hdrFb = this.hdrFb, pipeFb = this.pipeFb, chamFb = this.chamFb;
    var fMuff = this.fMuff, fBoom = this.fBoom, fCab = this.fCabin, fCab2 = this.fCabin2, fG = this.fGuard, fG2 = this.fGuard2, fDc = this.fDc;
    var useMid = !!this.profile.midDb, useBass = this.useBass, fBass = this.fBass;
    var dph = this.dph, rip = this.rip, phase = this.phase, dist = this.dist, next = this.next;
    var unevT = this.unevW * 0.22 / Math.max(N, 1), uTime = P.uTime;
    var amp = this.amp, ampStep = this.ampStep, drive = this.drive, dn = this.driveNorm;
    var seed = this.seed | 0, peak = 0, pre = 0, bad = false;
    var k, j, r, white, nz1 = this.nz1, nz2 = this.nz2, in0, in1, y, s, a, o = off * 2, e, d, step, hi;
    var bump = this.bump, bumpK = 1 - 1 / (this.sr * 0.08);
    var vib1 = this.vib1, vib2 = this.vib2, kVib = this.kVib, bark = this.bark * this.barkMul, exMix = this.exMixEff || this.exMix, vibMix = this.vibMix;
    var hLp0 = this.hLp0, hLp1 = this.hLp1, pLp = this.pLp, pLp2 = this.pLp2, cLp = this.cLp, radLp = this.radLp, yPrev = this.yPrev;

    for (k = 0; k < n; k++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      white = (seed >>> 0) * INV32 * 2 - 1;
      nz1 += (white - nz1) * kNz; nz2 += (nz1 - nz2) * kNz;   // Rauschen bis ~2 kHz
      r = nz2 * 3.2;

      // Kurbelwelle und Zündungen
      if (dph > 0) {
        step = dph * (1 + rip * Math.sin(TWO_PI * phase * N) + bump);
        phase += step; if (phase >= 1) phase -= 1;
        dist -= step;
        while (dist <= 0) {
          this.nz1 = nz1; this.seed = seed; this.bump = bump;
          this._fire(next);
          seed = this.seed | 0; bump = this.bump;
          var nx = next + 1 < N ? next + 1 : 0;
          var gap = ang[nx] - ang[next]; if (gap <= 0) gap += 1;
          gap += unevT * (uTime[nx] - uTime[next]);
          dist += gap > 0.001 ? gap : 0.001;
          next = nx;
        }
        bump *= bumpK;
      }

      // Impulse summieren (je Bank)
      in0 = 0; in1 = 0; hi = this.pHigh;
      for (j = 0; j < hi; j++) {
        if (!pOn[j]) continue;
        if (pWait[j] > 0) { pWait[j]--; continue; }
        pR[j] *= pKr[j]; pE1[j] *= pK1[j]; pE2[j] *= pK2[j];
        e = 1 - pR[j];
        d = pAmp[j] * e * e * (pE1[j] * (1 + pNz[j] * r) + pTail[j] * pE2[j]);
        if (pBank[j]) in1 += d; else in0 += d;
        if (pE1[j] < 1e-4 && pE2[j] < 1e-4) { pOn[j] = 0; if (j === hi - 1) this.pHigh = hi = j; }
      }

      // Körperschall: die Zündimpulse selbst, stark tiefpassgefiltert (Motorlager, Karosserie)
      vib1 += (in0 + in1 - vib1) * kVib; vib2 += (vib1 - vib2) * kVib;
      // Krümmer (je Bank ein Rohr, invertierte Reflexion, Tiefpass in der Schleife)
      y = hdr0.read(dH0); hLp0 += (y - hLp0) * kH; hdr0.write(in0 - hdrFb * hLp0); in0 = y;
      y = hdr1.read(dH1); hLp1 += (y - hLp1) * kH; hdr1.write(in1 - hdrFb * hLp1); in1 = y;
      // Hauptrohr
      y = pipe.read(dPipe); pLp += (y - pLp) * kP; pLp2 += (pLp - pLp2) * kP;
      pipe.write((in0 + in1) * 0.8 - pipeFb * pLp2);
      // Schalldämpferkammer
      a = cham.read(dCham); cLp += (a - cLp) * kC; cham.write(y + chamFb * cLp);
      y = fMuff.run(y + chamFb * cLp);
      // Abstrahlung am Endrohr: Fluss + Ableitung (oberhalb ~2 kHz gebremst)
      radLp += ((y - yPrev) - radLp) * kRad; yPrev = y;
      // im Innenraum: weniger "Bellen" (Ableitungsanteil), dazu Körperschall
      s = (0.55 * y + bark * radLp) * exMix + vib2 * vibMix;


      // Innenraum: Gleichanteil weg, Bass-Dröhnen, Höhen gedämpft, weiche Sättigung, Schutz-Tiefpass
      s = fDc.run(s);
      s = fBoom.run(s);
      s = fCab.run(s); if (useMid) s = fCab2.run(s);
      y = s * drive;
      s = y / (1 + (y < 0 ? -y : y)) * dn;
      s = fG.run(s);
      if (useBass) s = fBass.run(s);
      a = s < 0 ? -s : s; if (a > pre) pre = a;
      amp += ampStep;
      s *= amp;
      if (s !== s) { s = 0; bad = true; } else if (s > 0.8 || s < -0.8) s = softLimit(s);
      out[o++] = s; out[o++] = s;
      a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    this.phase = phase; this.dist = dist; this.next = next; this.bump = bump;
    this.nz1 = nz1; this.nz2 = nz2;
    this.vib1 = vib1; this.vib2 = vib2;
    this.hLp0 = hLp0; this.hLp1 = hLp1; this.pLp = pLp; this.pLp2 = pLp2; this.cLp = cLp; this.radLp = radLp; this.yPrev = yPrev;
    this.amp = amp; this.seed = seed;
    if (pre > this.prePk) this.prePk = pre;
    if (bad || pLp !== pLp || cLp !== cLp) this._reset();
    return peak;
  };

  // ---------------------------------------------------------------------------
  // Audio-Schleife Elektro (PolyBLEP-Sägezähne + Sub-Sinus, danach dieselbe Innenraum-Kette)
  // ---------------------------------------------------------------------------
  Synth.prototype._blockElec = function (out, off, n) {
    var ph = this.ePh, inc = this.eInc, w = this.eW, V = this.eN;
    var sPh = this.subPh, sInc = this.subInc, sW = this.subW, level = this.eLevel;
    var useBass = this.useBass, fBass = this.fBass;
    var fE = this.fElec, fE2 = this.fElec2, fBoom = this.fBoom, fCab = this.fCabin, fG = this.fGuard, fG2 = this.fGuard2, fDc = this.fDc;
    var amp = this.amp, ampStep = this.ampStep, drive = this.drive, dn = this.driveNorm;
    var peak = 0, pre = 0, bad = false, k, j, x, dt, t, saw, sum, s, y, a, o = off * 2;
    for (k = 0; k < n; k++) {
      sum = 0;
      for (j = 0; j < V; j++) {
        dt = inc[j]; x = ph[j] + dt; if (x >= 1) x -= 1; ph[j] = x;
        saw = 2 * x - 1;
        if (x < dt) { t = x / dt; saw -= t + t - t * t - 1; }
        else if (x > 1 - dt) { t = (x - 1) / dt; saw -= t * t + t + t + 1; }
        sum += w[j] * saw;
      }
      sPh += sInc; if (sPh >= 1) sPh -= 1;
      sum += sW * Math.sin(TWO_PI * sPh);
      s = fE2.run(fE.run(sum)) * level;
      s = fDc.run(s); s = fBoom.run(s); s = fCab.run(s);
      y = s * drive; s = y / (1 + (y < 0 ? -y : y)) * dn;
      s = fG.run(s);
      if (useBass) s = fBass.run(s);
      a = s < 0 ? -s : s; if (a > pre) pre = a;
      amp += ampStep; s *= amp;
      if (s !== s) { s = 0; bad = true; } else if (s > 0.8 || s < -0.8) s = softLimit(s);
      out[o++] = s; out[o++] = s;
      a = s < 0 ? -s : s; if (a > peak) peak = a;
    }
    this.subPh = sPh; this.amp = amp;
    if (pre > this.prePk) this.prePk = pre;
    if (bad) this._reset();
    return peak;
  };

  /** Füllt `out` (Float32Array, Stereo interleaved) mit Samples in [-1, 1]; gibt den Spitzenwert zurück. */
  Synth.prototype.render = function (out, frames) {
    var peak = 0, i = 0, n, pk;
    while (i < frames) {
      if (this.cnt <= 0) { this._control(); this.cnt = CR; }
      n = frames - i < this.cnt ? frames - i : this.cnt;
      if (this.amp === 0 && this.ampStep === 0) {
        for (var z = i * 2, end = (i + n) * 2; z < end; z++) out[z] = 0;
      } else {
        pk = this.profile.kind === 'electric' ? this._blockElec(out, i, n) : this._blockComb(out, i, n);
        if (pk > peak) peak = pk;
      }
      i += n; this.cnt -= n;
    }
    return peak;
  };

  Synth.prototype.state = function () {
    return { profile: this.cfg.profile, rpm: this.rpm, load: this.load, speed: this.speed, gain: this.gain, enabled: this.cfg.enabled };
  };

  Synth.Biquad = Biquad;
  return Synth;
});
