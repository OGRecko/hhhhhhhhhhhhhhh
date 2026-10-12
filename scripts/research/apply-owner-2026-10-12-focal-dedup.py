#!/usr/bin/env python3
"""Owner decision (2026-10-12): archive the duplicate record 'focal-sopra2' (Focal Sopra No.2).

- focal-sopra2 is the same product as focal-sopra-n-2 (Focal Sopra N°2). The survivor focal-sopra-n-2 is
  MANUFACTURER_VERIFIED from the Focal product sheet (91 dB at 2.83 V/1 m, 8 ohm nominal, 3.1 ohm minimum).
  focal-sopra2 was THIRD_PARTY_VERIFIED from a dealer listing and already simulation-excluded.
- focal-sopra2 is removed from the live dataset and archived UNCHANGED in removed-owner-round5-records.json.
  Nothing is deleted. No value is transferred between the two records.
- Counts after this change: live 669, archived 81 + 27, reviewed total 777 (unchanged).
"""
import copy
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ARCH = os.path.join(ROOT, 'scripts', 'research', 'removed-owner-round5-records.json')
DATE = '2026-10-12'


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    dup = by.get('focal-sopra2')
    assert dup is not None and dup['model'] == 'Sopra No.2', 'focal-sopra2 must be the Sopra No.2 duplicate'
    assert 'focal-sopra-n-2' in by and by['focal-sopra-n-2']['sensitivity']['status'] == 'MANUFACTURER_VERIFIED'
    archived = copy.deepcopy(dup)

    new = []
    for r in data:
        if r['id'] == 'focal-sopra2':
            continue
        if r['id'] == 'focal-sopra-n-2':
            r = copy.deepcopy(r)
            r['notes'] = r['notes'].rstrip() + (
                f" Duplicate record 'focal-sopra2' (Focal Sopra No.2, dealer-sourced) was archived on {DATE} "
                "by owner decision; this record is the surviving manufacturer-verified entry for the product.")
        new.append(r)
    assert len(new) == len(data) - 1

    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(new, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, DATA)

    arch = json.load(open(ARCH, encoding='utf-8'))
    assert arch['recordCount'] == len(arch['records'])
    assert not any(r['id'] == 'focal-sopra2' for r in arch['records'])
    arch['records'].append(archived)
    arch['recordCount'] = len(arch['records'])
    arch['reason'] += (
        f" Addendum ({DATE}, owner decision): focal-sopra2 'Focal Sopra No.2' is archived here, unchanged. It duplicates "
        "focal-sopra-n-2 (Focal Sopra N°2), which is manufacturer-verified; the dealer-sourced copy is not kept live.")
    json.dump(arch, open(ARCH, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

    print('live', len(new), 'archived', arch['recordCount'], 'total', len(new) + 81 + arch['recordCount'])


if __name__ == '__main__':
    main()
