#!/usr/bin/env python3
"""Apply the Focal Sopra N°2 driverCount confirmation recorded in provenance-ledger-2026-10-13.json.

Only the entry focal-sopra-n-2 / driverCount (decision MANUFACTURER_VERIFIED) is applied. The stored value must
equal the ledger value and the status must still be CITED_IN_NOTES_UNCHECKED. The script refuses to run twice.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(ROOT, 'scripts', 'research', 'provenance-ledger-2026-10-13.json')


def main():
    ledger = json.load(open(LEDGER, encoding='utf-8'))
    db = json.load(open(DATA, encoding='utf-8'))
    matches = [e for e in ledger['entries'] if e['id'] == 'focal-sopra-n-2' and e['field'] == 'driverCount'
               and e['decision'] == 'MANUFACTURER_VERIFIED']
    assert len(matches) == 1
    e = matches[0]
    r = next(x for x in db if x['id'] == e['id'])
    assert r['driverCount'] == e['value'], (r['driverCount'], e['value'])
    p = r.get('driverCountProvenance') or {}
    assert p.get('status') == 'CITED_IN_NOTES_UNCHECKED', p
    assert p.get('source') == e['url'], p
    r['driverCountProvenance'] = {'status': 'MANUFACTURER_VERIFIED', 'source': e['url'], 'sourceType': 'MANUFACTURER'}
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(db, fh, indent=2, ensure_ascii=False); fh.write('\n')
    os.replace(tmp, DATA)
    print('applied focal-sopra-n-2 driverCount')


if __name__ == '__main__':
    main()
