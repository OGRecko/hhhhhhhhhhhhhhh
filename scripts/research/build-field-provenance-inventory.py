#!/usr/bin/env python3
"""Round 18: generate the field-level provenance inventory from authoritative data.

Covers every populated structural/acoustic field and every unsourced null structural field in
live (src/data/speakers.json) and archived records (scripts/research/removed-*.json, 'records').
Writes scripts/research/field-provenance-inventory.json and
scripts/research/field-provenance-url-queue.json (URLs ordered by outstanding CITED_IN_NOTES_UNCHECKED fields).
Does not change any speaker data. Statuses are read from the stored data only; nothing is verified here.
"""
import json, pathlib, collections, glob
ROOT = pathlib.Path(__file__).resolve().parents[2]
SKIP_KEYS = {'id', 'brand', 'model', 'category', 'year', 'overallStatus', 'notes', 'panel', 'aliases',
             'researchNote', 'name', 'frequencyResponse', 'archiveMeta', 'unresolvedNotes'}
ARCHIVE_FILES = sorted(glob.glob(str(ROOT / 'scripts/research/removed-*.json')))
def archive_records():
    seen = {}
    for f in ARCHIVE_FILES:
        d = json.loads(pathlib.Path(f).read_text(encoding='utf-8'))
        if isinstance(d, dict) and isinstance(d.get('records'), list):
            for r in d['records']:
                seen.setdefault(r['id'], (r, str(pathlib.Path(f).relative_to(ROOT))))
    return seen

def fields_of(rec, location, archive_file):
    out = []
    rid = rec['id']
    base = {'speakerId': rid, 'brand': rec.get('brand'), 'model': rec.get('model'), 'location': location,
            'archiveFile': archive_file}
    for k, v in rec.items():
        if k in SKIP_KEYS or k.endswith('Provenance'):
            continue
        prov_key = k + 'Provenance'
        if isinstance(v, dict) and 'value' in v:
            if v.get('value') is None and v.get('status') in (None, 'UNAVAILABLE'):
                continue
            out.append({**base, 'field': k, 'value': v.get('value'), 'unit': v.get('unit'),
                        'storedStatus': v.get('status'), 'source': v.get('source'),
                        'sourceType': v.get('sourceType'), 'reference': v.get('reference'),
                        'note': v.get('note')})
        elif k in ('driverCount', 'active'):
            prov = rec.get(prov_key) if isinstance(rec.get(prov_key), dict) else {}
            if v is None:
                continue  # null structural fields are emitted once by the null-field pass below
            out.append({**base, 'field': k, 'value': v, 'unit': None,
                        'storedStatus': prov.get('status') if prov else None,
                        'source': prov.get('source'), 'sourceType': prov.get('sourceType'),
                        'reference': None, 'note': prov.get('note')})
    fr = rec.get('frequencyResponse') or {}
    if fr.get('points'):
        out.append({**base, 'field': 'frequencyResponse.points', 'value': f"{len(fr['points'])} points",
                    'unit': 'Hz/dB', 'storedStatus': fr.get('pointsStatus'), 'source': fr.get('pointsSource'),
                    'sourceType': fr.get('pointsSourceType'), 'reference': None, 'note': fr.get('pointsContext')})
    return out

def main():
    live = json.loads((ROOT / 'src/data/speakers.json').read_text(encoding='utf-8'))
    arch = archive_records()
    entries = []
    for r in live:
        entries.extend(fields_of(r, 'LIVE', None))
    for rid, (r, f) in sorted(arch.items()):
        entries.extend(fields_of(r, 'ARCHIVED', f))
    # Unsourced nulls: structural fields that are null with no provenance object or UNSOURCED status.
    for r in live + [x for x, _ in arch.values()]:
        for f in ('driverCount', 'active'):
            if r.get(f) is None:
                prov = r.get(f + 'Provenance') if isinstance(r.get(f + 'Provenance'), dict) else None
                st = prov.get('status') if prov else 'NO_PROVENANCE'
                loc = 'LIVE' if r in live else 'ARCHIVED'
                entries.append({'speakerId': r['id'], 'brand': r.get('brand'), 'model': r.get('model'), 'location': loc,
                                'archiveFile': None, 'field': f, 'value': None, 'unit': None, 'storedStatus': st,
                                'source': prov.get('source') if prov else None, 'sourceType': prov.get('sourceType') if prov else None,
                                'reference': None, 'note': prov.get('note') if prov else None, 'nullField': True})
    for e in entries:
        e.setdefault('nullField', False)
        e['lastCheckedDate'] = None
        e['checkOutcome'] = 'NOT_CHECKED' if e['storedStatus'] in ('CITED_IN_NOTES_UNCHECKED', 'UNSOURCED', 'NO_PROVENANCE') else 'STORED_STATUS_ONLY'
    by_status = collections.Counter(e['storedStatus'] for e in entries)
    by_field_status = collections.Counter((e['field'], e['storedStatus']) for e in entries)
    cited = [e for e in entries if e['storedStatus'] == 'CITED_IN_NOTES_UNCHECKED']
    url_counts = collections.Counter(e['source'] for e in cited if e['source'])
    no_url = sum(1 for e in cited if not e['source'])
    queue = [{'url': u, 'outstandingFields': n,
              'fields': [f"{e['speakerId']}.{e['field']}" for e in cited if e['source'] == u]}
             for u, n in url_counts.most_common()]
    inv = {'schema': 'field-provenance-inventory/v1', 'generatedBy': 'scripts/research/build-field-provenance-inventory.py',
           'counts': {'entries': len(entries), 'live': sum(1 for e in entries if e['location'] == 'LIVE'),
                      'archived': sum(1 for e in entries if e['location'] == 'ARCHIVED'),
                      'byStoredStatus': dict(by_status.most_common()),
                      'citedUncheckedWithoutUrl': no_url, 'citedUncheckedUrls': len(url_counts)},
           'entries': entries}
    (ROOT / 'scripts/research/field-provenance-inventory.json').write_text(json.dumps(inv, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    (ROOT / 'scripts/research/field-provenance-url-queue.json').write_text(json.dumps({'schema': 'field-provenance-url-queue/v1', 'urls': queue}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps(inv['counts'], indent=1))
    print('top URLs:', [(q['url'][:70], q['outstandingFields']) for q in queue[:8]])

if __name__ == '__main__':
    main()
