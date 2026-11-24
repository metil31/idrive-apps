'use strict';
/**
 * Tonweg im Chaos: simuliertes Auto (Audiomanager) in virtueller Zeit mit Ansagen, Knopfdrehs, Telefon, Ausfällen,
 * Uhrsprüngen und Aufruffehlern. Geprüft: Nach jeder Störung kommt der Ton zurück, nie doppelt verbunden, keine Pause
 * ohne Dreh, Trennen wird nachgeholt.   node kit/tools/test_iconix_chaos.js [Zufallsfolge]
 */
const path = require('path');
const CarRoute = require(path.join(__dirname, '..', '..', 'apps/iconix_sounds/car_route.js'));
let seed = Number(process.argv[2]) || 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const realST = setTimeout, realSI = setImmediate, realNow = Date.now;
let bad = 0; const fail = (m) => { if (bad++ < 30) console.log('FAIL ' + m); };
// virtuelle Uhr
let now = 1.8e12, q = [], id = 1;
global.setTimeout = (fn, ms) => { const x = { id: id++, t: now + (ms || 0), fn }; q.push(x); return x; };
global.clearTimeout = global.clearInterval = (x) => { if (x) x.dead = true; };
global.setInterval = (fn, ms) => { const x = { id: id++, t: now + ms, fn, ms }; q.push(x); return x; };
require(path.join(__dirname, '..', '..', 'apps/iconix_sounds/clock.js')).now = () => now;
const tick = () => new Promise((ok) => realSI(ok));
async function advance(ms) {
  const end = now + ms;
  for (;;) { q = q.filter((x) => !x.dead); let n = null; for (const x of q) if (x.t <= end && (!n || x.t < n.t || (x.t === n.t && x.id < n.id))) n = x; if (!n) break; now = Math.max(now, n.t); if (n.ms) n.t += n.ms; else n.dead = true; n.fn(); await tick(); await tick(); }
  now = end;
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
function car(o) {
  const c = { conns: [{ mainConnectionID: 1, sourceID: 1, sinkID: 1024, connectionState: 2 }], id: 2, music: 30, ours: 30, ann: 0, log: [], calls: 0, connects: 0, dis: 0, dead: 0, log2: [] };
  const own = () => c.conns.find((x) => x.sourceID === 1048);
  c.vol = () => (c.ann > now ? 22 : own() && own().connectionState === 2 ? c.ours : c.music);
  c.turn = (d) => { if (c.ann > now) return; const w = own(); if (w && w.connectionState === 2) { c.ours = Math.max(0, Math.min(55, c.ours + d)); c.hitOurs = (c.hitOurs || 0) + 1; } else { c.music = Math.max(0, Math.min(55, c.music + d)); c.hitMusic = (c.hitMusic || 0) + 1; } };
  c.announce = (ms, kill) => { c.ann = now + ms; c.conns.push({ mainConnectionID: 900 + c.id, sourceID: 60, sinkID: 1024, connectionState: 2 }); const x = c.conns[c.conns.length - 1]; if (kill) c.conns = c.conns.filter((y) => y.sourceID !== 1048); setTimeout(() => { c.conns = c.conns.filter((y) => y !== x); }, ms); };
  c.signals = {
    proxy: async () => { await sleep(20); if (c.dead > now) throw new Error('not available'); return {}; },
    onAvailable: async () => {},
    call: async (p, m, x, ms) => {
      c.calls++; if (!p) throw new Error('kein Proxy');
      await sleep(5 + rnd() * 60 + (rnd() < 0.01 ? 2000 : 0));
      if (c.dead > now) { await sleep(rnd() < 0.5 ? 0 : ms); throw new Error(rnd() < 0.5 ? 'Service unavailable for call ' + m : 'timeout'); }
      if (rnd() < (o.err || 0)) throw new Error('zufälliger Fehler');
      if (m === 'getListMainConnections') return { listConnections: c.conns.map((y) => Object.assign({}, y)) };
      if (m === 'getListMainSinks') return { listMainSinks: [{ sinkID: 1024, volume: 0 }, { sinkID: 1, volume: c.vol() }] };
      if (m === 'getListMainSources') return { listMainSources: [{ sourceID: 1, name: 'FM' }, { sourceID: 60, name: 'NaviPrompt' }, { sourceID: 70, name: 'HandsfreePhone' }, { sourceID: 1048, name: 'OAPGenericOverlay' }] };
      if (m === 'connect') { if (c.ann > now && rnd() < 0.8) return { amError: 'E_NOT_POSSIBLE' }; if (own()) return { amError: 'E_ALREADY_EXISTS' }; c.connects++; const y = { mainConnectionID: c.id++, sourceID: x.sourceID, sinkID: x.sinkID, connectionState: 1 }; c.conns.push(y); setTimeout(() => { y.connectionState = 2; c.ours = Math.max(c.ours, c.music); }, 800 + rnd() * 1500); return { amError: 'E_OK', mainConnectionID: y.mainConnectionID }; }
      if (m === 'disconnect') { c.dis++; c.conns = c.conns.filter((y) => y.mainConnectionID !== x.mainConnectionID); return { amError: 'E_OK' }; }
      return {};
    }
  };
  c.own = own; return c;
}
async function drive(name, hours, o) {
  q = []; const c = car(o), msgs = [];
  const r = new CarRoute(c.signals, { info: (m) => msgs.push(m), warn: (m) => msgs.push(m) }, null);
  let aud = 0, tot = 0, gapMax = 0, gap = 0, turnsDone = 0, anns = 0, audible = false; r.onChange = (a) => { audible = a; };
  r.want('overlay', true); r.start();
  const end = now + hours * 3600000; let quietUntil = now + 15000;
  while (now < end) {
    const u = rnd();
    if (u < o.turn) { const n = 1 + Math.floor(rnd() * 8), dir = rnd() < 0.5 ? -1 : 1; for (let i = 0; i < n; i++) { c.turn(dir * (rnd() < 0.2 ? 2 : 1)); await advance(80 + rnd() * 300); } turnsDone++; quietUntil = now + 9000; }
    else if (u < o.turn + o.ann) { const ms = 1500 + rnd() * 7000; c.announce(ms, rnd() < 0.5); anns++; quietUntil = now + ms + 9000; }
    else if (u < o.turn + o.ann + o.phone) { const x = { mainConnectionID: 800 + c.id, sourceID: 70, sinkID: 1024, connectionState: 2 }; c.conns.push(x); await advance(20000); if (!r.ducked && c.own() && c.dead < now - 12000) fail(name + ': Telefon senkt nicht ab | duckBusy ' + r.duckBusy + ' conn ' + JSON.stringify(r.conn)); c.conns = c.conns.filter((y) => y !== x); await advance(6000); if (r.ducked && c.own()) fail(name + ': bleibt abgesenkt'); quietUntil = now + 9000; }
    else if (u < o.turn + o.ann + o.phone + o.dead) { c.dead = now + 3000 + rnd() * 40000; if (rnd() < 0.5) c.conns = c.conns.filter((y) => y.sourceID !== 1048); quietUntil = c.dead + 25000; }
    else if (rnd() < o.clock) { const d = (rnd() - 0.5) * 7200000; Date.now = () => realNow() + d; }   // nur die Uhrzeit springt
    else if (rnd() < o.off) { r.want('overlay', false); await advance(8000); if (c.own() && c.dead < now - 12000) fail(name + ': nicht getrennt, obwohl aus | orph ' + r.orphans + ' conn ' + JSON.stringify(r.conn) + ' own ' + JSON.stringify(c.own()) + ' | ' + msgs.slice(-4).join(' / ')); r.want('overlay', true); quietUntil = now + 12000; }
    if (c.dead + 30000 > quietUntil) quietUntil = Math.max(quietUntil, c.dead + 30000);
    await advance(1000);
    tot++; if (audible) { aud++; gap = 0; } else { gap++; if (now > quietUntil) gapMax = Math.max(gapMax, gap); }
    if (c.conns.filter((y) => y.sourceID === 1048).length > 1) fail(name + ': doppelte Verbindung');
    if (now > quietUntil + 5000 && !audible && gap > 12) { fail(name + ': Ruhe, aber kein Ton nach ' + gap + ' s; Zustand ' + r.state + ' conn ' + JSON.stringify(r.conn) + ' ' + r.connState + ' busy ' + r.busy + ' | ' + msgs.slice(-4).join(' / ')); quietUntil = now + 60000; }
    if (audible && !(c.own() && c.own().connectionState === 2) && now > quietUntil + 5000) { fail(name + ': meint hörbar zu sein, ist es nicht | conn ' + JSON.stringify(r.conn) + ' ' + r.connState + ' own ' + JSON.stringify(c.own()) + ' duckBusy ' + r.duckBusy + ' busy ' + r.busy + ' orph ' + r.orphans + ' lastDuck vor ' + (now - r.lastDuck) + ' | ' + msgs.slice(-5).join(' / ')); quietUntil = now + 60000; }
    if (msgs.length > 4000) msgs.splice(0, 3000);
  }
  const t = r.knobTurns;
  console.log(name.padEnd(22) + hours + ' h: hörbar ' + (100 * aud / tot).toFixed(1) + ' %, Verbindungen ' + c.connects + ', Drehs ' + turnsDone + ' (Pausen ' + t + '), Ansagen ' + anns + ', Knopf traf Musik ' + (c.hitMusic || 0) + ' / Motor ' + (c.hitOurs || 0) + ', Aufrufe/s ' + (c.calls / tot).toFixed(1));
  r.stop(); await advance(8000); if (c.own() && !c.dead) fail(name + ': nach dem Beenden noch verbunden');
  return { t, turnsDone, anns, c };
}
(async () => {
  const base = { turn: 0, ann: 0, phone: 0, dead: 0, clock: 0, off: 0, err: 0 };
  let x = await drive('ruhige Fahrt', 4, base); if (x.t) fail('Pause ohne Dreh'); if (x.c.connects > 1) fail('verbindet ohne Grund neu');
  x = await drive('viele Ansagen', 4, Object.assign({}, base, { ann: 0.02 })); console.log('   falsche Pausen durch Ansagen: ' + x.t + ' von ' + x.anns);
  if (x.t > x.anns * 0.03) fail('Ansagen gelten als Dreh');
  await drive('viel Drehen', 4, Object.assign({}, base, { turn: 0.02 }));
  await drive('Telefon', 4, Object.assign({}, base, { phone: 0.01 }));
  await drive('Audiomanager fällt aus', 4, Object.assign({}, base, { dead: 0.004 }));
  await drive('Uhr springt', 3, Object.assign({}, base, { clock: 0.004 }));
  await drive('Aufruffehler 5 %', 3, Object.assign({}, base, { err: 0.05 }));
  await drive('alles durcheinander', 8, { turn: 0.006, ann: 0.006, phone: 0.002, dead: 0.0015, clock: 0.0005, off: 0.004, err: 0.01 });
  console.log(bad ? bad + ' Auffälligkeiten' : 'Tonweg: alles in Ordnung'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
