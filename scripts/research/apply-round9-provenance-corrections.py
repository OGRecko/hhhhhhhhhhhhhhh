#!/usr/bin/env python3
"""Round 9 corrections (current brief, 2026-10-12).

1. ELX200-15: the current brief keeps the stored 85 points and keeps disputed data out of simulation while the
   primary-source conflict is open. Round 8b had adopted the 87-row EN table as published points. That is reversed here:
   the EN table is kept as an UNVERIFIED alternate that is not simulated. Stored 85 points stay under disputedPoints
   with status UNRESOLVED_ROW_COUNT. The reversal is recorded, not silent.
2. Turbosound iP15B: the 10 response points come from a dealer-hosted copy (monthany.com) of the manufacturer PID.
   Origin is not proven, so the classification is downgraded from MANUFACTURER to THIRD_PARTY. Values are unchanged.
Refuses to rerun: exits if the marker is already in the data file.
"""
import json, os, sys

MARK = 'round9-provenance-corrections'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-source-ledger.json')
DATE = '2026-10-12'
EN_URL = 'https://products.electrovoice.com/binary/ELX200-15_BDL_en.pdf'
DM_URL = 'https://monthany.com/wp-content/uploads/2022/12/Turbosound_iP15B_datasheet_monthany.pdf'

raw = open(DATA, encoding='utf-8').read()
if MARK in raw:
    sys.exit('round 9 already applied; refusing to rerun')
db = json.load(open(DATA, encoding='utf-8'))
by = {r['id']: r for r in db}

# 1. ELX200-15
rec = by['electro-voice-elx200-15']
fr = rec['frequencyResponse']
assert len(fr['points']) == 87 and fr['pointsStatus'] == 'MANUFACTURER_VERIFIED', 'expected round 8b state'
en_points = fr.pop('points')
fr['alternatePublishedPoints'] = {
    'status': 'UNVERIFIED_ALTERNATE_NOT_SIMULATED',
    'source': EN_URL,
    'sourceType': 'MANUFACTURER',
    'points': en_points,
    'comparisonWithStoredPoints': 'Value differences on shared frequencies: 52. EN-only rows: 2400 Hz and 2600 Hz.',
    'reason': 'Not used by the simulator. The EN table conflicts with the 85 stored points at 52 frequencies, and the FR editions disagree with each other and with EN. Round 9: kept as an unverified alternate under the current brief.',
    'verificationScript': 'scripts/research/verify-elx200-15-en-transcription.py (transcription matches one fetch of the EN PDF, 87/87 rows)',
    'changeLog': [{'date': DATE, 'marker': MARK, 'change': 'Moved from points (round 8b adoption) to alternatePublishedPoints. Reversed under current brief.'}],
}
fr['pointsStatus'] = 'UNAVAILABLE'
fr['pointsSourceType'] = 'NONE'
fr['pointsSource'] = None
fr['pointsContext'] = ('Response points are unavailable for simulation. The stored 85 points are retained under disputedPoints '
                       'with status UNRESOLVED_ROW_COUNT. The EN 87-row table is kept as alternatePublishedPoints. '
                       'No edition is adopted while the conflict is open.')
dp = fr['disputedPoints']
dp.pop('supersededBy', None)
dp['status'] = 'UNRESOLVED_ROW_COUNT'
dp['simulationExcluded'] = True
dp['round9Reversal'] = {'date': DATE, 'marker': MARK,
    'statement': 'Round 8b set the EN table as published points. Reversed: the current brief keeps the stored 85 points and keeps disputed data out of simulation.'}
rec['notes'] = (rec.get('notes') or '').rstrip() + (
    f' {MARK} (2026-10-12): response points unavailable for simulation. The stored 85 points are retained as disputed; the EN 87-row table is an unverified alternate.')

# 2. Turbosound iP15B: dealer copy, origin not proven
t = by['turbosound-ip15b']
f2 = t['frequencyResponse']
assert f2['pointsStatus'] == 'MANUFACTURER_VERIFIED' and f2['pointsSource'] == DM_URL
for k in ('status', 'sourceType', 'pointsStatus', 'pointsSourceType'):
    pass
f2['status'] = 'THIRD_PARTY_VERIFIED'
f2['sourceType'] = 'THIRD_PARTY'
f2['pointsStatus'] = 'THIRD_PARTY_VERIFIED'
f2['pointsSourceType'] = 'THIRD_PARTY'
f2['pointsContext'] = (f2.get('pointsContext') or '') + (
    f' {MARK}: the source is a dealer-hosted copy (monthany.com) of the Turbosound iNSPIRE iP15B product information document. '
    'The manufacturer-hosted original (media63.musictribe.com) could not be opened. Origin is not proven, so the points '
    'are classified THIRD_PARTY_VERIFIED, not MANUFACTURER_VERIFIED. Values are unchanged.')
t['notes'] = (t.get('notes') or '').rstrip() + (
    f' {MARK}: iP15B response points and frequency range are THIRD_PARTY_VERIFIED (dealer-hosted copy). sourceType stays unset.')

with open(DATA, 'w', encoding='utf-8') as f:
    json.dump(db, f, indent=2, ensure_ascii=False)
    f.write('\n')

led = json.load(open(LEDGER, encoding='utf-8'))
led.setdefault('rounds', []).append({
    'round': 9, 'marker': MARK, 'date': DATE,
    'applied': [
        'electro-voice-elx200-15: EN 87-row table moved to alternatePublishedPoints (not simulated); 85 stored points retained as disputed (UNRESOLVED_ROW_COUNT). Reverses round 8b.',
        'turbosound-ip15b: response points and frequency range reclassified THIRD_PARTY_VERIFIED (dealer copy, origin not proven).',
    ],
})
for s in led['sources']:
    if s.get('url', '').endswith('ELX200-15_BDL_en.pdf'):
        s.setdefault('decisions', []).append(f'{MARK}: EN table moved to unverified alternate, not simulated. Current brief keeps stored 85 points.')
    if s.get('url', '') == DM_URL:
        s.setdefault('decisions', []).append(f'{MARK}: points classified THIRD_PARTY_VERIFIED (dealer-hosted copy).')
with open(LEDGER, 'w', encoding='utf-8') as f:
    json.dump(led, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('round 9 applied')
