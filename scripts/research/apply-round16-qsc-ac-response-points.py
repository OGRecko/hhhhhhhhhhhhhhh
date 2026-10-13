#!/usr/bin/env python3
"""Round 16: correct QSC AC-C4T and AC-C8T published response points.

Source: exact-model QSC spec sheets (manufacturer host www.qscaudio.com, ESTABLISHED),
opened 2026-10-13. Column used: "Frequency Response (Raw)" only. The sheets carry no
revision label, so the revision cannot be pinned from the document.
Correction is limited to values that differ from the cited sheet; the 10 kHz end
of the table is kept (the 20 kHz row is blank on both sheets).
"""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEAKERS = ROOT / 'src/data/speakers.json'
HISTORY = ROOT / 'scripts/research/round16-value-history.json'

C4T = [(20,65),(30,54),(40,59),(50,65),(60,71),(70,76),(80,80),(90,83),(100,85),(200,86),
       (300,85),(400,88),(500,88),(600,92),(700,92),(800,92),(900,91),(1000,91),(2000,88.5),
       (3000,87),(4000,87),(5000,88),(6000,91),(7000,90),(8000,88),(9000,86),(10000,84)]
C8T = [(20,62.5),(30,66.5),(40,70),(50,76),(60,82),(70,87),(80,90.5),(90,92.5),(100,93),
       (200,89.5),(300,87.5),(400,89),(500,90),(600,88),(700,93),(800,94.5),(900,93),(1000,92),
       (2000,92),(3000,98),(4000,99.5),(5000,99),(6000,91),(7000,94),(8000,91),(9000,92),(10000,90)]

CTX_SUFFIX = (" Round 16 (2026-10-13): every point was re-read against the cited sheet's Raw column; "
              "values that differed from the sheet were corrected. Table ends at 10 kHz; the 20 kHz row is blank. "
              "The 16 kHz (C4T) / 20 kHz (C8T) figures are the stated effective range, not response coverage. "
              "Sheet has no revision label.")

TARGETS = {'qsc-ac-c4t': C4T, 'qsc-ac-c8t': C8T}

def main():
    speakers = json.loads(SPEAKERS.read_text(encoding='utf-8'))
    by_id = {s['id']: s for s in speakers}
    history = []
    for sid, table in TARGETS.items():
        rec = by_id[sid]
        fr = rec['frequencyResponse']
        before = [(p['hz'], p['db']) for p in fr['points']]
        after = list(table)
        if before == after:
            print(sid, 'already matches'); continue
        diffs = []
        bd = dict(before); ad = dict(after)
        for hz in sorted(set(bd) | set(ad)):
            if bd.get(hz) != ad.get(hz):
                diffs.append({'hz': hz, 'before': bd.get(hz), 'after': ad.get(hz)})
        history.append({'id': sid, 'field': 'frequencyResponse.points', 'changes': diffs,
                        'source': fr['pointsSource'], 'round': 16,
                        'reason': 'Stored points differed from the cited exact-model sheet Raw column; re-transcribed.'})
        fr['points'] = [{'hz': hz, 'db': db} for hz, db in after]
        if not fr['pointsContext'].endswith(CTX_SUFFIX):
            fr['pointsContext'] = fr['pointsContext'] + CTX_SUFFIX
        print(sid, 'changed points:', len(diffs))
    SPEAKERS.write_text(json.dumps(speakers, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    HISTORY.write_text(json.dumps({'round': 16, 'entries': history}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('history entries:', len(history))

if __name__ == '__main__':
    sys.exit(main())
