#!/usr/bin/env python3
"""Round 14 host policy: demote MANUFACTURER_VERIFIED values whose source host is not established.

Host status comes from source-host-allowlist.json. Only hosts with status NOT_ESTABLISHED or
NOT_MANUFACTURER demote. Each demotion asserts the field's current status is MANUFACTURER_VERIFIED
and its source host matches, then writes CITED_IN_NOTES_UNCHECKED and keeps the URL and the prior
object in round14-host-policy-history.json. The queue status file is updated so recorded PROMOTED
outcomes do not contradict live provenance. Idempotent: already-demoted fields are skipped.
"""
import json, os, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ALLOW = os.path.join(HERE, 'source-host-allowlist.json')
STATUS = os.path.join(HERE, 'queue-url-status.json')
HISTORY = os.path.join(HERE, 'round14-host-policy-history.json')
DEMOTE_STATUSES = {'NOT_ESTABLISHED', 'NOT_MANUFACTURER'}
CITED = 'CITED_IN_NOTES_UNCHECKED'


def dump(path, obj):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(obj, indent=2, ensure_ascii=False) + '\n')


def main():
    allow = {h['host']: h for h in json.load(open(ALLOW, encoding='utf-8'))['hosts']}
    blocked = {h for h, v in allow.items() if v['status'] in DEMOTE_STATUSES}
    db = json.load(open(DATA, encoding='utf-8'))
    hist = json.load(open(HISTORY, encoding='utf-8')) if os.path.exists(HISTORY) else {'entries': []}
    done_keys = {(e['id'], e['field']) for e in hist['entries']}
    demoted = []
    db_by_id = {r['id']: r for r in db}
    for r in db:
        for f in ('driverCount', 'active'):
            p = r.get(f + 'Provenance') or {}
            if p.get('status') != 'MANUFACTURER_VERIFIED':
                continue
            host = urllib.parse.urlparse(p.get('source', '')).netloc
            if host not in blocked:
                continue
            new = {'status': CITED, 'source': p['source'], 'sourceType': None,
                   'note': f"Round 14 host policy ({allow[host]['status']}): {host} is not an established manufacturer host. "
                           f"Demoted from MANUFACTURER_VERIFIED pending an established source. Prior object kept in round14-host-policy-history.json. Previous note: " + str(p.get('note', ''))}
            hist['entries'].append({'id': r['id'], 'field': f, 'value': r.get(f), 'before': p, 'after': new,
                                    'host': host, 'hostStatus': allow[host]['status'], 'round': 14})
            r[f + 'Provenance'] = new
            demoted.append((r['id'], f, host))
    if demoted:
        with open(DATA, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(db, indent=2, ensure_ascii=False) + '\n')
        hist['marker'] = 'round14-host-policy'
        dump(HISTORY, hist)

    # Keep the URL status file consistent: a recorded PROMOTED outcome for a demoted field is changed.
    status = json.load(open(STATUS, encoding='utf-8'))
    changed = 0
    dem = {(i, f) for i, f, _ in demoted}
    for u in status['urls']:
        for fr in u.get('fieldResults', []):
            if fr.get('outcome') == 'PROMOTED' and (fr['record'], fr['field']) in dem:
                fr['outcome'] = 'SUPPORTED_NOT_PROMOTED'
                fr['note'] = (fr.get('note', '') + ' Round 14: host not established; demoted to CITED_IN_NOTES_UNCHECKED.').strip()
                changed += 1
    # Every round-14 demotion (this run or an earlier one) needs a recorded outcome on its URL.
    added = 0
    all_demoted = [(e['id'], e['field'], e['host']) for e in hist['entries'] if e.get('round') == 14]
    for u in status['urls']:
        host = urllib.parse.urlparse(u['url']).netloc
        for i, f, h in all_demoted:
            if h != host:
                continue
            if any(fr['record'] == i and fr['field'] == f for fr in u.get('fieldResults', [])):
                continue
            u.setdefault('fieldResults', []).append({'record': i, 'field': f, 'value': db_by_id[i].get(f), 'outcome': 'SUPPORTED_NOT_PROMOTED',
                                                    'note': 'Round 14: host not established; demoted to CITED_IN_NOTES_UNCHECKED.'})
            added += 1
    if changed or added:
        dump(STATUS, status)
    # Owner-facing record in the source ledger (idempotent, keyed by marker).
    LEDGER = os.path.join(HERE, 'provenance-source-ledger.json')
    led = json.load(open(LEDGER, encoding='utf-8'))
    if not any(r.get('marker') == 'round14-host-policy' for r in led['rounds']):
        led['rounds'].append({'round': 14, 'marker': 'round14-host-policy', 'date': '2026-10-12',
                              'reason': 'Host policy: MANUFACTURER_VERIFIED requires an ESTABLISHED host (source-host-allowlist.json). Non-established hosts demoted with history.',
                              'fieldsDemoted': len([e for e in hist['entries'] if e.get('round') == 14]),
                              'hostsEstablished': sorted(h for h, v in allow.items() if v['status'] == 'ESTABLISHED'),
                              'hostsDemotedFrom': sorted({e['host'] for e in hist['entries'] if e.get('round') == 14}),
                              'brandDomainUnverified': sorted(h for h, v in allow.items() if v['status'] == 'BRAND_DOMAIN_UNVERIFIED'),
                              'allowlist': 'scripts/research/source-host-allowlist.json'})
    if not any(q.get('id') == 'host-policy-acceptance' for q in led['openQuestionsForOwner']):
        led['openQuestionsForOwner'].append({'id': 'host-policy-acceptance',
            'question': 'Accept the host decisions in source-host-allowlist.json (Bose Professional, Electro-Voice and Genelec asset hosts ESTABLISHED; tile.loc.gov, walkersound, eviaudio.fr and fmicassets.com NOT established) and the demotion of the 12 fields. Brand-domain hosts stay flagged for review, not verified. Reversible if ownership is later shown.'})
    with open(LEDGER, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(led, indent=2, ensure_ascii=False) + '\n')
    print(f'round14 host policy: demoted={len(demoted)} status_outcomes_changed={changed} status_outcomes_added={added}')
    for i, f, h in demoted:
        print(f'  {i}.{f} <- {h}')


if __name__ == '__main__':
    main()
