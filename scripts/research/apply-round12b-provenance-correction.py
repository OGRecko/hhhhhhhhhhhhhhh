#!/usr/bin/env python3
"""Round 12b correction. Runs once after apply-round12-queue-batch.py.

Problem found by the test suite (src/data/speakers.round3.test.ts): driverCount/active provenance may only be
CITED_IN_NOTES_UNCHECKED, UNSOURCED or MANUFACTURER_VERIFIED. Round 12 used THIRD_PARTY_VERIFIED for copies
hosted by distributors or aggregators (leone.sk, manualslib.com). Those 12 fields are returned to
CITED_IN_NOTES_UNCHECKED. The value is unchanged and the copy's support is recorded in queue-url-status.json as
SUPPORTED_NOT_PROMOTED. They can be promoted only when the manufacturer's own host copy is checked.

Round 12 also demoted lacoustics-arcs-ii (MANUFACTURER_VERIFIED on a THIRD_PARTY sourceType) to THIRD_PARTY_VERIFIED.
That status is not allowed for these fields either, so it returns to CITED_IN_NOTES_UNCHECKED.

Every change asserts the current provenance equals the round-12 "after" state from round12-value-history.json and
keeps the prior object in the same history file. A marker prevents a second run.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
HISTORY = os.path.join(HERE, 'round12-value-history.json')
LEDGER = os.path.join(HERE, 'provenance-source-ledger.json')
MARKER = 'round12b-provenance-correction'
CITED = 'CITED_IN_NOTES_UNCHECKED'


def main():
    ledger = json.load(open(LEDGER, encoding='utf-8'))
    if any(r.get('marker') == MARKER for r in ledger.get('rounds', [])):
        print(f'{MARKER} already applied; refusing to rerun')
        sys.exit(1)

    db = json.load(open(DATA, encoding='utf-8'))
    by_id = {r['id']: r for r in db}
    hist = json.load(open(HISTORY, encoding='utf-8'))
    entries = hist['entries']
    corrections = []

    for h in entries:
        if h.get('marker') != 'round12-queue-batch':
            continue
        r = by_id[h['id']]
        field = h['field']
        cur = r[field + 'Provenance']
        after = h['after']
        if h.get('kind') == 'DEMOTION':
            assert cur == after, (h['id'], field, cur, after)
            new = {'status': CITED, 'source': h['before']['source'], 'sourceType': None,
                   'note': 'Round 12b: distributor copy (SISME) with status THIRD_PARTY; not manufacturer-verified. '
                           'Returned to unchecked pending a manufacturer source. Value unchanged.'}
            corrections.append({'id': h['id'], 'field': field, 'kind': 'DEMOTION_REVERTED', 'before': cur, 'after': new,
                                'round': '12b', 'marker': MARKER})
            r[field + 'Provenance'] = new
        elif after.get('status') == 'THIRD_PARTY_VERIFIED':
            assert cur == after, (h['id'], field, cur, after)
            host = after['source'].split('/')[2]
            new = {'status': CITED, 'source': after['source'], 'sourceType': None,
                   'note': f'Round 12b: supported by a distributor/aggregator-hosted copy ({host}); not promoted, because '
                           'driverCount/active allow only MANUFACTURER_VERIFIED. Value unchanged. Promote when the '
                           'manufacturer host copy is checked.'}
            corrections.append({'id': h['id'], 'field': field, 'kind': 'PROMOTION_NOT_ALLOWED_REVERTED', 'before': cur,
                                'after': new, 'round': '12b', 'marker': MARKER})
            r[field + 'Provenance'] = new
        # MANUFACTURER_VERIFIED promotions from round 12 are kept.

    assert len(corrections) == 14, f'expected 12 promotions + 2 demotions, got {len(corrections)}'

    with open(DATA, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(db, indent=2, ensure_ascii=False) + '\n')

    hist['entries'].extend(corrections)
    json.dump(hist, open(HISTORY, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(HISTORY, 'a', encoding='utf-8').write('\n')

    r12 = [r for r in ledger['rounds'] if r.get('round') == 12][0]
    r12['correctedBy12b'] = {
        'fieldsStillPromoted': r12['fieldsPromoted'] - 12,
        'promotionsReverted': 12,
        'demotionsReverted': 2,
    }
    ledger['rounds'].append({
        'round': '12b',
        'marker': MARKER,
        'date': '2026-10-12',
        'reason': 'Test suite vocabulary: driverCount/active allow only CITED_IN_NOTES_UNCHECKED, UNSOURCED, MANUFACTURER_VERIFIED.',
        'fieldsReverted': 12,
        'demotionsReverted': 2,
        'applied': [f'{c["id"]}.{c["field"]} -> {c["kind"]}' for c in corrections],
    })
    json.dump(ledger, open(LEDGER, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(LEDGER, 'a', encoding='utf-8').write('\n')
    print(f'{MARKER} applied; reverted {len(corrections)} fields')


if __name__ == '__main__':
    main()
