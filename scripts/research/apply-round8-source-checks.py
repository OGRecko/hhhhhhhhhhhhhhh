#!/usr/bin/env python3
"""Round 8 source checks. Applies only changes backed by documents opened in this round.

Opened and checked this round:
  - PreSonus R65/R80 owner's manual (fmicassets.com, OM_2777500201_R65_EN.pdf, chunk 0 of 4)
  - Electro-Voice Sx300PI/PIX engineering data sheet (products.electrovoice.com/binary/Sx300PI_PIX_EDS.pdf, chunk 0 of 4)
  - QSC WideLine-8 specifications (qscaudio.com .../wideline_8/q_spk_wl8_specs.pdf, chunk 0 of 2; WL212-sw column)
  - Focal Sopra N2 product sheet (media.focal-naim.com/dam/sopra-n-2/fp_sopra_n2_en.pdf) - ledger only, already applied
  - KEF R Series 2018 information sheet (assets.kef.com/uploads/cm/r2018_infosheet_en.pdf, chunks 0-1) - ledger only
  - Electro-Voice ELX200-15 EN transcription (scripts/research/data/elx200-15-primary-en-2026-10-13-bdl.txt) - ledger only

Not changed:
  - KEF R11/R3/R5 driverCount: the sheet's bass-driver counts match, but the total driver count was not fully confirmed.
  - Sx300PI/PIX active: the sheet does not state passive in words; stays as stored and cited-unchecked.
  - Mackie CR3 (legacy-mack-4): distributor-only evidence; stays null.
  - DALI Oberon 1/3/5/7: stays OPEN.
  - ELX200-15: the 85 stored points stay excluded; see ledger.

Refuses to rerun: exits if the marker is already in the data file.
"""
import json
import os
import sys

MARK = 'round8-source-checks'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-source-ledger.json')
ELX_HEADER = os.path.join(ROOT, 'scripts', 'research', 'data', 'elx200-15-primary-en-2026-10-13-bdl.txt')

PRESONUS_URL = 'https://www.fmicassets.com/Damroot/Original/10001/OM_2777500201_R65_EN.pdf'
EV_URL = 'https://products.electrovoice.com/binary/Sx300PI_PIX_EDS.pdf'
QSC_WL8_URL = 'https://www.qscaudio.com/resource-files/productresources/spk/wideline_8/q_spk_wl8_specs.pdf'
DATE = '2026-10-12'

raw = open(DATA, encoding='utf-8').read()
if MARK in raw:
    sys.exit('round 8 already applied to speakers.json; refusing to rerun')

db = json.load(open(DATA, encoding='utf-8'))
by_id = {r['id']: r for r in db}


def verified(rec, field, url, note):
    prov = rec.get(field + 'Provenance') or {}
    prov.update({
        'status': 'MANUFACTURER_VERIFIED',
        'source': url,
        'sourceType': 'MANUFACTURER',
        'checkedDate': DATE,
        'note': note,
    })
    rec[field + 'Provenance'] = prov


def append_note(rec, text):
    rec['notes'] = ((rec.get('notes') or '').rstrip() + ' ' + text).strip()


# PreSonus R65 / R80: one manual covers both models. Explicit: "2-way active AMT studio monitor", "self-powered".
for rid in ('presonus-r65', 'presonus-r80'):
    rec = by_id[rid]
    assert rec['driverCount'] == 2 and rec['active'] is True, rid
    verified(rec, 'driverCount', PRESONUS_URL,
             MARK + ': 2-way system with one AMT tweeter and one low-frequency driver (manual chunk 0).')
    verified(rec, 'active', PRESONUS_URL,
             MARK + ': manual describes the model as a 2-way active AMT studio monitor, self-powered (chunk 0).')

# Electro-Voice Sx300PI / Sx300PIX: two-way, 12-inch DL12Sx woofer and DH2010A HF driver named.
# active is NOT changed: the sheet does not state passive in words.
for rid in ('electro-voice-sx300pi', 'electro-voice-sx300pix'):
    rec = by_id[rid]
    assert rec['driverCount'] == 2, rid
    verified(rec, 'driverCount', EV_URL,
             MARK + ': two-way; DL12Sx 12-inch woofer and DH2010A HF driver named in the data sheet.')
    append_note(rec, MARK + ': active not stated in the data sheet; stored False is unchanged and remains cited-unchecked.')

