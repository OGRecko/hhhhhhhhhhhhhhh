#!/usr/bin/env python3
"""Owner decision (2026-10-12): remove the catalog row 'ARCS' (legacy-la-2) and approve the 777 reviewed total.

- legacy-la-2 'ARCS' has no exact-model source (only third-party copies, and ARCS II / ARCS Wide are different
  products). It is removed from the live dataset and archived UNCHANGED in removed-owner-round5-records.json.
  Nothing is deleted.
- The ARCS II record (lacoustics-arcs-ii) is unchanged except for its note, which no longer refers to a live 'ARCS' row.
- Counts after this change: live 670, archived 81 + 26, reviewed total 777 (approved by the owner).
"""
import copy
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ARCH = os.path.join(ROOT, 'scripts', 'research', 'removed-owner-round5-records.json')
LEADS = os.path.join(ROOT, 'scripts', 'research', 'directivity-leads.json')
DATE = '2026-10-12'


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    arcs = by.get('legacy-la-2')
    assert arcs is not None and arcs['model'] == 'ARCS' and arcs['overallStatus'] == 'UNVERIFIED', 'legacy-la-2 must be the UNVERIFIED ARCS row'
    assert 'lacoustics-arcs-ii' in by and 'lacoustics-arcs' in by
    archived = copy.deepcopy(arcs)

    new = []
    for r in data:
        if r['id'] == 'legacy-la-2':
            continue
        if r['id'] == 'lacoustics-arcs-ii':
            r = copy.deepcopy(r)
            r['notes'] = r['notes'].replace(
                "ARCS II is a separate product from the catalog row 'ARCS' (legacy-la-2). ",
                f"ARCS II is a separate product from the former catalog row 'ARCS' (legacy-la-2), which was removed on {DATE} for lack of an exact-model source. ")
            assert 'former catalog row' in r['notes']
        new.append(r)
    assert len(new) == len(data) - 1

    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(new, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, DATA)

    arch = json.load(open(ARCH, encoding='utf-8'))
    assert arch['recordCount'] == len(arch['records'])
    assert not any(r['id'] == 'legacy-la-2' for r in arch['records'])
    arch['records'].append(archived)
    arch['recordCount'] = len(arch['records'])
    arch['reason'] += (
        f" Addendum ({DATE}, owner decision): legacy-la-2 'ARCS' is also archived here, unchanged. It had no exact-model "
        "source; ARCS II and ARCS Wide are different products and were not transferred to it.")
    json.dump(arch, open(ARCH, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

    leads = json.load(open(LEADS, encoding='utf-8'))
    arr = leads if isinstance(leads, list) else leads.get('leads', leads)
    hit = 0
    for l in arr:
        if l.get('id') == 'legacy-la-2':
            l['note'] = (f"Owner decision ({DATE}): the catalog row 'ARCS' was archived "
                         "for lack of an exact-model source. This lead is kept for reference only. ") + l['note']
            hit += 1
    assert hit == 1
    raw = open(LEADS, encoding='utf-8').read()
    with open(LEADS, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(leads, indent=2, ensure_ascii=False) + ('\n' if raw.endswith('\n') else ''))

    print('live', len(new), 'archived', arch['recordCount'], 'total', len(new) + 81 + arch['recordCount'])


if __name__ == '__main__':
    main()
