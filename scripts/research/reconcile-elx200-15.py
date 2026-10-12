#!/usr/bin/env python3
"""ELX200-15 row-count conflict (2026-10-12): primary datasheet now reachable.

The owner's round-3 decision preserved the 85 stored points and recorded the conflict. This script does NOT
replace them. It adds the primary-sheet table (86 rows, transcribed from the exact EV datasheet at
https://assets.electrovoicedynacord.com/asset/c2b9bf16-1e17-4053-847a-20773866d7f8/ELX200-15-Engineering-Data-Sheet.pdf,
section 'Réponse en fréquence et impédance', column 'Frequency Response, Full Space, 1W/1m (Sensitivity, dB)')
under disputedPoints.primarySourceReconciliation, with a diff against the stored table. The simulator exclusion
stays in place; adopting the primary table is an owner decision.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
DOC = 'https://assets.electrovoicedynacord.com/asset/c2b9bf16-1e17-4053-847a-20773866d7f8/ELX200-15-Engineering-Data-Sheet.pdf'
DATE = '2026-10-12'

PRIMARY = [
    (20, 62), (25, 68), (30, 73), (35, 76), (40, 79), (45, 81), (50, 83), (55, 85), (60, 87), (65, 89), (70, 91),
    (75, 92), (80, 93), (85, 94), (90, 95), (95, 95), (100, 95), (110, 95.5), (120, 95.5), (130, 95), (140, 94.5),
    (150, 95), (160, 95.5), (170, 95.5), (180, 95), (190, 95), (200, 95), (220, 95), (250, 95), (280, 95), (300, 94.5),
    (330, 95), (360, 95.5), (400, 95.5), (450, 95), (500, 95), (550, 95), (600, 95), (650, 95), (700, 95), (750, 95),
    (800, 95), (850, 95), (900, 95), (950, 95), (1000, 95), (1100, 94), (1200, 93.5), (1300, 94), (1400, 94.5),
    (1500, 95), (1600, 95), (1700, 94), (1800, 92), (1900, 92), (2000, 92), (2200, 93), (2400, 93.5), (2600, 94),
    (2800, 95), (3000, 95), (3300, 95), (3600, 95), (4000, 95), (4500, 95), (5000, 95), (5500, 95), (6000, 95),
    (6500, 95), (7000, 95), (7500, 95), (8000, 95), (8500, 95), (9000, 95), (9500, 95), (10000, 95), (11000, 94),
    (12000, 93), (13000, 92), (14000, 91), (15000, 90), (16000, 88), (17000, 85), (18000, 82), (19000, 80), (20000, 78),
]


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    rec = next(r for r in data if r['id'] == 'electro-voice-elx200-15')
    dp = rec['frequencyResponse']['disputedPoints']
    stored = {p['hz']: p['db'] for p in dp['points']}
    primary = dict(PRIMARY)
    assert len(PRIMARY) == 86 and len(stored) == 85

    only_primary = sorted(set(primary) - set(stored))
    only_stored = sorted(set(stored) - set(primary))
    value_diffs = [{'hz': h, 'stored_db': stored[h], 'primary_db': primary[h]}
                   for h in sorted(set(primary) & set(stored)) if stored[h] != primary[h]]

    dp['primarySourceReconciliation'] = {
        'status': 'PRIMARY_SHEET_TRANSCRIBED_NOT_ADOPTED',
        'reviewedDate': DATE,
        'source': DOC,
        'sourceType': 'MANUFACTURER',
        'table': 'Frequency Response, Full Space, 1W/1m (Sensitivity, dB), Frequency (Hz) column; 86 rows, 20 Hz to 20 kHz',
        'points': [{'hz': h, 'db': v} for h, v in PRIMARY],
        'comparisonWithStoredPoints': {
            'storedRows': 85,
            'primaryRows': 86,
            'rowsOnlyInPrimary': only_primary,
            'rowsOnlyInStored': only_stored,
            'valueDifferences': value_diffs,
        },
        'note': (
            "The primary sheet is the exact-model EV datasheet, so the earlier 'primary could not be obtained' basis for "
            "the conflict no longer holds. Compared with the stored 85 points, the primary table has 86 rows: it adds "
            f"{only_primary} Hz, drops the stored {only_stored} Hz row (not printed on the sheet), and differs in "
            f"{len(value_diffs)} stored values. The stored 85 points are preserved unchanged in 'points' and the "
            "disputed status stays until the owner decides. The simulator exclusion stays in place."
        ),
    }
    dp['context'] = dp['context'] + (
        f" Reconciliation ({DATE}): the primary datasheet was reopened. It prints 86 rows, not 84 or 85; see "
        "primarySourceReconciliation for the row-by-row comparison. The stored points are not replaced without owner approval."
    )
    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)
    print('only_primary', only_primary, 'only_stored', only_stored, 'value_diffs', len(value_diffs))


if __name__ == '__main__':
    main()
