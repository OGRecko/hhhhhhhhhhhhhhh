#!/usr/bin/env python3
"""Round 5 second pass for the batch-A records (2026-10-12).

The first batch-A pass (apply-round5-response-corrections-2026-10-12.py, committed in 06e623f) wrote
point values that do not appear in the cited tables. A readback of both sources on 2026-10-12 found:
  electro-voice-sb122 : 9 of 16 points differ from the Half Space (SPL, 1W/1m, dB) table in the EV EDS.
  turbosound-ip15b    : 9 of 10 points differ from the Frequency Response Sensitivity 1 W / 1 m table.
This pass sets every point of both records to the cited source values. The record context and the
change log are updated; the first-pass entries are kept unchanged.

The script asserts the current stored values before it writes, so it refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LOG = os.path.join(ROOT, 'scripts', 'research', 'round5-response-corrections-2026-10-12.json')
DATE = '2026-10-12'

CORRECTIONS = {
    'electro-voice-sb122': {
        'source': 'https://products.electrovoice.com/binary/SB122%20EDS.pdf',
        'table': 'Frequency Response, Half Space (SPL, 1W/1m, dB)',
        'src': {20: 80.5, 30: 80.5, 40: 85, 50: 92, 60: 97, 70: 98, 80: 100, 90: 101, 100: 102, 200: 94,
                300: 88, 400: 88, 500: 85, 600: 83, 700: 81, 800: 77},
        'expected_old': {20: 80.3, 60: 96.5, 70: 97.5, 80: 99.5, 400: 82, 500: 82, 600: 81.5, 700: 79, 800: 76.5},
        'note': (' Round 5 correction (2026-10-12): the first pass changed 5 points to values that are not in the cited '
                 'table; a second pass set all 16 points to the cited table, and the context now matches it. Change '
                 'records: scripts/research/round5-response-corrections-2026-10-12.json (entries electro-voice-sb122 and '
                 'electro-voice-sb122 second pass).'),
    },
    'turbosound-ip15b': {
        'source': 'https://monthany.com/wp-content/uploads/2022/12/Turbosound_iP15B_datasheet_monthany.pdf',
        'table': "Frequency Response Sensitivity 1 W / 1 m, column 'Full Range (Sound Pressure Level, dB)'",
        'src': {20: 67, 30: 84, 40: 91, 50: 93.5, 60: 94.5, 70: 94.5, 80: 94, 90: 93, 100: 91.5, 200: 74},
        'expected_old': {20: 66.5, 40: 91.5, 50: 94.5, 60: 95.5, 70: 95.3, 80: 94.5, 90: 93.5, 100: 92, 200: 76},
        'note': (' Round 5 correction (2026-10-12): the first pass changed 9 points to values that are not in the cited '
                 'table; a second pass set all 10 points to the cited table, and the context now matches it. Change '
                 'records: scripts/research/round5-response-corrections-2026-10-12.json (entries turbosound-ip15b and '
                 'turbosound-ip15b second pass).'),
    },
}


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    log = json.load(open(LOG, encoding='utf-8'))
    history = []
    for rid, c in CORRECTIONS.items():
        fr = by[rid]['frequencyResponse']
        assert fr.get('source') == c['source'], (rid, fr.get('source'))
        stored = {p['hz']: p['db'] for p in fr['points']}
        assert set(stored) == set(c['src']), (rid, 'frequency set must equal the cited table')
        changes = []
        for hz in sorted(c['src']):
            if stored[hz] != c['src'][hz]:
                assert stored[hz] == c['expected_old'][hz], (rid, hz, stored[hz], c['expected_old'][hz])
                changes.append({'hz': hz, 'was': stored[hz], 'now': c['src'][hz]})
        for p in fr['points']:
            p['db'] = c['src'][p['hz']]
        ctx = fr.get('pointsContext') or ''
        # Keep the first-pass text, then append the second-pass note once.
        fr['pointsContext'] = ctx.rstrip() + c['note']
        history.append({'id': rid, 'pass': 'second', 'date': DATE, 'source': c['source'], 'table': c['table'],
                        'changes': changes,
                        'note': 'Second pass after a readback of the cited table. The first-pass entry is kept unchanged.'})

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)

    log['corrections'].extend(history)
    with open(LOG, 'w', encoding='utf-8') as fh:
        json.dump(log, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    for h in history:
        print(h['id'], len(h['changes']), 'points changed (second pass)')


if __name__ == '__main__':
    main()
