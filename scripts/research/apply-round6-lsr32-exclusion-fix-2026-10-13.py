#!/usr/bin/env python3
"""Follow-up to apply-round6-source-checks-2026-10-13.py.

speaker-provenance-audit requires simulationExcluded and exclusionReason to sit inside disputedPoints (the same
place ELX200-15 keeps them). This moves the two keys from frequencyResponse into disputedPoints. Refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')


def main():
    db = json.load(open(DATA, encoding='utf-8'))
    r = next(x for x in db if x['id'] == 'jbl-lsr32')
    fr = r['frequencyResponse']
    dp = fr['disputedPoints']
    assert 'simulationExcluded' not in dp, 'already applied'
    assert fr.get('simulationExcluded') is True and isinstance(fr.get('exclusionReason'), str), fr.get('simulationExcluded')
    dp['simulationExcluded'] = True
    dp['exclusionReason'] = fr.pop('exclusionReason')
    fr.pop('simulationExcluded')
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(db, fh, indent=2, ensure_ascii=False); fh.write('\n')
    os.replace(tmp, DATA)
    print('moved simulationExcluded and exclusionReason into jbl-lsr32 disputedPoints')


if __name__ == '__main__':
    main()
