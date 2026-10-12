#!/usr/bin/env python3
"""Round 5 AC-C6T second pass (2026-10-12).

The first batch-B pass (apply-round5-response-corrections-2026-10-12-b.py, committed in 06e623f) set the
50-90 Hz values and 6 kHz to numbers that do not appear in the source, and left 2 kHz at 89 dB where the
source has 90. This pass sets all 28 points to the Frequency Response (Raw) column of the QSC AC-C6T
specification sheet (fetched from the URL below). The Intrinsic Correction column is not used.

The script asserts the current stored values before it writes, so it refuses to run twice. The
first-pass change-log entry is left unchanged; this pass is appended as a separate entry.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LOG = os.path.join(ROOT, 'scripts', 'research', 'round5-response-corrections-2026-10-12.json')
DATE = '2026-10-12'
RID = 'qsc-ac-c6t'
SOURCE = 'https://www.qscaudio.com/resource-files/productresources/spk/ac/ac-c_6t/q_spk_acc_6t_specs.pdf'
TABLE = 'Impedance/Frequency Response, Frequency Response (Raw) column'

# Frequency Response (Raw) column, verbatim from the sheet (Hz -> dB). "1k" = 1000, "2k" = 2000, etc.
SRC = {20: 63, 30: 65, 40: 63, 50: 69, 60: 75, 70: 81, 80: 86, 90: 88, 100: 88, 200: 87, 300: 87,
       400: 90, 500: 91, 600: 90, 700: 91, 800: 93, 900: 91, 1000: 91, 2000: 90, 3000: 91, 4000: 94,
       5000: 94, 6000: 88, 7000: 85, 8000: 88, 9000: 85, 10000: 88, 20000: 78}

# First-pass values the script expects for the points that differ.
EXPECTED_OLD = {50: 68, 60: 74, 70: 80, 80: 85, 90: 87, 2000: 89, 6000: 91}


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    rec = by[RID]
    fr = rec['frequencyResponse']
    assert fr.get('source') == SOURCE, fr.get('source')
    stored = {p['hz']: p['db'] for p in fr['points']}
    assert set(stored) == set(SRC), 'frequency set must equal the 28 published points'
    changes = []
    for hz in sorted(SRC):
        if stored[hz] != SRC[hz]:
            assert stored[hz] == EXPECTED_OLD[hz], (hz, stored[hz], EXPECTED_OLD[hz])
            changes.append({'hz': hz, 'was': stored[hz], 'now': SRC[hz]})
    assert len(changes) == 7, len(changes)
    for p in fr['points']:
        p['db'] = SRC[p['hz']]

    old_ctx = fr['pointsContext']
    marker = ' Round 5 correction (2026-10-12): 6 stored points did not match'
    assert marker in old_ctx, 'expected first-pass context text'
    head = old_ctx[:old_ctx.index(marker)]
    fr['pointsContext'] = (
        head.rstrip() + ' Round 5 correction (2026-10-12): the first pass changed 6 points; all 28 points were then '
        'checked against the cited table, a second pass set the 7 values that still differed to the source values, '
        'and the context now matches the table verbatim. Change records: scripts/research/round5-response-corrections-2026-10-12.json '
        '(entries qsc-ac-c6t and qsc-ac-c6t second pass).'
    )

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)

    log = json.load(open(LOG, encoding='utf-8'))
    log['corrections'].append({'id': RID, 'pass': 'second', 'date': DATE, 'source': SOURCE, 'table': TABLE,
                               'changes': changes,
                               'note': 'Second pass after a readback of the cited table. The first-pass entry above is kept unchanged.'})
    with open(LOG, 'w', encoding='utf-8') as fh:
        json.dump(log, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    print(RID, len(changes), 'points changed (second pass)')


if __name__ == '__main__':
    main()
