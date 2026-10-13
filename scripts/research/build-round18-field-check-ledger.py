#!/usr/bin/env python3
"""Round 18 machine-readable field-check ledger. Built from round18-url-results.json plus the
recheck results of two URLs already checked in round 12 (DALI Oberon manual, Library of Congress JBL 4310).
Writes scripts/research/round18-field-check-ledger.json. Does not change speaker data."""
import json, pathlib
R = pathlib.Path(__file__).resolve().parent
res = json.loads((R / 'round18-url-results.json').read_text(encoding='utf-8'))
hist = json.loads((R / 'round18-value-history.json').read_text(encoding='utf-8'))
before = {(h['id'], h['field']): h for h in hist.get('entries', [])}
checks = []
for e in res['entries']:
    for f in e['fieldResults']:
        key = (f['record'], f['field'])
        h = before.get(key)
        checks.append({'speakerId': f['record'], 'field': f['field'], 'value': f['value'],
                       'sourceUrl': e['url'], 'sourceClass': e['sourceClass'], 'host': e['host'],
                       'chunksOpened': e['chunksOpened'], 'checkedDate': e['checkedDate'],
                       'outcome': f['outcome'],
                       'before': h['before'] if h else None, 'after': h['after'] if h else None,
                       'reason': f['note']})
rechecks = [
 {'url': 'https://www.dali-speakers.com/media/5320/oberon-manual.pdf', 'checkedDate': '2026-10-13',
  'result': 'NO_CHANGE. Round 12 outcome confirmed on re-read: active false supported by the wiring-to-external-amplifier section; driverCount (dali-oberon-3 2, dali-oberon-5 3, dali-oberon7 3) NOT_EXTRACTED because the Table 2 specification table is absent from the extracted text. Table 1 "Speaker(s) per carton" is not a driver count and was not used.',
  'fields': ['dali-oberon-3.driverCount', 'dali-oberon-5.driverCount', 'dali-oberon7.driverCount'], 'outcomes': ['NOT_EXTRACTED'] * 3},
 {'url': 'https://tile.loc.gov/storage-services/master/mbrs/recording_preservation/manuals/JBL%20Prof.%20Series%20Model%204310%20Control%20Room%20Monitor.pdf',
  'checkedDate': '2026-10-13',
  'result': 'NO_CHANGE. Chunk 0 of 2 re-read: "three direct-radiator transducers", 12 in LF, 5 in midrange, separate ultra-high transducer; passive network, no amplifier stated in the text (active not stated, as round 12). Document is an undated Recording Consultants, Inc. (Kensington MD) archival copy of a JBL manual; revision not confirmable against the current 4310 specification. Host tile.loc.gov is not a manufacturer or distributor. jbl-4310 and legacy-jbl-3 are duplicate records with the same URL and values; duplicate archive is NOT done (needs owner authorization).',
  'fields': ['jbl-4310.driverCount', 'legacy-jbl-3.driverCount', 'jbl-4310.active', 'legacy-jbl-3.active'],
  'outcomes': ['SUPPORTED_NOT_PROMOTED', 'SUPPORTED_NOT_PROMOTED', 'NOT_STATED', 'NOT_STATED']},
]
out = {'schema': 'round18-field-check-ledger/v1', 'round': 18, 'checkedDate': '2026-10-13',
       'fieldChecks': checks, 'urlRechecks': rechecks,
       'counts': {'fieldChecksThisRound': len(checks), 'promoted': sum(1 for c in checks if c['outcome'] == 'PROMOTED'),
                  'supportedNotPromoted': sum(1 for c in checks if c['outcome'] == 'SUPPORTED_NOT_PROMOTED'),
                  'urlsChecked': len(res['entries']) + len(rechecks)}}
(R / 'round18-field-check-ledger.json').write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps(out['counts']))
