#!/usr/bin/env python3
"""Round 11 queue batch (2026-10-12) + durable per-URL queue status.

Creates scripts/research/queue-url-status.json (one entry per queue URL, initially NOT_CHECKED) if absent, then records
the URLs opened in this batch and promotes only the fields those pages explicitly support.

Opened in this batch (chunk indexes in parentheses):
- https://jblpro.com/en-US/site_elements/4430-and-4435-information (0 of 3): spec table; the 4430 uses one 380 mm LF
  driver and one compression driver crossed over at 1 kHz -> driverCount 2 for jbl-4430 and legacy-jbl-6. Active/passive
  is not stated in words; left cited-unchecked.
- https://www.bang-olufsen.com/en/us/comparison/products?slug=speakers&p1=beosound-a5&p2=beosound-level&p3=beolit-20 (0 of 1; the exact recorded URL):
  Beosound A5 = 1x0.8in tweeter + 2x2in full-range + 1x5.25in woofer = 4 drivers, each with its own class-D amplifier.
  Beosound Level = 2x0.8in tweeter + 1x2in full-range + 2x4in woofer = 5 drivers, class-D amplified.
  -> driverCount 4 and 5, active True: MANUFACTURER_VERIFIED (built-in per-driver amplification is explicit).
- https://mackie.com/img/file_resources/CR-X_Series_QSG.pdf (0 of 6): safety text only. No spec table in this chunk.
  mackie-cr3-x unchanged. Remaining chunks not yet opened.
- https://www.leone.sk/file/230/ev-zlx-manual.pdf (0 of 5): Electro-Voice user manual hosted by a reseller. Contents show
  powered and passive variants. Technical data is in a later chunk, not opened. eV-zlx12p / eV-zlx15p unchanged.

Refuses to rerun: exits if the marker is already in the ledger.
"""
import json, os, sys
MARK = 'round11-queue-batch'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-source-ledger.json')
QUEUE = os.path.join(ROOT, 'scripts', 'research', 'provenance-queue.json')
STATUS = os.path.join(ROOT, 'scripts', 'research', 'queue-url-status.json')
DATE = '2026-10-12'
JBL = 'https://jblpro.com/en-US/site_elements/4430-and-4435-information'
BO = 'https://www.bang-olufsen.com/en/us/comparison/products?slug=speakers&p1=beosound-a5&p2=beosound-level&p3=beolit-20'  # exact recorded URL (opened; same A5/Level rows)
MACKIE = 'https://mackie.com/img/file_resources/CR-X_Series_QSG.pdf'
EVZLX = 'https://www.leone.sk/file/230/ev-zlx-manual.pdf'

led = json.load(open(LEDGER, encoding='utf-8'))
if any(r.get('marker') == MARK for r in led.get('rounds', [])):
    sys.exit('round 11 already applied; refusing to rerun')

# durable per-URL status: initialise once from the current queue
if not os.path.exists(STATUS):
    q = json.load(open(QUEUE, encoding='utf-8'))
    status = {'generatedFrom': 'scripts/research/provenance-queue.json', 'urls': []}
    for g in q['groups']:
        status['urls'].append({'url': g['url'], 'host': g['host'], 'records': g['records'], 'fields': g['fields'],
                               'items': g['items'], 'status': 'NOT_CHECKED', 'chunksOpened': [], 'checkedDate': None,
                               'itemsResolved': 0, 'evidence': None})
else:
    status = json.load(open(STATUS, encoding='utf-8'))
by_url = {u['url']: u for u in status['urls']}

db = json.load(open(DATA, encoding='utf-8'))
by = {r['id']: r for r in db}

def promote(rid, field, url, note):
    rec = by[rid]
    assert (rec.get(field + 'Provenance') or {}).get('source') == url, (rid, field)
    p = rec.get(field + 'Provenance')
    p.update({'status': 'MANUFACTURER_VERIFIED', 'sourceType': 'MANUFACTURER', 'checkedDate': DATE, 'note': MARK + ': ' + note})
    return 1