# QSC WL212-sw: the WideLine-8 family sheet has a WL212-sw column (SUB 4 ohm; LF 99 dB SPL at 1 W/1 m).
# The earlier "different model" flag was wrong. Values are unchanged. active stays null.
rec = by_id['qsc-wl212-sw']
assert rec['impedance']['value'] == 4 and rec['sensitivity']['value'] == 99
assert rec['active'] is None
append_note(rec, MARK + ': cited sheet q_spk_wl8_specs.pdf contains the WL212-sw column '
            '(SUB nominal impedance 4 ohm; LF sensitivity 99 dB SPL at 1 W/1 m). Values confirmed. '
            'Active/passive not stated on the sheet; active stays null.')

with open(DATA, 'w', encoding='utf-8') as f:
    json.dump(db, f, indent=2, ensure_ascii=False)
    f.write('\n')

# Ledger
led = json.load(open(LEDGER, encoding='utf-8'))
elx_header = ''.join(open(ELX_HEADER, encoding='utf-8').readlines()[:3]).strip()
led['sources'].extend([
    {
        'url': PRESONUS_URL, 'host': 'fmicassets.com (PreSonus)',
        'document': 'PreSonus R65/R80 Owner\'s Manual, English', 'status': 'CHECKED_CONFIRMED',
        'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 4,
        'coverage': 'Overview and features (chunk 0). Covers both R65 and R80.',
        'decisions': ['presonus-r65 driverCount 2 MANUFACTURER_VERIFIED', 'presonus-r65 active True MANUFACTURER_VERIFIED',
                      'presonus-r80 driverCount 2 MANUFACTURER_VERIFIED', 'presonus-r80 active True MANUFACTURER_VERIFIED'],
        'queueItemsResolved': 4,
    },
    {
        'url': EV_URL, 'host': 'products.electrovoice.com',
        'document': 'Electro-Voice Sx300PI / Sx300PIX engineering data sheet', 'status': 'CHECKED_PARTIAL',
        'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 4,
        'coverage': 'Driver layout confirmed (two-way: DL12Sx + DH2010A). active not stated in words; left as stored.',
        'decisions': ['electro-voice-sx300pi driverCount 2 MANUFACTURER_VERIFIED',
                      'electro-voice-sx300pix driverCount 2 MANUFACTURER_VERIFIED',
                      'active False unchanged, CITED_IN_NOTES_UNCHECKED (open)'],
        'queueItemsResolved': 2,
    },
    {
        'url': QSC_WL8_URL, 'host': 'qscaudio.com',
        'document': 'QSC WideLine-8 specifications (WL3082 and WL212-sw columns)', 'status': 'CHECKED_CONFIRMED',
        'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': 2,
        'coverage': 'Spec table has WL212-sw column: SUB 4 ohm; LF sensitivity 99 dB SPL at 1 W/1 m; 32-107 Hz at -10 dB. '
                    'Does not state active or passive for either model.',
        'decisions': ['qsc-wl212-sw sensitivity 99 dB at 1W/1m confirmed (no change)',
                      'qsc-wl212-sw impedance 4 ohm confirmed (no change)',
                      'qsc-wl212-sw active stays null', 'qsc-wl3082 active stays null'],
        'queueItemsResolved': 0,
        'correction': 'Earlier note called this a different model. Corrected: the sheet contains the WL212-sw column.',
    },
    {
        'url': 'https://assets.kef.com/uploads/cm/r2018_infosheet_en.pdf', 'host': 'assets.kef.com',
        'document': 'KEF R Series 2018 information sheet', 'status': 'CHECKED_PARTIAL',
        'openedDate': DATE, 'chunksOpened': [0, 1], 'chunksTotal': 2,
        'coverage': 'Bass-driver layouts match stored driverCount for R11 (4 LF), R3 (1 LF), R5 (2 LF). '
                    'The sheet does not state active or passive. Total driver counts not fully confirmed.',
        'decisions': ['kef-r11, kef-r3, kef-r5 driverCount stays CITED_IN_NOTES_UNCHECKED',
                      'active stays null (sheet silent)'],
        'queueItemsResolved': 0,
    },
    {
        'url': 'https://www.dubaimachines.com (Mackie CR3 Specs)', 'host': 'dubaimachines.com (distributor)',
        'document': 'Mackie CR3 distributor spec listing', 'status': 'CHECKED_PARTIAL',
        'openedDate': '2026-10-10', 'chunksOpened': [], 'chunksTotal': None,
        'coverage': 'Distributor, not manufacturer. Lists active 2-way, LF 1 x 3 in, HF 1 x 0.75 in. Recorded as third-party only.',
        'decisions': ['legacy-mack-4 driverCount and active stay null (not promoted from distributor evidence)'],
        'queueItemsResolved': 0,
    },
    {
        'url': 'https://www.focal.com/products/sopra-n2', 'host': 'focal.com',
        'document': 'Focal Sopra N2 product page', 'status': 'CHECKED_PARTIAL',
        'openedDate': DATE, 'chunksOpened': [0, 1], 'chunksTotal': 2,
        'coverage': 'No spec table or sensitivity in the fetched text. Not used for sensitivity.',
        'decisions': [], 'queueItemsResolved': 0,
    },
    {
        'url': 'https://media.focal-naim.com/dam/sopra-n-2/fp_sopra_n2_en.pdf', 'host': 'media.focal-naim.com (Focal)',
        'document': 'Focal Sopra N2 product sheet', 'status': 'CHECKED_CONFIRMED',
        'openedDate': DATE, 'chunksOpened': [0], 'chunksTotal': None,
        'coverage': 'Sensitivity (2.83V / 1m) 91 dB; nominal 8 ohm; min 3.1 ohm.',
        'decisions': ['focal-sopra-n-2 sensitivity 91 dB at 2.83 V/1 m confirmed (reference unchanged; not converted to 1 W/1 m). '
                      'Already MANUFACTURER_VERIFIED before round 8; no new queue items resolved.'],
        'queueItemsResolved': 0,
    },
    {
        'url': 'https://www.turbosound.com (Music Tribe PIS media63 host, P0BKV iP15B)', 'host': 'media63.musictribe.com',
        'document': 'Turbosound iP15B Product Information Document', 'status': 'INACCESSIBLE',
        'openedDate': DATE, 'chunksOpened': [], 'chunksTotal': None,
        'coverage': 'Two fetch attempts failed with "Failed to fetch page". Authorship not verified.',
        'decisions': ['turbosound-ip15b sourceType stays None'], 'queueItemsResolved': 0,
    },
    {
        'url': 'https://zenodo.org/records/10255555', 'host': 'zenodo.org',
        'document': 'Genelec 8331A SOFA retry', 'status': 'INACCESSIBLE',
        'openedDate': DATE, 'chunksOpened': [], 'chunksTotal': None,
        'coverage': 'Retry from sandbox bash: curl to zenodo.org/records/10255555 and zenodo.org/api/records/10255555 both fail '
                    '(HTTP 000, no connection). Host not on the sandbox allowlist. No file downloaded; MD5 not checked.',
        'decisions': ['genelec-8331a directivity stays pending; no substitute file'], 'queueItemsResolved': 0,
    },
    {
        'url': 'https://products.electrovoice.com/binary/ELX200-15_BDL_en.pdf', 'host': 'products.electrovoice.com',
        'document': 'ELX200-15 Datasheet, English (EN) and FR revisions', 'status': 'CONFLICT',
        'openedDate': '2026-10-13', 'chunksOpened': [], 'chunksTotal': None,
        'coverage': elx_header,
        'decisions': [
            'EN (87 rows) vs stored 85 points: 52 value differences on shared frequencies; 2 EN-only rows (2400, 2600 Hz).',
            'EN vs FR-1 (86 rows): 55 differences. EN vs FR-2 (85 rows): 53 differences. FR-1 vs FR-2: 7 differences.',
            'Stored 85 points match no primary edition: they stay excluded from simulation.',
            'No edition is adopted silently. Owner must choose an edition or supply the original revision.',
            'Range difference (-3/-10 dB) is superseded by the row-level conflicts above.',
        ],
        'queueItemsResolved': 0,
    },
])
led['openQuestionsForOwner'].append({
    'id': 'sx300pi-active',
    'question': 'Electro-Voice Sx300PI/PIX active (stored False): the data sheet does not state passive in words. '
                'Confirm from an EV manual or accept the stored value as cited-unchecked.',
})
led.setdefault('rounds', []).append({
    'round': 8, 'marker': MARK, 'date': DATE,
    'applied': ['presonus-r65/r80 driverCount and active verified', 'electro-voice-sx300pi/pix driverCount verified',
                'qsc-wl212-sw note corrected: values confirmed from WL212-sw column'],
    'notRestored': ['kef-r11/r3/r5 driverCount (partial)', 'sx300pi/pix active (not stated)', 'legacy-mack-4 (distributor only)'],
})
with open(LEDGER, 'w', encoding='utf-8') as f:
    json.dump(led, f, indent=2, ensure_ascii=False)
    f.write('\n')

print('round 8 applied: 4 driverCount/active verifications (presonus), 2 driverCount verifications (EV Sx300), 1 note correction (QSC WL212-sw)')
