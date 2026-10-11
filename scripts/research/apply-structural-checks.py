#!/usr/bin/env python3
"""Record manufacturer-page checks of structural fields (driverCount / active) on existing records.

Usage: python3 scripts/research/apply-structural-checks.py decisions.json

Each decision: {"id", "field": "driverCount"|"active", "value", "url", "evidence", "date"}.
The value must already be present on the record (this script confirms, it does not add values).
Provenance for that field becomes MANUFACTURER_VERIFIED with the URL and evidence.
overallStatus is NOT changed here: structural facts alone keep a record UNVERIFIED
(see scripts/research/apply-batch.mjs). Acoustic fields are required for PARTIALLY_VERIFIED.
"""
import json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')

def main(path):
    data = json.load(open(DATA, encoding='utf-8'))
    by_id = {r['id']: r for r in data}
    decisions = json.load(open(path, encoding='utf-8'))
    n = 0
    for d in decisions:
        r = by_id.get(d['id'])
        if r is None:
            raise SystemExit(f"unknown id {d['id']}")
        f = d['field']
        if f not in ('driverCount', 'active'):
            raise SystemExit(f"{d['id']}: field {f} not allowed")
        if r.get(f) != d['value']:
            raise SystemExit(f"{d['id']}.{f} is {r.get(f)!r}, decision expects {d['value']!r}; refusing")
        if not str(d.get('url', '')).startswith('https://'):
            raise SystemExit(f"{d['id']}: https URL required")
        pk = 'driverCountProvenance' if f == 'driverCount' else 'activeProvenance'
        r[pk] = {'status': 'MANUFACTURER_VERIFIED', 'source': d['url'], 'sourceType': 'MANUFACTURER',
                 'note': f"Structural check ({d.get('date', '2026-10-11')}): {d['evidence']}"}
        n += 1
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, DATA)
    print('applied', n)

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
