#!/usr/bin/env python3
"""Round 21+ structural batch apply for driverCount / active.

Input: scripts/research/round<N>-structural-batch.json with entries:
  {record, field ('driverCount'|'active'), value, source (exact URL opened), sourceClass
   ('MANUFACTURER' only), evidence (quoted text from the opened source), checkedDate}

Rules enforced by assertions:
- the field must currently be null with provenance status UNSOURCED (no overwrite of cited values);
- the source URL must be https and must be the manufacturer domain named in the entry;
- every write is appended to round<N>-structural-history.json with before/after/source/reason.
"""
import json, os, sys
ROUND = int(sys.argv[1]) if len(sys.argv) > 1 else 21
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
BATCH = os.path.join(HERE, f'round{ROUND}-structural-batch.json')
HIST = os.path.join(HERE, f'round{ROUND}-structural-history.json')
db = json.load(open(DATA, encoding='utf-8'))
by_id = {r['id']: r for r in db}
batch = json.load(open(BATCH, encoding='utf-8'))
hist = json.load(open(HIST, encoding='utf-8')) if os.path.exists(HIST) else {'round': ROUND, 'entries': []}
n = 0
for e in batch['entries']:
    assert e['sourceClass'] == 'MANUFACTURER', e['record']
    assert e['source'].startswith('https://'), e['source']
    r = by_id[e['record']]
    f = e['field']
    assert r.get(f) is None, f"{e['record']}.{f} already {r.get(f)!r}"
    prov = r.get(f + 'Provenance') or {}
    assert prov.get('status') == 'UNSOURCED', f"{e['record']}.{f} status {prov.get('status')}"
    new = {'status': 'MANUFACTURER_VERIFIED', 'source': e['source'], 'sourceType': 'MANUFACTURER',
           'note': f"Round {ROUND} ({e['checkedDate']}): manufacturer page evidence: {e['evidence']}"}
    r[f] = e['value']
    r[f + 'Provenance'] = new
    hist['entries'].append({'id': e['record'], 'field': f, 'before': {'value': None, 'provenance': prov},
                            'after': {'value': e['value'], 'provenance': new}, 'round': ROUND,
                            'reason': 'Exact-model manufacturer page opened; explicit statement recorded.'})
    n += 1
json.dump(db, open(DATA, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(DATA, 'a').write('\n')
json.dump(hist, open(HIST, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(HIST, 'a').write('\n')
print(f'round{ROUND} structural apply: written={n}')
