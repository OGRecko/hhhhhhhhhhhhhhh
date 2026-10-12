#!/usr/bin/env python3
"""Round 5 response-point corrections, batch B (2026-10-12).

Each stored point list was compared with the cited manufacturer table on the same basis as the record's
pointsContext (basis verified against the cited PDF; not changed):
  electro-voice-zx4   : "Frequency Response, Half Space (SPL, 1W/1m, dB)", Part 38110416 Rev D. 18 points differ.
  electro-voice-sx600 : "Frequency Response (SPL, 1W/1m, dB)" (anechoic, EN 54-24). 7 points differ.
  qsc-ac-c6t          : "Frequency Response (Raw)" column (not Intrinsic Correction). 6 points differ.

The script asserts the current stored values before it writes, so it refuses to run twice. It appends
to the change log written by apply-round5-response-corrections-2026-10-12.py.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LOG = os.path.join(ROOT, 'scripts', 'research', 'round5-response-corrections-2026-10-12.json')
DATE = '2026-10-12'

CORRECTIONS = {
    'electro-voice-zx4': {
        'source': 'https://www.fullcompass.com/common/files/19733-ElectroVoiceZX4Datasheet.pdf',
        'table': 'Frequency Response, Half Space (SPL, 1W/1m, dB), Part 38110416 Rev D',
        'old': {40: 85, 50: 90, 60: 95, 70: 98, 80: 101, 90: 103.5, 100: 104, 300: 103, 600: 99,
                2000: 100, 3000: 99, 4000: 99, 5000: 99, 6000: 99, 7000: 99, 8000: 99, 9000: 99, 20000: 98.5},
        'new': {40: 86, 50: 91, 60: 96, 70: 99, 80: 102, 90: 104, 100: 104.5, 300: 103.5, 600: 99.5,
                2000: 99.5, 3000: 99.5, 4000: 99.5, 5000: 99.5, 6000: 99.5, 7000: 99.5, 8000: 99.5, 9000: 99.5,
                20000: 99},
    },
    'electro-voice-sx600': {
        'source': 'https://products.electrovoice.com/binary/Sx600_High_Output_Two-way_Loudspeaker_Datasheet_51_en_9006674443.pdf',
        'table': 'Frequency Response (SPL, 1W/1m, dB)',
        'old': {80: 95.5, 90: 96.5, 100: 98.5, 6000: 106.5, 7000: 104, 9000: 102, 10000: 100},
        'new': {80: 96, 90: 97, 100: 99, 6000: 106, 7000: 107, 9000: 103, 10000: 101},
    },
    'qsc-ac-c6t': {
        'source': 'https://www.qscaudio.com/resource-files/productresources/spk/ac/ac-c_6t/q_spk_acc_6t_specs.pdf',
        'table': 'Impedance/Frequency Response, Frequency Response (Raw) column',
        'old': {50: 69, 60: 75, 70: 81, 80: 86, 90: 88, 6000: 88},
        'new': {50: 68, 60: 74, 70: 80, 80: 85, 90: 87, 6000: 91},
    },
}


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    log = json.load(open(LOG, encoding='utf-8'))
    history = []
    for rid, c in CORRECTIONS.items():
        rec = by[rid]
        fr = rec['frequencyResponse']
        assert fr.get('source') == c['source'], (rid, fr.get('source'))
        stored = {p['hz']: p['db'] for p in fr['points']}
        for hz, old in c['old'].items():
            assert stored.get(hz) == old, (rid, hz, stored.get(hz), old)
        changes = []
        for p in fr['points']:
            if p['hz'] in c['new'] and p['db'] != c['new'][p['hz']]:
                changes.append({'hz': p['hz'], 'was': p['db'], 'now': c['new'][p['hz']]})
                p['db'] = c['new'][p['hz']]
        fr['pointsContext'] = (fr.get('pointsContext') or '').rstrip() + (
            f' Round 5 correction ({DATE}): {len(changes)} stored points did not match the cited table "{c["table"]}" '
            'and were replaced with the source values. Change record: '
            'scripts/research/round5-response-corrections-2026-10-12.json.'
        )
        history.append({'id': rid, 'source': c['source'], 'table': c['table'], 'changes': changes})

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)

    log['corrections'].extend(history)
    with open(LOG, 'w', encoding='utf-8') as fh:
        json.dump(log, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    for h in history:
        print(h['id'], len(h['changes']), 'points changed')


if __name__ == '__main__':
    main()
