'use strict';
/*
 * Sound Drive – Uhr für Abstände und Fristen: läuft gleichmäßig weiter, auch wenn das Head Unit die Uhrzeit stellt
 * (GPS/Netz nach dem Start). Mit Date.now() wären bei einem Sprung Daten plötzlich "veraltet", Fristen abgelaufen oder
 * stundenlang in der Zukunft. Millisekunden; der Startwert ist beliebig, aber groß (0 heißt überall "nie").
 */
const BASE = 1e9;
module.exports = {
  now() { const t = process.hrtime(); return BASE + t[0] * 1000 + Math.floor(t[1] / 1e6); }
};
