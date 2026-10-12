#!/usr/bin/env python3
"""Apply the 2026-10-13 provenance batch recorded in provenance-ledger-2026-10-13.json.

- CONFIRMED entries: the field's provenance status goes from CITED_IN_NOTES_UNCHECKED to MANUFACTURER_VERIFIED,
  with the same URL and sourceType MANUFACTURER. The stored value must equal the ledger value.
- jbl-lsr32 20 kHz: the point is removed from the stored series, because the manual conflicts with itself and no
  evidence selects either value. Both candidate values are recorded in pointsContext.
Every precondition is asserted before anything is written. The script refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-ledger-2026-10-13.json')
DATE = '2026-10-13'


def main():
    ledger = json.load(open(LEDGER, encoding='utf-8'))
    db = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in db}
    applied = 0
    for e in ledger['entries']:
        if e['decision'] != 'MANUFACTURER_VERIFIED':
            continue
        r = by[e['id']]
        f, pk = e['field'], e['field'] + 'Provenance'
        assert r.get(f) == e['value'], (e['id'], f, r.get(f), e['value'])
        p = r.get(pk) or {}
        assert p.get('status') == 'CITED_IN_NOTES_UNCHECKED', (e['id'], f, p.get('status'))
        assert p.get('source') == e['url'], (e['id'], f, p.get('source'))
        r[pk] = {'status': 'MANUFACTURER_VERIFIED', 'source': e['url'], 'sourceType': 'MANUFACTURER'}
        applied += 1

    lsr = by['jbl-lsr32']
    fr = lsr['frequencyResponse']
    pts = fr['points']
    hit = [p for p in pts if p['hz'] == 20000]
    assert len(hit) == 1 and hit[0]['db'] == 61, ('lsr32 20 kHz precondition', hit)
    fr['points'] = [p for p in pts if p['hz'] != 20000]
    fr['pointsContext'] = fr['pointsContext'] + (
        ' Round 6 (2026-10-13): the 20 kHz point is removed from the stored series. The Amplitude & Phase table gives 61 dB'
        ' at 20 kHz and the Acoustic Contribution table of the same manual gives a 92 dB fundamental at 20 kHz; no evidence'
        ' selects either value. The stored series now ends at 10 kHz, and the simulator extrapolates above the last point,'
        ' so owner review of that extrapolation is required. Record: provenance-ledger-2026-10-13.json.')
    applied += 1

    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(db, fh, indent=2, ensure_ascii=False); fh.write('\n')
    os.replace(tmp, DATA)
    print('applied', applied)


if __name__ == '__main__':
    main()
