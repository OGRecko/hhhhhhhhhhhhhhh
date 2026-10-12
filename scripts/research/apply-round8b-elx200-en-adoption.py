#!/usr/bin/env python3
"""Round 8b: owner chose the ELX200-15 EN manufacturer edition (2026-10-12 answer).

- Adds the 87-row EN table as the published response points (pointsStatus MANUFACTURER_VERIFIED).
- Its rows were checked against the EN datasheet text with scripts/research/verify-elx200-15-en-transcription.py (0 mismatches).
- The 85 previously stored points are kept as history under disputedPoints, marked SUPERSEDED. Nothing is deleted.
- The -3/-10 dB range difference is recorded as still open; the EN table is not used to restate the stated range.
Refuses to rerun: exits if the marker is already in the data file.
"""
import csv, json, os, subprocess, sys

MARK = 'round8b-elx200-en-adoption'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-source-ledger.json')
TRANS = os.path.join(ROOT, 'scripts', 'research', 'data', 'elx200-15-primary-en-2026-10-13-bdl.txt')
VERIFY = os.path.join(ROOT, 'scripts', 'research', 'verify-elx200-15-en-transcription.py')
EN_URL = 'https://products.electrovoice.com/binary/ELX200-15_BDL_en.pdf'
DATE = '2026-10-12'

if MARK in open(DATA, encoding='utf-8').read():
    sys.exit('round 8b already applied; refusing to rerun')

rc = subprocess.run([sys.executable, VERIFY]).returncode
if rc != 0:
    sys.exit('EN transcription does not match the datasheet; not adopting')

rows = []
for line in open(TRANS, encoding='utf-8'):
    s = line.strip()
    if not s or s.startswith('#'):
        continue
    f, db, _z = s.split()
    rows.append({'hz': int(float(f)), 'db': float(db)})
assert len(rows) == 87

db_all = json.load(open(DATA, encoding='utf-8'))
rec = [r for r in db_all if r['id'] == 'electro-voice-elx200-15'][0]
fr = rec['frequencyResponse']
assert fr.get('pointsStatus') == 'UNAVAILABLE' and 'points' not in fr
stored = fr['disputedPoints']
assert len(stored['points']) == 85

stored['status'] = 'SUPERSEDED_BY_OWNER_EN_ADOPTION'
stored['simulationExcluded'] = True
stored['supersededBy'] = {
    'date': DATE, 'marker': MARK,
    'decision': 'Owner chose the EN manufacturer edition. The 85 stored points are kept here as history, not used, and not deleted.',
}

fr['points'] = rows
fr['pointsStatus'] = 'MANUFACTURER_VERIFIED'
fr['pointsSource'] = EN_URL
fr['pointsSourceType'] = 'MANUFACTURER'
fr['pointsContext'] = (
    'EN manufacturer datasheet (products.electrovoice.com ELX200-15_BDL_en.pdf, one fetch, 2026-10-12). '
    'Table: Frequency (Hz) | Frequency Response, Full Space, 1W/1m (Sensitivity, dB) | Impedance. '
    'All 87 rows, 20 Hz to 20 kHz, copied without interpolation; the 2400, 2500 and 2600 Hz rows are included. '
    'Checked row-for-row with scripts/research/verify-elx200-15-en-transcription.py (0 mismatches). '
    'Open: the stated -3 dB (77 Hz-16 kHz) and -10 dB (52 Hz-19 kHz) range is not restated from the table. '
    'Reference: the sheet footnote says full-space 1 W/1 m. Impedance column is in the transcription file, not in points. '
    f'{MARK}: stored 85 points kept under disputedPoints as superseded history.'
)
rec['notes'] = (rec.get('notes') or '').rstrip() + (
    f' {MARK} (2026-10-12): owner chose the EN manufacturer edition. The published response is now the 87-row EN table '
    '(scripts/research/data/elx200-15-primary-en-2026-10-13-bdl.txt, row-checked against the datasheet). '
    'The stored 85 points are kept as superseded history under disputedPoints.'
)

with open(DATA, 'w', encoding='utf-8') as f:
    json.dump(db_all, f, indent=2, ensure_ascii=False)
    f.write('\n')

led = json.load(open(LEDGER, encoding='utf-8'))
for s in led['sources']:
    if s.get('url', '').endswith('ELX200-15_BDL_en.pdf'):
        s['status'] = 'CHECKED_CONFIRMED'
        s['chunksOpened'] = [0]
        s['chunksTotal'] = 1
        s.setdefault('decisions', []).append(
            f'{MARK}: owner adopted EN edition. 87/87 rows match this datasheet (verify script). Stored 85 points superseded, kept as history.')
        s['queueItemsResolved'] = 0
led.setdefault('rounds', []).append({
    'round': '8b', 'marker': MARK, 'date': DATE,
    'applied': ['electro-voice-elx200-15 published points = EN 87-row table (MANUFACTURER_VERIFIED)',
                'stored 85 points kept as disputedPoints SUPERSEDED_BY_OWNER_EN_ADOPTION'],
    'openIssue': 'stated -3/-10 dB range vs table not restated; FR editions still disagree with EN (55/53 diffs, see round 8 ledger)',
})
led['openQuestionsForOwner'] = [q for q in led['openQuestionsForOwner'] if q.get('id') != 'elx-edition']
with open(LEDGER, 'w', encoding='utf-8') as f:
    json.dump(led, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('round 8b applied: ELX200-15 published points = 87 EN rows; 85 stored points kept as superseded history')
