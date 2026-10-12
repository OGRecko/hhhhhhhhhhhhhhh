#!/usr/bin/env python3
"""Round 7b correction (2026-10-13). Corrects two errors made by apply-round7-source-checks-2026-10-13.py.

A. KRK nulling reversed. Round 7 cleared driverCount and active for krk-7000, krk-rokit-5 and krk-rokit-8 because
   their cited index page did not state them. That was wrong. Batch 117 (krk-7000) and batch 019 (krk-rokit-5 and
   krk-rokit-8) each record an exact-model manufacturer source for these values, and the Batch 117 regression test
   asserts them. The values are restored from those recorded sources. Their provenance is CITED_IN_NOTES_UNCHECKED
   with the exact manufacturer URL, not MANUFACTURER_VERIFIED, because those URLs were not re-opened in this round.

B. ELX200-15 round-6 comparison superseded. primarySourceReconciliation says valueDifferences is empty. The
   2026-10-13 readings contradict that (see provenance-source-ledger.json). The original fields stay as history; a
   supersession note is added and the status is set to UNRESOLVED_ROW_COUNT (already set by round 7).

Every precondition is asserted before anything is written. The script refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
DATE = '2026-10-13'
MARK = 'round7b-krk-restore-and-elx-supersede-2026-10-13'
KRK_INDEX = 'https://www.krkmusic.com/pages/downloads-and-manuals'

RESTORE = {
    'krk-7000': {
        'driverCount': (2, 'https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK-7000b_spec_sheet.pdf?v=1708102022',
                        'KRK 7000B legacy close-field information sheet: passive two-way, 2 drivers total (batch-117).'),
        'active': (False, 'https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK-7000b_spec_sheet.pdf?v=1708102022',
                   'KRK 7000B information sheet: passive two-way monitor (batch-117).'),
    },
    'krk-rokit-5': {
        'driverCount': (2, 'https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK_ROKIT_Powered_G1_Series_Manual.pdf?v=1708098973',
                        'KRK ROKIT Powered Generation 1 manual, Rokit 5 G1: two transducers (batch-019).'),
        'active': (True, 'https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK_ROKIT_Powered_G1_Series_Manual.pdf?v=1708098973',
                   'KRK ROKIT Powered Generation 1 manual, Rokit 5 G1: powered two-way monitor (batch-019).'),
    },
    'krk-rokit-8': {
        'driverCount': (2, 'https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK-ROKIT-Powered-Generation-3-Series-Info-Sheet.pdf?v=1708098409',
                        'KRK ROKIT Generation 3 information sheet, Rokit 8 G3: one woofer and one tweeter (batch-019).'),
        'active': (True, 'https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK-ROKIT-Powered-Generation-3-Series-Info-Sheet.pdf?v=1708098409',
                   'KRK ROKIT Generation 3 information sheet, Rokit 8 G3: powered two-way monitor (batch-019).'),
    },
}


def main():
    raw = open(DATA, encoding='utf-8').read()
    if MARK in raw:
        raise SystemExit('round 7b already applied; refusing to run twice')
    db = json.loads(raw)
    by = {r['id']: r for r in db}
    n = 0
    for rid, fields in RESTORE.items():
        r = by[rid]
        for f, (val, url, why) in fields.items():
            pk = f + 'Provenance'
            p = r.get(pk) or {}
            assert r.get(f) is None, (rid, f, r.get(f))
            assert p.get('status') == 'UNSOURCED' and p.get('source') is None, (rid, f, p)
            r[f] = val
            r[pk] = {'status': 'CITED_IN_NOTES_UNCHECKED', 'source': url, 'sourceType': 'MANUFACTURER',
                     'note': (f"Round 7b ({DATE}, {MARK}): restored after correcting the round 7 nulling, which was an error. "
                              f"Exact-model manufacturer source recorded in batch files: {why} Not re-opened in round 7b; "
                              f"remains cited-unchecked until inspected.")}
            n += 1

    e = by['electro-voice-elx200-15']
    prs = e['frequencyResponse']['disputedPoints'].get('primarySourceReconciliation')
    assert isinstance(prs, dict), 'ELX primarySourceReconciliation missing'
    assert 'supersededBy2026_10_13' not in prs, 'already superseded'
    prs['supersededBy2026_10_13'] = {
        'date': DATE,
        'marker': MARK,
        'statement': ('This reconciliation (valueDifferences empty, 85/85 match) is SUPERSEDED. Two fetches of the same '
                      'primary PDF on 2026-10-13 gave different tables: the first printed 86 rows (2400 and 2600 Hz, no 2500 Hz), '
                      'the second printed 85 rows (2500 Hz, no 2400 or 2600 Hz). Against the stored table the second reading '
                      'differs at 2000 Hz (92 vs 93), 2200 Hz (93 vs 94) and 2500 Hz (94 vs 95). The original fields are kept as history.'),
        'readings': ['scripts/research/data/elx200-15-primary-fr-2026-10-12.txt',
                     'scripts/research/data/elx200-15-primary-fr-2026-10-13-refetch.txt',
                     'scripts/research/data/elx200-15-primary-fr-2026-10-13-refetch2.txt'],
        'status': 'UNRESOLVED_ROW_COUNT',
    }

    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(db, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, DATA)
    print('restored_values', n, 'elx_superseded', 1)


if __name__ == '__main__':
    main()
