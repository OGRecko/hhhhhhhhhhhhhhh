#!/usr/bin/env python3
"""Owner decisions of 2026-10-12 (round 5, follow-up to the five outstanding items).

Archives three live records. Nothing is deleted: each record is copied exactly, unchanged, into
scripts/research/removed-owner-2026-10-12-decisions.json, with its reason and any redirect in archiveMeta.

  legacy-jbl-5        duplicate of jbl-4311 (same exact JBL 4311 model, same source, identical points and
                      scalars; the record's own note calls it a duplicate). Redirect: jbl-4311.
  electro-voice-zx5   generic Zx5 record. The owner's rule: archive unless the variant (ZX5-60 or ZX5-90) is
                      established by the original record or a reliable source. Neither is established, and the
                      record stores no values. Kept recoverable in the archive.
  legacy-ma-2         Martin Audio F2. The only manufacturer source is the F2 System datasheet, which describes a
                      reconfigurable multi-box system. It does not describe a standalone loudspeaker named F2.
                      No values are stored. Archived pending an exact-model source.

Live count: 669 -> 666. Archive: 81 + 27 + 3 = 111. Reviewed total: 777 (unchanged).

Asserts the record identity before removing anything, so it refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ARCHIVE = os.path.join(ROOT, 'scripts', 'research', 'removed-owner-2026-10-12-decisions.json')
DATE = '2026-10-12'

REMOVALS = {
    'legacy-jbl-5': {
        'expectModel': '4311 Studio Monitor',
        'redirectTo': 'jbl-4311',
        'reason': 'Duplicate of jbl-4311 (exact JBL 4311; same source https://jblpro.com/en-US/site_elements/4311-information; identical 1/3-octave points and scalars). Archived unchanged; references redirect to jbl-4311.',
    },
    'electro-voice-zx5': {
        'expectModel': 'ZX5',
        'redirectTo': None,
        'reason': 'Generic Electro-Voice Zx5 record. The variant (ZX5-60 or ZX5-90) is not established by the original record or a reliable source; no values are stored. Archived pending owner approval of a variant assignment; not assigned by guesswork.',
    },
    'legacy-ma-2': {
        'expectModel': 'F2',
        'redirectTo': None,
        'reason': 'Martin Audio F2. The only manufacturer source (F2 System datasheet) describes a reconfigurable multi-box system, not a standalone loudspeaker named F2. System specifications are not used as component specifications. No values stored. Archived pending an exact-model source.',
    },
}


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    archived = []
    meta = []
    for rid, spec in REMOVALS.items():
        rec = by.get(rid)
        assert rec is not None, f'{rid} is not live (already archived?)'
        assert rec.get('model') == spec['expectModel'], (rid, rec.get('model'))
        archived.append(rec)
        meta.append({'id': rid, 'reason': spec['reason'], 'redirectTo': spec['redirectTo'], 'archivedDate': DATE})

    target = by.get('jbl-4311')
    assert target is not None and target.get('model') == '4311', 'redirect target must be the exact JBL 4311 record'

    live = [r for r in data if r['id'] not in REMOVALS]
    assert len(live) == len(data) - 3

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(live, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)

    with open(ARCHIVE, 'w', encoding='utf-8') as fh:
        json.dump({
            'reviewDate': DATE,
            'reason': 'Archived by owner decision (round 5 follow-up, 2026-10-12). Records are unchanged copies. See archiveMeta for each reason and redirect.',
            'recordCount': len(archived),
            'records': archived,
            'archiveMeta': meta,
        }, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    print('archived', [r['id'] for r in archived], '; live now', len(live))


if __name__ == '__main__':
    main()
