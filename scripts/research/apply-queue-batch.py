#!/usr/bin/env python3
"""Generic queue apply: writes per-URL results from round<N>-url-results.json (N from argv).

Rules (enforced by assertions, not by convention):
- A PROMOTED outcome writes MANUFACTURER_VERIFIED only when the entry's sourceClass is
  MANUFACTURER, the stored value equals the recorded value, the field is still
  CITED_IN_NOTES_UNCHECKED, and the source URL is the entry's URL.
- SUPPORTED_NOT_PROMOTED / NOT_STATED / NOT_EXTRACTED never change speakers.json.
- Re-running is safe: an already-promoted field with the same source is skipped.
- queue-url-status.json: each recorded entry is replaced, and the previous non-OPEN snapshot is
  kept under history (nothing is erased).
- value history is appended to round<N>-value-history.json (de-duplicated by id/field/source).
"""
import json, os, sys

ROUND = int(sys.argv[1]) if len(sys.argv) > 1 else 13

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
RESULTS = os.path.join(HERE, f'round{ROUND}-url-results.json')
STATUS = os.path.join(HERE, 'queue-url-status.json')
HISTORY = os.path.join(HERE, f'round{ROUND}-value-history.json')
LEDGER = os.path.join(HERE, 'provenance-source-ledger.json')
CITED = 'CITED_IN_NOTES_UNCHECKED'
MANU_STATUS = 'MANUFACTURER_VERIFIED'
ALLOWED_OUTCOMES = {'PROMOTED', 'SUPPORTED_NOT_PROMOTED', 'NOT_STATED', 'NOT_EXTRACTED'}


def dump(path, obj):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(obj, indent=2, ensure_ascii=False) + '\n')


def main():
    results = json.load(open(RESULTS, encoding='utf-8'))
    db = json.load(open(DATA, encoding='utf-8'))
    by_id = {r['id']: r for r in db}
    hist = json.load(open(HISTORY, encoding='utf-8')) if os.path.exists(HISTORY) else {'entries': []}
    seen = {(h['id'], h['field'], h['after'].get('source')) for h in hist['entries']}
    promoted = skipped = recorded_only = 0
    for e in results['entries']:
        assert e['sourceClass'] in ('MANUFACTURER', 'NON_MANUFACTURER_HOST'), e['url']
        for fr in e['fieldResults']:
            assert fr['outcome'] in ALLOWED_OUTCOMES, fr
            r = by_id.get(fr['record'])
            assert r is not None, f"unknown record {fr['record']}"
            field = fr['field']
            assert r.get(field) == fr['value'], f"{fr['record']}.{field} stored {r.get(field)!r} != recorded {fr['value']!r}"
            prov = r[field + 'Provenance']
            if fr['outcome'] != 'PROMOTED':
                recorded_only += 1
                assert prov.get('status') == CITED, f"{fr['record']}.{field} not {CITED}: {prov.get('status')}"
                continue
            assert e['sourceClass'] == 'MANUFACTURER', f"PROMOTED from non-manufacturer host: {fr['record']}.{field}"
            if prov.get('status') == MANU_STATUS and prov.get('source') == e['url']:
                skipped += 1
                continue
            assert prov.get('status') == CITED, f"{fr['record']}.{field} status {prov.get('status')}"
            new = {'status': MANU_STATUS, 'source': e['url'], 'sourceType': 'MANUFACTURER',
                   'note': 'Round ' + str(e.get('round', ROUND)) + ': ' + fr.get('note', '')}
            if (r['id'], field, e['url']) not in seen:
                hist['entries'].append({'id': r['id'], 'field': field, 'value': r[field], 'before': prov,
                                        'after': new, 'round': e.get('round', ROUND)})
                seen.add((r['id'], field, e['url']))
            r[field + 'Provenance'] = new
            promoted += 1

    if promoted:
        with open(DATA, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(db, indent=2, ensure_ascii=False) + '\n')
        hist['marker'] = f'round{ROUND}-queue-batch'
        dump(HISTORY, hist)

    status = json.load(open(STATUS, encoding='utf-8'))
    by_url = {u['url']: u for u in status['urls']}
    for e in results['entries']:
        old = by_url.get(e['url'])
        assert old is not None, f"URL not in status file: {e['url']}"
        history = list(old.get('history', []))
        if old.get('status') not in (None, 'OPEN') and old.get('round') != ROUND:
            snap = {k: v for k, v in old.items() if k != 'history'}
            history.append({'snapshotOfRound': old.get('round'), 'entry': snap})
        new_entry = {
            'url': e['url'], 'round': ROUND, 'status': e['status'], 'chunksOpened': e['chunksOpened'],
            'chunksTotal': e.get('chunksTotal'), 'checkedDate': results['checkedDate'],
            'sourceClass': e['sourceClass'], 'document': e.get('document', ''), 'evidence': e['evidence'],
            'fieldResults': e['fieldResults'], 'history': history,
        }
        by_url[e['url']] = new_entry
    status['urls'] = [by_url[u['url']] for u in status['urls']]
    dump(STATUS, status)

    ledger = json.load(open(LEDGER, encoding='utf-8'))
    have = {s.get('url') for s in ledger['sources']}
    added = 0
    for e in results['entries']:
        if e['url'] in have:
            continue
        ledger['sources'].append({'url': e['url'], 'host': e['host'], 'document': e.get('document', ''),
                                  'status': e['status'], 'openedDate': results['checkedDate'],
                                  'chunksOpened': e['chunksOpened'], 'chunksTotal': e.get('chunksTotal'),
                                  'sourceClass': e['sourceClass'], 'round': ROUND, 'coverage': e['evidence']})
        added += 1
    dump(LEDGER, ledger)
    print(f'round{ROUND} apply: urls={len(results["entries"])} promoted={promoted} '
          f'already_promoted={skipped} recorded_without_write={recorded_only} ledger_sources_added={added}')


if __name__ == '__main__':
    main()
