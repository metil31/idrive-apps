"""Compile directional Romanian STOP / give-way signs from a Geofabrik PBF."""
import argparse
import json
import re
import struct

from pack_sli import ROAD, _block, _blocks, merc, oneway_of


def direction(tag):
    return {'forward': 1, 'backward': -1}.get(tag)


def priority_kind(tags):
    kinds = {'give_way': 'give_way', 'stop': 'stop', 'ro:b1': 'give_way', 'ro:b01': 'give_way',
             'ro:b2': 'stop', 'ro:b02': 'stop'}
    highway = tags.get('highway')
    sign = kinds.get(tags.get('traffic_sign', '').lower().strip())
    if highway in ('give_way', 'stop'):
        return highway if not sign or sign == highway else None
    return sign


def select_signs(nodes, ways):
    links = {}
    for way, refs, tags in ways:
        cls = ROAD.get(tags.get('highway'))
        if cls is None:
            continue
        one, _ = oneway_of(tags, cls)
        for index, node in enumerate(refs):
            if node in nodes:
                edge = 1 if index == len(refs) - 1 else -1 if index == 0 else 0
                links.setdefault(node, {})[way] = (one, tags.get('junction'), tags.get('name') or tags.get('ref'), edge)
    for node, (lat, lon, tags) in nodes.items():
        candidates = links.get(node, {})
        if len(candidates) not in (1, 2):
            continue
        if 'except' in tags or any(key.endswith(':conditional') for key in tags):
            continue
        raw = tags.get('direction')
        kind = priority_kind(tags)
        if not kind:
            continue
        directions = {v for v in (raw, tags.get(kind + ':direction'), tags.get('traffic_sign:direction')) if v}
        if len(directions) > 1:
            continue
        raw = next(iter(directions), None)
        if tags.get('highway') not in ('give_way', 'stop') and not raw:
            continue
        if len(candidates) == 2:
            roads = list(candidates.items())
            street = roads[0][1][2]
            if not street or any(junction or name != street or not one or not edge for _, (one, junction, name, edge) in roads):
                continue
            approaches = [(wid, info) for wid, info in roads if info[0] == info[3]]
            if len(approaches) != 1:
                continue
            way, (one, junction, _, _) = approaches[0]
        else:
            (way, (one, junction, _, _)), = candidates.items()
        if junction in ('roundabout', 'circular'):
            continue
        signed = direction(raw) if raw else one
        if not signed or (one and signed != one):
            continue
        x, y = merc(lat, lon)
        yield [way, 1 if one else signed, 'stop' if kind == 'stop' else 'yield',
               round(x, 1), round(y, 1)]


def extract(pbf):
    nodes, ways = {}, []
    try:
        import osmium
    except ImportError:
        osmium = None
    if osmium is not None:
        class Extract(osmium.SimpleHandler):
            def node(self, n):
                if priority_kind(n.tags):
                    nodes[n.id] = n.location.lat, n.location.lon, dict(n.tags)

            def way(self, w):
                if w.tags.get('highway') not in ROAD:
                    return
                refs = [n.ref for n in w.nodes]
                if any(node in nodes for node in refs):
                    ways.append((w.id, refs, dict(w.tags)))

        Extract().apply_file(pbf)
    else:
        for kind, raw in _blocks(pbf):
            if kind != 'data':
                continue
            for item in _block(raw, {'nodes', 'ways'}):
                if item[0] == 'n':
                    _, node, lat, lon, tags = item
                    if tags and priority_kind(tags):
                        nodes[node] = lat, lon, tags
                elif item[0] == 'w':
                    _, way, refs, tags = item
                    if tags.get('highway') in ROAD:
                        if any(node in nodes for node in refs):
                            ways.append((way, refs, tags))
    return nodes, list(select_signs(nodes, ways))


def speed_ways(path, date, candidates):
    with open(path, 'rb') as data:
        magic, version, count = struct.unpack('<4sHH', data.read(8))
        if magic != b'SLIP' or version != 1:
            raise ValueError('Unsupported speed pack')
        data.seek(16)
        sections = {kind: (offset, length) for kind, offset, length in struct.iter_unpack('<4sII', data.read(count * 12))}
        offset, length = sections[b'META']
        data.seek(offset)
        if json.loads(data.read(length))['data'] != date:
            raise ValueError('Junction and speed packs must have the same snapshot date')
        offset, length = sections[b'PIEC']
        data.seek(offset + 4)
        return {way for way, in struct.iter_unpack('<20xI', data.read(length - 4)) if way in candidates}


def write_signs(output, signs, date, pack):
    eligible = speed_ways(pack, date, {s[0] for s in signs})
    filtered = sorted({tuple(s) for s in signs if s[0] in eligible})
    if not filtered:
        raise ValueError('No directional junction signs on roads in the speed pack')
    with open(output, 'w', encoding='utf-8', newline='\n') as out:
        out.write("'use strict';\n\n// Generated by kit/tools/pack_junctions.py. See NOTICE.\nmodule.exports = {\n")
        out.write('    date: ' + json.dumps(date) + ',\n')
        out.write('    source: "https://download.geofabrik.de/europe/romania.html",\n    signs: [\n')
        for sign in filtered:
            out.write('        ' + json.dumps(sign, separators=(',', ':')) + ',\n')
        out.write('    ]\n};\n')
    return filtered


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf')
    parser.add_argument('output')
    parser.add_argument('--date', required=True, help='OSM extract date')
    parser.add_argument('--speed-pack', required=True, help='compiled speed pack from the same extract')
    args = parser.parse_args()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.date):
        parser.error('date must be YYYY-MM-DD')
    nodes, signs = extract(args.pbf)
    filtered = write_signs(args.output, signs, args.date, args.speed_pack)
    for kind, tag in [('yield', 'give_way'), ('stop', 'stop')]:
        print(kind, sum(s[2] == kind for s in filtered),
              'eligible of', sum(priority_kind(n[2]) == tag for n in nodes.values()), 'mapped')


if __name__ == '__main__':
    main()
