#!/usr/bin/env python3
"""Owner answers (2026-10-12) on the L-Acoustics queue records.

1. legacy-la-7 'X15' is renamed to 'X15 HiQ' (owner-approved identity change) and verified from the
   official L-Acoustics page https://www.l-acoustics.com/products/x15-hiq/ (fetched 2026-10-12).
   Only values printed on that page are stored. Sensitivity and RMS power are not published there and stay N/A.
2. ARCS II is added as a separate record 'lacoustics-arcs-ii' (owner decision). Values come from the
   manufacturer datasheet 'ARCS II_SP_EN_2-0/10-11' hosted at https://www.sisme.com/media/3071/lacoustics-arcsii_ds.pdf.
   That host is a third party, so the values are THIRD_PARTY_VERIFIED, as for Kara, and not MANUFACTURER.
   The record 'ARCS' (legacy-la-2) is not the same product and is not changed except for a note.
3. legacy-la-1 'V-DOSC' had no exact-model source after search (owner instruction: search, and remove if
   no source is found). The full record is archived unchanged in removed-owner-round5-records.json.
   The original 81-record archive is not modified.
"""
import copy
import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
ARCH = os.path.join(ROOT, 'scripts', 'research', 'removed-owner-round5-records.json')
DATE = '2026-10-12'

X15_URL = 'https://www.l-acoustics.com/products/x15-hiq/'
ARCSII_URL = 'https://www.sisme.com/media/3071/lacoustics-arcsii_ds.pdf'


def mv(value, unit, source, status='MANUFACTURER_VERIFIED', source_type='MANUFACTURER'):
    return {'value': value, 'unit': unit, 'status': status, 'source': source, 'sourceType': source_type}


def na(unit):
    return {'value': None, 'unit': unit, 'status': 'UNAVAILABLE', 'source': None, 'sourceType': 'NONE'}


