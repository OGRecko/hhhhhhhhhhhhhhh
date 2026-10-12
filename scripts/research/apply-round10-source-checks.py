#!/usr/bin/env python3
"""Round 10 source checks (2026-10-12). Opened and checked in this round:

- MartinLogan Motion 60XT product page (https://www.martinlogan.com/en/product/motion-60xt), chunks 0-1 of 3.
  Specs table lists: 1 Folded Motion XT HF transducer, 1 6.5in aluminum midrange, 2 8in woofers -> 4 transducers.
  -> martinlogan-motion-60xt driverCount 4 = MANUFACTURER_VERIFIED (count enumerated from the spec table).
  active (stored false): the page does not state passive. Kept CITED_IN_NOTES_UNCHECKED (not promoted).
- Yamaha NS-6490 specs (usa.yamaha.com .../ns-6490/specs.html): "Sensitivity 90 dB/2.83 V/m", "Nominal Impedance 8 ohms".
  Ledger only. Region of the record is still unresolved, so impedance stays unavailable.
- proaudiovideo.in Amazon Echo (4th Gen) review: retailer blog with a "Buy Now" link. Not a manufacturer source.
  Held amazon-echo driverCount (3) is NOT supported by a manufacturer source. Value stays null.
- bluebookofguitarvalues.com Peavey 5150 412 page: price guide, no driver specification. Held value 4 NOT supported. Stays null.
- pioneerelectronics.com TS-A1670F: the cited URL resolves to the Pioneer homepage (no product page). Held pioneer-ts-a active
  NOT supported. Stays null.

Refuses to rerun: exits if the marker is already in the ledger.
"""
import json, os, sys

MARK = 'round10-source-checks'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-source-ledger.json')
DATE = '2026-10-12'
MOTION = 'https://www.martinlogan.com/en/product/motion-60xt'

led = json.load(open(LEDGER, encoding='utf-8'))
if any(r.get('marker') == MARK for r in led.get('rounds', [])):
    sys.exit('round 10 already applied; refusing to rerun')

raw = open(DATA, encoding='utf-8').read()
db = json.load(open(DATA, encoding='utf-8'))
by = {r['id']: r for r in db}

m = by['martinlogan-motion-60xt']
assert m['driverCount'] == 4 and m['active'] is False
m['driverCountProvenance'] = {
    'status': 'MANUFACTURER_VERIFIED', 'source': MOTION, 'sourceType': 'MANUFACTURER', 'checkedDate': DATE,
    'note': MARK + ': spec table lists 1 Folded Motion XT tweeter, 1 6.5in midrange, 2 8in woofers (4 transducers).',
}
m['notes'] = (m.get('notes') or '').rstrip() + (
    f' {MARK}: driverCount 4 verified from the manufacturer spec table. active false is not stated as passive on the page; left cited-unchecked.')

for rid, text in [
    ('amazon-echo', 'Round 10: the cited source is a retailer blog ("Buy Now" link), not a manufacturer source. The held driverCount 3 is not supported and stays null.'),
    ('legacy-peavey-5150-412', None),
    ('peavey-5150-412', 'Round 10: the cited page is a price guide with no driver specification. The held driverCount 4 is not supported and stays null.'),
    ('pioneer-ts-a', 'Round 10: the cited URL resolves to the Pioneer homepage, not a product page. The held active value is not supported and stays null.'),
]:
    if rid in by and text:
        by[rid]['notes'] = (by[rid].get('notes') or '').rstrip() + ' ' + text

with open(DATA, 'w', encoding='utf-8') as f:
    json.dump(db, f, indent=2, ensure_ascii=False)
    f.write('\n')

led['sources'].extend([
    {'url': MOTION, 'host': 'martinlogan.com', 'document': 'MartinLogan Motion 60XT product page (specs table)',
     'status': 'CHECKED_PARTIAL', 'openedDate': DATE, 'chunksOpened': [0, 1], 'chunksTotal': 3,
     'coverage': 'Specs table: 35-25,000 Hz +/-3 dB; 94 dB/2.83 volts/meter; 4 ohm; 1 HF, 1 MF, 2 LF transducers. Active or passive is not stated.',
     'decisions': ['martinlogan-motion-60xt driverCount 4 MANUFACTURER_VERIFIED', 'active false stays CITED_IN_NOTES_UNCHECKED'],
     'queueItemsResolved': 1},
    {'url': 'https://usa.yamaha.com/products/audio_visual/speaker_systems/ns-6490/specs.html', 'host': 'usa.yamaha.com',
     'document': 'Yamaha NS-6490 specs (US)', 'status': 'CHECKED_PARTIAL', 'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 1,
     'coverage': 'Sensitivity 90 dB/2.83 V/m (literal wording); Nominal Impedance 8 ohms (US page). Market/variant of the record is not resolved, so impedance stays unavailable.',
     'decisions': ['yamaha-ns-6490 sensitivity 90 kept (reference wording 2.83V/m kept; not converted)', 'impedance stays N/A (region unresolved)'],
     'queueItemsResolved': 0},
    {'url': 'https://proaudiovideo.in/amazon-echo-4th-gen-review-2026/', 'host': 'proaudiovideo.in',
     'document': 'Amazon Echo (4th Gen) retailer review', 'status': 'CHECKED_REJECTED', 'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 3,
     'coverage': 'Retailer blog with Buy Now link. Not a manufacturer source.', 'decisions': ['amazon-echo driverCount held value cleared (stays null)'], 'queueItemsResolved': 0},
    {'url': 'https://bluebookofguitarvalues.com/products/peavey-5150-412-speaker-cabinet', 'host': 'bluebookofguitarvalues.com',
     'document': 'Peavey 5150 412 price guide', 'status': 'CHECKED_REJECTED', 'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 3,
     'coverage': 'Price and value guide. No driver specification.', 'decisions': ['peavey-5150-412 driverCount held value cleared (stays null)'], 'queueItemsResolved': 0},
    {'url': 'https://www.pioneerelectronics.com/PUSA/Car/Speakers/A-Series/TS-A1670F', 'host': 'pioneerelectronics.com',
     'document': 'Pioneer TS-A1670F (cited URL)', 'status': 'CHECKED_REJECTED', 'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 9,
     'coverage': 'Cited URL resolves to the Pioneer homepage (usa.pioneer), not a product page.', 'decisions': ['pioneer-ts-a active held value cleared (stays null)'], 'queueItemsResolved': 0},
])
led.setdefault('rounds', []).append({
    'round': 10, 'marker': MARK, 'date': DATE,
    'applied': ['martinlogan-motion-60xt driverCount 4 MANUFACTURER_VERIFIED (spec table)',
                'amazon-echo, peavey-5150-412, pioneer-ts-a: held values remain null; notes record rejected sources'],
})
with open(LEDGER, 'w', encoding='utf-8') as f:
    json.dump(led, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('round 10 applied')
