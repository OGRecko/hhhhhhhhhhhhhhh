#!/usr/bin/env python3
"""Round 21 structural audit of every point-bearing response dataset in src/data/speakers.json.
Read-only. Writes scripts/research/response-dataset-audit.json."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
db = json.load(open(os.path.join(ROOT, 'src/data/speakers.json'), encoding='utf-8'))

def walk(o, path):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == 'points' and isinstance(v, list) and v:
                yield path + '.' + k, o, v
            else:
                yield from walk(v, path + '.' + k)

out = []
for r in db:
    for path, parent, pts in walk(r, r['id']):
        bad = [i for i, p in enumerate(pts) if not (isinstance(p, dict) and isinstance(p.get('hz'), (int, float)) and isinstance(p.get('db'), (int, float)))]
        hz = [p['hz'] for p in pts if isinstance(p, dict) and isinstance(p.get('hz'), (int, float))]
        ascending = all(a < b for a, b in zip(hz, hz[1:]))
        dups = sorted({h for h in hz if hz.count(h) > 1})
        gaps = []
        for a, b in zip(hz, hz[1:]):
            if a > 0 and b / a > 1.5:
                gaps.append([a, b])
        # reference metadata at the same block level
        meta = {k: v for k, v in parent.items() if k not in ('points',) and not isinstance(v, (list, dict))}
        block_keys = sorted(k for k in parent.keys() if k != 'points')
        out.append({
            'record': r['id'], 'model': r.get('model'), 'path': path, 'points': len(pts),
            'hzMin': min(hz) if hz else None, 'hzMax': max(hz) if hz else None,
            'ascending': ascending, 'duplicateHz': dups, 'malformedIndexes': bad,
            'gapsOver1p5x': gaps[:10], 'gapCount': len(gaps),
            'blockKeys': block_keys, 'blockMeta': meta,
            'recordStatus': r.get('frequencyResponse', {}).get('status') if isinstance(r.get('frequencyResponse'), dict) else None,
        })

json.dump({'schema': 'response-dataset-audit/v1', 'date': '2026-10-16', 'datasetCount': len(out), 'datasets': out},
          open(os.path.join(HERE, 'response-dataset-audit.json'), 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
for o in out:
    print(o['record'], o['path'].split('.',1)[1], o['points'], o['hzMin'], o['hzMax'], 'asc' if o['ascending'] else 'NOT-ASC', 'dups' + str(o['duplicateHz']) if o['duplicateHz'] else '', 'bad' + str(o['malformedIndexes']) if o['malformedIndexes'] else '', 'gaps' + str(o['gapCount']))
print('datasets', len(out))
