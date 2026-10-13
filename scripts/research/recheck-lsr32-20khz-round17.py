#!/usr/bin/env python3
"""Round 17: recheck the LSR32 disputed 20 kHz points against the exact JBL LSR owner's manual copy
(https://jblpro.com/zh/site_elements/lsr-series-owner-s-manual, fetched 2026-10-13, chunks 5-6).
Table read: LSR32 'Amplitude & Phase' (SPL dB), 'Acoustic Contribution' (fundamental SPL dB).
Writes scripts/research/lsr32-20khz-round17.json. Does not change speaker data."""
import json, pathlib
R = pathlib.Path(__file__).resolve().parents[2]
amp_phase = {20:70,30:80,40:86,50:90,60:92,70:93,80:93.5,90:93.5,100:93.5,200:93,300:93,400:93,500:93,600:93,700:92.5,800:92,900:92,1000:92.5,2000:92.5,3000:92.5,4000:92.5,5000:92.5,6000:92.5,7000:92.5,8000:92.5,9000:92.5,10000:92.5,20000:92}
acoustic_fund = {20:70,30:79,40:85,50:88,60:90,70:91,80:92,90:93,100:93.5,200:93,300:93,400:93,500:93,600:93,700:93,800:92,900:92,1000:93,2000:92,3000:92,4000:92,5000:92,6000:92,7000:92,8000:92,9000:92,10000:92,20000:92}
speakers = json.loads((R / 'src/data/speakers.json').read_text(encoding='utf-8'))
rec = next(s for s in speakers if s['id'] == 'jbl-lsr32')
stored = {p['hz']: p['db'] for p in rec['frequencyResponse']['disputedPoints']['points']}
rows = []
for hz in sorted(stored):
    a = amp_phase.get(hz); c = acoustic_fund.get(hz)
    rows.append({'hz': hz, 'stored': stored[hz], 'amplitudePhaseTable': a, 'acousticContributionTable': c,
                 'matchesAmplitudePhase': a == stored[hz]})
mism = [r for r in rows if not r['matchesAmplitudePhase']]
out = {
 'schema': 'lsr32-20khz-recheck-round17/v1',
 'record': 'jbl-lsr32',
 'source': 'https://jblpro.com/zh/site_elements/lsr-series-owner-s-manual',
 'sourceFetchedDate': '2026-10-13',
 'tablesIdentified': 'LSR32 section identified by 250 Hz / 2.2 kHz crossover and 252G / C500G / 053ti drivers (chunk 5). Other JBL sections (LSR28P, LSR12P) have different drivers and were not used.',
 'at20kHz': {'amplitudePhaseTable_SPL_dB': 92, 'phase_deg': -780, 'acousticContribution_fundamental_dB': 92,
             'storedDisputedValue_dB': stored[20000] if 20000 in stored else None,
             'stored20kHzPresentInDisputedSeries': 20000 in stored,
             'note': 'Both tables read 92 dB at 20 kHz in this copy. The 61 dB value recorded in round 5 is not found at 20 kHz in either table. 61 appears only at 2000 Hz and 3000 Hz in the first-harmonic distortion table, which is not the on-axis response.'},
 'storedVsTable': {'rowsCompared': len(rows), 'rowsMatchingAmplitudePhase': len(rows) - len(mism),
                   'rowsDifferingAmplitudePhase': [{'hz': r['hz'], 'stored': r['stored'], 'table': r['amplitudePhaseTable']} for r in mism]},
 'status': 'NOT_REPRODUCED_20KHZ_CONFLICT; STORED_SERIES_DOES_NOT_MATCH_TABLE',
 'simulationExcluded': True,
 'decision': 'Keep the 27 disputed points excluded from simulation. The 20 kHz conflict cannot be reproduced from this copy (both tables give 92 dB). The stored series differs from the Amplitude & Phase table at the rows listed, so it is not a defensible transcription. Owner decision needed on whether to replace the disputed series with a full re-transcription from this table (not done in this round).'
}
(R / 'scripts/research/lsr32-20khz-round17.json').write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('rows', len(rows), 'match', len(rows)-len(mism), 'mismatch', len(mism))
print([ (r['hz'], r['stored'], r['amplitudePhaseTable']) for r in mism])