def fr(low, high, source, status='MANUFACTURER_VERIFIED', source_type='MANUFACTURER'):
    return {'low_hz': low, 'high_hz': high, 'status': status, 'source': source, 'sourceType': source_type}


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    by = {r['id']: r for r in data}
    x15 = by['legacy-la-7']
    arcs = by['legacy-la-2']
    vdosc = by['legacy-la-1']
    wide = by['lacoustics-arcs']
    assert x15['model'] == 'X15' and arcs['model'] == 'ARCS' and vdosc['model'] == 'V-DOSC'
    assert 'lacoustics-arcs-ii' not in by

    # 1. X15 -> X15 HiQ
    old_notes = x15['notes']
    x15['model'] = 'X15 HiQ'
    x15['overallStatus'] = 'PARTIALLY_VERIFIED'
    x15['driverCount'] = 2
    x15['driverCountProvenance'] = {'status': 'MANUFACTURER_VERIFIED', 'source': X15_URL, 'sourceType': 'MANUFACTURER'}
    x15['active'] = True
    x15['activeProvenance'] = {'status': 'MANUFACTURER_VERIFIED', 'source': X15_URL, 'sourceType': 'MANUFACTURER'}
    x15['sensitivity'] = na('dB')
    x15['frequencyResponse'] = fr(55, 20000, X15_URL)
    x15['power'] = na('W')
    x15['impedance'] = mv(8, 'ohm', X15_URL)
    x15['resonantFreq'] = na('Hz')
    x15['voiceCoil'] = na('in')
    x15['woofer'] = mv(15, 'in', X15_URL)
    x15['notes'] = (
        f"Owner decision ({DATE}): the row 'X15' is renamed to 'X15 HiQ' and verified from the L-Acoustics official page "
        f"{X15_URL}. That page is for the X15 HiQ, and the owner approved treating the row as that product. "
        "Stored values: 2-way active coaxial enclosure; LF 1 x 15 in, HF 1 x 3 in; nominal impedance LF 8 ohm and HF 8 ohm; "
        "usable bandwidth -10 dB 55 Hz to 20 kHz (preset [X15] as printed on the page); the page lists these as the values for the "
        "HiQ enclosure. Maximum SPL 138 dB is a peak level at 1 m under free field, pink noise with crest factor 4, with the [X15] "
        "preset. It is not a sensitivity or a power rating, so it is not stored in those fields. The page publishes no sensitivity "
        "and no RMS power rating, so both stay N/A. Nominal -6 dB directivity (60 deg vertical x 40 deg horizontal) is recorded only "
        "in the directivity-leads file and is not imported as a polar. Weight 21 kg is not a schema field. "
        "Earlier history (verbatim, before the rename):\n" + old_notes
    )

    # 2. ARCS II as a separate record
    arcs2 = copy.deepcopy(wide)
    arcs2['id'] = 'lacoustics-arcs-ii'
    arcs2['brand'] = 'L-Acoustics'
    arcs2['model'] = 'ARCS II'
    arcs2['category'] = wide['category']
    arcs2['year'] = None
    arcs2['overallStatus'] = 'PARTIALLY_VERIFIED'
    arcs2['driverCount'] = 2
    arcs2['driverCountProvenance'] = {'status': 'MANUFACTURER_VERIFIED', 'source': ARCSII_URL, 'sourceType': 'THIRD_PARTY'}
    arcs2['active'] = True
    arcs2['activeProvenance'] = {'status': 'MANUFACTURER_VERIFIED', 'source': ARCSII_URL, 'sourceType': 'THIRD_PARTY'}
    arcs2['sensitivity'] = na('dB')
    arcs2['frequencyResponse'] = fr(50, 20000, ARCSII_URL, 'THIRD_PARTY_VERIFIED', 'THIRD_PARTY')
    arcs2['power'] = na('W')
    arcs2['impedance'] = mv(8, 'ohm', ARCSII_URL, 'THIRD_PARTY_VERIFIED', 'THIRD_PARTY')
    arcs2['resonantFreq'] = na('Hz')
    arcs2['voiceCoil'] = mv(4, 'in', ARCSII_URL, 'THIRD_PARTY_VERIFIED', 'THIRD_PARTY')
    arcs2['woofer'] = mv(15, 'in', ARCSII_URL, 'THIRD_PARTY_VERIFIED', 'THIRD_PARTY')
    arcs2['notes'] = (
        f"Owner decision ({DATE}): ARCS II is a separate product from the catalog row 'ARCS' (legacy-la-2). "
        "Source: the L-Acoustics ARCS II product datasheet, footer 'ARCS II_SP_EN_2-0/10-11', hosted at "
        f"{ARCSII_URL} (a third-party host; the official l-acoustics.com ARCS II product page was not reached on "
        "2026-10-12, so the copy is treated as THIRD_PARTY_VERIFIED under the authenticated-copy rule, as for Kara). "
        "The datasheet identifies the exact model and revision, and the sheet's L-Acoustics branding, WST/LA8 content "
        "and specifications are consistent. Stored: full-range active 2-way enclosure; one 15 in neodymium LF with a 4 in "
        "coil and one 3 in neodymium HF compression driver (2 transducers in total); nominal impedance 8 ohm LF and 8 ohm HF; "
        "usable bandwidth -10 dB 50 Hz to 20 kHz with the [ARCS II] preset. "
        "Not stored: the datasheet's maximum SPL is 140 dB at 1 m with the [ARCS II] preset. A second copy of the ARCS II "
        "System User Manual is reported to print 142 dB, so the two revisions conflict; no value is stored from either "
        "because the maximum SPL has no schema field. RMS power is printed per transducer (LF 600 W, HF 100 W) with no single "
        "enclosure rating, so power stays N/A. Sensitivity is not published and stays N/A. The -6 dB coverage is "
        "22.5 deg symmetric x 60 deg asymmetric (-20/+40 deg) and is not an angle-resolved polar, so it is not imported. "
        "Weight 50 kg and dimensions are not schema fields."
    )

    # ARCS (legacy-la-2): note only, status unchanged
    arcs['notes'] = (
        f"Owner decision ({DATE}): ARCS II is added as a separate record (lacoustics-arcs-ii). This row 'ARCS' has no exact-model "
        "source, so it remains UNVERIFIED and no values are transferred from ARCS II or ARCS Wide. "
        + arcs['notes']
    )

    # 3. V-DOSC: remove from the live dataset and archive unchanged
    archived_vdosc = copy.deepcopy(vdosc)

    new = []
    for r in data:
        if r['id'] == 'legacy-la-1':
            continue
        new.append(r)
        if r['id'] == 'lacoustics-arcs':
            new.append(arcs2)
    assert len(new) == len(data) - 1 + 1, 'unexpected live count'
    assert sum(1 for r in new if r['id'] == 'lacoustics-arcs-ii') == 1

    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(new, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    os.replace(tmp, DATA)

    arch = json.load(open(ARCH, encoding='utf-8'))
    assert arch['recordCount'] == 24 and len(arch['records']) == 24
    assert not any(r['id'] == 'legacy-la-1' for r in arch['records'])
    arch['records'].append(archived_vdosc)
    arch['recordCount'] = len(arch['records'])
    arch['reason'] += (
        f" Addendum ({DATE}, owner instruction): legacy-la-1 'V-DOSC' is also archived here. Searches found only "
        "third-party-hosted copies of older V-DOSC sheets (2003-era and undated), not an exact-revision source from "
        "L-Acoustics; the record is archived unchanged, not deleted."
    )
    json.dump(arch, open(ARCH, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    print('live', len(new), 'archived', arch['recordCount'])


if __name__ == '__main__':
    main()