n = 0
n += promote('jbl-4430', 'driverCount', JBL, 'one 380 mm LF driver + one compression driver = 2 drivers (spec page).')
n += promote('legacy-jbl-6', 'driverCount', JBL, 'duplicate record of the same JBL 4430 page; one LF + one compression driver = 2.')
n += promote('bang-olufsen-beosound-a5', 'driverCount', BO, '1x0.8in tweeter + 2x2in full-range + 1x5.25in woofer = 4.')
n += promote('bang-olufsen-beosound-a5', 'active', BO, 'class-D amplifiers listed per driver (built-in amplification).')
n += promote('bang-olufsen-beosound-level', 'driverCount', BO, '2x0.8in tweeter + 1x2in full-range + 2x4in woofer = 5.')
n += promote('bang-olufsen-beosound-level', 'active', BO, 'class-D amplifiers listed per driver (built-in amplification).')
for rid in ('jbl-4430', 'legacy-jbl-6', 'bang-olufsen-beosound-a5', 'bang-olufsen-beosound-level'):
    by[rid]['notes'] = (by[rid].get('notes') or '').rstrip() + f' {MARK}: field-level check recorded in provenance.'

with open(DATA, 'w', encoding='utf-8') as f:
    json.dump(db, f, indent=2, ensure_ascii=False); f.write('\n')

def record(url, st, chunks, resolved, evidence):
    u = by_url[url]
    u.update({'status': st, 'chunksOpened': chunks, 'checkedDate': DATE, 'itemsResolved': resolved, 'evidence': evidence})
record(JBL, 'CHECKED_PARTIAL', [0], 2, 'Spec table: 4430 = one LF driver + one compression driver. Active/passive not stated.')
record(BO, 'CHECKED_CONFIRMED', [0], 4, 'A5 4 drivers + class-D per driver; Level 5 drivers + class-D.')
record(MACKIE, 'CHECKED_PARTIAL', [0], 0, 'Chunk 0 is safety text only. Spec chunk not opened.')
record(EVZLX, 'CHECKED_PARTIAL', [0], 0, 'Chunk 0 is table of contents and safety text. Technical data chunk not opened.')
json.dump(status, open(STATUS, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(STATUS, 'a').write('\n')

led['sources'].extend([
    {'url': JBL, 'host': 'jblpro.com', 'document': 'JBL 4430/4435 specification page', 'status': 'CHECKED_PARTIAL',
     'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 3,
     'coverage': 'driverCount 2 confirmed for 4430 (legacy-jbl-6 duplicate too). Active not stated.',
     'decisions': ['jbl-4430 driverCount 2 MANUFACTURER_VERIFIED', 'legacy-jbl-6 driverCount 2 MANUFACTURER_VERIFIED'], 'queueItemsResolved': 2},
    {'url': BO, 'host': 'bang-olufsen.com', 'document': 'B&O Beosound A5 vs Level comparison', 'status': 'CHECKED_CONFIRMED',
     'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 1,
     'coverage': 'Driver layouts and per-driver class-D amplifiers for both models. Page had an analytics block that was blocked; the spec table loaded.',
     'decisions': ['beosound-a5 driverCount 4, active True verified', 'beosound-level driverCount 5, active True verified'], 'queueItemsResolved': 4},
    {'url': MACKIE, 'host': 'mackie.com', 'document': 'CR3-X / CR4-X / CR5-X quick start guide', 'status': 'CHECKED_PARTIAL',
     'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 6, 'coverage': 'Chunk 0 only (safety text).',
     'decisions': ['mackie-cr3-x unchanged; spec chunk still to open'], 'queueItemsResolved': 0},
    {'url': EVZLX, 'host': 'leone.sk (reseller host of EV manual)', 'document': 'Electro-Voice ZLX user manual (powered and passive)',
     'status': 'CHECKED_PARTIAL', 'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 5,
     'coverage': 'Chunk 0 only (contents, safety). Technical data chunk still to open.',
     'decisions': ['eV-zlx12p / eV-zlx15p unchanged'], 'queueItemsResolved': 0},
])
led.setdefault('rounds', []).append({'round': 11, 'marker': MARK, 'date': DATE, 'fieldsPromoted': n,
    'applied': ['jbl-4430 and legacy-jbl-6 driverCount 2', 'bang-olufsen-beosound-a5 driverCount 4 / active True',
                'bang-olufsen-beosound-level driverCount 5 / active True']})
with open(LEDGER, 'w', encoding='utf-8') as f:
    json.dump(led, f, indent=2, ensure_ascii=False); f.write('\n')
print('round 11 applied; fields promoted:', n)
