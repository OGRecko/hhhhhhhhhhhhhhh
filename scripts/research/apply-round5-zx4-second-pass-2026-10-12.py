#!/usr/bin/env python3
"""Round 5 ZX4 second pass (2026-10-12).

The first batch-B pass (apply-round5-response-corrections-2026-10-12-b.py, committed in 06e623f) left
13 of 28 ZX4 points different from the cited table and changed 3000-9000 Hz and 20 kHz to values that
are not in the source. This pass sets all 28 points to the Half Space (SPL, 1W/1m, dB) column of
ZX4 Engineering Data Sheet, Part 38110416 Rev D (12/2010), fetched from the URL below.

The script asserts the current stored values before it writes, so it refuses to run twice. The
first-pass change-log entry is left unchanged; this pass is appended as a separate entry.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LOG = os.path.join(ROOT, 'scripts', 'research', 'round5-response-corrections-2026-10-12.json')
DATE = '2026-10-12'
RID = 'electro-voice-zx4'
SOURCE = 'https://www.fullcompass.com/common/files/19733-ElectroVoiceZX4Datasheet.pdf'
TABLE = 'Frequency Response, Half Space (SPL, 1W/1m, dB), Part 38110416 Rev D'

# Half Space column, verbatim from the datasheet (Hz -> dB).
SRC = {20: 79.5, 30: 83, 40: 86, 50: 91, 60: 96, 70: 99, 80: 102, 90: 104, 100: 104.5, 200: 103.5,
       300: 103.5, 400: 102, 500: 100, 600: 99.5, 700: 99, 800: 99, 900: 98.5, 1000: 98.5, 2000: 99.5,
       3000: 99, 4000: 99, 5000: 99, 6000: 99, 7000: 99, 8000: 98.5, 9000: 98, 10000: 99, 20000: 98.5}

# Stored values the second pass expects (the first-pass result) for the points that differ.
EXPECTED_OLD = {30: 82, 200: 103, 900: 99, 1000: 99, 3000: 99.5, 4000: 99.5, 5000: 99.5, 6000: 99.5,
                7000: 99.5, 8000: 99.5, 9000: 99.5, 10000: 100, 20000: 99}


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
    assert len(changes) == 13, len(changes)
    for p in fr['points']:
        p['db'] = SRC[p['hz']]

    old_ctx = fr['pointsContext']
    marker = ' Round 5 correction (2026-10-12): 18 stored points did not match'
    assert marker in old_ctx, 'expected first-pass context text'
    head = old_ctx[:old_ctx.index(marker)]
    fr['pointsContext'] = (
        head.rstrip() + ' Round 5 correction (2026-10-12): all 28 points were then checked against the cited '
        'table, a second pass set the 13 values that still differed to the source values, and the context now '
        'matches the table verbatim. Change records: scripts/research/round5-response-corrections-2026-10-12.json '
        '(entries electro-voice-zx4 and electro-voice-zx4 second pass).'
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
