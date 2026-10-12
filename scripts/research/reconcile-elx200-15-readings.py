#!/usr/bin/env python3
"""Field-by-field reconciliation of ELX200-15 response readings against the stored 85 points.

Reads each transcription file, compares it with the stored disputedPoints in src/data/speakers.json,
and with the other readings. Writes elx200-15-reading-reconciliation.json and records a summary on the
record's disputedPoints (points are NOT changed). Stored points stay excluded from simulation.
Idempotent.
"""
import hashlib, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
OUT = os.path.join(HERE, 'elx200-15-reading-reconciliation.json')
READINGS = [
    ('FR edition, fetch 2026-10-12', 'data/elx200-15-primary-fr-2026-10-12.txt'),
    ('FR edition, re-fetch 1 2026-10-13', 'data/elx200-15-primary-fr-2026-10-13-refetch.txt'),
    ('FR edition, re-fetch 2 2026-10-13', 'data/elx200-15-primary-fr-2026-10-13-refetch2.txt'),
    ('EN edition (products.electrovoice.com ELX200-15_BDL_en.pdf), 2026-10-13', 'data/elx200-15-primary-en-2026-10-13-bdl.txt'),
]
ROW = re.compile(r'^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?\s*$')


def read_rows(path):
    rows = {}
    order = []
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('#') or not line.strip():
                continue
            m = ROW.match(line.strip())
            if not m:
                continue
            hz = int(float(m.group(1)))
            if hz in rows:
                raise SystemExit(f'duplicate frequency {hz} in {path}')
            rows[hz] = float(m.group(2))
            order.append(hz)
    return rows, order


def sha256(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def main():
    db = json.load(open(DATA, encoding='utf-8'))
    rec = next(r for r in db if r['id'] == 'electro-voice-elx200-15')
    stored = {int(p['hz']): float(p['db']) for p in rec['frequencyResponse']['disputedPoints']['points']}
    report = {'schema': 'elx200-15-reading-reconciliation/v1', 'record': 'electro-voice-elx200-15',
              'storedPoints': len(stored), 'storedSource': rec['frequencyResponse']['source'],
              'pointsChanged': False, 'readings': [], 'pairwise': []}
    loaded = {}
    for label, rel in READINGS:
        path = os.path.join(HERE, rel)
        rows, order = read_rows(path)
        loaded[label] = rows
        only_reading = sorted(set(rows) - set(stored))
        only_stored = sorted(set(stored) - set(rows))
        diffs = [{'hz': h, 'stored': stored[h], 'reading': rows[h]} for h in sorted(set(rows) & set(stored)) if rows[h] != stored[h]]
        report['readings'].append({'label': label, 'file': rel, 'sha256': sha256(path), 'rows': len(rows),
                                   'orderedAscending': order == sorted(order), 'duplicateFrequencies': 0,
                                   'rowsOnlyInReading': only_reading, 'rowsOnlyInStored': only_stored,
                                   'valueDifferencesVsStored': diffs, 'matchesStoredExactly': not only_reading and not only_stored and not diffs})
    labels = [l for l, _ in READINGS]
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            a, b = loaded[labels[i]], loaded[labels[j]]
            diffs = [h for h in sorted(set(a) & set(b)) if a[h] != b[h]]
            report['pairwise'].append({'a': labels[i], 'b': labels[j], 'sharedFrequencies': len(set(a) & set(b)),
                                       'onlyInA': sorted(set(a) - set(b)), 'onlyInB': sorted(set(b) - set(a)),
                                       'valueDifferentFrequencies': diffs})
    fr = [r for r in report['readings'] if r['label'].startswith('FR')]
    report['conclusion'] = {
        'status': 'UNRESOLVED_NON_REPRODUCIBLE_READINGS',
        'reason': 'The three FR readings of the same PDF URL disagree with each other (row count 85/86/85 and different value sets). No reading can be treated as the authoritative transcription from text extraction alone.',
        'storedMatchesReadingsExactly': [r['label'] for r in report['readings'] if r['matchesStoredExactly']],
        'simulationExcluded': True,
        'nextStep': 'Controlled transcription from the original ELX200-15 PDF file (not available from this sandbox: asset host egress is not allowed). Until then, stored points stay excluded and no reading is adopted.',
        'rangeConflict': 'Sheet states -3 dB 77 Hz-16 kHz and -10 dB 52 Hz-19 kHz. Stored table gives about 75 Hz-13 kHz (-3 dB) relative to 1 kHz. The averaging band behind the stated range is not printed, so this stays open.'}
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    # Record a summary on the record (points unchanged).
    dp = rec['frequencyResponse']['disputedPoints']
    dp['readingReconciliation'] = {
        'file': 'scripts/research/elx200-15-reading-reconciliation.json',
        'status': report['conclusion']['status'],
        'readings': [{'label': r['label'], 'rows': r['rows'], 'matchesStoredExactly': r['matchesStoredExactly'],
                      'valueDifferences': len(r['valueDifferencesVsStored']), 'rowsOnlyInReading': r['rowsOnlyInReading'],
                      'rowsOnlyInStored': r['rowsOnlyInStored']} for r in report['readings']],
        'simulationExcluded': True}
    with open(DATA, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(db, indent=2, ensure_ascii=False) + '\n')
    for r in report['readings']:
        print(r['label'], '| rows', r['rows'], '| onlyReading', r['rowsOnlyInReading'], '| onlyStored', r['rowsOnlyInStored'],
              '| valueDiffs', len(r['valueDifferencesVsStored']), '| exact', r['matchesStoredExactly'])


if __name__ == '__main__':
    main()
