#!/usr/bin/env python3
"""Round 6 source checks (2026-10-13). Each change is backed by a source opened in this pass; see
provenance-ledger-round6-2026-10-13.json. Preconditions are asserted first; the script refuses to run twice.

1. electro-voice-elx200-15: the 2026-10-13 re-fetch of the primary datasheet conflicts with the stored 85 points
   (86 printed rows, 2400/2600 Hz present, 2500 Hz absent, 9 differing values). The stored points, the simulation
   exclusion and the owner's 2026-10-12 status are kept unchanged; the reopened conflict is recorded beside them.
2. jbl-lsr32: the 27 verified points end at 10 kHz, and the simulator extrapolates above the last point. The unresolved
   20 kHz conflict is handled with the existing exclusion mechanism (points moved to disputedPoints, simulationExcluded).
3. legacy-mack-4 (Mackie CR3): values checked against a pdf-manuals.com copy of the Mackie manual, not a Mackie host.
   Downgraded from MANUFACTURER_VERIFIED to THIRD_PARTY_VERIFIED.
4. equator-d5: woofer 5.25 in populated from the gear4music product page (exact product; retailer claim only).
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
DATE = '2026-10-13'
DONE_MARK = 'Round 6 source check (2026-10-13)'


def load_refetch():
    fetch = {}
    for line in open(os.path.join(ROOT, 'scripts/research/data/elx200-15-primary-fr-2026-10-13-refetch.txt'), encoding='utf-8'):
        if line.startswith('#') or not line.strip():
            continue
        h, s, _ = line.split()
        fetch[float(h)] = float(s)
    return fetch


def main():
    db = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in db}

    # 1. ELX200-15 reopened conflict (no change to stored points or status)
    elx = by['electro-voice-elx200-15']
    dp = elx['frequencyResponse']['disputedPoints']
    assert 'reopened2026_10_13' not in dp, 'already applied'
    stored = {p['hz']: p['db'] for p in dp['points']}
    fetch = load_refetch()
    assert len(stored) == 85 and len(fetch) == 86
    assert sorted(set(fetch) - set(stored)) == [2400.0, 2600.0] and sorted(set(stored) - set(fetch)) == [2500.0]
    diffs = [{'hz': h, 'stored': stored[h], 'refetch': fetch[h]} for h in sorted(set(fetch) & set(stored)) if fetch[h] != stored[h]]
    assert len(diffs) == 9, diffs
    dp['reopened2026_10_13'] = {
        'status': 'ROW_COUNT_AND_VALUE_CONFLICT_REOPENED',
        'date': DATE,
        'evidence': 'https://assets.electrovoicedynacord.com/asset/c2b9bf16-1e17-4053-847a-20773866d7f8/ELX200-15-Engineering-Data-Sheet.pdf',
        'evidenceFile': 'scripts/research/data/elx200-15-primary-fr-2026-10-13-refetch.txt',
        'storedRows': 85, 'refetchRows': 86,
        'onlyInRefetch': [2400, 2600], 'onlyInStored': [2500],
        'valueDifferences': diffs,
        'decision': 'Stored points unchanged. Simulation exclusion kept. The 2026-10-12 owner status is not overwritten, but this fetch conflicts with the v2 reconciliation it relied on, so owner review is required before the status is relied on.',
    }
    dp['exclusionReason'] = dp['exclusionReason'] + ' ' + DONE_MARK + ': a re-fetch of the primary datasheet prints 86 rows (2400 and 2600 Hz present, 2500 Hz absent) and nine values differ from the stored table; see disputedPoints.reopened2026_10_13. Owner review required.'

    # 2. LSR32: move the verified 27 points out of the simulated series
    lsr = by['jbl-lsr32']
    fr = lsr['frequencyResponse']
    assert 'points' in fr and fr.get('pointsStatus') == 'MANUFACTURER_VERIFIED', fr.get('pointsStatus')
    pts = fr['points']
    assert len(pts) == 27 and max(p['hz'] for p in pts) == 10000 and not any(p['hz'] == 20000 for p in pts)
    fr['disputedPoints'] = {
        'status': 'UNRESOLVED_SELF_CONFLICT_20KHZ',
        'points': pts,
        'source': fr['pointsSource'],
        'context': fr['pointsContext'] + ' ' + DONE_MARK + ': the 27 points are kept here, not simulated. Because the points stop at 10 kHz, the simulator would extrapolate above 10 kHz, so the series is excluded until the owner decides. The 20 kHz candidates (61 dB in the Amplitude & Phase table, 92 dB in the Acoustic Contribution table of the same manual) are both unresolved.',
    }
    del fr['points']
    fr['pointsStatus'] = 'UNAVAILABLE'
    fr['pointsSourceType'] = 'NONE'
    fr['simulationExcluded'] = True
    fr['exclusionReason'] = 'Unresolved self-conflict at 20 kHz in the same manual (61 vs 92 dB) and a 10 kHz coverage limit would be extrapolated above 10 kHz by the simulator. Points are kept in disputedPoints; owner decision required. ' + DONE_MARK + '.'
    fr.pop('pointsContext', None)
    fr.pop('pointsSource', None)

    # 3. legacy-mack-4: third-party copy of the manufacturer manual, downgraded
    mk = by['legacy-mack-4']
    src = 'https://www.pdf-manuals.com/pdf/mackie-cr3-3-woofer-creative-reference-cr3-pair-b-h-330662-user-manual.pdf'
    checks = {
        'frequencyResponse': ('low_hz', 70, 'MANUFACTURER_VERIFIED'),
        'power': ('value', 28, 'MANUFACTURER_VERIFIED'),
        'woofer': ('value', 3, 'MANUFACTURER_VERIFIED'),
    }
    for f, (k, v, st) in checks.items():
        assert mk[f][k] == v and mk[f]['status'] == st and mk[f]['source'] == src, (f, mk[f])
        mk[f]['status'] = 'THIRD_PARTY_VERIFIED'
        mk[f]['sourceType'] = 'THIRD_PARTY'
        mk[f]['notes'] = (mk[f].get('notes') or '') + ' ' + DATE + ': the copy is hosted by pdf-manuals.com, not by Mackie; no Mackie host was reached, so the status is THIRD_PARTY_VERIFIED. The values were re-read from the copy\'s Appendix B table (CR3 column: 70 Hz-20 kHz at -3 dB; 28 W rms; 3.0 in woofer).'
    mk['notes'] = mk['notes'].replace('No source-backed physical specification is retained for this exact model.', 'The earlier statement that no source-backed physical specification is retained is superseded: see the 2026-10-13 notes on frequencyResponse, power and woofer.')

    # 4. equator-d5 woofer from the gear4music product page
    eq = by['equator-d5']
    assert eq['woofer']['value'] is None and eq['woofer']['status'] == 'UNAVAILABLE'
    eq['woofer'] = {
        'value': 5.25, 'unit': 'in', 'status': 'THIRD_PARTY_VERIFIED',
        'source': 'https://www.gear4music.com/Recording-and-Computers/Equator-D5-Active-Studio-Monitors-with-Internal-DSP-Pair/LA3',
        'sourceType': 'THIRD_PARTY',
        'notes': DATE + ": the gear4music product page for the Equator D5 (Product Ref 27579) states 'Coaxial Designed 5.25\" Diameter Polypropylene Woofer'. Retailer claim only; no Equator manufacturer page has been reached.",
    }

    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(db, fh, indent=2, ensure_ascii=False); fh.write('\n')
    os.replace(tmp, DATA)
    print('round 6 source checks applied')


if __name__ == '__main__':
    main()
