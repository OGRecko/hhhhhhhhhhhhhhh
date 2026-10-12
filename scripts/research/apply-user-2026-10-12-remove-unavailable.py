#!/usr/bin/env python3
"""User request (2026-10-12): remove all unavailable speakers.

"Unavailable" is applied as: live records whose overall status is UNVERIFIED and whose acoustic fields
(sensitivity, impedance, power, woofer, frequencyResponse) are all UNAVAILABLE or empty. Seven records qualify.
Per the standing rule the records are archived unchanged (not destroyed) in
removed-unavailable-2026-10-12.json with archiveMeta. The reviewed total (live + archived) stays at 777.

The script asserts the exact seven IDs and their state, and refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ARCHIVE = os.path.join(ROOT, 'scripts', 'research', 'removed-unavailable-2026-10-12.json')
DATE = '2026-10-12'
EXPECTED = ['infinity-rs1', 'apogee-scintilla', 'tannoy-autograph', 'sonance-mariner-6',
            'morel-maximo-ultra-602', 'pmc-tb2', 'pmc-bb5-xbd-a']
ACOUSTIC = ['sensitivity', 'impedance', 'power', 'woofer', 'frequencyResponse']


def main():
    assert not os.path.exists(ARCHIVE), 'already applied'
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    moved = []
    for rid in EXPECTED:
        r = by.get(rid)
        assert r is not None, f'{rid} not live'
        assert r['overallStatus'] == 'UNVERIFIED', (rid, r['overallStatus'])
        for k in ACOUSTIC:
            st = (r.get(k) or {}).get('status')
            assert st in (None, 'UNAVAILABLE'), (rid, k, st)
        moved.append(r)
    keep = [r for r in data if r['id'] not in set(EXPECTED)]
    assert len(keep) == len(data) - len(EXPECTED)

    doc = {
        'reviewDate': DATE,
        'reason': 'User request 2026-10-12 (remove all unavailable speakers). Records had no acoustic data (all acoustic fields UNAVAILABLE) and overallStatus UNVERIFIED. Archived unchanged.',
        'recordCount': len(moved),
        'records': moved,
        'archiveMeta': [{'id': r['id'], 'reason': 'No acoustic field is sourced (all UNAVAILABLE); removed at user request 2026-10-12; archived unchanged.',
                         'redirectTo': None, 'archivedDate': DATE} for r in moved],
    }
    with open(ARCHIVE, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write('\n')
    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(keep, fh, indent=2, ensure_ascii=False); fh.write('\n')
    os.replace(DATA + '.tmp', DATA)
    print('archived', len(moved), '; live now', len(keep))


if __name__ == '__main__':
    main()
