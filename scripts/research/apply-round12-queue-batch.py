#!/usr/bin/env python3
"""Round 12 queue batch: source-checked promotions for driverCount / active.

Every promotion asserts the record's current value, its current provenance status
(must still be CITED_IN_NOTES_UNCHECKED) and the exact recorded source URL before writing.
Old provenance objects are preserved in round12-value-history.json. Nothing is withdrawn
in this round. Fields the opened source does not state are left CITED_IN_NOTES_UNCHECKED
and recorded per URL in queue-url-status.json as NOT_STATED / NOT_EXTRACTED.

Also applies one provenance demotion (lacoustics-arcs-ii: MANUFACTURER_VERIFIED on a
THIRD_PARTY sourceType is not allowed) and records the Genelec 8331A lead outcome.

Run once. A marker in provenance-source-ledger.json refuses a second run.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
DATA = os.path.join(ROOT, 'src', 'data', 'speakers.json')
LEDGER = os.path.join(HERE, 'provenance-source-ledger.json')
STATUS = os.path.join(HERE, 'queue-url-status.json')
HISTORY = os.path.join(HERE, 'round12-value-history.json')
LEADS = os.path.join(HERE, 'directivity-leads.json')
MARKER = 'round12-queue-batch'
GENELEC_LEAD_ID = 'genelec-8331a'  # replaced below if the lead file uses another id

CITED = 'CITED_IN_NOTES_UNCHECKED'
MANU = 'MANUFACTURER'
THIRD = 'THIRD_PARTY'

U = {
    'dali': 'https://www.dali-speakers.com/media/5320/oberon-manual.pdf',
    'kef_info': 'https://assets.kef.com/uploads/cm/r2018_infosheet_en.pdf',
    'zlx': 'https://www.leone.sk/file/230/ev-zlx-manual.pdf',
    'serafino': 'https://www.manualslib.com/manual/1290952/Sonus-Faber-Serafino-Tradition.html?page=30#manual',
    'nova42': 'https://www.manualslib.com/manual/1744876/Sonus-Faber-Olympica-Nova.html?page=42#manual',
    'nova43': 'https://www.manualslib.com/manual/1744876/Sonus-Faber-Olympica-Nova.html?page=43#manual',
    'mackie': 'https://mackie.com/img/file_resources/CR-X_Series_QSG.pdf',
    'loc4310': 'https://tile.loc.gov/storage-services/master/mbrs/recording_preservation/manuals/JBL%20Prof.%20Series%20Model%204310%20Control%20Room%20Monitor.pdf',
    'srx815': 'https://adn.harmanpro.com/site_elements/resources/20632_1576610251/JBL_SRX815_SpecSheet_11_11_19_original.pdf',
    'prx815': 'https://adn.harmanpro.com/site_elements/resources/20641_1577548732/JBL_PRX815_SpecSheet_12_16_19_original.pdf',
    'control30': 'https://adn.harmanpro.com/site_elements/resources/20872_1584131254/Control%2030%20Spec%20Sheet%20Review_original.pdf',
    'vtx': 'https://adn.harmanpro.com/site_elements/resources/21498_1607531053/VTX%20A12%20Specsheet%20-%205082886-00E_original.pdf',
    'amphion': 'https://amphion.fi/products/one18/',
    'kef_r5meta': 'https://ap.kef.com/products/r5-meta',
}

# (record id, field, expected stored value, source key, new status, sourceType, note)
PROMOTIONS = [
    # DALI OBERON manual: active only. Driver configuration is not in the extracted text (Table 2 not extracted).
    ('dali-oberon-3', 'active', False, 'dali', MANU, 'Manual wiring instructions connect each speaker to an external amplifier (section 4).'),
    ('dali-oberon-5', 'active', False, 'dali', MANU, 'Manual wiring instructions connect each speaker to an external amplifier (section 4).'),
    ('dali-oberon7', 'active', False, 'dali', MANU, 'Manual wiring instructions connect each speaker to an external amplifier (section 4).'),
    # KEF R Series 2018 information sheet, per-model specification columns (R11, R3, R5, R7).
    ('kef-r11', 'driverCount', 6, 'kef_info', MANU, 'Column R11: HF dome + MF cone + 4 x LF 165 mm = 6 drivers.'),
    ('kef-r3', 'driverCount', 3, 'kef_info', MANU, 'Column R3: HF dome + MF cone + 1 x LF 165 mm = 3 drivers.'),
    ('kef-r5', 'driverCount', 4, 'kef_info', MANU, 'Column R5: HF dome + MF cone + 2 x LF 130 mm = 4 drivers.'),
    ('kef-r7', 'driverCount', 4, 'kef_info', MANU, 'Column R7: HF dome + MF cone + 2 x LF 165 mm = 4 drivers.'),
    # EV ZLX user manual (distributor-hosted copy): ZLX-12P and ZLX-15P, technical data and "Powered loudspeakers" heading.
    ('eV-zlx12p', 'driverCount', 2, 'zlx', THIRD, 'Technical data: LF EVS-12K + HF DH-1K = 2 transducers. Distributor-hosted copy of the EV manual.'),
    ('eV-zlx12p', 'active', True, 'zlx', THIRD, 'Section 8.1 heading "Powered loudspeakers". Distributor-hosted copy of the EV manual.'),
    ('eV-zlx15p', 'driverCount', 2, 'zlx', THIRD, 'Technical data: LF EVS-15L + HF DH-1K (HF cell is merged across both models) = 2 transducers. Distributor-hosted copy.'),
    ('eV-zlx15p', 'active', True, 'zlx', THIRD, 'Section 8.1 heading "Powered loudspeakers". Distributor-hosted copy of the EV manual.'),
    # ManualsLib copy of the Sonus faber Homage Tradition owner's manual, page 30 (aggregator-hosted).
    ('sonus-faber-homage-tradition-serafino', 'driverCount', 4, 'serafino', THIRD, 'Technical table SERAFINO 3.5-way: H28 tweeter + M15 midrange + 2 x W18 woofers = 4. Aggregator-hosted copy.'),
    ('sonus-faber-homage-tradition-serafino', 'active', False, 'serafino', THIRD, 'Page header "Homage tradition passive loudspeakers". Aggregator-hosted copy.'),
    ('sonus-faber-homage-tradition-guarneri', 'driverCount', 2, 'serafino', THIRD, 'Technical table GUARNERI 2-way: H28 tweeter + W15 midwoofer = 2. Aggregator-hosted copy.'),
    ('sonus-faber-homage-tradition-guarneri', 'active', False, 'serafino', THIRD, 'Page header "Homage tradition passive loudspeakers". Aggregator-hosted copy.'),
    # ManualsLib copy of the Sonus faber Olympica Nova owner's manual, technical specifications pages 42 and 43.
    ('sonus-faber-olympica-nova-iii', 'driverCount', 4, 'nova42', THIRD, 'Technical table Olympica Nova III: tweeter + midrange + 2 x W18 = 4. Aggregator-hosted copy.'),
    ('sonus-faber-olympica-nova-v', 'driverCount', 5, 'nova42', THIRD, 'Technical table Olympica Nova V: tweeter + midrange + 3 x W18 = 5. Aggregator-hosted copy.'),
    ('sonus-faber-olympica-nova-i', 'driverCount', 2, 'nova43', THIRD, 'Technical table Olympica Nova I: tweeter + midwoofer = 2. Aggregator-hosted copy.'),
    ('sonus-faber-olympica-nova-ii', 'driverCount', 3, 'nova43', THIRD, 'Technical table Olympica Nova II: tweeter + midrange + woofer = 3. Aggregator-hosted copy.'),
    # Mackie CR-X Series quick start guide, technical specification table: built-in Class-D amplifier per model.
    ('mackie-cr3-x', 'active', True, 'mackie', MANU, 'CR3-X spec: "50 watts peak Class D power amplifier" (built-in amplifier).'),
    ('mackie-cr4-x', 'active', True, 'mackie', MANU, 'CR4-X spec: "50 watts peak Class D power amplifier" (built-in amplifier).'),
    ('mackie-cr5-x', 'active', True, 'mackie', MANU, 'CR5-X spec: "80 watts peak Class D power amplifier" (built-in amplifier).'),
    # Library of Congress copy of the JBL 4310 manual: same document as jbl-4310, whose driverCount is already MANUFACTURER_VERIFIED.
    ('legacy-jbl-3', 'driverCount', 3, 'loc4310', MANU, 'Manual text: "three direct-radiator transducers" (12 in LF, 5 in MF, HF direct radiator). Same document as jbl-4310.'),
    # JBL spec sheets (manufacturer asset host).
    ('jbl-srx815', 'driverCount', 2, 'srx815', MANU, 'Spec: LF driver 2275H (one 15 in) + HF driver 2432H (one) = 2.'),
    ('jbl-srx815', 'active', False, 'srx815', MANU, 'Spec: "System Type: Passive 15\\", two-way" and "Operational Modes: Passive/Bi-Amp".'),
    ('jbl-prx815w', 'driverCount', 2, 'prx815', MANU, 'Spec: 1 x JBL 275G (15 in) + 1 x 2408H-2 compression driver = 2. Sheet is headed PRX815; W identity rests on the Wi-Fi control listed in the same sheet.'),
    ('jbl-prx815w', 'active', True, 'prx815', MANU, 'Spec: "Self Powered" and "Power Rating: 1500W (750W x 2)" Class-D amplifier. Sheet headed PRX815; W identity rests on the Wi-Fi control listed in the same sheet.'),
    ('jbl-control-30', 'driverCount', 3, 'control30', MANU, 'Spec: 10 in LF woofer + 5 in MR cone + 1 in HF compression driver = 3.'),
    ('jbl-control-30', 'active', False, 'control30', MANU, 'Spec: "150 Watt transformer for 70V or 100V lines, with 4 ohm thru" (passive line-level speaker).'),
    ('jbl-vtx-a12', 'driverCount', 9, 'vtx', MANU, 'Spec: 2 x 2264H LF + 4 x 2165H MF + 3 x 2423K HF = 9 (text: "nine custom JBL transducers").'),
    ('jbl-vtx-a12', 'active', False, 'vtx', MANU, 'Spec: "System Amplification: Crown I-Tech ..." and "Required Amplifier Channels: (4)" (external amplifiers).'),
    # Amphion One18 product page (manufacturer).
    ('amphion-one18', 'driverCount', 2, 'amphion', MANU, 'Spec: 1 in titanium tweeter + 6.5 in aluminium woofer = 2. Passive radiator is not counted as a driver.'),
    ('amphion-one18', 'active', False, 'amphion', MANU, 'Amp700 block: "perfect partner for all Amphion models and other passive monitors". Operating principle: two-way passive radiator.'),
    # KEF R5 Meta product page (APAC regional manufacturer page).
    ('kef-r5-meta', 'driverCount', 4, 'kef_r5meta', MANU, 'Product page: 12th-gen Uni-Q (HF + MF) + two 5.25 in bass drivers = 4.'),
    ('kef-r5-meta', 'active', False, 'kef_r5meta', MANU, 'Product page feature badge: "Passive HiFi Speaker".'),
]

# Expected count of items to be promoted. Asserted so the batch cannot silently shrink.
EXPECTED_PROMOTIONS = 35

# Demotion: a MANUFACTURER_VERIFIED status cannot sit on a THIRD_PARTY sourceType.
DEMOTIONS = [
    ('lacoustics-arcs-ii', 'driverCount', 'THIRD_PARTY_VERIFIED', 'Round 12: sourceType is THIRD_PARTY (SISME distributor copy). Not manufacturer-verified; demoted to THIRD_PARTY_VERIFIED.'),
    ('lacoustics-arcs-ii', 'active', 'THIRD_PARTY_VERIFIED', 'Round 12: sourceType is THIRD_PARTY (SISME distributor copy). Not manufacturer-verified; demoted to THIRD_PARTY_VERIFIED.'),
]


def main():
    if '--rebuild-status' in sys.argv:
        json.dump(build_status(), open(STATUS, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
        open(STATUS, 'a', encoding='utf-8').write('\n')
        print('queue-url-status.json rebuilt from round-11 baseline plus round-12 results')
        return
    ledger = json.load(open(LEDGER, encoding='utf-8'))
    if any(r.get('marker') == MARKER for r in ledger.get('rounds', [])):
        print(f'{MARKER} already applied; refusing to rerun')
        sys.exit(1)

    raw_db = open(DATA, encoding='utf-8').read()
    db = json.loads(raw_db)
    by_id = {r['id']: r for r in db}
    history = []
    applied = 0

    for rid, field, expected, key, new_status, note in PROMOTIONS:
        r = by_id[rid]
        assert r.get(field) == expected, f'{rid}.{field} value {r.get(field)!r} != expected {expected!r}'
        prov = r[field + 'Provenance']
        assert prov.get('status') == CITED, f'{rid}.{field} status {prov.get("status")} is not {CITED}'
        assert prov.get('source') == U[key], f'{rid}.{field} source {prov.get("source")!r} != {U[key]!r}'
        new_prov = {'status': {MANU: 'MANUFACTURER_VERIFIED', THIRD: 'THIRD_PARTY_VERIFIED'}[new_status],
                    'source': U[key], 'sourceType': new_status, 'note': 'Round 12: ' + note}
        history.append({'id': rid, 'field': field, 'value': r[field], 'before': prov, 'after': new_prov,
                        'round': 12, 'marker': MARKER})
        r[field + 'Provenance'] = new_prov
        applied += 1
    assert applied == EXPECTED_PROMOTIONS, f'promotions {applied} != expected {EXPECTED_PROMOTIONS}'

    for rid, field, new_status, note in DEMOTIONS:
        r = by_id[rid]
        prov = r[field + 'Provenance']
        assert prov.get('status') == 'MANUFACTURER_VERIFIED' and prov.get('sourceType') == 'THIRD_PARTY', (rid, field, prov)
        new_prov = dict(prov, status=new_status, note=note)
        history.append({'id': rid, 'field': field, 'value': r[field], 'before': prov, 'after': new_prov,
                        'round': 12, 'marker': MARKER, 'kind': 'DEMOTION'})
        r[field + 'Provenance'] = new_prov

    # Write speakers.json with the repository's existing formatting.
    with open(DATA, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(db, indent=2, ensure_ascii=False) + '\n')

    json.dump({'marker': MARKER, 'entries': history}, open(HISTORY, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(HISTORY, 'a', encoding='utf-8').write('\n')

    # Directivity lead outcome for Genelec 8331A (inspected this round; not imported).
    leads = json.load(open(LEADS, encoding='utf-8'))
    matched = [lead for lead in leads if lead.get('id') == GENELEC_LEAD_ID]
    assert len(matched) == 1, f'Genelec lead {GENELEC_LEAD_ID!r} not found exactly once'
    for lead in leads:
        if lead.get('id') == GENELEC_LEAD_ID:
            lead['round12Outcome'] = {
                'status': 'INACCESSIBLE_AND_UNSUPPORTED_FORMAT',
                'zenodoRecord': 'https://zenodo.org/records/10255555',
                'recordFetched': 'Zenodo record page opened via fetch tool, 2026-10-12. Lists LS_directivity_Calibrated_GENELEC_8331A.sofa with md5 a00e40164556183420c315e9f6ecd7fd (410.5 MB).',
                'downloadAttempt': 'curl to https://zenodo.org/records/10255555/files/LS_directivity_Calibrated_GENELEC_8331A.sofa?download=1 failed: SSL_ERROR_SYSCALL (HTTP 000). No file bytes obtained, so no local checksum verification.',
                'formatSupport': 'server/directivityParser.ts accepts JSON only. The .sofa extension falls through to "Unsupported directivity file format". Not importable without a new SOFA parser.',
                'import': 'NOT IMPORTED. No substitute file or synthesized polar data.',
            }
    json.dump(leads, open(LEADS, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(LEADS, 'a', encoding='utf-8').write('\n')

    # Ledger: per-source entries and the round record.
    ledger['sources'].extend(LEDGER_SOURCES)
    ledger['rounds'].append({
        'round': 12,
        'marker': MARKER,
        'date': '2026-10-12',
        'fieldsPromoted': applied,
        'fieldsDemoted': len(DEMOTIONS),
        'applied': [f'{rid}.{field} -> {p["status"]}' for (rid, field, *_), p in
                    zip(PROMOTIONS, [h['after'] for h in history[:applied]])],
        'demotions': [f'{rid}.{field} -> {new}' for rid, field, new, _ in DEMOTIONS],
        'notes': [
            'Queue-status file migrated to queue-url-status/v2 with per-field outcomes.',
            'Genelec 8331A SOFA: download blocked in sandbox; format unsupported by parser; not imported.',
            'DALI Oberon driverCount not extracted from the manual text (Table 2 absent); left CITED_IN_NOTES_UNCHECKED.',
        ],
    })
    json.dump(ledger, open(LEDGER, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(LEDGER, 'a', encoding='utf-8').write('\n')

    status = build_status()
    json.dump(status, open(STATUS, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    open(STATUS, 'a', encoding='utf-8').write('\n')
    print(f'{MARKER} applied; promotions={applied} demotions={len(DEMOTIONS)}')


LEDGER_SOURCES = [
    {'url': U['dali'], 'host': 'www.dali-speakers.com', 'document': 'DALI OBERON manual (multi-language)', 'status': 'CHECKED_PARTIAL', 'openedDate': '2026-10-12', 'chunksOpened': [0, 1, 2, 3, 4, 5], 'chunksTotal': 6, 'coverage': 'All chunks opened. Driver configuration table (Table 2) not present in extracted text; only Table 1 (carton contents) is.', 'decisions': ['active False promoted for oberon 3/5/7', 'driverCount left CITED_IN_NOTES_UNCHECKED: not stated in extracted text'], 'queueItemsResolved': 3},
    {'url': U['kef_info'], 'host': 'assets.kef.com', 'document': 'KEF R Series 2018 information sheet', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0, 1], 'chunksTotal': 2, 'coverage': 'Specification tables for R11, R7, R5, R3, R2c, R8a.', 'decisions': ['driverCount promoted for kef-r11/r3/r5/r7', 'active not stated (only "Amplifier power (recommended)")'], 'queueItemsResolved': 4},
    {'url': U['zlx'], 'host': 'www.leone.sk', 'document': 'Electro-Voice ZLX user manual, 2015 revision (ZLX-12P/15P and ZLX-12/15)', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0, 4], 'chunksTotal': 5, 'coverage': 'Technical data and section 8.1 (powered loudspeakers). Distributor-hosted copy: THIRD_PARTY.', 'decisions': ['eV-zlx12p and eV-zlx15p driverCount 2 and active True promoted as THIRD_PARTY_VERIFIED'], 'queueItemsResolved': 4},
    {'url': U['serafino'], 'host': 'www.manualslib.com', 'document': 'Sonus faber Homage Tradition owner manual (ManualsLib copy), technical table page 30', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0, 1], 'chunksTotal': 3, 'coverage': 'Guarneri, Serafino and VOX technical table; "passive loudspeakers" header. Aggregator-hosted: THIRD_PARTY.', 'decisions': ['Serafino and Guarneri driverCount and active promoted as THIRD_PARTY_VERIFIED'], 'queueItemsResolved': 4},
    {'url': U['nova42'], 'host': 'www.manualslib.com', 'document': 'Sonus faber Olympica Nova owner manual (ManualsLib copy), technical specifications page 42', 'status': 'CHECKED_PARTIAL', 'openedDate': '2026-10-12', 'chunksOpened': [0, 1], 'chunksTotal': 4, 'coverage': 'Olympica Nova V and III technical table. No passive/active statement on this page.', 'decisions': ['driverCount promoted for nova-iii (4) and nova-v (5), THIRD_PARTY_VERIFIED', 'active not stated'], 'queueItemsResolved': 2},
    {'url': U['nova43'], 'host': 'www.manualslib.com', 'document': 'Sonus faber Olympica Nova owner manual (ManualsLib copy), technical specifications page 43', 'status': 'CHECKED_PARTIAL', 'openedDate': '2026-10-12', 'chunksOpened': [0, 1], 'chunksTotal': 3, 'coverage': 'Olympica Nova II and I technical table. No passive/active statement on this page.', 'decisions': ['driverCount promoted for nova-i (2) and nova-ii (3), THIRD_PARTY_VERIFIED', 'active not stated'], 'queueItemsResolved': 2},
    {'url': U['mackie'], 'host': 'mackie.com', 'document': 'Mackie CR-X Series quick start guide with shared technical specification table', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0, 1, 3, 5], 'chunksTotal': 6, 'coverage': 'Specification table in chunk 5. Driver configuration is not in the guide; driverCount not promoted for any CR-X model.', 'decisions': ['active True promoted for cr3-x, cr4-x, cr5-x (built-in Class-D amplifier)'], 'queueItemsResolved': 3},
    {'url': U['loc4310'], 'host': 'tile.loc.gov', 'document': 'JBL Professional Series Model 4310 control room monitor manual (Library of Congress copy)', 'status': 'CHECKED_PARTIAL', 'openedDate': '2026-10-12', 'chunksOpened': [0], 'chunksTotal': 2, 'coverage': 'Chunk 0 covers the full manual body text. Passive/active not explicitly stated.', 'decisions': ['legacy-jbl-3 driverCount 3 promoted (same document as jbl-4310)', 'active left open for jbl-4310 and legacy-jbl-3'], 'queueItemsResolved': 1},
    {'url': U['srx815'], 'host': 'adn.harmanpro.com', 'document': 'JBL SRX815 spec sheet (11/11/19)', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0], 'chunksTotal': 1, 'coverage': 'Full sheet.', 'decisions': ['driverCount 2 and active False promoted'], 'queueItemsResolved': 2},
    {'url': U['prx815'], 'host': 'adn.harmanpro.com', 'document': 'JBL PRX815 spec sheet (12/16/19), Wi-Fi model per record notes', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0], 'chunksTotal': 1, 'coverage': 'Full sheet. Sheet heading is PRX815; the PRX815W identity rests on the Wi-Fi control feature in the same sheet.', 'decisions': ['driverCount 2 and active True promoted for jbl-prx815w (identity caveat recorded)'], 'queueItemsResolved': 2},
    {'url': U['control30'], 'host': 'adn.harmanpro.com', 'document': 'JBL Control 30 spec sheet (Version B, 2020)', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0], 'chunksTotal': 4, 'coverage': 'Features, specifications and first measurement tables.', 'decisions': ['driverCount 3 and active False promoted'], 'queueItemsResolved': 2},
    {'url': U['vtx'], 'host': 'adn.harmanpro.com', 'document': 'JBL VTX A12 spec sheet (version E)', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0], 'chunksTotal': 2, 'coverage': 'Features, technical specifications, transducer list.', 'decisions': ['driverCount 9 and active False promoted'], 'queueItemsResolved': 2},
    {'url': U['amphion'], 'host': 'amphion.fi', 'document': 'Amphion One18 product page with specifications', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0, 1], 'chunksTotal': 2, 'coverage': 'Specification table and product copy.', 'decisions': ['driverCount 2 and active False promoted (active evidence: "passive monitors" statement in Amp700 block)'], 'queueItemsResolved': 2},
    {'url': U['kef_r5meta'], 'host': 'ap.kef.com', 'document': 'KEF R5 Meta product page (APAC region page)', 'status': 'CHECKED_CONFIRMED', 'openedDate': '2026-10-12', 'chunksOpened': [0, 2, 3], 'chunksTotal': 6, 'coverage': 'Product copy, feature badges ("Passive HiFi Speaker"), and specification table.', 'decisions': ['driverCount 4 and active False promoted'], 'queueItemsResolved': 2},
]


# Per-URL status file, version 2. Round-11 results are migrated with per-field outcomes.
PROMOTED = 'PROMOTED'
SUPPORTED_NOT_PROMOTED = 'SUPPORTED_NOT_PROMOTED'
NOT_STATED = 'NOT_STATED'
NOT_EXTRACTED = 'NOT_EXTRACTED'


def build_status():
    def fr(record, field, value, outcome, note=''):
        return {'record': record, 'field': field, 'value': value, 'outcome': outcome, 'note': note}

    urls = [
        {'url': 'https://jblpro.com/en-US/site_elements/4430-and-4435-information', 'round': 11, 'status': 'CHECKED_PARTIAL', 'chunksOpened': [0], 'checkedDate': '2026-10-12',
         'evidence': 'Spec table: 4430 = one LF driver + one compression driver. Active/passive not stated.',
         'fieldResults': [fr('jbl-4430', 'driverCount', 2, PROMOTED), fr('legacy-jbl-6', 'driverCount', 2, PROMOTED),
                          fr('jbl-4430', 'active', False, NOT_STATED), fr('legacy-jbl-6', 'active', False, NOT_STATED)]},
        {'url': 'https://www.bang-olufsen.com/en/us/comparison/products?slug=speakers&p1=beosound-a5&p2=beosound-level&p3=beolit-20', 'round': 11, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0], 'checkedDate': '2026-10-12',
         'evidence': 'A5: 4 drivers, class-D amplifier per driver. Level: 5 drivers, class-D amplifiers.',
         'fieldResults': [fr('bang-olufsen-beosound-a5', 'driverCount', 4, PROMOTED), fr('bang-olufsen-beosound-a5', 'active', True, PROMOTED),
                          fr('bang-olufsen-beosound-level', 'driverCount', 5, PROMOTED), fr('bang-olufsen-beosound-level', 'active', True, PROMOTED)]},
        {'url': U['dali'], 'round': 12, 'status': 'CHECKED_PARTIAL', 'chunksOpened': [0, 1, 2, 3, 4, 5], 'checkedDate': '2026-10-12',
         'evidence': 'Wiring to external amplifier (section 4). Driver configuration (Table 2) absent from extracted text.',
         'fieldResults': [fr('dali-oberon-3', 'active', False, PROMOTED), fr('dali-oberon-5', 'active', False, PROMOTED), fr('dali-oberon7', 'active', False, PROMOTED),
                          fr('dali-oberon-3', 'driverCount', 2, NOT_EXTRACTED, 'Table 2 not in extracted text; retry needed'),
                          fr('dali-oberon-5', 'driverCount', 3, NOT_EXTRACTED, 'Table 2 not in extracted text; retry needed'),
                          fr('dali-oberon7', 'driverCount', 3, NOT_EXTRACTED, 'Table 2 not in extracted text; retry needed')]},
        {'url': U['kef_info'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0, 1], 'checkedDate': '2026-10-12',
         'evidence': 'Per-model specification columns for R11, R7, R5, R3, R2c, R8a. All queue items for this URL are promoted. kef-r* active values are null with no provenance (not queue items) and the sheet does not state active/passive.',
         'fieldResults': [fr('kef-r11', 'driverCount', 6, PROMOTED), fr('kef-r3', 'driverCount', 3, PROMOTED), fr('kef-r5', 'driverCount', 4, PROMOTED), fr('kef-r7', 'driverCount', 4, PROMOTED),



]},
        {'url': U['zlx'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0, 4], 'checkedDate': '2026-10-12',
         'evidence': 'ZLX-12P/15P technical data (LF + HF DH-1K) and "Powered loudspeakers" section 8.1. Distributor-hosted: THIRD_PARTY.',
         'fieldResults': [fr('eV-zlx12p', 'driverCount', 2, SUPPORTED_NOT_PROMOTED), fr('eV-zlx12p', 'active', True, SUPPORTED_NOT_PROMOTED),
                          fr('eV-zlx15p', 'driverCount', 2, SUPPORTED_NOT_PROMOTED), fr('eV-zlx15p', 'active', True, SUPPORTED_NOT_PROMOTED)]},
        {'url': U['serafino'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0, 1], 'checkedDate': '2026-10-12',
         'evidence': 'Technical table Guarneri / Serafino / VOX; header "Homage tradition passive loudspeakers". Aggregator-hosted: THIRD_PARTY.',
         'fieldResults': [fr('sonus-faber-homage-tradition-serafino', 'driverCount', 4, SUPPORTED_NOT_PROMOTED), fr('sonus-faber-homage-tradition-serafino', 'active', False, SUPPORTED_NOT_PROMOTED),
                          fr('sonus-faber-homage-tradition-guarneri', 'driverCount', 2, SUPPORTED_NOT_PROMOTED), fr('sonus-faber-homage-tradition-guarneri', 'active', False, SUPPORTED_NOT_PROMOTED)]},
        {'url': U['nova42'], 'round': 12, 'status': 'CHECKED_PARTIAL', 'chunksOpened': [0, 1], 'checkedDate': '2026-10-12',
         'evidence': 'Olympica Nova V and III technical table. No passive/active statement on this page. Aggregator-hosted: THIRD_PARTY.',
         'fieldResults': [fr('sonus-faber-olympica-nova-iii', 'driverCount', 4, SUPPORTED_NOT_PROMOTED), fr('sonus-faber-olympica-nova-v', 'driverCount', 5, SUPPORTED_NOT_PROMOTED),
                          fr('sonus-faber-olympica-nova-iii', 'active', False, NOT_STATED), fr('sonus-faber-olympica-nova-v', 'active', False, NOT_STATED)]},
        {'url': U['nova43'], 'round': 12, 'status': 'CHECKED_PARTIAL', 'chunksOpened': [0, 1], 'checkedDate': '2026-10-12',
         'evidence': 'Olympica Nova II and I technical table. No passive/active statement on this page. Aggregator-hosted: THIRD_PARTY.',
         'fieldResults': [fr('sonus-faber-olympica-nova-i', 'driverCount', 2, SUPPORTED_NOT_PROMOTED), fr('sonus-faber-olympica-nova-ii', 'driverCount', 3, SUPPORTED_NOT_PROMOTED),
                          fr('sonus-faber-olympica-nova-i', 'active', False, NOT_STATED), fr('sonus-faber-olympica-nova-ii', 'active', False, NOT_STATED)]},
        {'url': U['mackie'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0, 1, 3, 5], 'checkedDate': '2026-10-12',
         'evidence': 'Spec table: CR3-X / CR4-X / CR5-X each list a built-in Class-D amplifier. No driver configuration in the guide.',
         'fieldResults': [fr('mackie-cr3-x', 'active', True, PROMOTED), fr('mackie-cr4-x', 'active', True, PROMOTED), fr('mackie-cr5-x', 'active', True, PROMOTED)]},
        {'url': U['loc4310'], 'round': 12, 'status': 'CHECKED_PARTIAL', 'chunksOpened': [0], 'checkedDate': '2026-10-12',
         'evidence': '"three direct-radiator transducers"; 12 in LF, 5 in MF, HF direct radiator. Passive/active not stated.',
         'fieldResults': [fr('legacy-jbl-3', 'driverCount', 3, PROMOTED), fr('jbl-4310', 'active', False, NOT_STATED), fr('legacy-jbl-3', 'active', False, NOT_STATED)]},
        {'url': U['srx815'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0], 'checkedDate': '2026-10-12',
         'evidence': '"System Type: Passive 15\\", two-way"; LF 2275H and HF 2432H.',
         'fieldResults': [fr('jbl-srx815', 'driverCount', 2, PROMOTED), fr('jbl-srx815', 'active', False, PROMOTED)]},
        {'url': U['prx815'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0], 'checkedDate': '2026-10-12',
         'evidence': '"Self Powered"; 1500 W Class-D; one 15 in woofer + one compression driver. Sheet headed PRX815; W identity via Wi-Fi control.',
         'fieldResults': [fr('jbl-prx815w', 'driverCount', 2, PROMOTED), fr('jbl-prx815w', 'active', True, PROMOTED)]},
        {'url': U['control30'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0], 'checkedDate': '2026-10-12',
         'evidence': 'LF 10 in + MR 5 in + HF 1 in; 150 W transformer for 70V/100V lines.',
         'fieldResults': [fr('jbl-control-30', 'driverCount', 3, PROMOTED), fr('jbl-control-30', 'active', False, PROMOTED)]},
        {'url': U['vtx'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0], 'checkedDate': '2026-10-12',
         'evidence': 'Nine transducers (2 LF, 4 MF, 3 HF). "Required Amplifier Channels: (4)", Crown I-Tech external amplification.',
         'fieldResults': [fr('jbl-vtx-a12', 'driverCount', 9, PROMOTED), fr('jbl-vtx-a12', 'active', False, PROMOTED)]},
        {'url': U['amphion'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0, 1], 'checkedDate': '2026-10-12',
         'evidence': '1 in tweeter + 6.5 in woofer; "passive monitors" in Amp700 block.',
         'fieldResults': [fr('amphion-one18', 'driverCount', 2, PROMOTED), fr('amphion-one18', 'active', False, PROMOTED)]},
        {'url': U['kef_r5meta'], 'round': 12, 'status': 'CHECKED_CONFIRMED', 'chunksOpened': [0, 2, 3], 'checkedDate': '2026-10-12',
         'evidence': 'Feature badge "Passive HiFi Speaker"; 12th-gen Uni-Q + two 5.25 in bass drivers.',
         'fieldResults': [fr('kef-r5-meta', 'driverCount', 4, PROMOTED), fr('kef-r5-meta', 'active', False, PROMOTED)]},
    ]
    return {
        'schema': 'queue-url-status/v2',
        'generatedFrom': 'scripts/research/apply-round12-queue-batch.py (rounds 11 and 12)',
        'vocabulary': {
            'CHECKED_CONFIRMED': 'Opened. Supports the listed field values for the exact model.',
            'CHECKED_PARTIAL': 'Opened. Supports some fields or models only. Remaining items stay open.',
            'CHECKED_REJECTED': 'Opened. Does not support the held values. Values cleared to null.',
            'CONFLICT': 'Opened, but sources or readings disagree. Values stay unchanged and the conflict is recorded.',
            'INACCESSIBLE': 'Could not be opened from the sandbox. Nothing is inferred from it.',
            'OPEN': 'Not yet opened (equivalent to NOT_CHECKED in the round-12 brief).',
        },
        'fieldOutcomeVocabulary': {
            PROMOTED: 'Source states the value for the exact model; provenance promoted.',
            NOT_STATED: 'Source opened; it does not state this field. Stays CITED_IN_NOTES_UNCHECKED.',
            NOT_EXTRACTED: 'Source opened; the page containing the field did not extract to text. Stays open; retry.',
            SUPPORTED_NOT_PROMOTED: 'Source opened and supports the value, but the copy is distributor- or aggregator-hosted. '
                                    'driverCount/active allow only MANUFACTURER_VERIFIED, so the field stays '
                                    'CITED_IN_NOTES_UNCHECKED until the manufacturer host copy is checked (round 12b).',
        },
        'urls': merge_with_baseline(urls),
    }


BASELINE = os.path.join(HERE, 'queue-url-status.round11.json')
STATUS_MAP = {'NOT_CHECKED': 'OPEN'}


def merge_with_baseline(new_urls):
    """Every round-11 URL is kept. Checked entries keep their prior snapshot in history."""
    base = json.load(open(BASELINE, encoding='utf-8'))['urls']
    new_by_url = {u['url']: u for u in new_urls}
    base_urls = {b['url'] for b in base}
    assert set(new_by_url) <= base_urls, 'round-12 entry not in the round-11 baseline'
    merged = []
    for b in base:
        prior_status = b.get('status')
        if b['url'] in new_by_url:
            e = dict(new_by_url[b['url']])
            e['history'] = [{'migratedFrom': 'queue-url-status.round11.json (round 11, committed in 9fb069a)', 'entry': b}]
        else:
            e = {'url': b['url'], 'status': STATUS_MAP.get(prior_status, prior_status),
                 'round': None, 'checkedDate': b.get('checkedDate'), 'chunksOpened': b.get('chunksOpened', []),
                 'evidence': b.get('evidence', ''), 'fieldResults': []}
            if prior_status != 'NOT_CHECKED':
                e['history'] = [{'migratedFrom': 'queue-url-status.round11.json (round 11, committed in 9fb069a)', 'entry': b}]
        merged.append(e)
    return merged


if __name__ == '__main__':
    main()
