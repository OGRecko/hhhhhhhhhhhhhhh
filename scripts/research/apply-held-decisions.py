#!/usr/bin/env python3
"""Apply Round 4 URL-check decisions to held driverCount/active values.

Usage: python3 scripts/research/apply-held-decisions.py decisions.json

decisions.json is a list of objects:
  {"id": "...", "field": "driverCount"|"active", "action": "accept"|"reject",
   "value": <int|bool>  (accept only), "url": "https://...", "evidence": "what the page states",
   "date": "YYYY-MM-DD"}

accept: the held value is restored, provenance becomes MANUFACTURER_VERIFIED with the URL.
reject: the field stays null, provenance records the reason (UNSOURCED with note).
Every decision is written to scripts/research/round4-value-history.json with its state.
Only values currently held (provenance UNSOURCED and value null) are changed.
"""
import json, os, sys
from collections import Counter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
HIST = os.path.join(ROOT, 'scripts', 'research', 'round4-value-history.json')

def main(decisions_path):
    data = json.load(open(DATA, encoding='utf-8'))
    hist = json.load(open(HIST, encoding='utf-8'))
    decisions = json.load(open(decisions_path, encoding='utf-8'))
    by_id = {r['id']: r for r in data}
    applied = Counter()
    for d in decisions:
        r = by_id.get(d['id'])
        if r is None:
            raise SystemExit(f"unknown id {d['id']}")
        f = d['field']
        pk = 'driverCountProvenance' if f == 'driverCount' else 'activeProvenance'
        if r.get(f) is not None or (r.get(pk) or {}).get('status') != 'UNSOURCED':
            raise SystemExit(f"{d['id']}.{f} is not a held value; refusing to overwrite")
        date = d.get('date', '2026-10-11')
        if d['action'] == 'accept':
            if not str(d.get('url', '')).startswith('https://'):
                raise SystemExit(f"{d['id']}: accept needs an https URL")
            r[f] = d['value']
            r[pk] = {'status': 'MANUFACTURER_VERIFIED', 'source': d['url'], 'sourceType': 'MANUFACTURER',
                     'note': f"Round 4 URL check ({date}): exact manufacturer source. {d['evidence']}"}
            state = 'RESTORED_AFTER_URL_CHECK'
        elif d['action'] == 'reject':
            r[pk]['note'] = f"Round 4 URL check ({date}): not restored; value stays N/A. {d['evidence']}"
            state = 'REJECTED_AFTER_URL_CHECK'
        else:
            raise SystemExit(f"unknown action {d['action']}")
        for h in hist:
            if h['id'] == d['id'] and h['field'] == f and h['state'] == 'HELD_PENDING_URL_CHECK':
                h['state'] = state
                h['checkedUrl'] = d.get('url', h['previousSource'])
                h['checkDate'] = date
                h['reason'] = d['evidence']
                break
        else:
            raise SystemExit(f"no held history entry for {d['id']}.{f}")
        applied[state] += 1
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False); fh.write('\n')
    os.replace(tmp, DATA)
    json.dump(hist, open(HIST, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    still = sum(1 for h in hist if h['state'] == 'HELD_PENDING_URL_CHECK')
    print('applied', dict(applied), 'still held', still)

if __name__ == '__main__':
    main(sys.argv[1])
