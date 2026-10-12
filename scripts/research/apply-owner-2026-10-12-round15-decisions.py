#!/usr/bin/env python3
"""Owner answers recorded 2026-10-12 (round 15, ask_user):

- Decision 6 (turbosound-ip15b): archive per the standing rule. The record moves unchanged to
  removed-unavailable-2026-10-12.json (recoverable; nothing is deleted). Live count 659 -> 658,
  archive 7 -> 8, total stays 777. The iP15B manufacturer PDF was not retrievable; the only copy
  found is dealer-hosted, so origin is not established and sourceType is left unset.
- Decision 7 (yamaha-ns-6490): the single record represents the US variant. Impedance is set to
  8 ohm from the US manufacturer page. The Malaysia page (6 ohm) is recorded in the notes and
  is not combined into the value.
- Decision 8 (yes, document check): www.qscaudio.com is ESTABLISHED because the fetched QSC
  WideLine-8 manual names QSC, LLC (copyright and trademark owner). Other hosts are not changed
  here: their fetched documents named only the brand (Klipsch, KEF, usa.yamaha.com) or a
  sub-brand without the operating company (JBL Professional / Harman, my.yamaha.com).

Idempotent: refuses to re-archive; updates the impedance only from the UNAVAILABLE state.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ARCHIVE = os.path.join(ROOT, 'scripts', 'research', 'removed-unavailable-2026-10-12.json')
ALLOW = os.path.join(ROOT, 'scripts', 'research', 'source-host-allowlist.json')
DATE = '2026-10-12'
USA_URL = 'https://usa.yamaha.com/products/audio_visual/speaker_systems/ns-6490/specs.html'
HIST = os.path.join(ROOT, 'scripts', 'research', 'round15-owner-decisions-history.json')


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    hist = []

    # --- Decision 6: archive turbosound-ip15b ---
    arch = json.load(open(ARCHIVE, encoding='utf-8'))
    ids = {r['id'] for r in arch['records']}
    if 'turbosound-ip15b' not in ids:
        r = by.get('turbosound-ip15b')
        assert r is not None, 'turbosound-ip15b not live and not archived'
        assert r['overallStatus'] == 'PARTIALLY_VERIFIED', r['overallStatus']
        arch['records'].append(r)
        arch['recordCount'] = len(arch['records'])
        arch['archiveMeta'].append({
            'id': 'turbosound-ip15b',
            'reason': ('Owner decision 6 (2026-10-12): archive per the standing rule. Manufacturer origin of the '
                       'iP15B Product Information Document is not established: the musictribe PDF was not '
                       'retrievable and the only copy found is dealer-hosted (monthany.com). Record archived '
                       'unchanged; recoverable. sourceType was not changed.'),
            'redirectTo': None, 'archivedDate': DATE})
        json.dump(arch, open(ARCHIVE, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
        del by['turbosound-ip15b']
        data = [x for x in data if x['id'] != 'turbosound-ip15b']
        hist.append({'id': 'turbosound-ip15b', 'action': 'ARCHIVED', 'decision': 'owner-decision-6-2026-10-12'})

    # --- Decision 7: Yamaha NS-6490 US variant impedance ---
    y = by['yamaha-ns-6490']
    if y['impedance'].get('status') == 'UNAVAILABLE':
        before = dict(y['impedance'])
        y['impedance'] = {
            'value': 8, 'unit': 'ohm', 'status': 'MANUFACTURER_VERIFIED', 'source': USA_URL,
            'sourceType': 'MANUFACTURER',
            'note': ('Owner decision 7 (2026-10-12): the record represents the US variant. Nominal 8 ohm from the '
                     'US manufacturer page (usa.yamaha.com; host not yet on the allowlist, same status as the '
                     'existing sensitivity). Malaysia page (my.yamaha.com) publishes 6 ohm for the Malaysia '
                     'variant; it is recorded in the notes and not combined into this value.')}
        hist.append({'id': 'yamaha-ns-6490', 'field': 'impedance', 'before': before, 'after': y['impedance'],
                     'decision': 'owner-decision-7-2026-10-12-us'})
        notes = y.get('notes') or ''
        old = ('The US Yamaha spec page lists 8-ohm nominal impedance, but Yamaha\'s Malaysia NS-6490 page lists '
               '6 ohms for the same model; because official manufacturer sources conflict, the impedance field '
               'remains N/A rather than selecting one.')
        new = ('Impedance is set to the US variant (8 ohm, owner decision 7, 2026-10-12). The Malaysia NS-6490 page '
               '(my.yamaha.com) lists 6 ohm for the Malaysia variant; the two regional values are not combined.')
        assert old in notes, 'expected impedance sentence not found in notes'
        y['notes'] = notes.replace(old, new)

    with open(DATA + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False); fh.write('\n')
    os.replace(DATA + '.tmp', DATA)

    # --- Decision 8: establish www.qscaudio.com (document names QSC, LLC) ---
    allow = json.load(open(ALLOW, encoding='utf-8'))
    hosts = allow['hosts'] if isinstance(allow, dict) else allow
    for h in hosts:
        if h['host'] == 'www.qscaudio.com' and h['status'] != 'ESTABLISHED':
            h['previousStatus'] = h['status']
            h['status'] = 'ESTABLISHED'
            h['operator'] = 'QSC, LLC (QSC Audio Products)'
            h['evidence'] = [
                'QSC WideLine-8 Series Loudspeaker System User Manual, TD-000237-00 rev D, '
                'https://www.qscaudio.com/resource-files/productresources/spk/wideline_8/q_spk_wl8_usermanual.pdf: '
                '"Copyright 2017, QSC, LLC" and "QSC(R) is a registered trademark of QSC, LLC" (fetched 2026-10-12).']
            h['note'] = 'Established by owner decision 8 (document check). No values were promoted from this host in round 15.'
            hist.append({'id': 'www.qscaudio.com', 'action': 'HOST_ESTABLISHED', 'decision': 'owner-decision-8-2026-10-12-yes-doc'})
            break
    else:
        raise AssertionError('www.qscaudio.com not in allowlist')
    if isinstance(allow, dict):
        allow['hosts'] = hosts
    json.dump(allow, open(ALLOW, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

    json.dump({'date': DATE, 'entries': hist}, open(HIST, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print('live', len(data), 'archive', arch['recordCount'], 'hist', len(hist))


if __name__ == '__main__':
    main()
