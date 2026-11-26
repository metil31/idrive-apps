'use strict';
/**
 * test_speed_limit_outputs.js - the Speed Limit app's cluster-render side against a fake service (no car).
 *
 *   node kit/tools/test_speed_limit_outputs.js [dist/speed_limit]
 *
 * Runs the app's outputs.js (from the sources with the kit beside them, as build.py lays them out; or a built
 * stage) against a socket that speaks cluster-render's
 * protocol 1 (PROTOCOL.md): hello, then the layers, frames, sets, drops and status requests it gets. Checks:
 * the HUD layer and its pixels; no map layer while no other app shows the map; the map layer once the status lists
 * another app's shown layer on "map", hidden when it goes; nothing shown without a limit; the connection closed on
 * stop() (cluster-render removes a client's layers with its connection).
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// the app's modules beside the kit, as build.py lays them out (no build, no SDK: CI); or a built stage's
function assemble() {
    const root = path.join(__dirname, '..', '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed_limit_'));
    const copy = (from, to) => {
        if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to); fs.readdirSync(from).forEach((f) => { if (f !== 'locales') copy(path.join(from, f), path.join(to, f)); }); } else fs.writeFileSync(to, fs.readFileSync(from));
    };
    fs.readdirSync(path.join(root, 'apps', 'speed_limit')).filter((f) => /\.js$/.test(f)).forEach((f) => copy(path.join(root, 'apps', 'speed_limit', f), path.join(dir, f)));
    copy(path.join(root, 'kit', 'runtime'), path.join(dir, 'kit'));
    return dir;
}
const js = process.argv[2] ? path.join(path.resolve(process.argv[2]), 'source', 'javascript') : assemble();
const { Outputs } = require(path.join(js, 'outputs'));
const sock = process.platform === 'win32' ? '\\\\.\\pipe\\speed_limit_test_' + process.pid : path.join(os.tmpdir(), 'speed_limit_test_' + process.pid + '.sock');

const got = [];                 // messages the app sent: { t: 'J', m } or { t: 'F', ref, bytes }
let statusText = 'upload: cap 4000 KB/s\n';
let client = null, closed = false;
const server = net.createServer((s) => {
    client = s;
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 5) {
            const n = buf.readUInt32LE(0);
            if (buf.length < 4 + n) break;
            const type = buf[4], body = buf.slice(5, 4 + n);
            buf = buf.slice(4 + n);
            if (type === 0x4A) {
                const m = JSON.parse(body.toString('utf8'));
                got.push({ t: 'J', m });
                if (m.op === 'hello') send(s, { ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' });
                if (m.op === 'status') send(s, { ev: 'status', text: statusText });
            } else if (type === 0x46) {
                let alpha = 0;
                for (let i = 17; i < body.length; i += 4) alpha = Math.max(alpha, body[i]);
                got.push({ t: 'F', ref: body.readUInt32LE(0), bytes: body.length - 14, alpha });
            }
        }
    });
    s.on('close', () => { closed = true; });
    s.on('error', () => {});
});
function send(s, obj) {
    const j = Buffer.from(JSON.stringify(obj)), h = Buffer.alloc(5);
    h.writeUInt32LE(j.length + 1, 0); h[4] = 0x4A;
    s.write(Buffer.concat([h, j]));
}

const settings = { v: { show: 'both', hudSize: 88, hudX: 0, hudY: 0, clusterSize: 110, clusterX: 0, clusterY: 0 }, get(k) { return this.v[k]; } };
const log = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(ok, what) { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; }
const ops = (op) => got.filter((g) => g.t === 'J' && g.m.op === op).map((g) => g.m);

(async () => {
    if (process.platform !== 'win32') { try { fs.unlinkSync(sock); } catch (e) { /* none */ } }
    await new Promise((r) => server.listen(sock, r));
    const out = new Outputs('speed_limit', log, settings, { cr: { path: sock, check: false } }).start();
    await wait(300);
    check(ops('hello').length === 1 && ops('hello')[0].app === 'speed_limit', 'hello as speed_limit');

    out.update({ limit: 60, inferred: false, over: false }, Date.now());
    await wait(200);
    const hud = ops('layer').filter((m) => m.target === 'hud');
    check(hud.length === 1 && hud[0].kind === 'image' && hud[0].class === 'overlay' && hud[0].w === 88 && hud[0].iw === 88, 'HUD layer: an 88 px image, class overlay');
    const hx = hud[0] || {};
    check(hx.x >= 0 && hx.x + 88 <= 800 && hx.y >= 0 && hx.y + 88 <= 480, 'HUD layer inside the 800x480 target (' + hx.x + ',' + hx.y + ')');
    check(got.some((g) => g.t === 'F' && g.ref === hx.ref && g.bytes === 88 * 88 * 4), 'HUD pixels sent whole (88x88 RGBA)');
    check(ops('layer').filter((m) => m.target === 'map').length === 0, 'no map layer while no other app shows the map');

    const framesBefore = got.filter((g) => g.t === 'F').length;
    out.update({ limit: 60, inferred: false, over: false }, Date.now());
    await wait(100);
    check(got.filter((g) => g.t === 'F').length === framesBefore, 'the same sign is not sent again');

    // Maps on cluster shows its picture on "map": the sign joins it
    statusText = 'upload: cap 4000 KB/s\ntarget map: slot 0x100 scene 0x10004f0 1088x480: shown\nlayer 4 video of robertn_waze_cluster on map, content z 0: shown\n';
    out.tick(Date.now());
    await wait(200);
    const map = ops('layer').filter((m) => m.target === 'map');
    check(map.length === 1 && map[0].w === 110 && out.diag().mapBusyBy === 'robertn_waze_cluster', 'map layer once robertn_waze_cluster shows the map');

    // over the limit: new pixels (red sign)
    const f0 = got.filter((g) => g.t === 'F').length;
    out.update({ limit: 60, inferred: false, over: true }, Date.now());
    await wait(150);
    check(got.filter((g) => g.t === 'F').length === f0 + 2, 'over the limit: both signs drawn again');

    // the phone map goes (its video stalls): the sign leaves the map
    statusText = 'layer 4 video of robertn_waze_cluster on map, content z 0: stalled - no frames\nlayer 1 image of speed_limit on map, overlay z 20: shown\n';
    out.tick(Date.now() + 4000);
    await wait(200);
    const mref = map[0] && map[0].ref;
    check(ops('set').some((m) => m.ref === mref && m.visible === 0), 'map layer hidden when the phone map goes (its own layer does not count)');

    const host = { ev: 'host', target: 'map', into: 'panel', shown: 1, x: 440, y: 150, w: 544, h: 240,
        src_x: 0, src_y: 0, src_w: 1088, src_h: 480 };
    statusText = 'layer 9 effect of custom_theme on panel, content z 1: shown\nlayer 12 video of phone_map on panel, content z 2: shown\n';
    send(client, host);
    await wait(30);
    out.tick(Date.now());
    await wait(100);
    check(out.diag().mapHost === 'panel' && out.diag().panelBy.includes('custom_theme') && !out.diag().mapBusy,
        'third-party panel and hosted map are reported independently of the standard map');
    check(!ops('layer').some((m) => m.target === 'panel'), 'a foreign video cannot activate the panel sign');
    statusText = 'layer 9 effect of custom_theme on panel, content z 1: shown\nlayer 12 video of waze-on-cluster on panel, content z 2: shown\n';
    out.tick(Date.now() + 3000);
    await wait(150);
    const hosted = ops('layer').find((m) => m.target === 'panel');
    check(hosted && hosted.class === 'overlay' && hosted.contend === 0 && hosted.x === 613 && hosted.y === 325 &&
        hosted.w === 55 && hosted.h === 55 && hosted.iw === 110 && hosted.ih === 110,
        'the sign follows the map into the theme, with its size and position scaled to the host');
    settings.v.clusterX = -180;
    out.update({ limit: 60 }, Date.now());
    await wait(100);
    check(ops('set').some((m) => m.ref === hosted.ref && m.x === 523), 'saved horizontal adjustments follow the map');
    settings.v.clusterX = 0;
    statusText = 'layer 12 video of waze-on-cluster on panel, content z 2: stalled\n';
    out.tick(Date.now() + 7000);
    await wait(100);
    check(out.diag().panelMapBy === '' && ops('drop').some((m) => m.ref === hosted.ref), 'the hosted sign leaves when the map stalls');
    send(client, { ev: 'host', target: 'map', into: '', shown: 0 });
    await wait(30);
    check(out.diag().mapHost === '', 'when the host goes away, the old host is forgotten');

    // no limit: the HUD layer is hidden too
    out.update(null, Date.now());
    await wait(100);
    check(ops('set').some((m) => m.ref === hx.ref && m.visible === 0), 'no limit: HUD layer hidden');

    // settings: kept over BMW's pop-ups; the HUD sign moved; then "cluster": the HUD sign hidden
    settings.v.hudKeep = true;
    out.update({ limit: 90, inferred: true, over: false }, Date.now());
    await wait(100);
    check(ops('set').some((m) => m.ref === hx.ref && m.yield === 0), "kept over BMW's pop-ups: yield 0");
    settings.v.hudX = 40;
    out.update({ limit: 90, inferred: true, over: false }, Date.now());
    await wait(100);
    check(ops('set').some((m) => m.ref === hx.ref && m.x === hx.x + 40), 'HUD sign moved by the setting');
    const hiddenBefore = ops('set').filter((m) => m.ref === hx.ref && m.visible === 0).length;
    settings.v.show = 'cluster';
    out.update({ limit: 90, inferred: true, over: false }, Date.now());
    await wait(100);
    check(ops('set').filter((m) => m.ref === hx.ref && m.visible === 0).length === hiddenBefore + 1, '"Cluster": HUD sign hidden');

    // never the panel (the whole-cluster slot BMW's trip and board computer content uses)
    check(ops('layer').filter((m) => m.target === 'panel').length === 1, 'the panel was used only inside the hosted map');

    // a speed camera ahead: the pill joined to the sign, a wider picture; resent only when the distance step changes
    settings.v.show = 'both';
    out.update({ limit: 60, inferred: false, over: false, camera: '350 m' }, Date.now());
    await wait(150);
    const camL = ops('layer').filter((m) => m.target === 'hud').slice(-1)[0];
    const camF = got.filter((g) => g.t === 'F' && g.ref === camL.ref);
    check(camL.w > camL.h && camL.iw === camL.w && camF.length === 1 && camF[0].bytes === camL.w * camL.h * 4, 'camera ahead: the sign with its pill (' + camL.w + 'x' + camL.h + ')');
    out.update({ limit: 60, inferred: false, over: false, camera: '350 m' }, Date.now());
    out.update({ limit: 60, inferred: false, over: false, camera: '300 m' }, Date.now());
    await wait(150);
    check(got.filter((g) => g.t === 'F' && g.ref === camL.ref).length === 2 && ops('layer').filter((m) => m.target === 'hud').slice(-1)[0].ref === camL.ref,
        'the distance counts down: the same layer, pixels only for the new step');
    out.update({ limit: 60, inferred: false, over: false }, Date.now());
    await wait(150);
    const back = ops('layer').filter((m) => m.target === 'hud').slice(-1)[0];
    check(back.ref !== camL.ref && back.w === back.h, 'camera passed: the sign alone again');

    // "Show ---" (no limit known): the dash sign on the HUD again
    settings.v.show = 'both';
    const hl = ops('layer').filter((m) => m.target === 'hud').slice(-1)[0];      // (the HUD layer now)
    const framesNow = got.filter((g) => g.t === 'F' && g.ref === hl.ref).length;
    out.update({ limit: null, unknown: true, inferred: false, over: false }, Date.now());
    await wait(150);
    check(got.filter((g) => g.t === 'F' && g.ref === hl.ref).length === framesNow + 1, '"---" (no limit known): HUD sign shown, its pixels sent once');
    out.update({ limit: null, unknown: true, inferred: false, over: false }, Date.now());
    await wait(100);
    check(got.filter((g) => g.t === 'F' && g.ref === hl.ref).length === framesNow + 1, '"---" again: nothing sent again');

    settings.v.hudSize = 40;
    out.update({ limit: 130, camera: '350 m' }, Date.now());
    await wait(150);
    const small = ops('layer').filter((m) => m.target === 'hud').slice(-1)[0];
    check(small.h === 40 && small.w > 40 && small.x + 20 === hx.x + 44 + 40 &&
        got.some((g) => g.t === 'F' && g.ref === small.ref && g.bytes === small.w * 40 * 4),
    '40 px HUD sign keeps its centre and sends the attached camera badge');

    statusText = 'layer 4 video of robertn_waze_cluster on map, content z 0: shown\n';
    out.tick(Date.now() + 20000);
    await wait(150);
    const mapSign = ops('layer').filter((m) => m.target === 'map' && m.z === 20).slice(-1)[0];
    const beforeAlert = got.length;
    out.setJunction({ kind: 'yield', metres: 60, demo: true }, Date.now());
    await wait(560);
    const priority = ops('layer').find((m) => m.z === 21);
    const faded = (ref) => got.slice(beforeAlert).filter((m) => m.t === 'F' && m.ref === ref).map((m) => m.alpha);
    check(priority && priority.target === 'hud' && priority.x === small.x && priority.y === small.y,
        'priority sign uses the speed sign position even with a camera badge');
    check(faded(small.ref).some((a) => a > 0 && a < 255) && faded(priority.ref).slice(-1)[0] === 255 &&
        ops('set').some((m) => m.ref === small.ref && m.visible === 0), 'speed sign fades out and priority sign fades in');
    const clusterAlert = ops('layer').find((m) => m.target === 'map' && m.z === 21);
    check(clusterAlert && clusterAlert.x + clusterAlert.w === mapSign.x + mapSign.w && clusterAlert.y === mapSign.y &&
        faded(clusterAlert.ref).slice(-1)[0] === 255 &&
        ops('set').some((m) => m.ref === mapSign.ref && m.visible === 0),
        'priority alert takes the cluster speed sign position and fades it out');
    settings.v.hudX += 10;
    out.setJunction({ kind: 'stop', metres: 40, demo: true }, Date.now());
    out.update({ limit: 130, camera: '350 m' }, Date.now());
    await wait(120);
    check(ops('set').some((m) => m.ref === priority.ref && m.x === priority.x + 10), 'demo sign moves ten pixels with the HUD controls');
    out.setJunction(null, Date.now());
    await wait(560);
    check(ops('drop').some((m) => m.ref === priority.ref) && faded(small.ref).slice(-1)[0] === 255 &&
        ops('set').some((m) => m.ref === small.ref && m.visible === 1), 'the speed sign fades back after the alert');

    check(ops('drop').some((m) => m.ref === clusterAlert.ref) &&
        ops('set').some((m) => m.ref === mapSign.ref && m.visible === 1), 'cluster speed sign returns after the alert');

    settings.v.junctionCluster = true;
    settings.v.junctionHud = false;
    settings.v.clusterX = 10;
    out.setJunction({ kind: 'stop', metres: 30 }, Date.now());
    await wait(560);
    const mapOnly = ops('layer').filter((m) => m.z === 21).slice(-1)[0];
    check(mapOnly.target === 'map' && mapOnly.x + mapOnly.w === clusterAlert.x + clusterAlert.w + 10 &&
        ops('layer').filter((m) => m.target === 'hud' && m.z === 21).length === 1,
        'cluster toggle and position work independently of the HUD');
    statusText = 'layer 12 video of waze-on-cluster on panel, content z 2: shown\n';
    send(client, host);
    await wait(50);
    out.tick(Date.now() + 20000);
    await wait(170);
    const panelAlert = ops('layer').filter((m) => m.z === 21).slice(-1)[0];
    check(panelAlert.target === 'panel' && panelAlert.h === 55 &&
        ops('drop').some((m) => m.ref === mapOnly.ref), 'priority alert follows the map into the hosted panel');
    statusText = 'layer 12 video of waze-on-cluster on panel, content z 2: stalled\n';
    out.tick(Date.now() + 40000);
    await wait(150);
    check(ops('drop').some((m) => m.ref === panelAlert.ref), 'priority alert leaves when the hosted map stops');

    out.stop();
    await wait(200);
    // (cluster-render removes a client's layers with its connection: the close is what gives the HUD and map back)
    check(closed && out.diag().hud === 'none' && out.diag().map === 'none', 'stop(): connection closed, no layers kept');
    server.close();
    if (fails) { console.log('\n' + fails + ' failed'); process.exit(1); }
    console.log('\nok');
})().catch((e) => { console.error(e); process.exit(1); });
