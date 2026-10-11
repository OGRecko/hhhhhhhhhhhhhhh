import json
p = 'scripts/research/round5-queue-checks.json'
q = json.load(open(p, encoding='utf-8'))
q['checked'] += [
 {"id": "electro-voice-zx3", "url": "https://www.eviaudio.fr/wp-content/uploads/2020/04/ev_zx3_manuel.pdf",
  "structural": "driverCount 2 and active false recorded (manual: 'Passive and biamp selectable').",
  "acoustic": "Manual spec table (97 dB axial, 8 ohm nominal, 6.2 ohm minimum, 58 Hz-15 kHz, 600 W passive) covers BOTH Zx3-60 and Zx3-90 with variant-specific response curves. The generic ZX3 record has no variant, so no acoustic values were assigned (owner decision: exact variant match only).",
  "queue": "Remains UNVERIFIED for acoustic fields until the record is split to exact variants (owner decision)."},
 {"id": "electro-voice-zx5", "url": "https://www.adorama.com/col/productManuals/EVZX560B.pdf",
  "structural": "Not recorded.",
  "acoustic": "The only manual found is a retailer-hosted copy with OCR artifacts and unrelated text (e.g. 'Manufacturer: Blasenheim'). Not authenticated, so not used.",
  "queue": "Remains UNVERIFIED: no authenticated official ZX5 manual reached."},
 {"id": "pmc-tb2", "url": "https://pmc-speakers.com/products/archive/archive/tb2plus/",
  "structural": "Not recorded.",
  "acoustic": "The reachable PMC page is the TB2+ (a different revision: 90 dB, 8 ohm, 170 mm LF, 27 mm HF, 3 kHz crossover, 8.5 kg). Not transferred to the TB2 record.",
  "queue": "Remains UNVERIFIED: no TB2 (non-plus) page reached."},
 {"id": "tannoy-autograph", "url": "https://www.tannoy.com/products/autograph",
  "structural": "Not recorded.",
  "acoustic": "Guessed URL returned 404. The record has no recorded source.",
  "queue": "Remains UNVERIFIED: needs a working manufacturer URL."},
 {"id": "morel-maximo-ultra-602", "url": "https://www.morelhifi.com/maximo-ultra-602",
  "structural": "Not recorded.",
  "acoustic": "Guessed URL returned a 404 page.",
  "queue": "Remains UNVERIFIED: needs the correct manufacturer product URL."},
 {"id": "apogee-scintilla", "url": "https://www.apogee-acoustics.com/products/scintilla",
  "structural": "Not recorded.",
  "acoustic": "Fetch failed.",
  "queue": "Remains UNVERIFIED: retry needed with a verified URL."},
]
q['note_on_queue_count'] = ("Round 5: electro-voice-zx3 gained structural provenance (driverCount, active). "
  "Its acoustic values are variant-specific and were not assigned. The queue count stays at 35 because "
  "overallStatus is derived from acoustic fields only.")
json.dump(q, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('queue notes updated')
