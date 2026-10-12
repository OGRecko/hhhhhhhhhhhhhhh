#!/usr/bin/env python3
"""ELX200-15 row-count conflict, reconciliation v2 (2026-10-12).

Supersedes reconcile-elx200-15.py. That script's PRIMARY list was a transcription error: it contained 86 rows,
including 2400 Hz and 2600 Hz rows that the sheet does not print, omitted the printed 2500 Hz row, and
carried values that differ from the sheet. The primary sheet was re-fetched on 2026-10-12 (two independent
fetches) and prints 85 rows from 20 Hz to 20 kHz. The row-level transcription is kept in
scripts/research/data/elx200-15-primary-fr-2026-10-12.txt and is compared here against the stored 85 points.

Stored points are not changed. Adopting them as simulation input is still excluded, because the table-derived
-3 dB / -10 dB crossovers (75 Hz-13 kHz; 55 Hz-17 kHz) differ from the sheet's stated -3 dB 77 Hz-16 kHz and
-10 dB 52 Hz-19 kHz. The table is not used by the simulator until the owner decides.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
TXT = os.path.join(ROOT, 'scripts', 'research', 'data', 'elx200-15-primary-fr-2026-10-12.txt')
DOC = 'https://assets.electrovoicedynacord.com/asset/c2b9bf16-1e17-4053-847a-20773866d7f8/ELX200-15-Engineering-Data-Sheet.pdf'
DATE = '2026-10-12'


def read_primary():
    rows = []
    for line in open(TXT, encoding='utf-8'):
        if line.startswith('#') or not line.strip():
            continue
        hz, db, _ohm = line.split()
        rows.append((int(float(hz)), float(db)))
    return rows


def main():
    primary = read_primary()
    assert len(primary) == 85, len(primary)
    assert all(primary[i][0] < primary[i + 1][0] for i in range(len(primary) - 1))

    data = json.load(open(DATA, encoding='utf-8'))
    rec = next(r for r in data if r['id'] == 'electro-voice-elx200-15')
    dp = rec['frequencyResponse']['disputedPoints']
    stored = [(p['hz'], p['db']) for p in dp['points']]
    assert len(stored) == 85, len(stored)

    sd, pd = dict(stored), dict(primary)
    only_primary = sorted(set(pd) - set(sd))
    only_stored = sorted(set(sd) - set(pd))
    value_diffs = [{'hz': h, 'stored_db': sd[h], 'primary_db': pd[h]}
                   for h in sorted(set(sd) & set(pd)) if sd[h] != pd[h]]
    assert not only_primary and not only_stored and not value_diffs, (only_primary, only_stored, value_diffs)

    dp['status'] = 'ROW_COUNT_RESOLVED_STORED_MATCHES_PRIMARY'
    dp['primarySourceReconciliation'] = {
        'status': 'PRIMARY_SHEET_RECHECKED_MATCHES_STORED_85',
        'reviewedDate': DATE,
        'source': DOC,
        'sourceType': 'MANUFACTURER',
        'table': 'Réponse en fréquence et impédance: column "Frequency Response, Full Space, 1W/1m (Sensitivity, dB)"; 85 rows, 20 Hz to 20 kHz',
        'fetches': 2,
        'transcriptionFile': 'scripts/research/data/elx200-15-primary-fr-2026-10-12.txt',
        'points': [{'hz': h, 'db': v} for h, v in primary],
        'comparisonWithStoredPoints': {
            'storedRows': 85,
            'primaryRows': 85,
            'rowsOnlyInPrimary': [],
            'rowsOnlyInStored': [],
            'valueDifferences': [],
        },
        'supersedes': 'scripts/research/reconcile-elx200-15.py (86-row transcription, in error)',
        'note': (
            'The primary sheet prints 85 rows. Stored points match it row-for-row (85/85, no value differences). '
            'The earlier "84 rows" statement and "86 rows" transcription were both errors. '
            'The stored points are retained unchanged.'
        ),
    }
    dp['context'] = dp['context'] + (
        f' Reconciliation v2 ({DATE}): the primary datasheet was re-fetched twice. It prints 85 rows, and the stored '
        '85 points match it row-for-row. The earlier 84-row and 86-row statements were errors. The stored points '
        'are not changed.'
    )
    dp['exclusionReason'] = (
        'Round 4/6: the row-level table now matches the primary sheet (85/85), but the table-derived -3 dB and '
        '-10 dB crossovers (about 75 Hz-13 kHz and 55 Hz-17 kHz) do not match the sheet\'s stated -3 dB 77 Hz-16 kHz '
        'and -10 dB 52 Hz-19 kHz. The table stays excluded from simulation until the owner decides whether to adopt it. '
        'The record and the table are preserved.'
    )

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)
    print('stored == primary: 85 rows, 0 differences')


if __name__ == '__main__':
    main()
