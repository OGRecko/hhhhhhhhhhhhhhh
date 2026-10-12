#!/usr/bin/env python3
"""Round 8c: ledger entries for the owner's answers (2026-10-12) and the searches run for them.

- Genelec 8331A SOFA: owner said to look elsewhere and remove the lead if not found. Searched genelec.com (no SOFA or
  polar data; graphic only), Erin's Audio Corner (third-party CTA-2034 set, different format), and the Zenodo listing
  (MD5 a00e4016... matches, host unreachable). No substitute file used. Lead withdrawn by owner rule.
- Turbosound iP15B: owner said to look elsewhere and delete if not found. A dealer-hosted copy of the Turbosound/Music
  Tribe Product Information Document was found (monthany.com, 2 chunks; chunk 0 opened). It gives 1 x 15" LF driver and
  "Crossover type: Active", but it is hosted by a dealer. Origin is not proven, so sourceType stays unset and the
  record is kept. Flagged for the owner.
- LSR32 20 kHz: owner chose to keep both readings disputed. No data change.
Refuses to rerun: exits if the marker is already in the ledger.
"""
import json, os, sys

MARK = 'round8c-owner-answers'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-source-ledger.json')
DATE = '2026-10-12'

led = json.load(open(LEDGER, encoding='utf-8'))
if any(r.get('marker') == MARK for r in led.get('rounds', [])):
    sys.exit('round 8c already applied; refusing to rerun')

led['sources'].extend([
    {
        'url': 'https://zenodo.org/records/10255555', 'host': 'zenodo.org',
        'document': 'Genelec 8331A directivity SOFA (LS_directivity_Calibrated_GENELEC_8331A.sofa, 410.5 MB, MD5 a00e40164556183420c315e9f6ecd7fd)',
        'status': 'WITHDRAWN_BY_OWNER', 'openedDate': DATE, 'chunksOpened': [], 'chunksTotal': None,
        'coverage': 'Zenodo host unreachable from sandbox (HTTP 000). The owner said to search elsewhere and remove the lead if not found. '
                    'Searched: genelec.com/8331a (spec page; directivity is a graphic only, no data file); Erin\'s Audio Corner '
                    '(third-party CTA-2034 measurement set, different format, not a substitute); spinorama.org (third-party). '
                    'No trusted substitute file. No file downloaded. No polar data synthesized.',
        'decisions': ['genelec-8331a directivity lead removed (no import, no substitute, no synthesized polar data)'],
        'queueItemsResolved': 0,
    },
    {
        'url': 'https://monthany.com/wp-content/uploads/2022/12/Turbosound_iP15B_datasheet_monthany.pdf', 'host': 'monthany.com (dealer-hosted copy)',
        'document': 'Turbosound iNSPIRE iP15B Product Information Document (dealer copy; contains Music Tribe trademark notice)',
        'status': 'CHECKED_PARTIAL', 'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 2,
        'coverage': 'Chunk 0 opened. Gives 1 x 15 in LF driver, Crossover type: Active, Maximum SPL 120 dB, Half space dispersion. '
                    'Hosted by a dealer, so manufacturer origin is not proven. sourceType stays unset.',
        'decisions': ['turbosound-ip15b sourceType stays unset (origin not proven). Record kept, not deleted. Flagged for owner.',
                      'turbosound-ip15b driverCount 1 and active True: supported by this copy; not promoted to MANUFACTURER_VERIFIED'],
        'queueItemsResolved': 0,
    },
])
led['openQuestionsForOwner'] = [q for q in led['openQuestionsForOwner']
                                if q.get('id') not in ('genelec-8331a-sofa', 'turbosound-ip15b-sourceType')]
led['openQuestionsForOwner'].append({
    'id': 'turbosound-ip15b-origin',
    'question': 'The only iP15B document found is a dealer-hosted copy (monthany.com). Keep the record with sourceType unset, or delete it under your earlier instruction?',
})
led.setdefault('rounds', []).append({
    'round': '8c', 'marker': MARK, 'date': DATE,
    'applied': ['genelec 8331A directivity lead withdrawn by owner rule (no import)',
                'turbosound iP15B: dealer copy recorded, sourceType unset, record kept (flagged)',
                'lsr32 20 kHz: owner kept both disputed (no data change)'],
})
with open(LEDGER, 'w', encoding='utf-8') as f:
    json.dump(led, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('round 8c ledger entries written')
