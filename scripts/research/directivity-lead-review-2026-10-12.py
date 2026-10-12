#!/usr/bin/env python3
"""Round 5 directivity-lead review (2026-10-12). Writes directivity-lead-review-2026-10-12.json.

Every lead in directivity-leads.json is classified by the blocker that keeps it from import. No lead is
imported in this review: the project schema has no angle-resolved polar field, and no CLF/GLL/SOFA parser exists.
A lead's status is taken from its live/archived state in the speaker dataset.
"""
import json, os, collections
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
R = lambda p: os.path.join(ROOT, p)

CATEGORY = {
 'NOMINAL_ONLY': ['bose-sub1','dandb-t10','jbl-4310','legacy-jbl-3','jbl-4311','jbl-4312','jbl-4350','jbl-l19',
                  'jbl-vrx932','legacy-jbl-1','rcf-nx45a','funktion-one-res2','lacoustics-arcs','legacy-la-7'],
 'BEAMWIDTH_OR_DI_ONLY': ['bose-designmax-dm3se','bose-designmax-dm6se','bose-designmax-dm8se',
                          'electro-voice-sx600','electro-voice-zx4'],
 'PARTIAL_OFFAXIS_TABLES': ['bose-l1-compact','jbl-4412','jbl-4430','legacy-jbl-6','jbl-control-30','jbl-lsr32',
                            'jbl-srx815','legacy-jbl-11','legacy-ma-3','nexo-ps15'],
 'ARCHIVE_NOT_INSPECTED': ['bose-freespace-ds100se','bose-freespace-ds16s','legacy-bose-6','genelec-8361a',
                           'genelec-8331a','legacy-gen-9','adamson-e15','void-air-8','danley-sh96','eaw-kf760','legacy-la-3'],
 'THIRD_PARTY_CHART_ONLY': ['genelec-8331a-measurement','kef-reference-1','ik-multimedia-iloud-mtm','psb-synchrony-t600'],
 'RECORD_ARCHIVED': ['electro-voice-zx5','legacy-jbl-5','legacy-la-1','legacy-la-2','electro-voice-zx3',
                     'electro-voice-zx1i','electro-voice-evf-1152d'],
}
NOTE = {
 'ARCHIVE_NOT_INSPECTED': 'manufacturer archive or simulation file exists but was not downloaded, or retrieval failed; no polar parser',
 'NOMINAL_ONLY': 'single nominal coverage, aggregate angle, or threshold value; not an angle-resolved polar set',
 'BEAMWIDTH_OR_DI_ONLY': 'frequency-dependent beamwidth/DI tables without a full off-axis response set',
 'PARTIAL_OFFAXIS_TABLES': 'some off-axis or spatial-average tables, incomplete for a polar field',
 'THIRD_PARTY_CHART_ONLY': 'independent or third-party measurement, chart-only or not manufacturer data',
 'RECORD_ARCHIVED': 'lead refers to a record archived in round 5 (history only; does not apply to a live record)',
}

def main():
    leads = json.load(open(R('scripts/research/directivity-leads.json')))
    ids = [l['id'] for l in leads]
    cat_of = {}
    for c, members in CATEGORY.items():
        for m in members:
            assert m not in cat_of, ('listed twice', m)
            cat_of[m] = c
    missing = [i for i in ids if i not in cat_of]
    extra = [m for m in cat_of if m not in ids]
    assert not missing and not extra, (missing, extra)
    live = {r['id'] for r in json.load(open(R('src/data/speakers.json')))}
    out = []
    for l in leads:
        i = l['id']
        state = 'LIVE' if i in live else 'ARCHIVED_OR_NO_RECORD'
        out.append({'id': i, 'leadStatus': l['status'], 'recordState': state, 'category': cat_of[i],
                    'decision': 'NOT_IMPORTED', 'reason': NOTE[cat_of[i]]})
    summary = collections.Counter(o['category'] for o in out)
    doc = {'date': '2026-10-12', 'leadCount': len(out), 'importedCount': 0,
           'summaryByCategory': dict(summary.most_common()), 'leads': out,
           'note': 'No directivity data was imported in this review. The directivity schema requires a complete angle-resolved response; none of the 51 leads supplies one from a fetched source.'}
    with open(R('scripts/research/directivity-lead-review-2026-10-12.json'), 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write('\n')
    print(len(out), dict(summary))

if __name__ == '__main__':
    main()
