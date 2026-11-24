'use strict';
/**
 * Iconix Sounds – Klang-Analyse und Pegelabgleich der Profile (ohne Auto, ohne Lautsprecher).
 *
 *   node kit/tools/iconix_calibrate.js [profil ...] [--wav ordner] [--rate 24000]
 *
 * Spielt jedes Profil durch eine feste Fahrt (Leerlauf, Vollgas bis zur Abregeldrehzahl eines 220d,
 * Schub, Konstantfahrt, Teillast) und misst je Abschnitt: Pegel (RMS, Spitze), spektralen Schwerpunkt, Anteil der
 * Energie über 1, 2 und 5 kHz, sowie die Rechenzeit. Mit --wav werden die Fahrten als WAV-Dateien
 * geschrieben (so, wie sie im Auto ankommen: --rate 24000 = Overlay-Kanal mono, Synthese direkt in 24 kHz).
 * Ausgabe "gain" = Vorschlag, damit alle Profile unter Vollgas gleich laut sind.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const Synth = require(path.join(ROOT, 'tools/iconix-audiod/synth.js'));
const Profiles = require(path.join(ROOT, 'tools/iconix-audiod/profiles.js'));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const wavDir = opt('--wav', null);
const outRate = Number(opt('--rate', '48000'));
const ids = args.length ? args : Profiles.ids;
const SR = outRate; // wie der Dienst: Synthese direkt in der Kanalrate (24 kHz Overlay, 48 kHz sonst)

// Fahrt: [Dauer s, Funktion t -> {rpm, load, speed, overrun}, Name]
const SCRIPT = [
  [3, () => ({ rpm: 800, load: 0.03, speed: 0, overrun: false }), 'Leerlauf'],
  [6, (t) => ({ rpm: 1100 + 3700 * t / 6, load: 1, speed: 20 + 80 * t / 6, overrun: false }), 'Vollgas'],
  [3, (t) => ({ rpm: 4800 - 3200 * t / 3, load: 0, speed: 100, overrun: true }), 'Schub'],
  [4, () => ({ rpm: 1900, load: 0.3, speed: 90, overrun: false }), 'Konstant'],
  [3, (t) => ({ rpm: 1900 + 1500 * t / 3, load: 0.6, speed: 90 + 20 * t / 3, overrun: false }), 'Teillast']
];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

function analyse(x, sr) {
  const N = 4096, re = new Float64Array(N), im = new Float64Array(N), pow = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += N / 2) {
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = x[s + i] * w; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) pow[i] += re[i] * re[i] + im[i] * im[i];
    frames++;
  }
  let tot = 0, c = 0, a1 = 0, a2 = 0, a5 = 0;
  for (let i = 1; i < N / 2; i++) {
    const f = i * sr / N; tot += pow[i]; c += pow[i] * f;
    if (f > 1000) a1 += pow[i];
    if (f > 2000) a2 += pow[i];
    if (f > 5000) a5 += pow[i];
  }
  let rms = 0, pk = 0;
  for (let i = 0; i < x.length; i++) { rms += x[i] * x[i]; if (Math.abs(x[i]) > pk) pk = Math.abs(x[i]); }
  return { rms: Math.sqrt(rms / x.length), peak: pk, centroid: tot ? c / tot : 0, over1k: tot ? a1 / tot : 0, over2k: tot ? a2 / tot : 0, over5k: tot ? a5 / tot : 0 };
}

function writeWav(file, mono, sr) {
  const pcm = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(mono[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

const rows = [];
for (const id of ids) {
  const s = new Synth(SR);
  s.configure({ profile: id, volume: 1, intensity: 0.7, carIdle: 800, carRedline: 4800 });
  s._setProfile(id); s.pending = null; s._reset();
  const block = 480, f32 = new Float32Array(block * 2);
  const all = [], seg = [];
  let cpu = 0n, total = 0;
  for (const [dur, fn, name] of SCRIPT) {
    const n = Math.round(dur * SR), mono = new Float32Array(n);
    for (let pos = 0; pos < n; pos += block) {
      const m = Math.min(block, n - pos);
      s.setParams(fn(pos / SR));
      const t0 = process.hrtime.bigint();
      s.render(f32, m);
      cpu += process.hrtime.bigint() - t0;
      for (let i = 0; i < m; i++) mono[pos + i] = f32[i * 2];
    }
    total += dur;
    seg.push([name, analyse(mono.subarray(Math.round(SR * 0.5)), SR)]);
    all.push(mono);
  }
  const full = new Float32Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const a of all) { full.set(a, o); o += a.length; }
  const wot = seg.find((x) => x[0] === 'Vollgas')[1];
  rows.push({ id, seg, cpuMsPerS: Number(cpu) / 1e6 / total, gainHint: 0.25 / Math.max(wot.rms, 1e-6) });
  if (wavDir) {
    fs.mkdirSync(wavDir, { recursive: true });
    const out = full;
    writeWav(path.join(wavDir, 'iconix_' + id + '_' + outRate / 1000 + 'k' + '.wav'), out, outRate);
  }
}

for (const r of rows) {
  console.log('\n' + r.id + '  (CPU ' + r.cpuMsPerS.toFixed(1) + ' ms pro s Audio, gain-Vorschlag x' + r.gainHint.toFixed(2) + ')');
  for (const [name, a] of r.seg) {
    console.log('  ' + name.padEnd(9) + ' RMS ' + a.rms.toFixed(3) + '  Spitze ' + a.peak.toFixed(2) + '  Schwerpunkt ' +
      String(Math.round(a.centroid)).padStart(4) + ' Hz  >1k ' + (a.over1k * 100).toFixed(1) + ' %  >2k ' + (a.over2k * 100).toFixed(1) + ' %  >5k ' + (a.over5k * 100).toFixed(2) + ' %');
  }
}
