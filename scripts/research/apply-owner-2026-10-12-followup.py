#!/usr/bin/env python3
"""Owner answers on 2026-10-12 (follow-up round), applied once.

1. infinity-rs1: the owner chose to clear the unverified single-source values to UNAVAILABLE and keep the row.
   Cleared: sensitivity 86 dB, impedance 6 ohm, woofer 12 in (all THIRD_PARTY from one page whose configuration
   conflicts with the hifi-guide copy). Source URLs are kept in notes. overallStatus becomes UNVERIFIED because no
   sourced field remains (same convention as the other all-UNAVAILABLE records).
2. electro-voice-elx200-15: the owner chose ROW_COUNT_RESOLVED_STORED_MATCHES_PRIMARY. The record already carries
   that status, so only the decision is noted in the record.
3. jbl-4311: the owner chose to keep the stored values and flag the discrepancy. A flag is added to the context.
4. electro-voice-zx3-60/-90: the owner chose to keep the source wording. No change.

The script asserts the current state and refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
DATE = '2026-10-12'


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}

    r = by['infinity-rs1']
    assert r['overallStatus'] == 'PARTIALLY_VERIFIED', r['overallStatus']
    assert r['sensitivity']['value'] == 86 and r['impedance']['value'] == 6 and r['woofer']['value'] == 12
    url = 'https://vintagetechnologyarchive.com/audio/infinity/rs-1b/'
    for k, unit in (('sensitivity', 'dB'), ('impedance', 'ohm'), ('woofer', 'in')):
        r[k] = {'value': None, 'unit': unit, 'status': 'UNAVAILABLE', 'source': None, 'sourceType': 'NONE'}
    r['overallStatus'] = 'UNVERIFIED'
    r['notes'] = (r['notes'].rstrip() + f' Owner decision ({DATE}): the unverified single-source values (86 dB sensitivity, '
                  f'6 ohm impedance, 12 in woofer, all from {url}) are cleared to UNAVAILABLE. The configuration conflict '
                  'with the hifi-guide.com passive five-way copy is unresolved, and the row stays in the dataset. '
                  'overallStatus is UNVERIFIED because no sourced field remains.')

    e = by['electro-voice-elx200-15']
    dp = e['frequencyResponse']['disputedPoints']
    assert dp['status'] == 'ROW_COUNT_RESOLVED_STORED_MATCHES_PRIMARY', dp['status']
    dp['ownerDecision'] = {'date': DATE, 'decision': 'Keep the 85 stored points excluded from simulation; status ROW_COUNT_RESOLVED_STORED_MATCHES_PRIMARY confirmed by owner. The open issue is the -3/-10 dB range difference only.'}

    j = by['jbl-4311']
    fr = j['frequencyResponse']
    assert 'Owner decision' not in (fr.get('pointsContext') or '')
    fr['pointsContext'] = (fr['pointsContext'].rstrip() + f' Owner decision ({DATE}): stored values kept. The cited page as fetched on {DATE} shows whole-dB values that differ from the stored points at about 13 frequencies (e.g. 31.5 Hz page -11 / stored -11.5; 3150 Hz page 1 / stored 2.5). Unresolved until a PDF or second render is checked.')

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(DATA + '.tmp', DATA)
    print('applied: infinity-rs1 -> UNVERIFIED; elx200-15 decision noted; jbl-4311 flagged; zx3 unchanged')


if __name__ == '__main__':
    main()
