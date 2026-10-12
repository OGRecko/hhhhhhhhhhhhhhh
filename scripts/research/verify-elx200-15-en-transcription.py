#!/usr/bin/env python3
"""Row-by-row check of the ELX200-15 EN transcription against the manufacturer's EN datasheet text.

Source: https://products.electrovoice.com/binary/ELX200-15_BDL_en.pdf (opened 2026-10-12, 1 chunk).
Reference rows are the datasheet table 'Frequency (Hz) | Frequency Response, Full Space, 1W/1m (Sensitivity, dB) | Impedance (Ohms, rhs)'.
Read-only: prints a comparison; writes nothing.
"""
import os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
TRANSCRIPTION = os.path.join(ROOT, 'scripts', 'research', 'data', 'elx200-15-primary-en-2026-10-13-bdl.txt')

# Reference: freq Hz, sensitivity dB, impedance ohm (verbatim from the EN datasheet table)
REFERENCE = [
(20,62,16),(25,68,16),(30,73,12),(35,76,10),(40,79,9.5),(45,82,9),(50,84,9),(55,86,10),(60,88,11),(65,90,13),
(70,91,16),(75,92,12),(80,93,10),(85,94,10),(90,95,9),(95,95,9),(100,95,8),(110,95.5,7),(120,96,6.5),(130,96,6.5),
(140,95,7),(150,95,7.5),(160,95.5,8),(170,96,8.5),(180,96,9),(190,96,9.5),(200,95.5,10),(220,95,11),(250,95,12),
(280,95.5,13),(300,96,14),(330,96,15),(360,95.5,16),(400,95,17),(450,96,18),(500,96,19),(550,96,20),(600,96,21),
(650,96,22),(700,96,23),(750,96,24),(800,96,25),(850,96,26),(900,96,27),(950,96,28),(1000,96,29),(1100,95,31),
(1200,94,34),(1300,94,38),(1400,94,43),(1500,95,49),(1600,95,56),(1700,95,64),(1800,95,72),(1900,95,80),(2000,95,88),
(2200,95,97),(2400,95,106),(2500,95,110),(2600,95,110),(2800,94,106),(3000,93,100),(3300,93,93),(3600,93,86),
(4000,94,80),(4500,95,74),(5000,95,69),(5500,95,65),(6000,95,62),(6500,95,60),(7000,95,58),(7500,95,56),(8000,95,55),
(8500,95,54),(9000,95,53),(9500,96,52),(10000,96,51),(11000,95,50),(12000,95,49),(13000,95,48),(14000,94,47),
(15000,94,46),(16000,93,45),(17000,92,44),(18000,91,43),(19000,89,42),(20000,82,41),
]


def load_transcription():
    rows = []
    for line in open(TRANSCRIPTION, encoding='utf-8'):
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        parts = s.split()
        rows.append((float(parts[0]), float(parts[1]), float(parts[2])))
    return rows


def main():
    tr = load_transcription()
    ref = {f: (db, z) for f, db, z in REFERENCE}
    got = {f: (db, z) for f, db, z in tr}
    mismatches = []
    for f, db, z in REFERENCE:
        if f not in got:
            mismatches.append((f, 'missing in transcription', db, z))
        elif got[f] != (db, z):
            mismatches.append((f, 'value', (db, z), got[f]))
    extra = [f for f in got if f not in ref]
    print(f'reference rows: {len(REFERENCE)}  transcription rows: {len(tr)}')
    print(f'mismatched rows: {len(mismatches)}  extra transcription rows: {extra}')
    for m in mismatches:
        print('  MISMATCH', m)
    return 0 if not mismatches and not extra and len(tr) == len(REFERENCE) else 1


if __name__ == '__main__':
    sys.exit(main())
