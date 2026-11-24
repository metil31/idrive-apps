/*
 * Sound Drive – Hauptbildschirm (1600 x 520) im Stil von BMW iDrive 7
 *
 * Aufbau: links "Sound Drive", darunter der Drehzahlmesser und der Status; rechts der aktive Sound, große
 * Profil-Knöpfe (zwei je Reihe, gut während der Fahrt zu treffen) und die Lautstärke.
 * Standard: alles links von x = 1140, denn mit geteilter Ansicht verdeckt das Seitenfenster von iDrive 7 den
 * rechten Teil der Seite. "Breite Ansicht" (ohne Seitenfenster) nutzt die ganze Breite.
 *
 * Gestaltung angelehnt an iDrive 7 und das digitale Kombiinstrument: dunkler, leicht blauer Grund,
 * dünne Linien, Light-Schrift für Zahlen und Titel, BMW-Blau als einzige Akzentfarbe, flache Kacheln
 * mit feinem Rand, Drehzahlmesser mit Skalenstrichen und rotem Bereich.
 *
 * Zeichnet über ein kleines Grafik-Interface `g`, damit derselbe Code im Auto (Kit-Canvas) und im
 * PC-Simulator (HTML-Canvas) läuft:
 *   g.rect(x, y, w, h, color)
 *   g.rrect(x, y, w, h, radius, color)
 *   g.line(x1, y1, x2, y2, width, color)
 *   g.text(str, x, baselineY, size, color, align /* 'left'|'center'|'right' *\/, weight /* true = fett, 'light' = dünn *\/)
 *   g.arc(cx, cy, radius, thickness, a0, a1, color)   // Winkel in Radiant, 0 = 3 Uhr, im Uhrzeigersinn
 *
 * Leistung: nur Rechtecke, Linien, Bögen und Text; keine Allokation pro Bild außer kurzen Strings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconixUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 1600, H = 520;
  var C = {
    bg: '#06090e', bg2: '#0a0f17', panel: '#0f151e', edge: '#233041', track: '#1b2430', tick: '#4d5a6b',
    text: '#f2f5f8', dim: '#8d99aa', faint: '#5b6676',
    accent: '#1c69d4', accent2: '#5fa3ff', hi: '#2f7fe6',
    warn: '#ffb020', crit: '#e8332f', ok: '#3fbf7f'
  };
  // Im Auto (Kit führt den Bildschirm) sind die oberen 38 px der Seite unter dem Kopf des Kits verborgen: alles
  // beginnt darunter (y >= 46) und endet über y = 516.
  var TX = 230, TY = 284, TR = 160;  // Drehzahlmesser: Mitte und Radius
  var A0 = Math.PI * 0.75, A1 = Math.PI * 2.25; // 135° .. 405° (270°-Skala wie im Kombiinstrument)

  function pct(x) { return Math.round(x * 100) + ' %'; }
  var MODE_TAG = { eco: ['ECO', '#3fbf7f'], sport: ['SPORT', '#5fa3ff'], sportplus: ['SPORT+', '#e8332f'] };

  // Geometrie der bedienbaren Flächen – EINE Quelle für Zeichnen, Touch-Ziele im Auto (cv.target)
  // und Klicks im Simulator.
  var X1_NARROW = 1132, X1_WIDE = 1572;
  // Lautstärke als senkrechte Leiste rechts (VOLW breit): [+] oben, Regler, [−] unten. Die Sound-Knöpfe nutzen die
  // ganze Höhe darunter (4 Reihen à CH) und sind so während der Fahrt leichter zu treffen.
  var VOLW = 88, VGAP = 24, VB = VOLW;   // Breite der Leiste, Abstand zu den Knöpfen; −/+ quadratisch
  var CHIP_Y = 108, BOTTOM = 510, RGAP = 10, CH = (BOTTOM - CHIP_Y - 3 * RGAP) / 4;
  var X0 = 488, X1 = X1_NARROW, COLS = 2, GAP = 16, VX = X1 - VOLW, CW = (VX - VGAP - X0 - GAP) / 2;
  function setWide(wide) { X1 = wide ? X1_WIDE : X1_NARROW; VX = X1 - VOLW; CW = (VX - VGAP - X0 - GAP) / 2; }
  function chipRect(i) {
    return { x: X0 + (i % COLS) * (CW + GAP), y: CHIP_Y + Math.floor(i / COLS) * (CH + RGAP), w: CW, h: CH, r: 8 };
  }
  /** Bedienbare Flächen: [{ key, act, arg, x, y, w, h, r }] – act: 'profile' | 'vol' */
  function hits(profiles, wide) {
    setWide(wide);
    var out = [], i, c;
    for (i = 0; i < profiles.length; i++) {
      c = chipRect(i);
      out.push({ key: 'profile:' + profiles[i].id, act: 'profile', arg: profiles[i].id, x: c.x, y: c.y, w: c.w, h: c.h, r: c.r });
    }
    out.push({ key: 'vol+', act: 'vol', arg: 1, x: VX, y: CHIP_Y, w: VOLW, h: VB, r: 8 });
    out.push({ key: 'vol-', act: 'vol', arg: -1, x: VX, y: BOTTOM - VB, w: VOLW, h: VB, r: 8 });
    return out;
  }
  // Diagnose-Ansicht: Geräte testen / Weiter / Schließen
  var DIAG_LINES = 12;   // 126 + 11 * 27 = 423: über den Knöpfen (458)
  function hitsDiag(wide) {
    if (wide !== undefined) setWide(wide);
    return [
      { key: 'diag-devtest', act: 'diagDevTest', arg: null, x: X1 - 640, y: 458, w: 220, h: 46, r: 6 },
      { key: 'diag-next', act: 'diagNext', arg: null, x: X1 - 408, y: 458, w: 190, h: 46, r: 6 },
      { key: 'diag-close', act: 'diagClose', arg: null, x: X1 - 206, y: 458, w: 206, h: 46, r: 6 }
    ];
  }
  // Regler der Lautstärke (zwischen [+] und [−]): Bahn von T0 (100 %) bis T1 (0 %)
  var T0 = CHIP_Y + VB + 70, T1 = BOTTOM - VB - 20;
  /**
   * Lautstärke unter dem Finger (0..1), wenn (x, y) auf dem Regler liegt (die ganze Fläche zwischen [+] und [−],
   * etwas breiter als die Leiste), sonst -1. clamp: Finger außerhalb (beim Ziehen) auf den Rand begrenzen.
   */
  function volAt(x, y, wide, clamp) {
    setWide(!!wide);
    if (!clamp && (x < VX - 16 || x > X1 + 8 || y < CHIP_Y + VB + 4 || y > BOTTOM - VB - 4)) return -1;
    return Math.max(0, Math.min(1, (T1 - y) / (T1 - T0)));
  }
  function hitAt(profiles, x, y, diag, wide) {
    var h = diag ? hitsDiag(!!wide) : hits(profiles, !!wide);
    for (var i = 0; i < h.length; i++) if (x >= h[i].x && x <= h[i].x + h[i].w && y >= h[i].y && y <= h[i].y + h[i].h) return h[i];
    return null;
  }

  // Kachel mit feinem Rand (iDrive: flach, kleiner Radius)
  function tile(g, x, y, w, h, r, fill, edge) {
    g.rrect(x, y, w, h, r, edge);
    g.rrect(x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1.5), fill);
  }

  // Untertitel eines Profils (Bauart)
  function kindOf(p) {
    if (!p) return '';
    if (p.kind === 'electric') return 'Elektro';
    var n = p.layout ? p.layout.length : 0;
    var v = { v8: 'V8', v10: 'V10', v12: 'V12', boxer: 'Boxer · 4 Zylinder', boxer6: 'Boxer · 6 Zylinder' }[p.id];
    return v || (n ? n + ' Zylinder' : '');
  }

  // Statuszeile auf höchstens zwei Zeilen à n Zeichen umbrechen (an " · ")
  function wrap2(t, n) {
    if (t.length <= n) return [t];
    var parts = t.split(' · '), a = '', i = 0;
    while (i < parts.length && (a ? a + ' · ' + parts[i] : parts[i]).length <= n) { a = a ? a + ' · ' + parts[i] : parts[i]; i++; }
    if (!a) {   // erster Teil zu lang: am letzten Leerzeichen trennen, nicht mitten im Wort
      var sp = t.lastIndexOf(' ', n), cut = sp > n / 2 ? sp : n, rest = t.slice(cut).replace(/^ /, '');
      return [t.slice(0, cut), rest.length > n ? rest.slice(0, n - 1) + '…' : rest];
    }
    var b = parts.slice(i).join(' · ');
    return [a, b.length > n ? b.slice(0, n - 1) + '…' : b];
  }

  /**
   * state = {
   *   profiles: [{id, name, kind, layout}], profile: 'turbo4',
   *   rpm, redline, speed, volume (0..1),
   *   enabled, sport, demo,
   *   audio: { ok: bool, text: '…' }
   * }
   */
  function draw(g, s) {
    setWide(!!s.wide);
    g.rect(0, 0, W, H, C.bg);

    // ---- links: App-Name, Drehzahlmesser, Status --------------------------
    // Titel nur, wenn das Kit ihn nicht schon im Kopf zeigt (im Auto mit GPU-Renderer steht er dort)
    if (!s.own) g.text('Sound Drive', 28, 72, 30, C.text, 'left', 'light');
    // Marken neben dem Titel: Fahrmodus (dem der Sound folgt), Sport-Boost, Demo
    var tags = [], tx = s.own ? 28 : 216, m = MODE_TAG[s.mode];
    if (m) tags.push(m);
    if (s.sport) tags.push(['BOOST', C.accent2]);
    if (s.demo) tags.push(['DEMO', C.warn]);
    for (var t = 0; t < tags.length && tx < 440; t++) {
      var tw = tags[t][0].length * 12 + 26;
      tile(g, tx, 48, tw, 30, 15, C.bg, tags[t][1]);
      g.text(tags[t][0], tx + tw / 2, 69, 16, tags[t][1], 'center', true);
      tx += tw + 8;
    }
    drawTacho(g, s);
    var a = s.audio || { ok: false, text: 'Audio-Dienst nicht verbunden' };
    var ls = wrap2(a.text, 38);
    g.rrect(28, 478 - 14, 12, 12, 6, a.ok ? C.ok : C.crit);
    for (var j = 0; j < ls.length; j++) g.text(ls[j], 50, 478 + j * 27, 21, C.dim, 'left', 'light');

    if (s.diag) { drawDiag(g, s); return; }

    // ---- rechts: aktiver Sound, große Profil-Knöpfe, Lautstärke ----------
    var x0 = X0, x1 = X1, i, cur = null;
    for (i = 0; i < s.profiles.length; i++) if (s.profiles[i].id === s.profile) cur = s.profiles[i];
    g.text(cur ? cur.name : '–', x0, 82, 34, s.enabled ? C.text : C.dim, 'left', 'light');
    g.text(kindOf(cur), x1, 82, 20, C.faint, 'right', 'light');
    g.line(x0, 96, x1, 96, 1.5, C.edge);
    g.line(x0, 96, x0 + 96, 96, 3, C.accent);

    for (i = 0; i < s.profiles.length; i++) {
      var c = chipRect(i), active = s.profiles[i].id === s.profile;
      if (active) {
        g.rrect(c.x, c.y, c.w, c.h, c.r, C.accent);
        g.rect(c.x + 4, c.y + 2, c.w - 8, 2, C.hi); // Lichtkante oben
      } else tile(g, c.x, c.y, c.w, c.h, c.r, C.panel, C.edge);
      g.text(s.profiles[i].name, c.x + c.w / 2, c.y + c.h / 2 + 11, s.wide ? 32 : 24, active ? '#ffffff' : '#c3ccd7', 'center', active ? false : 'light');
    }

    // ---- Lautstärke: senkrechte Leiste rechts – [+] oben, Wert, Regler, [−] unten ----------
    var vx = VX, cxv = VX + VOLW / 2, yTop = CHIP_Y, yBot = BOTTOM;
    tile(g, vx, yTop, VOLW, VB, 8, C.panel, C.edge);                       // [+]
    g.line(cxv - 14, yTop + VB / 2, cxv + 14, yTop + VB / 2, 3.5, C.text);
    g.line(cxv, yTop + VB / 2 - 14, cxv, yTop + VB / 2 + 14, 3.5, C.text);
    tile(g, vx, yBot - VB, VOLW, VB, 8, C.panel, C.edge);                  // [−]
    g.line(cxv - 14, yBot - VB / 2, cxv + 14, yBot - VB / 2, 3.5, C.text);
    g.text('Lautstärke', cxv, yTop + VB + 24, 15, C.dim, 'center', 'light');
    g.text(s.enabled ? pct(s.volume) : 'Stumm', cxv, yTop + VB + 50, 24, s.enabled ? C.text : C.warn, 'center', 'light');
    var t0 = T0, t1 = T1;                                                  // Regler von unten (0) nach oben (100 %)
    g.rrect(cxv - 3, t0, 6, t1 - t0, 3, C.track);
    var v = Math.max(0, Math.min(1, s.volume)), ky = t1 - (t1 - t0) * v;
    if (v > 0.01) g.rrect(cxv - 3, ky, 6, t1 - ky, 3, s.enabled ? C.accent : C.faint);
    g.rrect(cxv - 12, ky - 12, 24, 24, 12, s.enabled ? '#ffffff' : C.dim);
  }

  // Drehzahlmesser wie im Kombiinstrument: Skala mit Strichen und Ziffern, roter Bereich, blauer Bogen
  function drawTacho(g, s) {
    var cx = TX, cy = TY, r = TR;
    var redline = s.redline || 4800, top = Math.ceil(redline * 1.1 / 1000) * 1000;
    var rpm = Math.max(0, s.rpm || 0), frac = Math.min(1, rpm / top), redFrom = redline / top;
    var span = A1 - A0, k, ang, cs, sn, major, red;
    g.arc(cx, cy, r, 3, A0, A1, C.track);
    g.arc(cx, cy, r, 3, A0 + span * redFrom, A1, '#5a1c1f');
    // Striche alle 500 U/min, Ziffern (x1000) an den vollen Tausendern
    for (k = 0; k <= top; k += 500) {
      ang = A0 + span * (k / top); cs = Math.cos(ang); sn = Math.sin(ang);
      major = k % 1000 === 0; red = k >= redline;
      var r0 = r - (major ? 24 : 15), r1 = r - 6;
      g.line(cx + cs * r0, cy + sn * r0, cx + cs * r1, cy + sn * r1, major ? 3 : 2, red ? C.crit : (major ? '#c9d1db' : C.tick));
      if (major) g.text(String(k / 1000), cx + cs * (r - 46), cy + sn * (r - 46) + 8, 23, red ? C.crit : C.dim, 'center', 'light');
    }
    // Bogen bis zur aktuellen Drehzahl (blau, im roten Bereich rot) und schmale Nadel
    if (frac > 0.003) {
      var redA = A0 + span * Math.min(frac, redFrom);
      g.arc(cx, cy, r + 9, 8, A0, redA, s.sport ? C.accent2 : C.accent);
      if (frac > redFrom) g.arc(cx, cy, r + 9, 8, A0 + span * redFrom, A0 + span * frac, C.crit);
    }
    ang = A0 + span * frac; cs = Math.cos(ang); sn = Math.sin(ang);
    g.line(cx + cs * (r - 30), cy + sn * (r - 30), cx + cs * (r + 10), cy + sn * (r + 10), 4, frac > redFrom ? C.crit : "#ffffff"); // kurz: verdeckt die Ziffern nicht
    // in der Mitte das Tempo; die Drehzahl zeigt nur die Nadel
    g.text(String(Math.round(s.speed || 0)), cx, cy + 20, 78, C.text, 'center', 'light');
    g.text('km/h', cx, cy + 54, 22, C.dim, 'center', 'light');
  }

  // s.diag = { lines: [...], page: 0 }
  function drawDiag(g, s) {
    var d = s.diag, pages = Math.max(1, Math.ceil(d.lines.length / DIAG_LINES));
    var page = ((d.page || 0) % pages + pages) % pages;
    tile(g, X0 - 20, 46, X1 - X0 + 40, 468, 8, C.panel, C.edge);
    g.text('Audio-Diagnose', X0, 84, 28, C.text, 'left', 'light');
    g.line(X0, 98, X1, 98, 1.5, C.edge);
    g.line(X0, 98, X0 + 96, 98, 3, C.accent);
    g.text('Seite ' + (page + 1) + '/' + pages, X1, 84, 20, C.dim, 'right', 'light');
    var ls = d.lines.slice(page * DIAG_LINES, page * DIAG_LINES + DIAG_LINES);
    var maxL = s.wide ? 102 : 66;   // passend zum Umbruch in main.js (100 bzw. 64 Zeichen)
    ls = ls.map(function (l) { return l.length > maxL ? l.slice(0, maxL - 1) + '…' : l; });
    for (var i = 0; i < ls.length; i++) g.text(ls[i], X0, 126 + i * 27, 19, i === 0 && page === 0 ? C.text : C.dim, 'left', 'light');
    var b = hitsDiag();
    tile(g, b[0].x, b[0].y, b[0].w, b[0].h, b[0].r, C.bg2, C.edge);
    g.text('Geräte testen', b[0].x + b[0].w / 2, b[0].y + 32, 21, C.warn, 'center', 'light');
    tile(g, b[1].x, b[1].y, b[1].w, b[1].h, b[1].r, C.bg2, C.edge);
    g.text('Weiter', b[1].x + b[1].w / 2, b[1].y + 32, 21, C.text, 'center', 'light');
    g.rrect(b[2].x, b[2].y, b[2].w, b[2].h, b[2].r, C.accent);
    g.text('Schließen', b[2].x + b[2].w / 2, b[2].y + 32, 21, '#ffffff', 'center', false);
  }

  return { W: W, H: H, colors: C, draw: draw, hits: hits, hitsDiag: hitsDiag, hitAt: hitAt, volAt: volAt, DIAG_LINES: DIAG_LINES, X1_NARROW: X1_NARROW, X1_WIDE: X1_WIDE };
});
