#!/usr/bin/env python3
"""Generate the field-provenance work queue from src/data/speakers.json and queue-url-status.json.

A queue item is a populated driverCount or active value whose provenance is still CITED_IN_NOTES_UNCHECKED:
the value is attached to a URL from the record notes that has not yet been checked for that field.
Items are grouped by source URL so one opened page can settle every item that cites it.

queue-url-status.json (schema queue-url-status/v2) records what each opened URL supports. It is read here
so that every URL shows its recorded status, the fields still outstanding and any recorded per-field outcome.
URL counts and field counts are reported separately. Nothing in the output is typed by hand.

Writes PROVENANCE-QUEUE.md and provenance-queue.json. Deterministic: same inputs give byte-identical output.
"""
import json, os, collections
from urllib.parse import urlparse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
STATUS = os.path.join(ROOT, 'scripts', 'research', 'queue-url-status.json')
OUT_JSON = os.path.join(ROOT, 'scripts', 'research', 'provenance-queue.json')
OUT_MD = os.path.join(ROOT, 'scripts', 'research', 'PROVENANCE-QUEUE.md')

CITED = 'CITED_IN_NOTES_UNCHECKED'
CHECKED_STATUSES = {'CHECKED_CONFIRMED', 'CHECKED_PARTIAL', 'CHECKED_REJECTED', 'CONFLICT', 'INACCESSIBLE'}
# OPEN is the equivalent of NOT_CHECKED used in the round-12 brief.
DEFAULT_STATUS = 'OPEN'


def load_status():
    if not os.path.exists(STATUS):
        return {}, []
    data = json.load(open(STATUS, encoding='utf-8'))
    by_url = {}
    problems = []
    for u in data.get('urls', []):
        url = u.get('url')
        if not url:
            problems.append('status entry without url')
            continue
        if url in by_url:
            problems.append(f'duplicate status entry for {url}')
        by_url[url] = u
        if u.get('status') not in CHECKED_STATUSES | {DEFAULT_STATUS}:
            problems.append(f'unknown status {u.get("status")!r} for {url}')
    return by_url, problems


