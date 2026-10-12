#!/usr/bin/env python3
"""Round 5 LSR32 check (2026-10-12).

jbl-lsr32 points are the on-axis SPL column of the "Amplitude & Phase" table in the JBL LSR Series owner's
manual (https://jblpro.com/zh/site_elements/lsr-series-owner-s-manual, manual chunk 5). A readback found 27 of
28 stored points equal to that table. The 20 kHz row of the same table reads 61 dB, while the stored point is 92.
The same manual's "Acoustic Contribution" table lists 92 dB fundamental at 20 kHz, so the manual conflicts with
itself at that frequency. The record names the Amplitude & Phase table as its basis, so the stored value is set to
the table value and the internal conflict is written into the record context. Nothing else changes.

The script asserts the current values before it writes, so it refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LOG = os.path.join(ROOT, 'scripts', 'research', 'round5-response-corrections-2026-10-12.json')
DATE = '2026-10-12'
RID = 'jbl-lsr32'
SOURCE = 'https://jblpro.com/zh/site_elements/lsr-series-owner-s-manual'


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    rec = [r for r in data if r['id'] == RID][0]
    fr = rec['frequencyResponse']
    assert fr.get('pointsSource') == SOURCE, fr.get('pointsSource')
    pts = fr['points']
    p20k = [p for p in pts if p['hz'] == 20000]
    assert len(p20k) == 1 and p20k[0]['db'] == 92, p20k
    p20k[0]['db'] = 61
    fr['pointsContext'] = (fr['pointsContext'].rstrip() + ' Round 5 check (2026-10-12): the 20 kHz point is set to 61 dB, the value in the '
        'Amplitude & Phase table cited above. The same manual\'s Acoustic Contribution table lists 92 dB fundamental at 20 kHz, '
        'so the manual conflicts with itself at that frequency; the conflict is recorded here and is not resolved by this change. '
        'Change record: scripts/research/round5-response-corrections-2026-10-12.json (entry jbl-lsr32).')
    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)
    log = json.load(open(LOG, encoding='utf-8'))
    log['corrections'].append({'id': RID, 'pass': 'check', 'date': DATE, 'source': SOURCE,
                               'table': 'Amplitude & Phase, SPL (dB) column (manual chunk 5)',
                               'changes': [{'hz': 20000, 'was': 92, 'now': 61}],
                               'note': 'Internal conflict: Acoustic Contribution table lists 92 dB at 20 kHz in the same manual.'})
    with open(LOG, 'w', encoding='utf-8') as fh:
        json.dump(log, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    print(RID, '20 kHz set to 61 dB')


if __name__ == '__main__':
    main()
