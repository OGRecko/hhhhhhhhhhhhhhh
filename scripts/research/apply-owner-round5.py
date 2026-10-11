#!/usr/bin/env python3
"""Round 5 owner decisions (2026-10-11).

1. Split the generic Electro-Voice Zx3 record into exact variants Zx3-60 and Zx3-90, using the
   series specification table printed in the EV Zx3 owner's manual (manufacturer document, hosted at
   https://www.eviaudio.fr/wp-content/uploads/2020/04/ev_zx3_manuel.pdf). The generic record is archived.
   The manual prints ONE specification table for the Zx3 series and separate coverage patterns per
   variant; the shared values are attached to both variants and this basis is written into each note.
   PI (weatherproof) versions are not in the catalog and are not split.
2. Remove from the live dataset the consumer records (Sonos, Bose, Sony, Boston Acoustics) whose
   overallStatus is UNVERIFIED: manufacturer structural facts exist but no acoustic specification is
   published. Full records are archived unchanged in removed-owner-round5-records.json.

The original 81-record UNAVAILABLE archive (removed-unavailable-records.json) is not modified.
"""
import json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ARCH = os.path.join(ROOT, 'scripts', 'research', 'removed-owner-round5-records.json')
DATE = '2026-10-11'
EV_URL = 'https://www.eviaudio.fr/wp-content/uploads/2020/04/ev_zx3_manuel.pdf'
CONSUMER_BRANDS = {'Sonos', 'Bose', 'Sony', 'Boston Acoustics'}


def manuf(value, unit, source, reference=None):
    v = {'value': value, 'unit': unit, 'status': 'MANUFACTURER_VERIFIED', 'source': source,
         'sourceType': 'MANUFACTURER'}
    if reference:
        v['reference'] = reference
    return v


def variant(base, model, coverage, id_):
    r = json.loads(json.dumps(base))
    r['id'] = id_
    r['model'] = model
    r['overallStatus'] = 'PARTIALLY_VERIFIED'
    r['sensitivity'] = manuf(97, 'dB', EV_URL,
                             'Axial, half-space measurement, 1 W/1 m (manual footnote 1)')
    r['impedance'] = manuf(8, 'ohm', EV_URL)
    r['power'] = manuf(600, 'W', EV_URL)
    r['power']['role'] = 'speaker_power_handling'
    r['woofer'] = manuf(12, 'in', EV_URL)
    r['frequencyResponse'] = {'low_hz': 58, 'high_hz': 15000, 'status': 'MANUFACTURER_VERIFIED',
                              'source': EV_URL, 'sourceType': 'MANUFACTURER'}
    r['notes'] = (
        f"Round 5 variant split (owner decision, {DATE}). Exact variant: Electro-Voice {model}, coverage {coverage}. "
        "Source: Electro-Voice Zx3 Owner's Manual, manufacturer document (hosted copy: "
        f"{EV_URL}). The manual prints one specification table for the Zx3 series, which is applied to this variant: "
        "frequency response -3 dB 58 Hz to 15 kHz (-10 dB 48 Hz to 20 kHz), axial sensitivity 97 dB (1 W/1 m, half space), "
        "nominal impedance 8 ohm (minimum 6.2 ohm), power 600 W continuous passive / 2400 W peak, LF 12 in DVX3121, "
        "HF 1 in ND2 exit neodymium compression driver, crossover 2 kHz, Speakon NL4, 613 x 397 x 362 mm, net 19.8 kg. "
        "Voice-coil size is not stated for the LF driver and stays N/A. "
        "driverCount 2 and active false are variant-independent (see provenance). Its response graphs are per-variant "
        "manufacturer tables, not measurements, and are not stored."
    )
    r['sensitivity']['reference'] = 'Axial, half-space measurement, 1 W/1 m (manual footnote 1)'
    return r


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    zx = by.get('electro-voice-zx3')
    assert zx is not None, 'generic zx3 missing'
    consumer = [r for r in data if r['brand'] in CONSUMER_BRANDS and r['overallStatus'] == 'UNVERIFIED']
    assert len(consumer) == 23, f'expected 23 consumer UNVERIFIED records, found {len(consumer)}'
    consumer_ids = {r['id'] for r in consumer}

    v60 = variant(zx, 'Zx3-60', '60 x 60 degrees', 'electro-voice-zx3-60')
    v90 = variant(zx, 'Zx3-90', '90 x 50 degrees', 'electro-voice-zx3-90')

    archived = consumer + [zx]
    new = []
    for r in data:
        if r['id'] in consumer_ids:
            continue
        if r['id'] == 'electro-voice-zx3':
            new.extend([v60, v90])
            continue
        new.append(r)

    assert len(new) == len(data) - 24 + 2, 'unexpected live count'
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(new, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, DATA)

    arch = {
        'reviewDate': DATE,
        'reason': ("Removed from the live dataset at owner request (round 5, decision 2, 2026-10-11): consumer records "
                   "(Sonos, Bose, Sony, Boston Acoustics) whose manufacturer publishes no acoustic specification "
                   "(structural facts only, overallStatus UNVERIFIED), and the generic Electro-Voice Zx3 record, replaced "
                   "by exact variants Zx3-60 and Zx3-90 (decision 1). Full records are archived unchanged; they are not speaker data."),
        'recordCount': len(archived),
        'records': archived,
    }
    json.dump(arch, open(ARCH, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print('live', len(new), 'archived', len(archived))


if __name__ == '__main__':
    main()
