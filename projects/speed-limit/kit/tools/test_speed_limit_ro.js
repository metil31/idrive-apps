'use strict';
/* Romania-specific rules plus sanity checks against the generated Geofabrik pack. Node 8 compatible. */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { LimitPack, F, SRC, merc } = require(path.join(ROOT, 'apps', 'speed_limit', 'limitpack'));
const { Matcher, limitOf } = require(path.join(ROOT, 'apps', 'speed_limit', 'matcher'));
const { DemoDrive } = require(path.join(ROOT, 'apps', 'speed_limit', 'position'));
const { Junctions, demoAllowed } = require(path.join(ROOT, 'apps', 'speed_limit', 'junctions'));
const junctionData = require(path.join(ROOT, 'apps', 'speed_limit', 'junctions-data'));
let failed = 0;
function check(ok, text) { console.log((ok ? 'ok   ' : 'FAIL ') + text); if (!ok) failed++; }
function piece(cls, flags, f, b, src) { return { cls, flags, limF: f || 0, limB: b || 0, src: src || 0 }; }

check(limitOf(piece(6, F.URBAN), 1).limit === 50, 'Romania: 50 km/h in settlements');
check(limitOf(piece(2, 0), 1).limit === 90, 'Romania: 90 km/h outside settlements');
check(limitOf(piece(2, F.EUROPEAN), 1).limit === 100, 'Romania: 100 km/h on European roads outside settlements');
check(limitOf(piece(1, F.EXPRESSWAY), 1).limit === 120, 'Romania: 120 km/h on identified expressways');
check(limitOf(piece(1, F.EUROPEAN), 1).limit === 100, 'Romania: trunk tagged as European is 100 km/h');
check(limitOf(piece(1, F.EUROPEAN | F.URBAN), 1).limit === 50, 'Romania: European road in a settlement uses 50 km/h');
check(limitOf(piece(1, 0), 1).limit === 90, 'Romania: trunk alone does not imply 120 km/h');
const conditional = piece(0, 0, 90, 0, SRC.NUM | (SRC.VAR << 2));
check(limitOf(conditional, 1).limit === 90 && limitOf(conditional, -1).limit === null && limitOf(conditional, 0).variable,
    'variable limit is hidden for the affected or unknown direction');
check(limitOf(piece(0, 0), 1).limit === 130, 'Romania: 130 km/h on motorways');
check(limitOf(piece(7, F.URBAN), 1).limit === 20, 'Romania: 20 km/h on living streets');
check(limitOf(piece(2, F.URBAN, 30, 30, SRC.NUM | (SRC.NUM << 2)), 1).limit === 30,
    'an explicit local 30 km/h limit overrides the legal default');
check(limitOf(piece(2, 0, 70, 50, SRC.NUM | (SRC.NUM << 2)), -1).limit === 50,
    'the backward-direction limit is interpreted independently');
check(limitOf(piece(2, 0, 70, 50, SRC.NUM | (SRC.NUM << 2)), 0).limit === null,
    'different directional limits are hidden until direction is known');
check(limitOf(piece(2, F.URBAN, 50, 50, SRC.ZONE | (SRC.ZONE << 2)), 1).inferred,
    'an implicit zone limit has the estimated presentation');
check(limitOf(piece(0, F.LINK), 1).limit === 90, 'a motorway ramp does not inherit 130 km/h');

const file = process.argv[2] || path.join(ROOT, 'apps', 'speed_limit', 'romania.pack');
const pack = LimitPack.open(file);
check(pack.meta.region === 'Romania', 'pack metadata identifies Romania');
check(pack.count > 500000, 'pack contains Romania-scale road coverage (' + pack.count + ' pieces)');
check(pack.cameras.n > 0, 'pack contains mapped speed cameras (' + pack.cameras.n + ')');
const classes = {}, ways = new Set();
let expressway = 0, europeanTrunk = 0;
for (let i = 0; i < pack.count; i++) {
    const p = pack.piece(i); classes[p.cls] = (classes[p.cls] || 0) + 1;
    ways.add(p.way);
    if (p.flags & F.EXPRESSWAY) expressway++;
    if (p.cls === 1 && (p.flags & F.EUROPEAN) && !(p.flags & F.EXPRESSWAY)) europeanTrunk++;
}
check(classes[0] > 0 && classes[1] > 0 && classes[6] > 0 && classes[7] > 0,
    'pack has motorways, expressways, residential and living-street roads');
check(expressway > 0 && europeanTrunk > 0, 'pack distinguishes expressways (' + expressway + ' pieces) and European trunk roads (' + europeanTrunk + ')');
const signs = junctionData.signs;
const linked = signs.filter((s) => ways.has(s[0]));
check(junctionData.date === pack.meta.data && linked.length === signs.length && signs.length > 10000 &&
    ['yield', 'stop'].every((kind) => signs.some((s) => s[2] === kind)),
'junction pack has both signs, the same date and ' + linked.length + '/' + signs.length + ' roads present in the speed pack');

