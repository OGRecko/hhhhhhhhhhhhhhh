#!/usr/bin/env python3
"""Round 17: machine-readable 774 -> 777 catalog reconciliation.

Baseline 774 = src/data/speakers.json at commit 8feda31 (last commit with 774 live records,
before a130a71 moved 81 UNAVAILABLE records to the archive). Current = live speakers.json +
the four archive files. Writes scripts/research/catalog-reconciliation-774-777.json.
"""
import json, pathlib, subprocess, collections
ROOT = pathlib.Path(__file__).resolve().parents[2]
BASELINE_COMMIT = '8feda31'
ARCHIVES = [
    'scripts/research/removed-unavailable-records.json',          # 81, 2026-10-10 owner request
    'scripts/research/removed-owner-round5-records.json',        # 27, 2026-10-11/12
    'scripts/research/removed-owner-2026-10-12-decisions.json',  # 3, 2026-10-12 owner decisions
    'scripts/research/removed-unavailable-2026-10-12.json',      # 8, user/owner 2026-10-12
]
# Records not in the baseline: each added by an owner decision.
ADDED = {
    'electro-voice-zx3-60': 'Owner round 5 decision 1: generic EV Zx3 split into exact variants Zx3-60 and Zx3-90 (live).',
    'electro-voice-zx3-90': 'Owner round 5 decision 1: generic EV Zx3 split into exact variants Zx3-60 and Zx3-90 (live).',
    'lacoustics-arcs-ii': 'Owner 2026-10-12: add ARCS II as a separate record (live, third-party sourced, unpromoted).',
}
base = json.loads(subprocess.run(['git', 'show', f'{BASELINE_COMMIT}:src/data/speakers.json'],
                                 cwd=ROOT, capture_output=True, text=True, check=True).stdout)
base_ids = [r['id'] for r in base]
live = json.loads((ROOT / 'src/data/speakers.json').read_text(encoding='utf-8'))
entries = {}
for r in live:
    entries[r['id']] = {'id': r['id'], 'brand': r['brand'], 'model': r['model'], 'location': 'LIVE',
                        'archiveFile': None, 'archiveReason': None, 'redirectTo': None}
for f in ARCHIVES:
    d = json.loads((ROOT / f).read_text(encoding='utf-8'))
    meta = {m['id']: m for m in d.get('archiveMeta', [])} if isinstance(d.get('archiveMeta'), list) else {}
    for r in d['records']:
        m = meta.get(r['id'], {})
        reason = m.get('reason') or d.get('reason')
        entries[r['id']] = {'id': r['id'], 'brand': r['brand'], 'model': r['model'], 'location': 'ARCHIVED',
                            'archiveFile': f, 'archiveReason': reason, 'redirectTo': m.get('redirectTo')}
ids_all = set(entries)
base_set = set(base_ids)
for i, e in entries.items():
    e['inBaseline774'] = i in base_set
    e['addedAfterBaseline'] = i in ADDED
    if i in ADDED:
        e['addedReason'] = ADDED[i]
    if e['archiveFile'] is None and not e['inBaseline774'] and not e['addedAfterBaseline']:
        raise SystemExit(f'unexplained live record {i}')
missing = sorted(base_set - ids_all)
extra = sorted(ids_all - base_set)
assert not missing, f'baseline records missing from current catalog: {missing}'
assert sorted(extra) == sorted(ADDED), f'unexplained additions: {extra}'
counts = collections.Counter(e['location'] for e in entries.values())
out = {
    'generated_by': 'scripts/research/build-catalog-reconciliation.py',
    'baseline': {'label': '774 reviewed records', 'source': f'git {BASELINE_COMMIT}:src/data/speakers.json',
                 'count': len(base_ids), 'note': 'Last commit with 774 live records; 81 UNAVAILABLE moved to archive in a130a71.'},
    'current': {'live': counts['LIVE'], 'archived': counts['ARCHIVED'], 'total': len(entries)},
    'difference': {'added_since_baseline': extra, 'missing_from_baseline': missing,
                   'explanation': 'Total 777 = 774 baseline + 3 added records (2 exact EV Zx3 variants, 1 ARCS II). No baseline record is missing; no record was deleted or restored.'},
    'archiveFiles': [{'file': f, 'records': len(json.loads((ROOT / f).read_text(encoding='utf-8'))['records'])} for f in ARCHIVES],
    'entries': sorted(entries.values(), key=lambda e: (e['location'], e['id'])),
}
(ROOT / 'scripts/research/catalog-reconciliation-774-777.json').write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('live', counts['LIVE'], 'archived', counts['ARCHIVED'], 'total', len(entries), 'added', extra)
