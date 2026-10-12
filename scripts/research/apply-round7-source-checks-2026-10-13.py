#!/usr/bin/env python3
"""Round 7 source checks (2026-10-13). Applies only what the opened sources support.

1. Mackie MR Series owner's manual, SW1198 Rev. A 06/17 (mackie.com), opened 2026-10-13:
   Powered Studio Monitors; "Bi-amplified Class A/B amplification" for MR524, MR624, MR824;
   one polypropylene woofer and one 1" silk dome tweeter (two transducers).
   -> driverCount 2 and active true are MANUFACTURER_VERIFIED for legacy-mack-3 (MR624),
      mackie-mr524 and mackie-mr824. Stored values are asserted equal before any write.

2. KRK downloads index page (krkmusic.com/pages/downloads-and-manuals), opened 2026-10-13:
   an index of links, not a specification sheet. It lists only Rokit Generation Five,
   Generation 4 and older model manuals. Rokit 5 G1, Rokit 8 G3 and 7000B are not listed,
   so the page supports none of their values. Those six held values become null (UNSOURCED).

3. ELX200-15 (French datasheet) second re-fetch, 2026-10-13: a 85-row reading that differs
   from the first re-fetch and from the stored table at 2000, 2200 and 2500 Hz. The stored
   points stay excluded from simulation and the status is UNRESOLVED_ROW_COUNT.

Every precondition is asserted before anything is written. The script refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
DATE = '2026-10-13'
MACKIE = 'https://mackie.com/img/file_resources/MR_Studio_Monitors_OM.pdf'
KRK = 'https://www.krkmusic.com/pages/downloads-and-manuals'
MARK = 'round7-source-checks-2026-10-13'

MACKIE_RECORDS = {'legacy-mack-3': 'MR624', 'mackie-mr524': 'MR524', 'mackie-mr824': 'MR824'}
KRK_RECORDS = ['krk-7000', 'krk-rokit-5', 'krk-rokit-8']


def main():
    db = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in db}
    if MARK in open(DATA, encoding='utf-8').read():
        raise SystemExit('round 7 already applied; refusing to run twice')
    applied = {'mackieConfirmed': 0, 'krkNulled': 0, 'elxReopened': 0}

    # 1. Mackie confirmations
    for rid, model in MACKIE_RECORDS.items():
        r = by[rid]
        assert model in r['model'], (rid, r['model'])
        for f, want in (('driverCount', 2), ('active', True)):
            pk = f + 'Provenance'
            p = r.get(pk) or {}
            assert r.get(f) == want, (rid, f, r.get(f))
            assert p.get('status') == 'CITED_IN_NOTES_UNCHECKED', (rid, f, p.get('status'))
            assert p.get('source') == MACKIE, (rid, f, p.get('source'))
            r[pk] = {'status': 'MANUFACTURER_VERIFIED', 'source': MACKIE, 'sourceType': 'MANUFACTURER',
                     'note': (f"Round 7 ({DATE}, {MARK}): Mackie MR Series owner's manual SW1198 Rev. A 06/17 "
                              f"lists {model} as a powered monitor ('Bi-amplified Class A/B amplification') with one "
                              f"polypropylene woofer and one 1-inch silk dome tweeter.")}
            applied['mackieConfirmed'] += 1

    # 2. KRK index page: nothing supported, held values to null
    for rid in KRK_RECORDS:
        r = by[rid]
        for f in ('driverCount', 'active'):
            pk = f + 'Provenance'
            p = r.get(pk) or {}
            assert p.get('status') == 'CITED_IN_NOTES_UNCHECKED', (rid, f, p.get('status'))
            assert p.get('source') == KRK, (rid, f, p.get('source'))
            r[f] = None
            r[pk] = {'status': 'UNSOURCED', 'source': None, 'sourceType': None,
                     'note': (f"Round 7 ({DATE}, {MARK}): cited page {KRK} is an index of downloads and does not "
                              f"state {f} for this model. It lists no exact-revision sheet for this model "
                              f"(Rokit G1 / G3 / 7000B). Value cleared to null; restore only with an exact-model source.")}
            applied['krkNulled'] += 1

    # 3. ELX200-15: reopen with the second reading; stored points stay excluded
    e = by['electro-voice-elx200-15']
    fr = e['frequencyResponse']
    dp = fr['disputedPoints']
    assert dp.get('simulationExcluded') is True or 'simulationExcluded' in dp, 'elx exclusion marker missing'
    dp['status'] = 'UNRESOLVED_ROW_COUNT'
    dp.setdefault('reconciliationLog', []).append({
        'date': DATE,
        'marker': MARK,
        'source': 'https://assets.electrovoicedynacord.com/asset/c2b9bf16-1e17-4053-847a-20773866d7f8/ELX200-15-Engineering-Data-Sheet.pdf',
        'reading': 'scripts/research/data/elx200-15-primary-fr-2026-10-13-refetch2.txt',
        'result': ('Second fetch of the same URL printed 85 rows (2500 Hz present; 2400 and 2600 Hz absent). '
                   'Against the stored table: row set matches; values differ at 2000 Hz (92 vs 93), 2200 Hz (93 vs 94), '
                   '2500 Hz (94 vs 95). Against the first re-fetch (86 rows): 2400 and 2600 Hz absent in this reading, '
                   '2500 Hz present, and values differ at 140, 280, 300, 330, 400, 1200 and 1400 Hz. Two fetches of the same '
                   'PDF do not agree, so the text extraction is not reproducible.'),
        'decision': 'Stored points stay excluded from simulation. No value changed. Owner needs the original PDF file for a '
                    'controlled transcription.'})
    applied['elxReopened'] += 1

    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(db, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, DATA)
    print('applied', applied)


if __name__ == '__main__':
    main()