const junction = new Junctions({ near: () => [0, 1], piece: () => ({ way: 17 }), chain: (ids) => ids,
    points: (id) => (id ? [0, 0, 0, 100] : [-100, 0, 0, 0]) }, [[17, 1, 'stop', 0, 50], [17, -1, 'yield', -40, 0]]);
const road = { state: 'match', way: 17, piece: 0, dir: 1, junctionMatch: true };
const fix = { x: -15, y: 0 };
check(!junction.update(fix, road) && junction.update(fix, road).metres === 65,
    'two consecutive matches and road distance through a bend, across two pieces');
check(!junction.update({ x: 0, y: 55 }, Object.assign({}, road, { piece: 1 })), 'crossing the STOP removes the alert');
const reverse = Object.assign({}, road, { dir: -1 });
check(!junction.update(fix, reverse) && junction.update(fix, reverse).kind === 'yield' &&
    !junction.update(fix, Object.assign({}, road, { junctionMatch: false })) &&
    !junction.update(fix, Object.assign({}, road, { way: 18 })), 'opposite direction, uncertain match and other road');
const parallel = new Matcher({ covers: () => true, near: () => [0, 1],
    points: (id) => [-100, 4 * id, 100, 4 * id],
    piece: (id) => Object.assign(piece(6, F.URBAN), { id, way: id + 17 }) });
const parallelResult = parallel.update({ x: -20, y: 0, heading: 90, speed: 40 }, 1);
check(parallelResult.state === 'match' && !parallelResult.junctionMatch, 'a nearby parallel road suppresses the priority warning');
check(demoAllowed(7, 0) && demoAllowed(10, 0) && !demoAllowed(7, 0.5) && !demoAllowed(10, null) && !demoAllowed(8, 0),
    'demo requires fresh measured stationary speed and an active parked-compatible power state');

function replayJunction(kind, way, samples, heading) {
    const matcher = new Matcher(pack), j = new Junctions(pack, signs);
    const output = samples.map(([x, y], i) => {
        const sample = { x, y, heading, speed: 25 };
        const match = matcher.update(sample, 1 + i * 500);
        return match.way === way ? j.update(sample, match) : null;
    });
    check(!output[0] && output[1] && output[1].kind === kind && output[1].metres === 35 &&
        output[2] && output[2].kind === kind && output[2].metres === 25,
        'replay against București map geometry: ' + kind + ' on OSM way ' + way);
}
replayJunction('yield', 1759, [[2909814.7, 5529537.9], [2909821.3, 5529535.6], [2909834.6, 5529531.1]], 108.84);
replayJunction('stop', 23707623, [[2912395.8, 5528469], [2912402.5, 5528466.7], [2912415.7, 5528462.1]], 109.28);

// Two reproducible Romanian city examples from this exact pack.
function at(name, lat, lon, heading, expected, way) {
    const xy = merc(lat, lon), m = new Matcher(pack, { radius: 40 });
    const r = m.update({ x: xy[0], y: xy[1], heading, speed: 40 }, 1);
    check(r.state === 'match' && r.limit === expected && (!way || r.way === way),
        name + ': matched OSM way ' + r.way + ', ' + r.limit + ' km/h' + (r.inferred ? ' inferred' : ' tagged'));
}
at('Cluj-Napoca, Calea Moților sample', 46.7700, 23.5900, 0, 50);
at('Otopeni living-street sample', 44.5470, 26.0720, 0, 30);
at('Calea Victoriei, northern section', 44.4466283, 26.0902792, 155, 30, 4865914);
at('Calea Victoriei, southern section', 44.4312338, 26.0968527, 189, 30, 231242706);
for (const [way, lat, lon] of [[23050183, 44.4371, 26.1255], [218259739, 44.4378, 26.12535]]) {
    const xy = merc(lat, lon);
    const pieces = pack.near(xy[0], xy[1], 120).map(id => pack.piece(id)).filter(p => p.way === way);
    check(pieces.length > 0 && pieces.every(p => p.limF === 30 && (p.src & 3) === SRC.NUM),
        'Strada Rondă: confirmed 30 km/h replaces the implicit urban limit on OSM way ' + way);
}
at('Corbeanca, existing 30 km/h section on Strada Cantonului', 44.5869402, 26.0309329, 342, 30, 27930712);

const demo = new DemoDrive(pack);
function demoMatch(drive, seconds, way, limit) {
    const now = drive.t0 + seconds * 1000;
    const fix = drive.fix(now);
    if (!fix || fix.source !== 'demo') return null;
    const r = new Matcher(pack).update(fix, now);
    return r.state === 'match' && r.way === way && r.limit === limit ? r : null;
}
const outbound = demoMatch(demo, 30, 746230194, 50);
const returning = demoMatch(demo, 105, 746230194, 50);
check(outbound && returning && outbound.dir === 1 && returning.dir === -1,
    'default demo matches the Cluj-Napoca route at 50 km/h in both directions');
const custom = new DemoDrive(pack, { way: 41496744, speed: 35 });
check(custom.speedKmh(custom.t0) === 35 && demoMatch(custom, 10, 41496744, 50),
    'demo still accepts a custom way and a steady speed');
pack.close();
if (failed) { console.error('\n' + failed + ' failed'); process.exit(1); }
console.log('\nok');