def main():
    db = json.load(open(DATA, encoding='utf-8'))
    status_by_url, status_problems = load_status()

    status_counts = collections.Counter()
    items = []
    for r in db:
        for f in ('driverCount', 'active'):
            p = r.get(f + 'Provenance') or {}
            st = p.get('status', 'MISSING')
            status_counts[(f, st, 'null' if r.get(f) is None else 'value')] += 1
            if st == CITED:
                items.append({'id': r['id'], 'field': f, 'value': r.get(f), 'source': p.get('source')})

    # Cross-check every recorded field outcome against the live record provenance.
    VERIFIED = {'MANUFACTURER_VERIFIED', 'MEASUREMENT_VERIFIED', 'REPUTABLE_DATABASE_VERIFIED', 'THIRD_PARTY_VERIFIED'}
    by_id = {r['id']: r for r in db}
    result_warnings = []
    for u, st in status_by_url.items():
        for fr in st.get('fieldResults', []):
            rec = by_id.get(fr.get('record'))
            if rec is None:
                result_warnings.append(f'{u}: recorded result for unknown record {fr.get("record")!r}')
                continue
            prov = rec.get(fr['field'] + 'Provenance') or {}
            pst = prov.get('status', 'MISSING')
            if fr['outcome'] == 'PROMOTED':
                if pst not in VERIFIED:
                    result_warnings.append(f'{u}: {fr["record"]}.{fr["field"]} PROMOTED but provenance status is {pst}')
                if prov.get('source') != u:
                    result_warnings.append(f'{u}: {fr["record"]}.{fr["field"]} PROMOTED but provenance source is {prov.get("source")!r}')
            elif fr['outcome'] in ('NOT_STATED', 'NOT_EXTRACTED', 'SUPPORTED_NOT_PROMOTED'):
                if pst != CITED:
                    result_warnings.append(f'{u}: {fr["record"]}.{fr["field"]} {fr["outcome"]} but provenance status is {pst}')
            else:
                result_warnings.append(f'{u}: unknown outcome {fr["outcome"]!r} for {fr["record"]}.{fr["field"]}')

    by_url = collections.defaultdict(list)
    for it in items:
        by_url[it['source']].append(it)
    groups = sorted(by_url.items(), key=lambda kv: (-len(kv[1]), kv[0] or ''))

    warnings = list(status_problems) + result_warnings
    url_rows = []
    for u, v in groups:
        st = status_by_url.get(u, {})
        status = st.get('status', DEFAULT_STATUS)
        recorded = {(fr['record'], fr['field']): fr for fr in st.get('fieldResults', [])}
        outstanding = []
        for it in sorted(v, key=lambda x: (x['id'], x['field'])):
            key = (it['id'], it['field'])
            fr = recorded.get(key)
            outstanding.append({
                'record': it['id'],
                'field': it['field'],
                'value': it['value'],
                'recordedOutcome': fr['outcome'] if fr else None,
                'recordedNote': fr.get('note', '') if fr else '',
            })
            if status in CHECKED_STATUSES and fr is None:
                warnings.append(f'{u}: status {status} but {it["id"]}.{it["field"]} has no recorded field outcome')
        row = {
            'url': u,
            'host': urlparse(u or '').netloc,
            'status': status,
            'items': len(v),
            'records': sorted({x['id'] for x in v}),
            'fields': sorted({x['field'] for x in v}),
            'outstanding': outstanding,
            'checkedRound': st.get('round'),
            'checkedDate': st.get('checkedDate'),
            'chunksOpened': st.get('chunksOpened', []),
            'evidence': st.get('evidence', ''),
        }
        url_rows.append(row)

    # Status-file URLs that are not in the queue: fully resolved sources, kept for the record.
    queued = {u for u, _ in groups}
    resolved_urls = sorted(u for u in status_by_url if u not in queued)

    url_status_counts = collections.Counter(row['status'] for row in url_rows)
    item_status_counts = collections.Counter()
    for row in url_rows:
        item_status_counts[row['status']] += row['items']

    total_items = len(items)
    total_urls = len(groups)
    queue = {
        'generated_from': ['src/data/speakers.json', 'scripts/research/queue-url-status.json'],
        'schema': 'provenance-queue/v2',
        'liveRecords': len(db),
        'uncheckedItems': total_items,
        'uniqueSourceUrls': total_urls,
        'urlsByStatus': dict(sorted(url_status_counts.items())),
        'uncheckedItemsByUrlStatus': dict(sorted(item_status_counts.items())),
        'statusCounts': [{'field': f, 'status': s, 'value': v, 'count': c} for (f, s, v), c in sorted(status_counts.items())],
        'resolvedSourceUrls': resolved_urls,
        'warnings': warnings,
        'groups': url_rows,
    }
    with open(OUT_JSON, 'w', encoding='utf-8') as fh:
        json.dump(queue, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

    lines = [
        '# Field provenance queue',
        '',
        'Generated by `scripts/research/make-provenance-queue.py` from `src/data/speakers.json` and '
        '`scripts/research/queue-url-status.json`. Do not edit by hand.',
        '',
        '## Summary',
        '',
        f'- Live records: **{len(db)}**',
        f'- Populated driverCount/active values still `{CITED}` (fields): **{total_items}**',
        f'- Distinct source URLs with outstanding fields: **{total_urls}**',
        f'- URLs with no recorded status (`OPEN`): **{url_status_counts.get(DEFAULT_STATUS, 0)}**',
        f'- Source URLs already opened and recorded in the status file (outstanding fields remain): '
        f'**{total_urls - url_status_counts.get(DEFAULT_STATUS, 0)}**',
        f'- Source URLs fully resolved (in the status file, no outstanding fields): **{len(resolved_urls)}**',
        '',
        'URL counts and field counts are separate. A URL is counted once in the URL table even when it carries several fields.',
        '',
        '| Status | URLs | Outstanding fields |',
        '|---|---:|---:|',
    ]
    for s in sorted(set(url_status_counts) | set(item_status_counts)):
        lines.append(f'| {s} | {url_status_counts.get(s, 0)} | {item_status_counts.get(s, 0)} |')
    lines += [
        '',
        'Status vocabulary (from `provenance-source-ledger.json`): `CHECKED_CONFIRMED`, `CHECKED_PARTIAL`, '
        '`CHECKED_REJECTED`, `CONFLICT`, `INACCESSIBLE`, `OPEN` (not yet opened; the brief calls this NOT_CHECKED).',
        '',
        'Field outcomes: `PROMOTED` (value now verified), `NOT_STATED` (source opened, field not stated; stays open), '
        '`NOT_EXTRACTED` (source opened, containing table not in extracted text; retry).',
        '',
        '## Sources still to open (status OPEN)',
        '',
        '| # | Items | Host | Records | Fields | Source URL |',
        '|---:|---:|---|---|---|---|',
    ]
    open_rows = [r for r in url_rows if r['status'] == DEFAULT_STATUS]
    for i, r in enumerate(open_rows, 1):
        lines.append(f'| {i} | {r["items"]} | {r["host"]} | {", ".join(r["records"])} | {", ".join(r["fields"])} | {r["url"]} |')
    if not open_rows:
        lines.append('| - | 0 | - | - | - | none |')

    lines += [
        '',
        '## Sources already opened (do not reopen unless retrying NOT_EXTRACTED fields or new evidence)',
        '',
        '| # | Status | Items | Host | Outstanding fields and recorded outcome | Source URL |',
        '|---:|---|---:|---|---|---|',
    ]
    checked_rows = [r for r in url_rows if r['status'] != DEFAULT_STATUS]
    for i, r in enumerate(checked_rows, 1):
        detail = '; '.join(
            f'{o["record"]}.{o["field"]} ({o["recordedOutcome"] or "no outcome recorded"})' for o in r['outstanding'])
        lines.append(f'| {i} | {r["status"]} | {r["items"]} | {r["host"]} | {detail} | {r["url"]} |')
    if not checked_rows:
        lines.append('| - | - | 0 | - | none | none |')

    lines += [
        '',
        '## Sources fully resolved (status file, no outstanding fields)',
        '',
    ]
    if resolved_urls:
        for u in resolved_urls:
            lines.append(f'- {status_by_url[u].get("status")}: {u}')
    else:
        lines.append('- none')

    lines += ['', '## Consistency warnings', '']
    if warnings:
        for w in warnings:
            lines.append(f'- {w}')
    else:
        lines.append('- none')
    lines.append('')

    with open(OUT_MD, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))

    print(f'records={len(db)} unchecked_items={total_items} unique_urls={total_urls} '
          f'resolved_urls={len(resolved_urls)} warnings={len(warnings)}')


if __name__ == '__main__':
    main()
