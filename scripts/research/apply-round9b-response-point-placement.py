#!/usr/bin/env python3
"""Round 9b: keep unverified response points out of the authoritative `points` field.

The response-point auditor (scripts/lib/speakerAuditCore.mjs) accepts `points` only with MANUFACTURER, MEASUREMENT or
REPUTABLE_DATABASE provenance. Round 9 left Turbosound's dealer-copy points in `points` as THIRD_PARTY, and left
ELX pointsContext on a record with no point table. Both are fixed here without losing data:
- turbosound-ip15b: the 10 points move to frequencyResponse.thirdPartyPoints (THIRD_PARTY_VERIFIED, not simulated).
- electro-voice-elx200-15: pointsContext text moves into alternatePublishedPoints.pointsContextNote.
Refuses to rerun: exits if the marker is already present.
"""
import json, os, sys
MARK = 'round9b-response-point-placement'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
if MARK in open(DATA, encoding='utf-8').read():
    sys.exit('round 9b already applied; refusing to rerun')
db = json.load(open(DATA, encoding='utf-8'))
by = {r['id']: r for r in db}

t = by['turbosound-ip15b']['frequencyResponse']
assert 'points' in t and t['pointsStatus'] == 'THIRD_PARTY_VERIFIED'
pts = t.pop('points')
ctx = t.pop('pointsContext', '')
t['thirdPartyPoints'] = {
    'status': 'THIRD_PARTY_VERIFIED', 'sourceType': 'THIRD_PARTY',
    'source': t.get('pointsSource'),
    'points': pts,
    'context': ctx + f' {MARK}: not used by the simulator (dealer copy; origin not proven).',
}
t['pointsStatus'] = 'UNAVAILABLE'
t['pointsSourceType'] = 'NONE'
t['pointsSource'] = None

e = by['electro-voice-elx200-15']['frequencyResponse']
ectx = e.pop('pointsContext', None)
if ectx:
    e['alternatePublishedPoints']['pointsContextNote'] = ectx + f' {MARK}: moved here so the unavailable-points record has no context field.'

with open(DATA, 'w', encoding='utf-8') as f:
    json.dump(db, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('round 9b applied')
