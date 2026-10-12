#!/usr/bin/env python3
"""Round 5 sensitivity-reference review (2026-10-12). Writes sensitivity-reference-review-2026-10-12.json.

No reference string is changed. The DSP (src/lib/speakerResponse.ts) converts only references matching
^2\\.83(?:V|Vrms)/1m$ (using the stored nominal impedance), accepts ^1W/1m$ verbatim, and uses the neutral
fallback for any other stated reference. Every non-standard string is therefore either converted by an exact
rule or falls back; none is read as 1 W/1 m. This script counts each case over the live dataset.
"""
import json, os, re, collections
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
CONVERT = re.compile(r'^2\.83(?:V|Vrms)/1m$', re.I)
DIRECT = re.compile(r'^1W/1m$', re.I)

def main():
    data = json.load(open(os.path.join(ROOT, 'src/data/speakers.json'), encoding='utf-8'))
    buckets = collections.defaultdict(lambda: {'records': [], 'converted': 0, 'fallback': 0, 'no_value': 0})
    for r in data:
        s = r.get('sensitivity') or {}
        ref = s.get('reference')
        val = s.get('value')
        key = ref if ref else '(blank)'
        if val is None:
            buckets[key]['no_value'] += 1
            continue
        buckets[key]['records'].append(r['id'])
        imp = (r.get('impedance') or {}).get('value')
        if DIRECT.match(ref or ''):
            buckets[key]['converted'] += 1
        elif CONVERT.match(ref or '') and isinstance(imp, (int, float)) and imp > 0:
            buckets[key]['converted'] += 1
        else:
            buckets[key]['fallback'] += 1
    out = []
    for k, b in sorted(buckets.items(), key=lambda kv: -len(kv[1]['records'])):
        n = len(b['records'])
        if DIRECT.match(k):
            rule = 'used verbatim (1W/1m)'
        elif CONVERT.match(k):
            rule = 'converted to 1W/1m using stored impedance; neutral fallback if impedance missing'
        elif k == 'unspecified by source':
            rule = 'neutral fallback; source states no reference'
        else:
            rule = 'neutral fallback; not an exact rule match (source wording kept)'
        out.append({'reference': k, 'records': n, 'converted': b['converted'], 'neutralFallback': b['fallback'],
                    'valueWithoutReference': b['no_value'], 'rule': rule, 'recordIds': sorted(b['records'])})
    doc = {'date': '2026-10-12', 'changedReferenceStrings': 0,
           'totalLiveRecords': len(data),
           'totalWithValue': sum(len(b['records']) for b in buckets.values()),
           'buckets': out}
    with open(os.path.join(ROOT, 'scripts/research/sensitivity-reference-review-2026-10-12.json'), 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False); fh.write('\n')
    for o in out:
        print(f"{o['reference']!r}: records={o['records']} converted={o['converted']} fallback={o['neutralFallback']}")

if __name__ == '__main__':
    main()
