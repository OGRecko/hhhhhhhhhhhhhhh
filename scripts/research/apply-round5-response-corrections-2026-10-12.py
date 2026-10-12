#!/usr/bin/env python3
"""Round 5 response-point corrections (2026-10-12).

Each stored point list was compared with the table in the record's cited manufacturer PDF.
Only records whose stored points disagree with their cited source are changed here. The script
asserts the current stored values before it writes, so it refuses to run twice.

Corrected:
  electro-voice-sb122  (EV SB122 EDS, Half Space SPL 1W/1m table): 5 points
  turbosound-ip15b     (Turbosound iP15B Product Information Document, Frequency Response Sensitivity 1 W / 1 m): 9 points

Not changed (documented, recorded in the audit file):
  dynaudio-core-47 20 Hz: 62 stored vs 62.5 on the 2022 datasheet. The product page cited in the
  record did not render a table in this session, so the stored value is kept and the gap is noted.
  Dynaudio low/high cutoffs and SB122 -10 dB range: documented basis, kept.
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
        'old': {20: 80.2, 70: 98, 80: 100, 90: 101.5, 100: 102.5},
        'new': {20: 80.3, 70: 97.5, 80: 99.5, 90: 101, 100: 102},
    },
    'turbosound-ip15b': {
        'source': 'https://monthany.com/wp-content/uploads/2022/12/Turbosound_iP15B_datasheet_monthany.pdf',
        'table': 'Frequency Response Sensitivity 1 W / 1 m, Full Range (SPL, dB)',
        'old': {20: 67, 40: 91, 50: 93.5, 60: 94.5, 70: 94.5, 80: 94, 90: 93, 100: 91.5, 200: 74},
        'new': {20: 66.5, 40: 91.5, 50: 94.5, 60: 95.5, 70: 95.3, 80: 94.5, 90: 93.5, 100: 92, 200: 76},
    },
}


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    history = []
    for rid, c in CORRECTIONS.items():
        rec = by[rid]
        fr = rec['frequencyResponse']
        pts = fr['points']
        stored = {p['hz']: p['db'] for p in pts}
        for hz, old in c['old'].items():
            assert stored.get(hz) == old, (rid, hz, stored.get(hz), old)
        changes = []
        for p in pts:
            if p['hz'] in c['new'] and p['db'] != c['new'][p['hz']]:
                changes.append({'hz': p['hz'], 'was': p['db'], 'now': c['new'][p['hz']]})
                p['db'] = c['new'][p['hz']]
        assert all(stored.get(h) is not None for h in c['new'])
        assert fr.get('source') == c['source'], (rid, fr.get('source'))
        fr['context'] = (fr.get('context') or '').rstrip() + (
            f' Round 5 correction ({DATE}): {len(changes)} stored points did not match the cited manufacturer '
            f'table "{c["table"]}" and were replaced with the source values. Full change record: '
            'scripts/research/round5-response-corrections-2026-10-12.json.'
        )
        history.append({'id': rid, 'source': c['source'], 'table': c['table'], 'changes': changes})

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)

    with open(LOG, 'w', encoding='utf-8') as fh:
        json.dump({'date': DATE, 'corrections': history}, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    for h in history:
        print(h['id'], len(h['changes']), 'points changed')


if __name__ == '__main__':
    main()
