#!/usr/bin/env python3
"""Round 17: row-level comparison of all ELX200-15 readings. Writes elx200-15-reconciliation-round17.json.
Stored points (the 85 excluded points) are the 2026-10-12 FR reading. Nothing is adopted; status stays UNRESOLVED."""
import json, pathlib
R = pathlib.Path(__file__).resolve().parent
D = R / 'data'
def load(p):
    rows = {}
    for line in open(p, encoding='utf-8'):
        if line.startswith('#') or not line.strip(): continue
        parts = line.split()
        try: f = int(float(parts[0]))
        except ValueError: continue
        rows.setdefault(f, (float(parts[1]), float(parts[2])))
    return rows
readings = {
 'FR-2026-10-12 (stored)': 'elx200-15-primary-fr-2026-10-12.txt',
 'FR-2026-10-13 re-fetch 1': 'elx200-15-primary-fr-2026-10-13-refetch.txt',
 'FR-2026-10-13 re-fetch 2': 'elx200-15-primary-fr-2026-10-13-refetch2.txt',
 'FR-2026-10-13 re-fetch 3': 'elx200-15-primary-fr-2026-10-13-refetch3.txt',
 'EN-BDL-2026-10-13': 'elx200-15-primary-en-2026-10-13-bdl.txt',
}
D_ = {k: load(D / v) for k, v in readings.items()}
ref = D_['FR-2026-10-12 (stored)']
out = {'schema': 'elx200-15-reconciliation-round17/v1', 'status': 'UNRESOLVED',
       'storedPoints': 85, 'simulationExcluded': True,
       'readings': [], 'pairwise_vs_stored': {}, 'notes': []}
for k, v in readings.items():
    rows = D_[k]
    out['readings'].append({'label': k, 'file': f'scripts/research/data/{v}', 'rows': len(rows),
                            'has2400': 2400 in rows, 'has2500': 2500 in rows, 'has2600': 2600 in rows})
for k in readings:
    if k == 'FR-2026-10-12 (stored)': continue
    a, b = D_[k], ref
    shared = sorted(set(a) & set(b))
    db = [f for f in shared if a[f][0] != b[f][0]]
    z = [f for f in shared if a[f][1] != b[f][1]]
    out['pairwise_vs_stored'][k] = {
        'sharedRows': len(shared), 'onlyInThis': sorted(set(a) - set(b)), 'onlyInStored': sorted(set(b) - set(a)),
        'dbDifferences': [{'hz': f, 'stored': b[f][0], 'this': a[f][0]} for f in db],
        'impedanceDifferences': len(z),
        'dbMaxAbsDiff': max((abs(b[f][0]-a[f][0]) for f in db), default=0)}
out['notes'] = [
 'Units: dB sensitivity values are the sheet column "Frequency Response, Full Space, 1W/1m (Sensitivity, dB)"; the stored points are dB. Impedance column is in ohms (rhs) and is not part of the stored points.',
 'Tolerance: the sheet prints integer or half-dB values; no tolerance is printed. Readings are text extraction, not image reads; no reading is tolerance-certified.',
 'The 2400 Hz and 2600 Hz rows appear in the EN edition and in FR re-fetch 1 (86 rows), but not in the stored FR reading, FR re-fetch 2 or FR re-fetch 3. The 2500 Hz row is absent only in FR re-fetch 1.',
 'The stored FR reading and FR re-fetch 3 agree on all 85 dB values. FR re-fetch 3 impedance differs from the stored reading impedance on 71 rows (not stored in points).',
 'The sheet states -3 dB 77 Hz-16 kHz, -10 dB 52 Hz-19 kHz (Mesure intégrale). Stored table does not cover that range as a measured point set; the averaging band is not printed.',
]
(R / 'elx200-15-reconciliation-round17.json').write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps({k: {x: y for x, y in v.items() if x not in ('dbDifferences',)} for k, v in out['pairwise_vs_stored'].items()}, indent=1))
print([r['rows'] for r in out['readings']])
