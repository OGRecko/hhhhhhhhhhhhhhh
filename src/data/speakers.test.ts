/**
 * Speaker database integrity tests.
 *
 * Guards the merged/additive database against silent regressions:
 * accidental rebuilds, dropped legacy records, reintroduced duplicates, and
 * reverted manufacturer spec corrections.
 *
 * Run with:  npx tsx src/data/speakers.test.ts
 */

import speakers from "./speakers.json";
import unresolvedNotes from "../../scripts/research/unresolved-notes.json";
import removedRecords from "../../scripts/research/removed-records.json";
import removedUnavailable from "../../scripts/research/removed-unavailable-records.json";
import removedOwnerRound5 from "../../scripts/research/removed-owner-round5-records.json";
import directivityLeads from "../../scripts/research/directivity-leads.json";
import nodeAssert from "node:assert/strict";
import { resolveSensitivity } from "../lib/speakerResponse";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: any) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

const db = speakers as any[];
// Live dataset plus the archived UNAVAILABLE records (removed 2026-10-10 at owner request); used only for lookups of archived IDs.
// Round 5 (owner decision 2026-10-11) archived consumer records and the generic Zx3 record are included for lookups.
const allDb = [...db, ...((removedUnavailable as any).records as any[]), ...((removedOwnerRound5 as any).records as any[])];
// Notes ledger for live and archived UNAVAILABLE records (archived ledger entries are kept in the removal archive).
const unresolvedAll: Record<string, any> = { ...(unresolvedNotes as Record<string, any>), ...((removedUnavailable as any).unresolvedNotes as Record<string, any>) };
const removalLog = removedRecords as { reviewDate: string; entries: Array<{ id: string; brand: string; model: string; statusBeforeRemoval: string; disposition: string; reason: string; sourceRefs: string[]; researchNote: string; restored: boolean }> };
const removedById = new Map(removalLog.entries.map((entry) => [entry.id, entry]));
function assertPreservedUnavailable(id: string) {
  const entry = removedById.get(id);
  const record = allDb.find((item) => item.id === id);
  assert(entry, `${id} must retain its individual historical research record`);
  assert(record, `${id} must remain in the preserved catalog`);
  nodeAssert.equal(entry.statusBeforeRemoval, "UNAVAILABLE", `${id} must have been reviewed as unavailable`);
  nodeAssert.equal(entry.restored, true, `${id} must be marked restored from the 774-record source archive`);
  nodeAssert.equal(record.overallStatus, "UNAVAILABLE", `${id} must remain excluded from verified speaker data`);
  nodeAssert.equal(record.brand, entry.brand);
  nodeAssert.equal(record.model, entry.model);
  assert(entry.reason.length > 20, `${id} needs an explicit identity rationale`);
  assert(entry.researchNote.length > 20, `${id} must retain the diligence notes reviewed before restoration`);
  assert(entry.sourceRefs.length > 0, `${id} must retain links to relevant source/search evidence`);
  for (const field of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"] as const) {
    nodeAssert.equal(record[field]?.value ?? null, null, `${id}.${field} must remain N/A`);
    nodeAssert.equal(record[field]?.source ?? null, null, `${id}.${field} must not claim unsupported provenance`);
  }
  nodeAssert.equal(record.frequencyResponse?.low_hz ?? null, null);
  nodeAssert.equal(record.frequencyResponse?.high_hz ?? null, null);
  nodeAssert.equal(record.frequencyResponse?.source ?? null, null);
  nodeAssert.equal(record.notes, (unresolvedAll as Record<string, any>)[id]?.note);
}

console.log("\n=== Speaker database integrity ===\n");

check("total record count matches the reviewed dataset", () => {
  assert(Array.isArray(db), "speakers.json is not an array");
  // Owner decision (round 5, 2026-10-11): 24 records archived (23 consumer records without published acoustic specs
  // and the generic Zx3 record); the Zx3 record is replaced by two exact variants (+2). 693 - 24 + 2 = 671.
  assert(db.length === 669, `expected 669 live records after the 2026-10-12 owner decisions, found ${db.length}`);
  assert((removedUnavailable as any).records.length === 81, "archive must hold the 81 removed UNAVAILABLE records");
  // Owner answers (2026-10-12): legacy-la-1 V-DOSC and legacy-la-2 ARCS archived (no exact source); ARCS II added live.
  // Live: 671 - 2 + 1 - 1 = 669 (focal-sopra2 duplicate archived 2026-10-12). Archive: 24 + 3 = 27. Total: 669 + 81 + 27 = 777.
  nodeAssert.equal((removedOwnerRound5 as any).records.length, 27, "round 5 archive must hold the 24 removed records plus the V-DOSC, ARCS and focal-sopra2 addenda");
  assert(db.length + (removedUnavailable as any).records.length + (removedOwnerRound5 as any).records.length === 777, "live plus archived records must total the 777 reviewed records");
});

check("overall status follows sourced fields or an audited unresolved-identity disposition", () => {
  const physical = ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"] as const;
  // Live ledger only: archived UNAVAILABLE records are checked separately in the archive assertions.
  const unresolvedIds = Object.keys(unresolvedNotes as Record<string, any>).sort();
  const hasSourceBackedField = (s: (typeof db)[number]) =>
    physical.some((f) => s[f]?.value !== null && s[f]?.value !== undefined) ||
    Number.isFinite(s.frequencyResponse?.low_hz) || Number.isFinite(s.frequencyResponse?.high_hz);
  for (const s of db) {
    assert(s.overallStatus !== "LEGACY", `${s.id} must not use LEGACY status`);
    const expected = hasSourceBackedField(s) ? "PARTIALLY_VERIFIED"
      : unresolvedIds.includes(s.id) ? "UNAVAILABLE" : "UNVERIFIED";
    assert(s.overallStatus === expected, `${s.id}: status ${s.overallStatus} but its fields/identity ledger imply ${expected}`);
  }
  const unavailableIds = db.filter((s) => s.overallStatus === "UNAVAILABLE").map((s) => s.id).sort();
  nodeAssert.deepEqual(unavailableIds, unresolvedIds, "every unresolved identity must remain present with an auditable UNAVAILABLE disposition");
  for (const id of unavailableIds) {
    const record = allDb.find((s) => s.id === id);
    const note = (unresolvedAll as Record<string, any>)[id];
    assert(record, `${id} unavailable record must remain in the database`);
    nodeAssert.equal(note.status, "UNAVAILABLE");
    assert(typeof note.note === "string" && note.note.length > 80, `${id} needs an individual diligence note`);
    assert(Array.isArray(note.sources) && note.sources.length > 0, `${id} needs source/search references`);
    assert(record.notes === note.note, `${id} dataset and unresolved ledger notes must agree`);
    for (const field of physical) {
      nodeAssert.equal(record[field]?.value ?? null, null, `${id}.${field} cannot carry unsupported values`);
      nodeAssert.equal(record[field]?.source ?? null, null, `${id}.${field} cannot claim unsupported provenance`);
    }
    nodeAssert.equal(record.frequencyResponse?.low_hz ?? null, null, `${id} cannot carry unsupported response bounds`);
    nodeAssert.equal(record.frequencyResponse?.high_hz ?? null, null, `${id} cannot carry unsupported response bounds`);
    nodeAssert.equal(record.frequencyResponse?.source ?? null, null, `${id} cannot claim unsupported response provenance`);
  }
});

check("diligently reviewed unavailable records remain present with an auditable research trail", () => {
  nodeAssert.equal(removalLog.reviewDate, "2026-10-08");
  nodeAssert.equal(removalLog.entries.length, 35);
  const ids = removalLog.entries.map((entry) => entry.id);
  nodeAssert.equal(new Set(ids).size, ids.length, "removal manifest must not duplicate IDs");
  for (const id of ids) assertPreservedUnavailable(id);
  assertPreservedUnavailable("legacy-sonos-1");
  nodeAssert.equal(removedById.get("legacy-sonos-1")?.disposition, "non-speaker-component");
  assertPreservedUnavailable("legacy-focal-7");
  nodeAssert.equal(removedById.get("legacy-focal-7")?.disposition, "duplicate-alias");
  assertPreservedUnavailable("legacy-jbl-2");
  nodeAssert.equal(removedById.get("legacy-jbl-2")?.disposition, "duplicate-alias");
  assertPreservedUnavailable("rcf-art312a");
  nodeAssert.equal(removedById.get("rcf-art312a")?.disposition, "unconfirmed-identity");
  nodeAssert.match(removedById.get("rcf-art312a")?.reason ?? "", /ART 312-A MK5/);
  nodeAssert.match(removedById.get("rcf-art312a")?.researchNote ?? "", /no specifications from MKIII or MK4 are transferred/i);
  assertPreservedUnavailable("pioneer-ts-a1607f");
  nodeAssert.equal(removedById.get("pioneer-ts-a1607f")?.disposition, "unconfirmed-identity");
  nodeAssert.match(removedById.get("pioneer-ts-a1607f")?.researchNote ?? "", /exact TS-A1607F/);
  nodeAssert.match(removedById.get("pioneer-ts-a1607f")?.researchNote ?? "", /no TS-A1670F or other sibling specifications are transferred/i);
  assertPreservedUnavailable("eV-live-x2");
  nodeAssert.equal(removedById.get("eV-live-x2")?.disposition, "unconfirmed-identity");
  nodeAssert.match(removedById.get("eV-live-x2")?.researchNote ?? "", /does not identify a product named “Live X X2\.”/i);
  nodeAssert.match(removedById.get("eV-live-x2")?.researchNote ?? "", /No ELX112\/115\/118\/215 or other sibling specifications are transferred/);
  assertPreservedUnavailable("jl-audio-c7-650");
  nodeAssert.equal(removedById.get("jl-audio-c7-650")?.disposition, "unconfirmed-identity");
  nodeAssert.match(removedById.get("jl-audio-c7-650")?.researchNote ?? "", /C7-650cw/);
  nodeAssert.match(removedById.get("jl-audio-c7-650")?.researchNote ?? "", /no C7-650cw measurements\/specifications are assigned/);
  assertPreservedUnavailable("focal-shape-80");
  nodeAssert.equal(removedById.get("focal-shape-80")?.disposition, "unconfirmed-identity");
  nodeAssert.match(removedById.get("focal-shape-80")?.researchNote ?? "", /every chunk of Focal.* official Shape manual/i);
  nodeAssert.match(removedById.get("focal-shape-80")?.researchNote ?? "", /no Alpha 80 specifications are transferred/i);
  for (const id of ["monitor-audio-creator-q50", "monitor-audio-creator-q250"]) {
    assertPreservedUnavailable(id);
    nodeAssert.equal(removedById.get(id)?.disposition, "unconfirmed-identity");
    nodeAssert.match(removedById.get(id)?.researchNote ?? "", /the similar Q50a|the similar Q250c/i);
    nodeAssert.match(removedById.get(id)?.researchNote ?? "", /no .*specifications are transferred|no KEF specifications are transferred/i);
  }
});

check("Sonos structural facts use exact manufacturer sources without invented acoustic specs", () => {
  const cases = [
    { id: "sonos-one", drivers: 2, active: true, source: "https://www.sonos.com/en-us/guides/one" },
    { id: "sonos-five", drivers: 6, active: true, source: "https://www.sonos.com/en-us/guides/five" },
    { id: "sonos-arc", drivers: 11, active: true, source: "https://www.sonos.com/en-us/guides/arc" },
    { id: "sonos-beam", drivers: 5, active: true, source: "https://www.sonos.com/en-us/guides/beam" },
    { id: "sonos-play1", drivers: 2, active: null, source: "https://newsroom.sonos.com/254814-introducing-sonos-play-1/" },
    { id: "sonos-play3", drivers: 3, active: true, source: "https://newsroom.sonos.com/254858-forget-everything-you-ve-heard-before-introducing-the-sonos-play-3/" },
    { id: "legacy-sonos-5", drivers: 2, active: true, source: "https://www.sonos.com/en-us/guides/move" },
    { id: "sonos-sonos-era-100", drivers: 3, active: true, source: "https://www.sonos.com/en-us/guides/era100" },
    { id: "sonos-sonos-era-300", drivers: 6, active: true, source: "https://www.sonos.com/en-us/guides/era300" },
    { id: "sonos-sonos-move-2", drivers: 3, active: true, source: "https://www.sonos.com/en-us/guides/move2" },
    { id: "sonos-sonos-roam-2", drivers: 2, active: true, source: "https://www.sonos.com/en-us/guides/roam2" },
    { id: "sonos-sonos-arc-ultra", drivers: 14, active: true, source: "https://www.sonos.com/en-us/guides/arcultra" },
    { id: "sonos-sonos-ray", drivers: 4, active: true, source: "https://www.sonos.com/en-us/guides/ray" },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.driverCount, c.drivers, `${c.id} driver count`);
    nodeAssert.equal(s.active, c.active, `${c.id} powered/active status`);
    assert(String(s.notes).includes(c.source), `${c.id} must retain its exact source in notes`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}.${f} must remain N/A without an exact published value`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null, `${c.id} must not inherit a response cutoff`);
    nodeAssert.equal(s.frequencyResponse.high_hz, null, `${c.id} must not inherit a response cutoff`);
  }

  const subMini = allDb.find((s) => s.id === "sonos-sub-mini");
  assert(subMini, "sonos-sub-mini must remain in the database");
  nodeAssert.equal(subMini.woofer.value, 6);
  nodeAssert.equal(subMini.woofer.unit, "in");
  nodeAssert.equal(subMini.woofer.source, "https://www.sonos.com/en-us/guides/submini");
  nodeAssert.equal(subMini.driverCount, 2);
  nodeAssert.equal(subMini.active, true);
  nodeAssert.equal(subMini.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(subMini.frequencyResponse.low_hz, null, "‘plays down to 25 Hz’ is not treated as a standardized response limit");
  nodeAssert.match(subMini.notes, /no structured frequency-response bound is entered/i);

  for (const id of ["sonos-play5", "sonos-sonos-beam", "legacy-sonos-1"]) assertPreservedUnavailable(id);
  nodeAssert.match(removedById.get("sonos-play5")?.reason ?? "", /Gen 1 or Gen 2/);
  nodeAssert.match(removedById.get("sonos-sonos-beam")?.reason ?? "", /Gen 1 or Gen 2/);
  nodeAssert.equal(removedById.get("legacy-sonos-1")?.disposition, "non-speaker-component");
});

check("Bose structural facts retain exact manufacturer sources without invented acoustics", () => {
  const cases = [
    { id: "bose-bose-home-speaker-500", drivers: 2, active: null, source: "https://www.bose.com/pressroom/bose-introduces-new-smart-speaker-and-soundbars" },
    { id: "bose-bose-home-speaker-300", drivers: null, active: true, source: "https://assets.bosecreative.com/m/29dd39b1091ed23f/original/830857_OG_HS300-SPEAKERWIRELESS_enUS.pdf" },
    { id: "bose-bose-portable-smart-speaker", drivers: 1, active: null, source: "https://www.bose.com/p/speakers/bose-portable-smart-speaker/PORTSS-SPEAKERWIRELESS.html" },
    { id: "bose-bose-soundlink-flex", drivers: 1, active: null, source: "https://www.bose.com/pressroom/soundlink-flex-bluetooth-speaker" },
    { id: "bose-bose-soundlink-max", drivers: 3, active: null, source: "https://www.bose.com/pressroom/bose-soundlink-max" },
    { id: "bose-bose-smart-ultra-soundbar", drivers: 9, active: null, source: "https://www.bose.com/p/home-theater/bose-smart-ultra-soundbar/SUSB-SOUNDBAR.html" },
    { id: "bose-bose-smart-soundbar", drivers: 5, active: null, source: "https://www.bose.com/pressroom/bose-smart-soundbar-and-personal-surround-sound" },
    { id: "bose-bose-tv-speaker", drivers: 3, active: null, source: "https://www.bose.com/p/home-theater/bose-tv-speaker/TVSPKR-SOUNDBAR.html" },
    { id: "bose-wave-music-system", drivers: 2, active: null, source: "https://assets.bosecreative.com/m/deb85fef843b3c2/original/AM745087_OG_WMSIV-SPEAKERWAVE_enUS.pdf" },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "UNVERIFIED", `${c.id} structural facts alone do not verify simulation inputs`);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.active, c.active);
    assert(String(s.notes).includes(c.source), `${c.id} must retain its exact manufacturer source in notes`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}.${f} must remain N/A without an exact published value`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null, `${c.id} must not inherit a response cutoff`);
    nodeAssert.equal(s.frequencyResponse.high_hz, null, `${c.id} must not inherit a response cutoff`);
  }

  assertPreservedUnavailable("bose-lifestyle-cube");
  nodeAssert.match(removedById.get("bose-lifestyle-cube")?.reason ?? "", /generic component\/type label/);
  assert(removedById.get("bose-lifestyle-cube")?.sourceRefs.includes("https://products.bose.com/pdf/customer_service/owners/ls18ii_ls28ii_ls38_ls48_install.pdf"));
});

check("Bowers & Wilkins exact-model sources preserve published limits and unsupported N/A fields", () => {
  const cases = [
    {
      id: "bw-802d3",
      source: "https://www.bowerswilkins.com/on/demandware.static/-/Library-Sites-bowers_northamerica_shared/default/dw7f94b222/archive-manuals/802-d3-info-sheet.pdf",
      drivers: 4,
      active: null,
      woofer: 8,
      low: 17,
      high: 28000,
      sensitivity: 90,
      impedance: 8,
    },
    {
      id: "legacy-bw-7",
      source: "https://www.bowerswilkins.com/on/demandware.static/-/Library-Sites-bowers_apac_shared/default/dw49334432/archive-manuals/800-d3-info-sheet.pdf",
      drivers: 4,
      active: null,
      woofer: 10,
      low: 15,
      high: 28000,
      sensitivity: 90,
      impedance: 8,
    },
    {
      id: "bowers-wilkins-formation-flex",
      source: "https://www.bowerswilkins.com/en/product/archive-speakers/formation-flex/FP41343P.html",
      drivers: 2,
      active: true,
      woofer: 4,
      low: 50,
      high: 28000,
      sensitivity: null,
      impedance: null,
    },
    {
      id: "bowers-wilkins-formation-wedge",
      source: "https://www.bowerswilkins.com/en/product/archive/formation-wedge/FP40664P.html",
      drivers: 5,
      active: true,
      woofer: 6,
      low: 35,
      high: 28000,
      sensitivity: null,
      impedance: null,
    },
    {
      id: "bowers-wilkins-asw610",
      source: "https://www.bowerswilkins.com/en-us/product/subwoofers/asw-series/asw610/150059.html",
      drivers: 1,
      active: true,
      woofer: 10,
      low: 27,
      high: null,
      sensitivity: null,
      impedance: null,
    },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.active, c.active);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.woofer.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    assert(String(s.notes).includes(c.source), `${c.id} notes must retain the exact product/revision source`);
    assert(!Array.isArray(s.frequencyResponse.points), `${c.id} must not get an unpublished response curve`);
    nodeAssert.equal(s.power.value, null, `${c.id} must not receive an unsupported scalar power value`);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);

    if (c.sensitivity !== null) {
      nodeAssert.equal(s.sensitivity.value, c.sensitivity);
      nodeAssert.equal(s.sensitivity.source, c.source);
      nodeAssert.equal(s.sensitivity.reference, "2.83Vrms on-axis; measurement distance not stated");
      nodeAssert.equal(s.impedance.value, c.impedance);
      nodeAssert.equal(s.impedance.source, c.source);
      const resolved = resolveSensitivity(s);
      nodeAssert.equal(resolved.isFallback, true, "distance-unspecified voltage sensitivity must not be normalized as 1W/1m");
      nodeAssert.equal(resolved.valueDb, 89, "unknown reference must leave the simulator on its explicit neutral reference");
      nodeAssert.equal(resolved.source, "none");
    } else {
      nodeAssert.equal(s.sensitivity.value, null, `${c.id} sensitivity must remain N/A`);
      nodeAssert.equal(s.impedance.value, null, `${c.id} driver impedance must remain N/A`);
    }
  }

  const asw610 = allDb.find((s) => s.id === "bowers-wilkins-asw610");
  nodeAssert.match(asw610.notes, /27 Hz to a variable 40\/140 Hz upper cutoff/i);
  nodeAssert.match(asw610.notes, /power consumption, not amplifier output/i);
  nodeAssert.match(asw610.notes, /input impedance, not driver nominal impedance/i);
  nodeAssert.equal(asw610.frequencyResponse.high_hz, null, "do not choose an arbitrary adjustable ASW610 upper cutoff");

  for (const id of ["bw-802d3", "legacy-bw-7"]) {
    const s = allDb.find((x) => x.id === id);
    nodeAssert.equal(s.active, null, "do not infer passive/active classification from a recommended-amplifier range");
    nodeAssert.match(s.notes, /recommended-amplifier range, not a scalar speaker rating/i);
  }
  for (const id of ["bowers-wilkins-formation-flex", "bowers-wilkins-formation-wedge"]) {
    const s = allDb.find((x) => x.id === id);
    nodeAssert.match(s.notes, /no single scalar power value is entered|single total output figure/i);
  }

  assertPreservedUnavailable("bw-800-d4");
  nodeAssert.match(removedById.get("bw-800-d4")?.reason ?? "", /series-level label/);
  assert(removedById.get("bw-800-d4")?.sourceRefs.includes("https://www.bowerswilkins.com/en/category/loudspeakers/800-series-diamond/"));
});

check("Bowers & Wilkins historical and exact-model findings retain source context and gaps", () => {
  const byId = (id: string) => allDb.find((s) => s.id === id);
  const dm6 = byId("legacy-bw-1");
  const dm6Source = "https://www.bowerswilkins.com/on/demandware.static/-/Library-Sites-bowers_northamerica_shared/default/dw7433324b/archive-manuals/eng_ft00061_dm6_info_sheet.pdf";
  assert(dm6, "DM6 record must remain present");
  nodeAssert.equal(dm6.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(dm6.driverCount, 3);
  nodeAssert.equal(dm6.frequencyResponse.low_hz, 50);
  nodeAssert.equal(dm6.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(dm6.frequencyResponse.source, dm6Source);
  nodeAssert.equal(dm6.sensitivity.value, 95);
  nodeAssert.equal(dm6.sensitivity.reference, "at 1m; input reference unspecified");
  nodeAssert.equal(dm6.impedance.value, 8);
  nodeAssert.equal(dm6.woofer.value, null, "DM6 bass-driver size is not supplied by the exact sheet");
  nodeAssert.equal(dm6.power.value, null, "25–350 W DM6 handling range is not a scalar rating");
  nodeAssert.equal(dm6.resonantFreq.value, null, "‘below 50 Hz’ is not an exact resonant frequency");
  const dm6Resolved = resolveSensitivity(dm6);
  nodeAssert.equal(dm6Resolved.isFallback, true, "DM6 source omits sensitivity drive reference");
  nodeAssert.equal(dm6Resolved.valueDb, 89);
  nodeAssert.equal(dm6Resolved.source, "none");
  assert(String(dm6.notes).includes(dm6Source), "DM6 must retain its exact information sheet");

  const bw802d = byId("legacy-bw-5");
  const bw802dSource = "https://www.bowerswilkins.com/on/demandware.static/-/Library-Sites-bowers_northamerica_shared/default/dwe4b5b4d3/archive-manuals/eng_fp20001_802-d_info_sheet.pdf";
  assert(bw802d, "802D record must remain present");
  nodeAssert.equal(bw802d.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(bw802d.frequencyResponse.low_hz, 34);
  nodeAssert.equal(bw802d.frequencyResponse.high_hz, 28000);
  nodeAssert.equal(bw802d.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(bw802d.impedance.value, 8);
  nodeAssert.equal(bw802d.woofer.value, 8);
  nodeAssert.equal(bw802d.power.value, null);
  const bw802dResolved = resolveSensitivity(bw802d);
  nodeAssert.equal(bw802dResolved.isFallback, false, "802D has a complete 2.83 V/1 m reference and nominal impedance");
  nodeAssert.equal(bw802dResolved.source, "manufacturer");
  assert(Math.abs(bw802dResolved.valueDb - 90) < 0.01, "802D 2.83 V/1 m at 8 ohms converts to approximately 90 dB at 1 W/1 m");
  assert(String(bw802d.notes).includes(bw802dSource), "802D must retain its exact revision sheet");
  nodeAssert.match(bw802d.notes, /-6 dB frequency range/);

  const original801 = byId("legacy-bw-2");
  nodeAssert.equal(original801?.driverCount, 3);
  nodeAssert.equal(original801?.woofer.value, 10.63, "27 cm woofer is directly converted to inches");
  nodeAssert.equal(original801?.frequencyResponse.low_hz, null, "no standardized 801 response limit is published in the history article");
  nodeAssert.match(original801?.notes ?? "", /original 801 \(launched in 1979\)/);

  assertPreservedUnavailable("bw-802-original");
  nodeAssert.match(removedById.get("bw-802-original")?.reason ?? "", /801 as the original 1979 model/);

  const matrix801 = byId("legacy-bw-3");
  nodeAssert.equal(matrix801?.woofer.value, 11.81, "30 cm Matrix 801 bass driver is directly converted to inches");
  nodeAssert.equal(matrix801?.frequencyResponse.low_hz, 20);
  nodeAssert.equal(matrix801?.frequencyResponse.high_hz, null, "the history article gives no Matrix 801 upper limit");
  nodeAssert.equal(matrix801?.power.value, null, "do not transfer power values from Matrix 801 S2/S3 sheets");
  nodeAssert.match(matrix801?.notes ?? "", /no response tolerance or upper limit/);
  nodeAssert.match(matrix801?.notes ?? "", /Matrix 801 S2 and S3 information sheets/);

  const nautilus = byId("legacy-bw-4");
  nodeAssert.equal(nautilus?.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(nautilus?.driverCount, 4);
  nodeAssert.equal(nautilus?.woofer.value, 12);
  nodeAssert.equal(nautilus?.active, null, "semi-active Nautilus cannot be represented accurately by the binary active field");
  nodeAssert.equal(nautilus?.power.value, null, "Nautilus amplifier recommendations are not speaker power ratings");
  nodeAssert.match(nautilus?.notes ?? "", /semi-active/);
  nodeAssert.match(nautilus?.notes ?? "", /not Nautilus 801/);

  const cm10 = byId("legacy-bw-6");
  const cm10Measurement = "https://www.soundandvision.com/content/bowers-wilkins-cm10-loudspeaker-test-bench";
  const cm10Specs = "https://www.audioholics.com/tower-speaker-reviews/bowers-wilkins-cm10";
  nodeAssert.equal(cm10?.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(cm10?.active, false);
  nodeAssert.equal(cm10?.driverCount, 5);
  nodeAssert.equal(cm10?.frequencyResponse.low_hz, 49, "retain the exact measured -3 dB lower point");
  nodeAssert.equal(cm10?.frequencyResponse.high_hz, null, "do not infer an upper cutoff from an undigitized graph");
  nodeAssert.equal(cm10?.frequencyResponse.source, cm10Measurement);
  nodeAssert.equal(cm10?.frequencyResponse.sourceType, "MEASUREMENT");
  nodeAssert.equal(cm10?.sensitivity.value, 88.5);
  nodeAssert.equal(cm10?.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(cm10?.sensitivity.source, cm10Measurement);
  nodeAssert.equal(cm10?.impedance.value, 8, "use the nominal 8-ohm value, not the measured minimum");
  nodeAssert.equal(cm10?.impedance.source, cm10Specs);
  nodeAssert.equal(cm10?.impedance.sourceType, "REPUTABLE_DATABASE");
  nodeAssert.equal(cm10?.woofer.value, 6.5);
  nodeAssert.equal(cm10?.woofer.source, cm10Specs);
  nodeAssert.equal(cm10?.power.value, null, "30–300 W is an amplifier recommendation, not a scalar rating");
  const cm10Sensitivity = resolveSensitivity(cm10);
  nodeAssert.equal(cm10Sensitivity.isFallback, false);
  nodeAssert.equal(cm10Sensitivity.source, "measurement");
  assert(Math.abs(cm10Sensitivity.valueDb - 88.5) < 0.01, "CM10 sensitivity uses the known 8-ohm nominal impedance");
  nodeAssert.match(cm10?.notes ?? "", /externally amplified/);
  nodeAssert.match(cm10?.notes ?? "", /-3 dB point at 49 Hz/);
  nodeAssert.match(cm10?.notes ?? "", /3\.72 ohms minimum at 115 Hz/);

  assertPreservedUnavailable("legacy-bw-10");
  nodeAssert.match(removedById.get("legacy-bw-10")?.reason ?? "", /CCM80, CCM818 and CCM8\.5/);
  assertPreservedUnavailable("bowers-wilkins-zeppelin");
  nodeAssert.match(removedById.get("bowers-wilkins-zeppelin")?.reason ?? "", /generation/);
});

check("recommended-amplifier ranges are not collapsed into scalar power values", () => {
  const rangePattern = /recommended amplifier[^.;]*\b\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*W\b/i;
  const offenders = db.filter((s) => s.power?.role === "recommended_amplifier" && s.power?.value != null && rangePattern.test(String(s.notes ?? "")));
  assert(offenders.length === 0, `range endpoint stored as scalar for: ${offenders.map((s) => s.id).join(", ")}`);
});

check("KEF research retains exact-model sources and does not merge revisions", () => {
  const byId = (id: string) => allDb.find((s) => s.id === id);
  const ls50 = byId("kef-ls50");
  const reference5 = byId("kef-reference-5");
  const q100 = byId("legacy-kef-5");
  const originalBlade = byId("legacy-kef-7");
  const model103 = byId("legacy-kef-3");
  const model104 = byId("legacy-kef-2");
  const original105 = byId("legacy-kef-4");
  const model1052 = byId("kef-105");
  const reference1 = byId("kef-reference-1");
  const ls35a = byId("kef-ls3-5a");
  const concord = byId("legacy-kef-1");
  assert(ls50 && reference5 && q100 && originalBlade && model103 && model104 && original105 && model1052 && reference1 && ls35a && concord, "KEF records must remain present");
  assertPreservedUnavailable("kef-blade-meta");
  assertPreservedUnavailable("legacy-kef-10");

  nodeAssert.equal(ls50.sensitivity.source, "https://www.stereophile.com/content/kef-ls50-anniversary-model-loudspeaker-specifications");
  nodeAssert.equal(ls50.power.value, null, "25–100 W LS50 amplifier range is not stored as scalar power");
  nodeAssert.equal(reference5.sensitivity.source, "https://www.stereophile.com/content/kef-reference-5-loudspeaker-specifications");
  nodeAssert.equal(reference5.power.value, null, "50–400 W Reference 5 amplifier range is not stored as scalar power");
  nodeAssert.equal(q100.frequencyResponse.source, "https://www.manualslib.com/manual/286175/Kef-Q100.html?page=12");
  nodeAssert.equal(q100.power.value, null, "10–100 W Q100 amplifier range is not stored as scalar power");

  nodeAssert.equal(ls35a.frequencyResponse.source, "https://manualsnet.com/kef/reference-series-model-ls3-5a");
  nodeAssert.equal(ls35a.frequencyResponse.low_hz, 70);
  nodeAssert.equal(ls35a.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(ls35a.sensitivity.value, 82.5);
  nodeAssert.equal(ls35a.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(ls35a.impedance.value, 11);
  nodeAssert.equal(ls35a.power.value, null, "25–75 W LS3/5a amplifier requirement is not scalar speaker power");

  nodeAssert.equal(reference1.sensitivity.value, 85);
  nodeAssert.equal(reference1.sensitivity.source, "https://www.questforsound.com/speakers/spkrs_kef_reference_1.htm");
  nodeAssert.equal(reference1.frequencyResponse.low_hz, 45);
  nodeAssert.equal(reference1.frequencyResponse.high_hz, 35000);
  nodeAssert.equal(reference1.impedance.value, 8);
  nodeAssert.equal(reference1.woofer.value, 6.5);
  nodeAssert.equal(reference1.power.value, null, "50–200 W Reference 1 amplifier requirement is not scalar speaker power");

  nodeAssert.equal(originalBlade.model, "Blade");
  nodeAssert.equal(originalBlade.frequencyResponse.low_hz, 40);
  nodeAssert.equal(originalBlade.sensitivity.value, 90);
  nodeAssert.equal(originalBlade.sensitivity.source, "https://www.manualslib.com/manual/1412330/Kef-Blade.html?page=10");
  nodeAssert.equal(originalBlade.power.value, null, "50–400 W recommended-amp range is not a scalar power rating");
  nodeAssert.match(removedById.get("kef-blade-meta")?.reason ?? "", /Blade One Meta and Blade Two Meta/);
  nodeAssert.match(removedById.get("legacy-kef-10")?.reason ?? "", /multiple distinct KEF Ci200 models/);

  nodeAssert.equal(model103.sensitivity.value, null, "25 W / 400 Hz sensitivity is not normalized into the standard field");
  nodeAssert.equal(model103.resonantFreq.value, 58, "Model 103's published 58 Hz system resonance is retained with context");
  nodeAssert.equal(model104.sensitivity.value, null, "12.5 W / 400 Hz sensitivity is not normalized into the standard field");
  nodeAssert.equal(model104.resonantFreq.value, 25, "Model 104's B200 LF unit resonance is source-backed");
  nodeAssert.equal(model104.resonantFreq.source, "https://audio-database.com/KEF/speaker/model104.html");
  nodeAssert.equal(model104.power.value, 50);
  nodeAssert.equal(model104.power.role, "allowable_input");
  nodeAssert.equal(model104.woofer.value, 20);
  nodeAssert.equal(model104.woofer.unit, "cm", "source unit must be retained rather than silently converted");

  nodeAssert.equal(concord.power.value, 15);
  nodeAssert.equal(concord.power.role, "allowable_input");
  nodeAssert.equal(concord.resonantFreq.value, 45);
  nodeAssert.equal(concord.impedance.value, null, "8–16 ohm range must not be collapsed into a single value");
  nodeAssert.equal(concord.frequencyResponse.low_hz, 30);
  nodeAssert.equal(concord.frequencyResponse.high_hz, 20000);
  nodeAssert.match(concord.notes, /no stated tolerance or measurement conditions/i);

  nodeAssert.equal(original105.model, "Reference 105");
  nodeAssert.equal(original105.sensitivity.source, "https://stereonomono.blogspot.com/2010/08/kef-model-105.html");
  nodeAssert.equal(original105.frequencyResponse.low_hz, null, "ambiguous response text is not transferred into structured bounds");
  nodeAssert.equal(model1052.frequencyResponse.source, "https://assets.kef.com/pdf_doc/product-archive/1970s/REFERENCE+SERIES+MODEL+105.2+(1979-87)/Reference_Series_Model_105_2_r.pdf");
  nodeAssert.notEqual(original105.frequencyResponse.source, model1052.frequencyResponse.source, "Model 105 and 105.2 provenance must remain separate");
  nodeAssert.equal(reference1.sensitivity.source, "https://www.questforsound.com/speakers/spkrs_kef_reference_1.htm", "pre-Meta Reference 1 fields use its exact-model source, not Model One or Meta data");
  nodeAssert.match(reference1.notes, /not the later Reference 1 Meta/);
  nodeAssert.match(reference1.notes, /no points were digitized or imported/);
});

check("Klipsch research retains exact revision sources and does not merge sibling models", () => {
  const batchSources: Record<string, string> = {
    "klipsch-cornwall-iv": "https://assets.klipsch.com/product-specsheets/Cornwall-2019-Spec-Sheet-v03.pdf",
    "klipsch-forte-iv": "https://assets.klipsch.com/product-specsheets/Forte-IV-Spec-Sheet-v01-1.pdf",
    "klipsch-heresy-iv": "https://assets.klipsch.com/product-specsheets/Heresy-IV-Spec-Sheet-v04.pdf",
    "klipsch-rp500m": "https://assets.klipsch.com/product-specsheets/RP-500M-II_Spec-Sheet_v02_2022-05-18-131859_rlqj.pdf",
    "klipsch-rp600m": "https://assets.klipsch.com/product-specsheets/RP-600M-II_Spec-Sheet_v02.pdf",
    "klipsch-rp-5000f-ii": "https://assets.klipsch.com/product-specsheets/RP-5000F-II_Spec-Sheet_v02.pdf",
    "klipsch-rp6000f": "https://assets.klipsch.com/product-specsheets/RP-6000F-II_Spec-Sheet_v02.pdf",
    "klipsch-rp-8000f-ii": "https://assets.klipsch.com/product-specsheets/RP-8000F-II_Spec-Sheet_v02.pdf",
    "klipsch-rp8060fa": "https://assets.klipsch.com/product-specsheets/RP-8060FA-II_Spec-Sheet_v02.pdf",
    "legacy-klip-8": "https://assets.klipsch.com/product-specsheets/R-41M_Spec-Sheet_GM_v01.pdf",
    "klipsch-r-120sw": "https://assets.klipsch.com/product-specsheets/R-120SW_GM_Spec-Sheet_v01.pdf",
    "klipsch-r-121sw": "https://assets.klipsch.com/product-specsheets/Reference-R-121SW-Spec-Sheet.pdf",
    "klipsch-spl-100": "https://assets.klipsch.com/product-specsheets/SPL-100_Spec-Sheet_v01.pdf",
    "klipsch-spl-120": "https://assets.klipsch.com/product-specsheets/SPL-120_Spec-Sheet_v01.pdf",
    "klipsch-spl-150": "https://assets.klipsch.com/product-specsheets/SPL-150_Spec-Sheet_v01.pdf",
    "klipsch-awr650sm": "https://assets.klipsch.com/product-specsheets/AWR-650-SM.pdf",
    "klipsch-rp-500m": "https://assets.klipsch.com/product-specsheets/RP-500M_Spec-Sheet_v01.pdf",
    "klipsch-rp-600m": "https://assets.klipsch.com/product-specsheets/RP-600M_Spec-Sheet_v01.pdf",
    "legacy-klip-6": "https://assets.klipsch.com/product-specsheets/RF-7-III_Spec-Sheet-v01.pdf",
    "klipsch-cdt5650c": "https://d2um2qdswy1tb0.cloudfront.net/spec-sheets/CDT-5650-C-II-Spec-Sheet-v02_2024-07-09-213225_uzir.pdf?v=1720560745",
    "klipsch-cdt-5800-c-ii": "https://d2um2qdswy1tb0.cloudfront.net/spec-sheets/CDT-5800-C_II_-_Spec_Sheet_-_v01_635125110119760000.pdf?v=1720561036",
    "klipsch-la-scala-ii": "https://assets.klipsch.com/product-specsheets/La-Scala-II-Spec-Sheet-v03.pdf",
    "legacy-klip-5": "https://assets.klipsch.com/product-specsheets/forte-brochure.pdf",
    "klipsch-kg4": "https://www.hifi-guide.com/loudspeaker/klipsch-kg-4-5/",
  };
  for (const [id, source] of Object.entries(batchSources)) {
    const s = allDb.find((x) => x.id === id);
    assert(s, `${id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED", `${id} status must derive from sourced physical fields`);
    for (const f of ["sensitivity", "power", "impedance", "frequencyResponse", "woofer"] as const) {
      const field = s[f];
      const populated = f === "frequencyResponse"
        ? field.low_hz !== null || field.high_hz !== null
        : field.value !== null;
      if (populated) nodeAssert.equal(field.source, source, `${id}.${f} must cite its exact-model source`);
    }
  }

  const original500 = allDb.find((s) => s.id === "klipsch-rp-500m");
  const revision500 = allDb.find((s) => s.id === "klipsch-rp500m");
  const original600 = allDb.find((s) => s.id === "klipsch-rp-600m");
  const revision600 = allDb.find((s) => s.id === "klipsch-rp600m");
  nodeAssert.equal(original500?.model, "RP-500M");
  nodeAssert.equal(original500?.sensitivity.value, 93);
  nodeAssert.equal(revision500?.model, "RP-500M II");
  nodeAssert.equal(revision500?.sensitivity.value, 92);
  nodeAssert.notEqual(original500?.sensitivity.source, revision500?.sensitivity.source);
  nodeAssert.equal(original600?.model, "RP-600M");
  nodeAssert.equal(original600?.sensitivity.value, 96);
  nodeAssert.equal(revision600?.model, "RP-600M II");
  nodeAssert.equal(revision600?.sensitivity.value, 94.5);
  nodeAssert.notEqual(original600?.sensitivity.source, revision600?.sensitivity.source);

  const rp8060 = allDb.find((s) => s.id === "klipsch-rp8060fa");
  nodeAssert.equal(rp8060?.power.value, null, "separate main/height-channel ratings are not collapsed into one scalar");
  nodeAssert.equal(rp8060?.driverCount, 5, "the exact sheet lists three main-channel and two height-channel transducers");
  for (const id of ["klipsch-r-120sw", "klipsch-r-121sw", "klipsch-spl-100", "klipsch-spl-120", "klipsch-spl-150"]) {
    const sub = allDb.find((s) => s.id === id);
    nodeAssert.equal(sub?.power.role, "amplifier_output", `${id} internal amp output is not passive speaker handling`);
  }
  nodeAssert.equal(allDb.find((s) => s.id === "klipsch-kg4")?.sensitivity.reference, "unspecified by source");
  const laScalaII = allDb.find((s) => s.id === "klipsch-la-scala-ii");
  nodeAssert.equal(laScalaII?.frequencyResponse.low_hz, 51);
  nodeAssert.equal(laScalaII?.frequencyResponse.high_hz, 17000);
  nodeAssert.equal(laScalaII?.sensitivity.reference, "2.83V/1m");
  nodeAssert.match(laScalaII?.notes ?? "", /average listening room/i);

  const forte = allDb.find((s) => s.id === "legacy-klip-5");
  nodeAssert.equal(forte?.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(forte?.sensitivity.value, 98);
  nodeAssert.equal(forte?.sensitivity.reference, "1W/1m");
  nodeAssert.equal(forte?.frequencyResponse.low_hz, 32);
  nodeAssert.equal(forte?.frequencyResponse.points?.length, 28);
  // Round 3: the Klipsch brochure table is manufacturer-published, not an independent measurement dataset.
  nodeAssert.equal(forte?.frequencyResponse.pointsSourceType, "MANUFACTURER");
  nodeAssert.equal(forte?.frequencyResponse.pointsStatus, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(forte?.frequencyResponse.pointsSource, "https://assets.klipsch.com/product-specsheets/forte-brochure.pdf");
  nodeAssert.match(forte?.frequencyResponse.pointsContext ?? "", /on-axis.*1 m.*0 = 100 dB SPL/i);
  nodeAssert.match(forte?.notes ?? "", /conflicts with its tabulated low-frequency values/i);
  nodeAssert.match(allDb.find((s) => s.id === "klipsch-cdt5650c")?.notes ?? "", /overview paragraph incorrectly names CDT-5800-C II/i);

  for (const id of ["legacy-klip-3", "legacy-klip-4", "klipsch-rf-8000f"]) assertPreservedUnavailable(id);
  nodeAssert.match(removedById.get("legacy-klip-3")?.reason ?? "", /Cornwall IV/);
  nodeAssert.match(removedById.get("legacy-klip-4")?.reason ?? "", /70th-anniversary edition/);
  nodeAssert.match(removedById.get("klipsch-rf-8000f")?.reason ?? "", /no silent correction\/substitution/);
});

check("Dynaudio Core, Emit, and Evoke data keep exact-source context and honest power/sensitivity roles", () => {
  const byId = (id: string) => allDb.find((s) => s.id === id);
  const coreCases = [
    { id: "dynaudio-core-7", source: "https://dynaudio.com/professional-audio/core/core-7", sheet: "https://dynaudio.com/hubfs/Datasheet/2022_DynaudioCore7_SpecSheet_WEB.pdf?hsLang=en", low: 40, high: 27000, woofer: 7, drivers: 2 },
    { id: "dynaudio-core-47", source: "https://dynaudio.com/professional-audio/core/core-47", sheet: "https://dynaudio.com/hubfs/Datasheet/2022_DynaudioCore47_SpecSheet_WEB.pdf?hsLang=en", low: 41, high: 24000, woofer: 7, drivers: 3 },
    { id: "dynaudio-core-59", source: "https://dynaudio.com/professional-audio/core/core-59", sheet: "https://dynaudio.com/hubfs/Datasheet/2022_DynaudioCore59_SpecSheet_WEB.pdf?hsLang=en", low: 39, high: 27000, woofer: 9, drivers: 3 },
  ];
  for (const c of coreCases) {
    const s = byId(c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.active, true);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.points?.length, 10);
    nodeAssert.equal(s.frequencyResponse.pointsSource, c.sheet);
    nodeAssert.equal(s.frequencyResponse.pointsSourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.pointsStatus, "MANUFACTURER_VERIFIED");
    nodeAssert.match(s.frequencyResponse.pointsContext, /only as curve shape/i);
    nodeAssert.equal(s.sensitivity.value, null, "maximum SPL/input sensitivity must not be converted into acoustic sensitivity");
    nodeAssert.equal(s.impedance.value, null, "active-monitor output must not be assigned a passive load impedance");
    nodeAssert.equal(s.power.value, null, "separate internal amplifier channels must not be summed into scalar power");
  }

  const passiveCases = [
    { id: "dynaudio-emit-10", source: "https://dynaudio.com/home-audio/emit/emit-10", low: 64, high: 25000, sensitivity: 86, power: 150, impedance: 6, woofer: 14, wooferUnit: "cm", drivers: 2 },
    { id: "dynaudio-emit-20", source: "https://dynaudio.com/home-audio/emit/emit-20", low: 53, high: 25000, sensitivity: 86, power: 160, impedance: 6, woofer: 18, wooferUnit: "cm", drivers: 2 },
    { id: "dynaudio-emit-30", source: "https://dynaudio.com/home-audio/emit/emit-30", low: 45, high: 25000, sensitivity: 88, power: 180, impedance: 4, woofer: 14, wooferUnit: "cm", drivers: 3 },
    { id: "dynaudio-evoke-10", source: "https://dynaudio.com/home-audio/evoke/evoke-10", low: 47, high: 23000, sensitivity: 84, power: 160, impedance: 6, woofer: 14, wooferUnit: "cm", drivers: 2 },
    { id: "dynaudio-evoke-20", source: "https://dynaudio.com/home-audio/evoke/evoke-20", low: 40, high: 23000, sensitivity: 86, power: 180, impedance: 6, woofer: 18, wooferUnit: "cm", drivers: 2 },
    { id: "dynaudio-evoke-30", source: "https://dynaudio.com/home-audio/evoke/evoke-30", low: 40, high: 23000, sensitivity: 88, power: 200, impedance: 4, woofer: 14, wooferUnit: "cm", drivers: 3 },
    { id: "dynaudio-evoke-50", source: "https://dynaudio.com/home-audio/evoke/evoke-50", low: 35, high: 23000, sensitivity: 87, power: 260, impedance: 4, woofer: 18, wooferUnit: "cm", drivers: 4 },
  ];
  for (const c of passiveCases) {
    const s = byId(c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.active, false);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.impedance.value, c.impedance);
    nodeAssert.equal(s.impedance.source, c.source);
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, c.wooferUnit, "manufacturer source units are retained");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.match(s.notes, /Passive Speakers manual/);
  }
  nodeAssert.match(byId("dynaudio-evoke-50")?.notes ?? "", /3-ohm minimum impedance at 100 Hz/i);

  const contourConfidenceCases = [
    { id: "legacy-dyn-1", source: "https://dynaudio.com/discontinued-models/contour/contour-13", low: 45, high: 22000, sensitivity: 85, power: 150, impedance: 4, woofer: 17, drivers: 2, active: null },
    { id: "legacy-dyn-2", source: "https://dynaudio.com/discontinued-models/editions/special-twenty-five", low: null, high: null, sensitivity: 88, power: 200, impedance: 4, woofer: 20, drivers: 2, active: null },
    { id: "legacy-dyn-3", source: "https://dynaudio.com/discontinued-models/confidence/confidence-c1", low: 45, high: 22000, sensitivity: 85, power: 170, impedance: 4, woofer: 17, drivers: 2, active: null },
    { id: "legacy-dyn-4", source: "https://dynaudio.com/discontinued-models/evidence/evidence-platinum", low: 28, high: 25000, sensitivity: 89, power: 550, impedance: 4, woofer: 18, drivers: 8, active: false },
    { id: "legacy-dyn-7", source: "https://dynaudio.com/discontinued-models/contour-2016/contour-20", low: 39, high: 23000, sensitivity: 86, power: 180, impedance: 4, woofer: 18, drivers: 2, active: false },
    { id: "dynaudio-contour-20i", source: "https://dynaudio.com/home-audio/contour-i/contour-20i", low: 39, high: 23000, sensitivity: 86, power: 180, impedance: 4, woofer: 18, drivers: 2, active: false },
    { id: "dynaudio-contour-30i", source: "https://dynaudio.com/home-audio/contour-i/contour-30i", low: 32, high: 23000, sensitivity: 87, power: 300, impedance: 4, woofer: 18, drivers: 3, active: false },
    { id: "dynaudio-contour-60i", source: "https://dynaudio.com/home-audio/contour-i/contour-60i", low: 28, high: 23000, sensitivity: 88, power: 390, impedance: 4, woofer: 23, drivers: 4, active: false },
    { id: "dynaudio-confidence-20", source: "https://dynaudio.com/home-audio/confidence/confidence-20", low: 42, high: 22000, sensitivity: 87, power: 250, impedance: 6, woofer: 18, drivers: 2, active: false },
    { id: "dynaudio-confidence-30", source: "https://dynaudio.com/home-audio/confidence/confidence-30", low: 38, high: 22000, sensitivity: 88, power: 350, impedance: 4, woofer: 18, drivers: 4, active: false },
    { id: "dynaudio-confidence-50", source: "https://dynaudio.com/home-audio/confidence/confidence-50", low: 35, high: 22000, sensitivity: 87, power: 400, impedance: 4, woofer: 18, drivers: 5, active: false },
  ];
  for (const c of contourConfidenceCases) {
    const s = byId(c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.active, c.active, `${c.id} active classification must use only its exact-model source context`);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    if (c.low === null) {
      nodeAssert.equal(s.frequencyResponse.status, "UNAVAILABLE", `${c.id} must not invent unpublished response limits`);
      nodeAssert.equal(s.frequencyResponse.source, null);
    } else {
      nodeAssert.equal(s.frequencyResponse.source, c.source);
      nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    }
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.impedance.value, c.impedance);
    nodeAssert.equal(s.impedance.source, c.source);
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "cm", "manufacturer units are retained");
    nodeAssert.equal(s.woofer.source, c.source);
  }
  nodeAssert.match(byId("legacy-dyn-3")?.notes ?? "", /not C1 Platinum/i);
  nodeAssert.match(byId("legacy-dyn-4")?.notes ?? "", /model-specific Evidence Platinum user manual/i);
  nodeAssert.match(byId("legacy-dyn-7")?.notes ?? "", /not Contour 20i/i);
  nodeAssert.match(byId("dynaudio-confidence-20")?.notes ?? "", /5-ohm minimum impedance at 155 Hz/i);
  nodeAssert.match(byId("dynaudio-confidence-30")?.notes ?? "", /2.8-ohm minimum impedance at 85 Hz/i);
  nodeAssert.match(byId("dynaudio-confidence-50")?.notes ?? "", /2.7-ohm minimum impedance at 79 Hz/i);
  for (const id of ["dynaudio-contour-20i", "dynaudio-contour-30i", "dynaudio-contour-60i", "dynaudio-confidence-20", "dynaudio-confidence-30", "dynaudio-confidence-50"]) {
    nodeAssert.match(byId(id)?.notes ?? "", /Passive Speakers manual/i);
  }
});

check("Monitor Audio Creator and Platinum 3G values retain exact-page provenance and response context", () => {
  const cases = [
    { id: "monitor-audio-creator-c1m", source: "https://www.monitoraudio.com/en/us/product-ranges/creator-series/c1m/", low: 35, high: 30000, sensitivity: 86, impedance: 8, power: 65, woofer: 7, drivers: 2, context: /installed frequency-response limits 35 Hz[–-]30 kHz \(-6 dB\)/i },
    { id: "monitor-audio-creator-c2m", source: "https://www.monitoraudio.com/en/us/product-ranges/creator-series/c2m/", low: 35, high: 35000, sensitivity: 86, impedance: 8, power: 75, woofer: 7, drivers: 2, context: /installed frequency-response limits 35 Hz[–-]35 kHz \(-6 dB\)/i },
    { id: "monitor-audio-creator-c3m", source: "https://www.monitoraudio.com/en/us/product-ranges/creator-series/c3m/", low: 45, high: 35000, sensitivity: 87, impedance: 6, power: 120, woofer: 7, drivers: 3, context: /installed frequency-response limits 45 Hz[–-]35 kHz \(-6 dB\)/i },
    { id: "monitor-audio-platinum-100-3g", source: "https://www.monitoraudio.com/en/deu/product-ranges/platinum-series-3g/platinum-100-3g/", low: 37, high: 60000, sensitivity: 85, impedance: 4, power: 150, woofer: 6, drivers: 2, context: /free-field frequency-response limits 37 Hz[–-]60 kHz \(-6 dB\)/i },
    { id: "monitor-audio-platinum-200-3g", source: "https://www.monitoraudio.com/en/deu/product-ranges/platinum-series-3g/platinum-200-3g/", low: 32, high: 60000, sensitivity: 88, impedance: 4, power: 300, woofer: 6, drivers: 4, context: /free-field frequency-response limits 32 Hz[–-]60 kHz \(-6 dB\)/i },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null, `${c.id}: do not infer a release year`);
    nodeAssert.equal(s.active, null, `${c.id}: do not infer active/passive status`);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83Vrms/1m");
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.sensitivity.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.impedance.value, c.impedance);
    nodeAssert.equal(s.impedance.source, c.source);
    nodeAssert.equal(s.impedance.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.impedance.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: published limits must not be turned into curve points`);
    nodeAssert.equal(s.resonantFreq.value, null, `${c.id}: resonant frequency remains N/A`);
    nodeAssert.equal(s.voiceCoil.value, null, `${c.id}: voice-coil size remains N/A`);
    nodeAssert.match(s.notes, c.context);
    nodeAssert.match(s.notes, /continuous power handling .*6 dB crest factor/i);
    assert(s.notes.includes(c.source), `${c.id} notes must retain its exact product page`);

    const resolved = resolveSensitivity(s);
    const normalized = c.sensitivity - 10 * Math.log10((2.83 * 2.83) / c.impedance);
    nodeAssert.equal(resolved.source, "manufacturer");
    nodeAssert.ok(Math.abs(resolved.valueDb - normalized) < 1e-10, `${c.id}: 2.83 Vrms sensitivity must be normalized using its sourced nominal impedance`);
  }

  const unresolvedLedger = unresolvedAll as Record<string, any>;
  for (const id of ["monitor-audio-bronze-50", "monitor-audio-bronze-100", "monitor-audio-bronze-200", "monitor-audio-bronze-500", "monitor-audio-silver-50", "monitor-audio-silver-100", "monitor-audio-silver-300", "monitor-audio-silver-500"]) {
    const unresolved = allDb.find((s) => s.id === id);
    assert(unresolved, `${id} must remain in the database`);
    nodeAssert.equal(unresolved.overallStatus, "UNAVAILABLE", `${id} exact revision remains unresolved after individual research`);
    nodeAssert.equal(unresolved.notes, unresolvedLedger[id].note);
    for (const field of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(unresolved[field].value, null, `${id}.${field} must remain N/A`);
    }
    nodeAssert.equal(unresolved.frequencyResponse.low_hz, null);
    nodeAssert.equal(unresolved.frequencyResponse.high_hz, null);
  }
});

check("DALI OPTICON MK2, RUBICON, and EPICON values use exact official specifications without treating amp ranges as speaker power", () => {
  const cases = [
    { id: "dali-opticon-2-mk2", source: "https://www.dali-speakers.com/en/products/opticon-mk2/opticon-2-mk2/", low: 59, high: 25000, sensitivity: 86.5, impedance: 4, woofer: 6.5, drivers: 2 },
    { id: "dali-opticon-6-mk2", source: "https://www.dali-speakers.com/en/products/opticon-mk2/opticon-6-mk2/", low: 49, high: 30000, sensitivity: 88, impedance: 4, woofer: 6.5, drivers: 4 },
    { id: "dali-opticon-8-mk2", source: "https://www.dali-speakers.com/en-us/products/opticon-mk2/opticon-8-mk2/", low: 38, high: 30000, sensitivity: 88.5, impedance: 4, woofer: 8, drivers: 5 },
    { id: "dali-rubicon-2", source: "https://www.dali-speakers.com/en/products/discontinued/rubicon/rubicon-2/", low: 50, high: 26000, sensitivity: 87, impedance: 4, woofer: 6.5, drivers: 2 },
    { id: "dali-rubicon-6", source: "https://www.dali-speakers.com/en/products/discontinued/rubicon/rubicon-6/", low: 38, high: 34000, sensitivity: 88.5, impedance: 4, woofer: 6.5, drivers: 4 },
    { id: "dali-rubicon-8", source: "https://www.dali-speakers.com/en/products/discontinued/rubicon/rubicon-8/", low: 38, high: 34000, sensitivity: 90.5, impedance: 4, woofer: 6.5, drivers: 5 },
    { id: "dali-epicon-2", source: "https://www.dali-speakers.com/en/products/discontinued/epicon/epicon-2/", low: 47, high: 30000, sensitivity: 87, impedance: 4, woofer: 6.5, drivers: 2 },
    { id: "dali-epicon-6", source: "https://www.dali-speakers.com/en-us/products/discontinued/epicon/epicon-6/", low: 35, high: 30000, sensitivity: 88, impedance: 5, woofer: 6.5, drivers: 4 },
    { id: "dali-epicon-8", source: "https://www.dali-speakers.com/en/products/discontinued/epicon/epicon-8/", low: 35, high: 30000, sensitivity: 89, impedance: 5, woofer: 8, drivers: 5 },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null, `${c.id}: do not infer a launch year`);
    nodeAssert.equal(s.active, null, `${c.id}: do not infer an active/passive flag`);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.sensitivity.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.impedance.value, c.impedance);
    nodeAssert.equal(s.impedance.source, c.source);
    nodeAssert.equal(s.impedance.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.impedance.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: published limits are not curve points`);
    nodeAssert.equal(s.power.value, null, `${c.id}: recommended-amplifier ranges are not speaker power handling`);
    nodeAssert.equal(s.resonantFreq.value, null, `${c.id}: resonant frequency remains N/A`);
    nodeAssert.equal(s.voiceCoil.value, null, `${c.id}: voice-coil size remains N/A`);
    nodeAssert.match(s.notes, /frequency range \(±3 dB\)/i);
    nodeAssert.match(s.notes, /recommended amplifier power, not speaker power handling, so power remains N\/A/i);
    nodeAssert.match(s.notes, /numeric frequency bounds are published limits, not curve points/i);
    assert(s.notes.includes(c.source), `${c.id} notes must retain its exact manufacturer page`);

    const resolved = resolveSensitivity(s);
    const normalized = c.sensitivity - 10 * Math.log10((2.83 * 2.83) / c.impedance);
    nodeAssert.equal(resolved.source, "manufacturer");
    nodeAssert.ok(Math.abs(resolved.valueDb - normalized) < 1e-10, `${c.id}: 2.83 V sensitivity must be normalized from its sourced nominal impedance`);
  }

  const oberon9 = allDb.find((s) => s.id === "dali-oberon-9");
  assert(oberon9, "dali-oberon-9 must remain in the database");
  const oberon9Source = "https://linqcdn.avbportal.com/documents/fa9572a7-b80e-42a9-8faf-ac9426d1f177.pdf";
  nodeAssert.equal(oberon9.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(oberon9.active, false, "the exact manual describes a passively connected single-wire speaker");
  nodeAssert.equal(oberon9.driverCount, 4, "two 9-inch woofers, one 7-inch midrange, and one 29 mm tweeter");
  nodeAssert.equal(oberon9.sensitivity.value, 90.5);
  nodeAssert.equal(oberon9.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(oberon9.sensitivity.source, oberon9Source);
  nodeAssert.equal(oberon9.sensitivity.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(oberon9.impedance.value, 4);
  nodeAssert.equal(oberon9.impedance.source, oberon9Source);
  nodeAssert.equal(oberon9.impedance.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(oberon9.woofer.value, 9, "store the published low-frequency woofer size; do not replace it with the midrange driver");
  nodeAssert.equal(oberon9.woofer.source, oberon9Source);
  nodeAssert.equal(oberon9.frequencyResponse.low_hz, 35);
  nodeAssert.equal(oberon9.frequencyResponse.high_hz, 26000);
  nodeAssert.equal(oberon9.frequencyResponse.source, oberon9Source);
  nodeAssert.equal(oberon9.frequencyResponse.points, undefined, "published response limits are not a measured response curve");
  nodeAssert.equal(oberon9.power.value, null, "50–400 W is recommended amplifier power, not speaker handling");
  nodeAssert.equal(oberon9.resonantFreq.value, null, "31 Hz bass-reflex tuning is not driver Fs");
  nodeAssert.equal(oberon9.voiceCoil.value, null);
  nodeAssert.match(oberon9.notes, /manufacturer-authored DALI A\/S content mirrored at the cited URL/i);
  nodeAssert.match(oberon9.notes, /recommended amplifier range is not speaker power handling and power remains N\/A/i);
  nodeAssert.match(oberon9.notes, /bass-reflex tuning frequency, which is not driver resonant frequency/i);
  const oberon9Resolved = resolveSensitivity(oberon9);
  const oberon9Normalized = 90.5 - 10 * Math.log10((2.83 * 2.83) / 4);
  nodeAssert.ok(Math.abs(oberon9Resolved.valueDb - oberon9Normalized) < 1e-10, "2.83 V sensitivity must be normalized using the sourced 4-ohm nominal impedance");
});

check("Polk RTi, RCi, Signature, Reserve, and Signature Elite fields preserve exact model-source context", () => {
  const cases = [
    { id: "polk-rti-a7", model: "RTi A7", source: "https://www.polkaudio.com/en-us/product/archive/archive-built-in-speakers/rti-a7/112671.html", low: 35, high: 26000, sensitivity: 89, reference: "1W/1m", impedance: 8, woofer: 7, drivers: 4, responseContext: /35 Hz[–-]26 kHz as the lower\/upper -3 dB limits/i },
    { id: "polk-rc85i", model: "RC85i", source: "https://www.polkaudio.com/on/demandware.static/-/Library-Sites-polk_northamerica_shared/default/dw5c6c39bf/downloads/rc60i-rc80i-rc85i-owners-manual-en.pdf", low: 30, high: 20000, sensitivity: 90, reference: "1W/1m", impedance: null, woofer: 8, drivers: 2, responseContext: /does not state a response tolerance/i },
    { id: "polk-signature-s50", model: "Signature S50", source: "https://www.polkaudio.com/en-us/product/archive/archive-floor-standing-speakers/signature-s50/112700.html", low: 33, high: 40000, sensitivity: 89, reference: "1W/1m", impedance: null, woofer: 5.25, drivers: 3, responseContext: /total-response range/i },
    { id: "polk-signature-s15", model: "Signature S15", source: "https://www.polkaudio.com/on/demandware.static/-/Library-Sites-polk_northamerica_shared/default/dw245d4011/downloads/P_Signature%20Series_Product%20Info%20Sheet_Black%20Walnut.pdf", low: 50, high: 40000, sensitivity: 88, reference: "unspecified by source", impedance: null, woofer: 5.25, drivers: 2, responseContext: /no stated tolerance\/measurement condition/i },
    { id: "polk-audio-reserve-r100", model: "Reserve R100", source: "https://www.polkaudio.com/en-us/product/home-speakers/bookshelf/reserve-r100/300028.html", low: 58, high: 39000, sensitivity: 86, reference: "2.83V/1m", impedance: null, woofer: 5.25, drivers: 2, responseContext: /explicitly labeled -3 dB limits/i },
    { id: "polk-audio-reserve-r200", model: "Reserve R200", source: "https://www.polkaudio.com/en-us/product/home-speakers/bookshelf/reserve-r200/300029.html", low: 51, high: 38000, sensitivity: 86, reference: "2.83V/1m", impedance: null, woofer: 6.5, drivers: 2, responseContext: /explicitly labeled -3 dB limits/i },
    { id: "polk-audio-signature-elite-es15", model: "Signature Elite ES15", source: "https://www.polkaudio.com/en-us/product/home-speakers/bookshelf/signature-elite-es15/300363.html", low: 44, high: 40000, sensitivity: 85, reference: "2.83V/1m", impedance: null, woofer: 5.25, drivers: 2, responseContext: /no stated tolerance\/measurement condition/i },
    { id: "polk-audio-signature-elite-es20", model: "Signature Elite ES20", source: "https://www.polkaudio.com/en-us/product/home-speakers/bookshelf/signature-elite-es20/300364.html", low: 41, high: 40000, sensitivity: 86, reference: "2.83V/1m", impedance: null, woofer: 6.5, drivers: 2, responseContext: /no stated tolerance\/measurement condition/i },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null, `${c.id}: do not infer a release year`);
    nodeAssert.equal(s.active, null, `${c.id}: do not infer active/passive status`);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, c.reference);
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.sensitivity.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.impedance.value, c.impedance, `${c.id}: only explicit nominal impedance is structured`);
    if (c.impedance !== null) {
      nodeAssert.equal(s.impedance.source, c.source);
      nodeAssert.equal(s.impedance.status, "MANUFACTURER_VERIFIED");
    } else {
      nodeAssert.equal(s.impedance.source, null);
      nodeAssert.equal(s.impedance.status, "UNAVAILABLE");
    }
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: published limits are not curve points`);
    nodeAssert.equal(s.power.value, null, `${c.id}: recommended amplifier ranges are not speaker power handling`);
    nodeAssert.equal(s.power.status, "UNAVAILABLE");
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    nodeAssert.match(s.notes, c.responseContext);
    nodeAssert.match(s.notes, /recommended (?:amplifier|amplification)/i);
    nodeAssert.match(s.notes, /speaker power handling/i);
    nodeAssert.match(s.notes, /response points|curve points/i);
    nodeAssert.match(s.notes, /directivity data/i);
    assert(s.notes.includes(c.source), `${c.id} notes must retain the exact model-specific source`);

    const resolved = resolveSensitivity(s);
    if (c.reference === "1W/1m") {
      nodeAssert.equal(resolved.isFallback, false, `${c.id}: an explicit 1 W / 1 m sensitivity is directly usable`);
      nodeAssert.equal(resolved.valueDb, c.sensitivity);
      nodeAssert.equal(resolved.source, "manufacturer");
    } else {
      nodeAssert.equal(resolved.isFallback, true, `${c.id}: do not convert voltage/unspecified sensitivity without an explicit nominal impedance and reference`);
      nodeAssert.equal(resolved.valueDb, 89);
      nodeAssert.equal(resolved.source, "none");
    }
  }
});

check("Wharfedale exact models retain published response context and do not infer power or sensitivity normalization", () => {
  const cases = [
    { id: "wharfedale-diamond-12-0", model: "Diamond 12.0", source: "https://www.wharfedale.co.uk/products/diamond-12-0", low: 70, high: 20000, woofer: 4, drivers: 2, sensitivity: 87, bassExtension: 65 },
    { id: "wharfedale-diamond-12-2", model: "Diamond 12.2", source: "https://www.wharfedale.co.uk/products/diamond-12-2", low: 50, high: 20000, woofer: 6.5, drivers: 2, sensitivity: 88, bassExtension: 43 },
    { id: "wharfedale-evo4-1", model: "EVO4.1", source: "https://www.wharfedale.co.uk/products/evo4-1", low: 64, high: 22000, woofer: 5, drivers: 2, sensitivity: 87, bassExtension: 55 },
    { id: "wharfedale-evo4-2", model: "EVO4.2", source: "https://www.wharfedale.co.uk/products/evo4-2", low: 54, high: 22000, woofer: 6.5, drivers: 3, sensitivity: 87, bassExtension: 48 },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null);
    nodeAssert.equal(s.active, null, `${c.id}: do not infer active/passive classification`);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: response bounds are not curve points`);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.impedance.value, 8);
    nodeAssert.equal(s.impedance.unit, "ohm");
    nodeAssert.equal(s.impedance.source, c.source);
    nodeAssert.equal(s.impedance.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83V/1m (RMS not stated)");
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.sensitivity.status, "MANUFACTURER_VERIFIED");
    const resolved = resolveSensitivity(s);
    nodeAssert.equal(resolved.isFallback, true, `${c.id}: no impedance-based normalization when the source does not state RMS`);
    nodeAssert.equal(resolved.source, "none");
    nodeAssert.equal(s.power.value, null, `${c.id}: amplifier recommendations are not power handling`);
    nodeAssert.equal(s.power.source, null);
    nodeAssert.equal(s.power.status, "UNAVAILABLE");
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    nodeAssert.match(s.notes, new RegExp(`${c.low} Hz[–-]${c.high === 20000 ? "20" : "22"} kHz at ±3 dB`, "i"));
    nodeAssert.match(s.notes, new RegExp(`${c.bassExtension} Hz.*−6 dB`, "i"));
    nodeAssert.match(s.notes, /recommended-amplifier range is not speaker power handling/i);
    nodeAssert.match(s.notes, /not converted to 1 W\/1 m because RMS is unspecified/i);
    nodeAssert.match(s.notes, /response-point table|response-point curve/i);
    nodeAssert.match(s.notes, /directivity/i);
    assert(s.notes.includes(c.source), `${c.id} must retain its exact manufacturer source`);
  }
  const d122 = allDb.find((s) => s.id === "wharfedale-diamond-12-2");
  nodeAssert.match(d122.notes, /6\.5 inches and parenthetically 150 mm/i);
  nodeAssert.match(d122.notes, /not a conversion from millimetres/i);
  const evo42 = allDb.find((s) => s.id === "wharfedale-evo4-2");
  nodeAssert.match(evo42.notes, /3-way.*bookshelf speaker/i);
  nodeAssert.match(evo42.notes, /2-inch \(50 mm\) soft-dome midrange/i);
});

check("Wharfedale W60 remains distinct from suffix revisions when secondary sources conflict", () => {
  const s = allDb.find((x) => x.id === "wharfedale-w60");
  assert(s, "exact no-suffix W60 row must remain in the database");
  nodeAssert.equal(s.model, "W60");
  nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
  nodeAssert.equal(s.sensitivity.value, null);
  nodeAssert.equal(s.power.value, null);
  nodeAssert.equal(s.impedance.value, null);
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  nodeAssert.equal(s.woofer.value, null);
  nodeAssert.equal(s.frequencyResponse.low_hz, null);
  nodeAssert.equal(s.frequencyResponse.high_hz, null);
  nodeAssert.equal(s.active, null);
  nodeAssert.equal(s.driverCount, null);
  nodeAssert.match(s.notes, /no-suffix Wharfedale W60.*not merged with W60D\/W60E/i);
  nodeAssert.match(s.notes, /5 inches.*4\.5-inch.*6 Ω/i);
  nodeAssert.match(s.notes, /no physical values are transferred/i);
});

check("Q Acoustics exact models retain published response and sensitivity references without collapsing recommendations", () => {
  const cases = [
    {
      id: "q-acoustics-3010i", model: "3010i", source: "https://www.qacoustics.com/products/3010i-compact-bookshelf-speaker-pair",
      low: 65, high: 30000, woofer: 4, impedance: 6, sensitivity: 86, reference: "2.83Vrms/1m",
      responseContext: /65 Hz–30 kHz with the source's \(\+3 dB, −6 dB\) context/i,
    },
    {
      id: "q-acoustics-3020i", model: "3020i", source: "https://www.qacoustics.com/products/3020i-bookshelf-speaker-pair",
      low: 64, high: 30000, woofer: 5, impedance: 6, sensitivity: 88, reference: "2.83Vrms/1m",
      responseContext: /64 Hz–30 kHz with the source's \(\+3 dB, −6 dB\) context/i,
    },
    {
      id: "q-acoustics-3030i", model: "3030i", source: "https://www.qacoustics.com/products/3030i-bookshelf-speaker-pair",
      low: 46, high: 30000, woofer: 6.5, impedance: null, sensitivity: 88, reference: "2.83V/1m (RMS not stated)",
      responseContext: /46 Hz–30 kHz.*does not unambiguously assign a tolerance/i,
    },
    {
      id: "q-acoustics-5020", model: "5020", source: "https://www.qacoustics.com/products/5020-bookshelf-speaker",
      low: 53, high: 30000, woofer: 5, impedance: 6, sensitivity: null, reference: null,
      responseContext: /53 Hz–30 kHz frequency-response limits at −6 dB/i,
    },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null);
    nodeAssert.equal(s.active, null, `${c.id}: do not infer active/passive classification`);
    nodeAssert.equal(s.driverCount, 2, `${c.id}: exact two-way driver complement`);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: range limits are not imported as response points`);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.impedance.value, c.impedance);
    if (c.impedance === null) {
      nodeAssert.equal(s.impedance.source, null, `${c.id}: average/minimum impedance is not converted into nominal impedance`);
      nodeAssert.equal(s.impedance.status, "UNAVAILABLE");
    } else {
      nodeAssert.equal(s.impedance.unit, "ohm");
      nodeAssert.equal(s.impedance.source, c.source);
      nodeAssert.equal(s.impedance.status, "MANUFACTURER_VERIFIED");
    }
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference ?? null, c.reference);
    if (c.sensitivity === null) {
      nodeAssert.equal(s.sensitivity.source, null, `${c.id}: do not resolve the source's contradictory sensitivity reference`);
      nodeAssert.equal(s.sensitivity.status, "UNAVAILABLE");
      nodeAssert.equal(resolveSensitivity(s).isFallback, true);
      nodeAssert.equal(resolveSensitivity(s).source, "none");
    } else {
      nodeAssert.equal(s.sensitivity.source, c.source);
      nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
      nodeAssert.equal(s.sensitivity.status, "MANUFACTURER_VERIFIED");
      const resolved = resolveSensitivity(s);
      if (c.id === "q-acoustics-3010i" || c.id === "q-acoustics-3020i") {
        if (c.impedance === null) throw new Error(`${c.id}: test case must declare nominal impedance for conversion`);
        const expectedOneWatt = c.sensitivity - 10 * Math.log10((2.83 * 2.83) / c.impedance);
        nodeAssert.equal(resolved.isFallback, false, `${c.id}: exact 2.83 Vrms/1m reference and nominal impedance permit conversion`);
        nodeAssert.equal(resolved.source, "manufacturer");
        nodeAssert.ok(Math.abs(resolved.valueDb - expectedOneWatt) < 1e-10, `${c.id}: impedance-aware sensitivity conversion`);
      } else {
        nodeAssert.equal(resolved.isFallback, true, `${c.id}: do not convert without explicit RMS or nominal impedance`);
        nodeAssert.equal(resolved.source, "none");
      }
    }
    nodeAssert.equal(s.power.value, null, `${c.id}: recommended amplifier ranges are not scalar power handling`);
    nodeAssert.equal(s.power.source, null);
    nodeAssert.equal(s.power.status, "UNAVAILABLE");
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    nodeAssert.match(s.notes, c.responseContext);
    nodeAssert.match(s.notes, /recommend(?:ation|ed).*not .*power handling/i);
    nodeAssert.match(s.notes, /curve points|response points|response[- ]point curve/i);
    nodeAssert.match(s.notes, /directivity|polar/i);
    assert(s.notes.includes(c.source), `${c.id} must retain its exact Q Acoustics product-page source`);
  }
  const r3030 = allDb.find((s) => s.id === "q-acoustics-3030i");
  nodeAssert.match(r3030.notes, /average impedance 6 Ω and minimum impedance 4 Ω, not nominal impedance/i);
  nodeAssert.match(r3030.notes, /no impedance-dependent sensitivity conversion is made/i);
  const r5020 = allDb.find((s) => s.id === "q-acoustics-5020");
  nodeAssert.match(r5020.notes, /internally ambiguous/i);
  nodeAssert.match(r5020.notes, /sensitivity remains N\/A/i);
});

check("PreSonus exact-model batches retain sourced limits and keep unsupported fields unavailable", () => {
  const e5Sheet = "https://www.fmicassets.com/Damroot/Original/10001/OM_2777500107_Eris-E5_Tech-Sheet_EN.pdf";
  const r65Manual = "https://www.fmicassets.com/Damroot/Original/10001/OM_2777500201_R65_EN.pdf";
  const r65Sheet = "https://www.fmicassets.com/Damroot/Original/10001/OM_2777500201_R65_Tech-Sheet_Multi.pdf";
  const r80Sheet = "https://www.fmicassets.com/Damroot/Original/10001/OM_2777500203_R80_Tech-Sheet_EN.pdf";
  const cases = [
    {
      id: "presonus-eris-e5", model: "Eris E5", frequencySource: e5Sheet, wooferSource: e5Sheet, powerSource: e5Sheet,
      low: 53, high: 20000, woofer: 5.25, power: 80,
      responseContext: /53 Hz–20 kHz frequency-response limits \(no tolerance is stated\)/i,
      powerContext: /80 W Class AB biamplification total \(45 W LF \+ 35 W HF\)/i,
    },
    {
      id: "presonus-r65", model: "R65", frequencySource: r65Manual, wooferSource: r65Manual, powerSource: r65Sheet,
      low: 45, high: 22000, woofer: 6.5, power: 150,
      responseContext: /45 Hz–22 kHz frequency response at −3 dB/i,
      powerContext: /150 W Class D biamplification/i,
    },
    {
      id: "presonus-r80", model: "R80", frequencySource: r65Manual, wooferSource: r65Manual, powerSource: r80Sheet,
      low: 40, high: 22000, woofer: 8, power: 150,
      responseContext: /40 Hz–22 kHz frequency response at −3 dB/i,
      powerContext: /150 W Class D biamplification/i,
    },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null, `${c.id}: do not infer a release year`);
    nodeAssert.equal(s.active, true, `${c.id}: exact manufacturer documentation identifies an active system`);
    nodeAssert.equal(s.driverCount, 2, `${c.id}: exact two-way design is retained`);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.frequencySource);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: do not import an under-contextualized SPL table as a response curve`);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.wooferSource);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.unit, "W");
    nodeAssert.equal(s.power.role, "amplifier_output", `${c.id}: built-in amplification is not passive-speaker power handling`);
    nodeAssert.equal(s.power.source, c.powerSource);
    nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.sensitivity.value, null, `${c.id}: maximum SPL is not acoustic sensitivity`);
    nodeAssert.equal(s.impedance.value, null, `${c.id}: line-level input impedance is not speaker-load impedance`);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null, `${c.id}: no exact voice-coil diameter is published`);
    nodeAssert.match(s.notes, c.responseContext);
    nodeAssert.match(s.notes, c.powerContext);
    nodeAssert.match(s.notes, /response points?|response[- ]point curve/i);
    nodeAssert.match(s.notes, /directivity|polar/i);
    assert(s.notes.includes(c.frequencySource), `${c.id} notes must retain the source for frequency response`);
    assert(s.notes.includes(c.wooferSource), `${c.id} notes must retain the source for woofer diameter`);
    assert(s.notes.includes(c.powerSource), `${c.id} notes must retain the source for amplifier output`);
  }
  const r80 = allDb.find((s) => s.id === "presonus-r80");
  nodeAssert.match(r80.notes, /R80 technical sheet explicitly lists 150 W/i);
  nodeAssert.match(r80.notes, /detailed LF-driver row conflicts/i);
  nodeAssert.equal(r80.woofer.value, 8, "R80 woofer diameter must come from its distinct manual row, not the conflicting copied table cell");
});

check("Mackie source-backed records preserve exact model limits and leave unsupported fields unavailable", () => {
  const cases = [
    { id: "mackie-srm550", model: "SRM550", source: "https://mackie.com/img/file_resources/SRM550_650_750_SS.pdf", low: 55, high: 17000, woofer: 12, voiceCoil: 2.6, drivers: 2, power: 800, responseContext: /55 Hz–17 kHz at −3 dB/i },
    { id: "mackie-srm212", model: "SRM212 V-Class", source: "https://mackie.com/img/file_resources/SRM%20V-Class_SS.pdf", low: 50, high: 20000, woofer: 12, voiceCoil: null, drivers: 2, power: null, responseContext: /50 Hz–20 kHz at −3 dB/i },
    { id: "mackie-thump215xt", model: "Thump215XT", source: "https://mackie.com/img/file_resources/THUMPXT_2022_SS.pdf", low: 47, high: 20000, woofer: 15, voiceCoil: null, drivers: 2, power: null, responseContext: /47 Hz–20 kHz at −3 dB/i },
    { id: "mackie-mr524", model: "MR524", source: "https://mackie.com/img/file_resources/MR_Studio_Monitors_OM.pdf", low: 57, high: 20000, woofer: 5.25, voiceCoil: null, drivers: 2, power: null, responseContext: /57 Hz–20 kHz at −3 dB/i },
    { id: "legacy-mack-3", model: "MR624", source: "https://mackie.com/img/file_resources/MR_Studio_Monitors_OM.pdf", low: 45, high: 20000, woofer: 6.5, voiceCoil: null, drivers: 2, power: null, responseContext: /45 Hz–20 kHz at −3 dB/i },
    { id: "mackie-mr824", model: "MR824", source: "https://mackie.com/img/file_resources/MR_Studio_Monitors_OM.pdf", low: 38, high: 20000, woofer: 8, voiceCoil: null, drivers: 2, power: null, responseContext: /38 Hz–20 kHz at −3 dB/i },
    { id: "mackie-cr3-x", model: "CR3-X", source: "https://mackie.com/img/file_resources/CR-X_Series_QSG.pdf", low: 70, high: 20000, woofer: null, voiceCoil: null, drivers: null, power: null, responseContext: /70 Hz–20 kHz at −10 dB/i },
    { id: "mackie-cr4-x", model: "CR4-X", source: "https://mackie.com/img/file_resources/CR-X_Series_QSG.pdf", low: 55, high: 20000, woofer: null, voiceCoil: null, drivers: null, power: null, responseContext: /frequency range at −10 dB: 55 Hz–20 kHz/i },
    { id: "mackie-cr5-x", model: "CR5-X", source: "https://mackie.com/img/file_resources/CR-X_Series_QSG.pdf", low: 51, high: 20000, woofer: null, voiceCoil: null, drivers: null, power: null, responseContext: /frequency range at −10 dB: 51 Hz–20 kHz/i },
    { id: "legacy-mack-7", model: "DLM12", source: "https://mackie.com/img/file_resources/DLM8_12_SS.pdf", low: 38, high: 20000, woofer: 12, voiceCoil: 2.5, drivers: 2, power: 1000, responseContext: /38 Hz–20 kHz at −10 dB/i },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null, `${c.id}: do not infer a release year`);
    nodeAssert.equal(s.active, true, `${c.id}: exact Mackie documentation identifies a powered system`);
    nodeAssert.equal(s.driverCount, c.drivers, `${c.id}: only an explicit driver complement is counted`);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: published response limits are not curve points`);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.source, c.woofer === null ? null : c.source);
    nodeAssert.equal(s.woofer.status, c.woofer === null ? "UNAVAILABLE" : "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.voiceCoil.value, c.voiceCoil);
    nodeAssert.equal(s.voiceCoil.source, c.voiceCoil === null ? null : c.source);
    nodeAssert.equal(s.voiceCoil.status, c.voiceCoil === null ? "UNAVAILABLE" : "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.power.value, c.power);
    if (c.power !== null) {
      nodeAssert.equal(s.power.role, "amplifier_output", `${c.id}: built-in amplifier output is not passive-speaker handling`);
      nodeAssert.equal(s.power.source, c.source);
      nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    } else {
      nodeAssert.equal(s.power.status, "UNAVAILABLE", `${c.id}: no unqualified or unsupported power value`);
    }
    nodeAssert.equal(s.sensitivity.value, null, `${c.id}: no acoustic sensitivity is inferred from maximum SPL or input sensitivity`);
    nodeAssert.equal(s.impedance.value, null, `${c.id}: line/input impedance is not speaker-load impedance`);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.match(s.notes, c.responseContext);
    nodeAssert.match(s.notes, /response[- ]points?|response curve/i);
    nodeAssert.match(s.notes, /polar|directivity/i);
    assert(s.notes.includes(c.source), `${c.id} notes must retain the exact manufacturer source`);
  }
});

check("SVS subwoofer fields preserve exact-model response modes and distinguish built-in amplifier output", () => {
  const cases = [
    { id: "svs-sb-2000-pro", model: "SB-2000 Pro", source: "https://www.svsound.com/products/sb-2000-pro", low: 19, high: 240, power: 550, woofer: 12, voiceCoil: null },
    { id: "svs-pb16-ultra", model: "PB16-Ultra", source: "https://www.svsound.com/products/pb16-ultra", low: 15, high: 280, power: 1500, woofer: 16, voiceCoil: 8 },
    { id: "svs-sb4000", model: "SB4000", source: "https://www.svsound.com/products/sb-4000", low: 19, high: 310, power: 1200, woofer: 13.5, voiceCoil: 3 },
    { id: "svs-sb16-ultra", model: "SB16-Ultra", source: "https://www.svsound.com/products/sb16-ultra", low: 16, high: 460, power: 1500, woofer: 16, voiceCoil: 8 },
    { id: "svs-pb-3000", model: "PB-3000", source: "https://www.svsound.com/products/pb-3000", low: 16, high: 260, power: 800, woofer: 13, voiceCoil: null },
    { id: "svs-pb-1000-pro", model: "PB-1000 Pro", source: "https://www.svsound.com/products/pb-1000-pro-subwoofer", low: 17, high: 260, power: 325, woofer: 12, voiceCoil: 1.5 },
    { id: "svs-sb-3000", model: "SB-3000", source: "https://www.svsound.com/products/sb-3000", low: 18, high: 270, power: 800, woofer: 13, voiceCoil: null },
    { id: "svs-pb-4000", model: "PB-4000", source: "https://www.svsound.com/products/pb-4000", low: 16, high: 200, power: 1200, woofer: 13.5, voiceCoil: 3 },
    { id: "svs-pb-2000-pro", model: "PB-2000 Pro", source: "https://www.svsound.com/products/pb-2000-pro", low: 16, high: 290, power: 550, woofer: 12, voiceCoil: null },
  ];
  for (const c of cases) {
    const s = allDb.find((x) => x.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.year, null, `${c.id}: do not infer a year`);
    nodeAssert.equal(s.active, true, `${c.id}: exact official page describes its built-in powered-subwoofer amplifier`);
    nodeAssert.equal(s.driverCount, 1);
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.unit, "W");
    nodeAssert.equal(s.power.role, "amplifier_output", `${c.id}: built-in amp output is not passive speaker power handling`);
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.voiceCoil.value, c.voiceCoil, `${c.id}: only manufacturer-published coil diameter is populated`);
    if (c.voiceCoil !== null) {
      nodeAssert.equal(s.voiceCoil.source, c.source);
      nodeAssert.equal(s.voiceCoil.unit, "in");
      nodeAssert.equal(s.voiceCoil.status, "MANUFACTURER_VERIFIED");
    }
    nodeAssert.equal(s.sensitivity.value, null, `${c.id}: no unsupported sensitivity is inferred`);
    nodeAssert.equal(s.impedance.value, null, `${c.id}: amplifier input impedance is not driver impedance`);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low, `${c.id}: retain the published standard/sealed response context`);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: chart is not imported as measured curve points`);
    nodeAssert.match(s.notes, /RMS/i);
    nodeAssert.match(s.notes, /amplifier_output, not passive-speaker power handling/i);
    nodeAssert.match(s.notes, /peak[^.]*context/i);
    nodeAssert.match(s.notes, /±3 dB/i);
    nodeAssert.match(s.notes, /2-meter ground plane away from reflective structures \(quasi-anechoic\)/i);
    nodeAssert.match(s.notes, /directivity dataset (?:is|are) (?:published\/)?imported/i);
    assert(s.notes.includes(c.source), `${c.id} notes must cite the exact manufacturer page`);
  }
});

check("Genelec S30 retains exact-model limits and leaves conflicting amplifier ratings unavailable", () => {
  const s = allDb.find((item) => item.id === "legacy-gen-1");
  assert(s, "legacy-gen-1 Genelec S30 record is missing");
  const dataSheet = "https://assets.ctfassets.net/4zjnzn055a4v/4iSHIIWFKggGUcqwQe2aK0/6628244febab9ed9b04c22e238776cb1/S30_datasheet.pdf";
  nodeAssert.equal(s.model, "S30");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.frequencyResponse.low_hz, 42);
  nodeAssert.equal(s.frequencyResponse.high_hz, 25000);
  nodeAssert.equal(s.frequencyResponse.source, dataSheet);
  nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(s.woofer.value, 8);
  nodeAssert.equal(s.woofer.source, dataSheet);
  nodeAssert.equal(s.driverCount, 3);
  nodeAssert.equal(s.active, true);
  nodeAssert.equal(s.power.value, null, "conflicting peak/transient/continuous output ratings must not be collapsed");
  nodeAssert.equal(s.power.status, "UNAVAILABLE");
  for (const f of ["sensitivity", "impedance", "resonantFreq", "voiceCoil"]) {
    nodeAssert.equal(s[f].value, null, `${f} must remain N/A`);
  }
  nodeAssert.equal(s.frequencyResponse.points, undefined, "uncertain extracted response points are not imported");
  nodeAssert.match(s.notes, /42 Hz and ≥25 kHz/);
  nodeAssert.match(s.notes, /±2 dB band \(43 Hz–20 kHz\)/);
  nodeAssert.match(s.notes, /65\/65\/50 W peak/);
  nodeAssert.match(s.notes, /66\/66\/50 W transient/);
  nodeAssert.match(s.notes, /-20 dBu input-to-87 dB SPL statement is not passive sensitivity/);
  nodeAssert.match(s.notes, /10 kΩ balanced XLR value is input impedance, not speaker impedance/);
});

check("Genelec 4430 uses its exact launch source and does not import the 4430A revision", () => {
  const s = allDb.find((item) => item.id === "legacy-gen-8");
  assert(s, "legacy-gen-8 Genelec 4430 record is missing");
  const source = "https://www.genelec.com/-/new-genelec-4430-loudspeaker-gives-the-av-world-exceptional-sound-quality-over-ip-1";
  nodeAssert.equal(s.model, "4430");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.frequencyResponse.low_hz, 45);
  nodeAssert.equal(s.frequencyResponse.high_hz, 23000);
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.power.value, 100);
  nodeAssert.equal(s.power.role, "amplifier_output");
  nodeAssert.equal(s.power.source, source);
  nodeAssert.equal(s.woofer.value, 5);
  nodeAssert.equal(s.woofer.source, source);
  nodeAssert.equal(s.driverCount, 2);
  nodeAssert.equal(s.active, true);
  for (const f of ["sensitivity", "impedance", "resonantFreq", "voiceCoil"]) {
    nodeAssert.equal(s[f].value, null, `${f} must remain N/A`);
  }
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.match(s.notes, /names the model 4430 \(without an A suffix\)/);
  nodeAssert.match(s.notes, /different upper -6 dB limit \(39 kHz\)/);
  nodeAssert.match(s.notes, /not transferred to this unqualified 4430 record/);
});

check("Genelec 8020C retains only exact-model specifications and keeps active-system ratings distinct", () => {
  const s = allDb.find((item) => item.id === "genelec-8020c");
  assert(s, "genelec-8020c record is missing");
  const dataSheet = "https://assets.ctfassets.net/4zjnzn055a4v/8E5jwhoZgs828IQGqCq22/db2095584f86c40fb8112ba117055286/8020C_datasheet.pdf";
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.frequencyResponse.low_hz, 66);
  nodeAssert.equal(s.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(s.frequencyResponse.source, dataSheet);
  nodeAssert.equal(s.power.value, 40, "sum of 20 W bass and 20 W treble amplifier outputs");
  nodeAssert.equal(s.power.role, "amplifier_output");
  nodeAssert.equal(s.power.source, dataSheet);
  nodeAssert.equal(s.woofer.value, 4, "manufacturer's nominal 4-inch driver size");
  nodeAssert.equal(s.woofer.source, dataSheet);
  nodeAssert.equal(s.driverCount, 2);
  nodeAssert.equal(s.active, true);
  for (const f of ["sensitivity", "impedance", "resonantFreq", "voiceCoil"]) {
    nodeAssert.equal(s[f].value, null, `${f} must remain N/A`);
    nodeAssert.equal(s[f].status, "UNAVAILABLE", `${f} must not be inferred`);
  }
  nodeAssert.equal(s.frequencyResponse.points, undefined, "ambiguous dated/generic-8020 curve points are not imported");
  nodeAssert.match(s.notes, /66 Hz–20 kHz \(±2\.5 dB\)/);
  nodeAssert.match(s.notes, /-3 dB cutoff bounds are ≤65 Hz and ≥21 kHz/);
  nodeAssert.match(s.notes, /not a passive sensitivity rating/);
  nodeAssert.match(s.notes, /8 Ω amplifier test load is not the speaker's impedance/);
  nodeAssert.match(s.notes, /No response-point table or directivity data was imported/);
});

check("Genelec 7060C remains unavailable after the official archive fails to establish that model", () => {
  assertPreservedUnavailable("genelec-7060c");
  const refs = removedById.get("genelec-7060c")?.sourceRefs ?? [];
  assert(refs.includes("https://www.genelec.com/previous-models/7060a"));
  assert(refs.includes("https://www.genelec.com/previous-models/7060b"));
  assert(refs.includes("https://www.genelec.com/previous-models/7060c"));
  nodeAssert.match(removedById.get("genelec-7060c")?.reason ?? "", /No exact Genelec 7060C/);
});

check("Marshall passive guitar cabinets retain exact ratings and omit mode-ambiguous impedance", () => {
  const cases = [
    { id: "marshall-marshall-1960a", source: "https://www.marshall.com/us/en/product/1960a-4x12-angled-cabinet?pid=1007269", power: 300, drivers: 4, woofer: 12, impedance: null },
    { id: "marshall-marshall-1960b", source: "https://www.marshall.com/us/en/support/amps/support-for-1960b-4x12-base-cabinet", power: 300, drivers: 4, woofer: 12, impedance: null },
    { id: "marshall-marshall-1960av", source: "https://www.marshall.com/us/en/support/amps/support-for-1960av-4x12-angled-cabinet", power: 280, drivers: 4, woofer: 12, impedance: null },
    { id: "marshall-marshall-1960bv", source: "https://www.marshall.com/us/en/support/amps/support-for-1960bv-4x12-base-cabinet", power: 280, drivers: 4, woofer: 12, impedance: null },
    { id: "marshall-marshall-1936", source: "https://www.marshall.com/us/en/product/1936-2x12-cabinet?pid=1007263", power: 150, drivers: 2, woofer: 12, impedance: null },
    { id: "marshall-marshall-1936v", source: "https://www.marshall.com/us/en/product/1936v-2x12-cabinet?pid=1007266", power: 140, drivers: 2, woofer: 12, impedance: null },
    { id: "marshall-marshall-mx112", source: "https://www.marshall.com/us/en/product/mx112-1x12-cabinet?pid=1007173", power: 80, drivers: 1, woofer: 12, impedance: 16 },
    { id: "marshall-marshall-mx212", source: "https://www.marshall.com/us/en/product/mx212-2x12-cabinet?pid=1007176", power: 160, drivers: 2, woofer: 12, impedance: 8 },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.brand, "Marshall");
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.category, "guitar-cab");
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.active, false);
    nodeAssert.equal(s.impedance.value, c.impedance, `${c.id}: do not collapse multi-mode impedance options into one number`);
    if (c.impedance === null) {
      nodeAssert.equal(s.impedance.status, "UNAVAILABLE");
      nodeAssert.equal(s.impedance.source, null);
    } else {
      nodeAssert.equal(s.impedance.status, "MANUFACTURER_VERIFIED");
      nodeAssert.equal(s.impedance.source, c.source);
      nodeAssert.equal(s.impedance.sourceType, "MANUFACTURER");
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null, `${c.id}: no response bounds are published`);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    for (const f of ["sensitivity", "resonantFreq", "voiceCoil"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}: ${f} remains unavailable`);
    }
    nodeAssert.match(s.notes, /passive/i);
    nodeAssert.match(s.notes, /No response curve or directivity data is imported/i);
    assert(s.notes.includes(c.source), `${c.id} notes must cite the exact manufacturer source`);
  }
  nodeAssert.match(allDb.find((item) => item.id === "marshall-marshall-1960b")?.notes ?? "", /direct product route previously returned Page not found/i);
  nodeAssert.match(allDb.find((item) => item.id === "marshall-marshall-1960av")?.notes ?? "", /GENERAL\/Model cell is mislabeled 1960A/i);
});

check("Marshall active speakers retain published ranges and distinguish amp output from sensitivity", () => {
  const cases = [
    { id: "marshall-marshall-acton-iii", source: "https://www.marshall.com/us/en/product/acton-iii?pid=1006008", low: 45, high: 20000, power: 60, drivers: null, woofer: null, category: "hifi" },
    { id: "marshall-marshall-stanmore-iii", source: "https://www.marshall.com/us/en/product/stanmore-iii?pid=1009642", low: 45, high: 20000, power: 80, drivers: null, woofer: null, category: "hifi" },
    { id: "marshall-marshall-woburn-iii", source: "https://www.marshall.com/us/en/product/woburn-iii?pid=1006020", low: 35, high: 20000, power: null, drivers: null, woofer: null, category: "hifi" },
    { id: "marshall-marshall-middleton", source: "https://www.marshall.com/us/en/product/middleton?pid=1006034", low: 50, high: 20000, power: 60, drivers: 4, woofer: 3, category: "portable" },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.brand, "Marshall");
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.category, c.category);
    nodeAssert.equal(s.active, true);
    nodeAssert.equal(s.driverCount, c.drivers, `${c.id}: do not infer driver count from amplifier channels`);
    nodeAssert.equal(s.woofer.value, c.woofer, `${c.id}: only an explicitly published woofer size is populated`);
    nodeAssert.equal(s.power.value, c.power);
    if (c.power === null) {
      nodeAssert.equal(s.power.source, null, `${c.id}: the arithmetic sum of channel ratings is not a published power value`);
      nodeAssert.equal(s.power.status, "UNAVAILABLE");
    } else {
      nodeAssert.equal(s.power.role, "amplifier_output", `${c.id}: integrated amplifier ratings are not speaker power handling`);
      nodeAssert.equal(s.power.source, c.source);
      nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
      nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: published limits are not response-curve points`);
    for (const f of ["sensitivity", "impedance", "resonantFreq", "voiceCoil"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}: ${f} remains N/A`);
    }
    nodeAssert.match(s.notes, /no response tolerance or measurement conditions stated/i);
    nodeAssert.match(s.notes, /maximum SPL, not sensitivity/i);
    nodeAssert.match(s.notes, /arithmetic sum/i);
    if (c.power !== null) nodeAssert.match(s.notes, /amplifier_output/i);
    nodeAssert.match(s.notes, /no (?:response )?curve or directivity data is imported/i);
    assert(s.notes.includes(c.source), `${c.id} notes must cite the exact manufacturer source`);
  }
  nodeAssert.match(allDb.find((item) => item.id === "marshall-marshall-middleton")?.notes ?? "", /passive radiators are not counted as drivers/i);
});

check("Focal active Trio6 monitors preserve exact model generation, published ranges, and amplifier roles", () => {
  const cases = [
    {
      id: "focal-trio6",
      source: "https://media.focal-naim.com/dam/trio6/fp_trio_6_black_en.pdf",
      low: 35,
      high: 40000,
      power: 250,
      woofer: 8,
      notes: /current ST6 monitor \(not the earlier Trio6 Be\)/i,
    },
    {
      id: "legacy-focal-5",
      source: "https://www.bhphotovideo.com/lit_files/115920.pdf",
      low: 35,
      high: 40000,
      power: 450,
      woofer: 8,
      notes: /manufacturer-authored and mirrored at B&H/i,
    },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.brand, "Focal");
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.category, "studio-monitor");
    nodeAssert.equal(s.active, true);
    nodeAssert.equal(s.driverCount, 3);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: published limits are not response-curve points`);
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.role, "amplifier_output");
    nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
    for (const f of ["sensitivity", "impedance", "resonantFreq", "voiceCoil"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}: ${f} remains N/A`);
      nodeAssert.equal(s[f].status, "UNAVAILABLE", `${c.id}: ${f} is not a published speaker-level measurement`);
    }
    assert(c.notes.test(s.notes), `${c.id}: exact generation/source context is missing`);
    nodeAssert.match(s.notes, /not sensitivity/i);
    nodeAssert.match(s.notes, /not driver impedance/i);
    nodeAssert.match(s.notes, /directivity dataset is imported/i);
    assert(s.notes.includes(c.source), `${c.id} notes must cite its exact source`);
  }
});

check("Focal Utopia Evo data retain sensitivity references and do not mislabel recommended amp ranges", () => {
  const cases = [
    { id: "focal-scala-utopia-evo", source: "https://media.focal-naim.com/dam/scala-utopia-evo/fp_scala_utopia_evo_en.pdf", low: 27, high: 40000, sensitivity: 92, woofer: 11, drivers: 3 },
    { id: "focal-maestro-utopia-evo", source: "https://media.focal-naim.com/dam/maestro-utopia-evo/notice_maestroutopiaevo_codo1510_bc_web.pdf", low: 25, high: 40000, sensitivity: 93, woofer: 11, drivers: 4 },
    { id: "focal-grande-utopia-em-evo", source: "https://media.focal-naim.com/dam/grande-utopia-em-evo/notice_grandeutopiaemevo_web.pdf", low: 18, high: 40000, sensitivity: 94, woofer: 16, drivers: 5 },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.brand, "Focal");
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.category, "hifi");
    nodeAssert.equal(s.active, false);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.woofer.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.impedance.value, 8);
    nodeAssert.equal(s.impedance.source, c.source);
    nodeAssert.equal(s.power.value, null, `${c.id}: recommended amplifier ranges must not become power handling`);
    nodeAssert.equal(s.power.status, "UNAVAILABLE");
    nodeAssert.equal(s.power.source, null);
    nodeAssert.match(s.notes, /recommended amplifier power, not speaker power handling/i);
    nodeAssert.match(s.notes, /no response points are digitized|response graph is not digitized/i);
    nodeAssert.match(s.notes, /no directivity dataset is imported/i);
    assert(s.notes.includes(c.source), `${c.id} notes must cite its exact source`);
  }
});

check("Focal pre-Evo Scala records remain unavailable until exact V1/V2 identity is established", () => {
  const cases = [
    {
      id: "focal-utopia-scala",
      model: "Scala Utopia III",
      notes: /does not identify the non-Evo V1\/V2 revision/i,
      sources: [
        "https://www.manualslib.com/manual/456276/Focal-Scala-Utopia.html?page=13",
        "https://www.manualslib.com/manual/1230420/Focal-Scala-V2-Utopia.html?page=11",
      ],
    },
    {
      id: "legacy-focal-3",
      model: "Utopia III Scala",
      notes: /no alias\/deduplication is assumed/i,
      sources: [
        "https://www.manualslib.com/manual/456276/Focal-Scala-Utopia.html?page=13",
        "https://www.manualslib.com/manual/1230420/Focal-Scala-V2-Utopia.html?page=11",
      ],
    },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
    nodeAssert.equal(s.active, null);
    nodeAssert.equal(s.driverCount, null);
    nodeAssert.equal(s.frequencyResponse.low_hz, null);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.equal(s.frequencyResponse.status, "UNAVAILABLE");
    nodeAssert.equal(s.frequencyResponse.source, null);
    nodeAssert.equal(s.sensitivity.value, null);
    nodeAssert.equal(s.sensitivity.status, "UNAVAILABLE");
    nodeAssert.equal(s.impedance.value, null);
    nodeAssert.equal(s.impedance.status, "UNAVAILABLE");
    nodeAssert.equal(s.power.value, null);
    nodeAssert.equal(s.woofer.value, null);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    nodeAssert.match(s.notes, c.notes);
    for (const source of c.sources) assert(s.notes.includes(source), `${c.id} notes must preserve its revision research: ${source}`);
  }
});

check("Focal Kanta No2 alias remains preserved as unavailable while the canonical exact model remains", () => {
  const canonical = allDb.find((item) => item.id === "focal-kanta-n-2");
  assert(canonical, "focal-kanta-n-2 must remain as the canonical exact-model record");
  assertPreservedUnavailable("legacy-focal-7");
  const source = "https://media.focal-naim.com/dam/kanta-n-2/fp_kanta_n-2_en.pdf";
  nodeAssert.equal(canonical.model, "Kanta N°2");
  nodeAssert.equal(canonical.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(canonical.frequencyResponse.source, source);
  nodeAssert.equal(removedById.get("legacy-focal-7")?.disposition, "duplicate-alias");
  assert(removedById.get("legacy-focal-7")?.sourceRefs.includes(source), "the removal ledger must retain the exact Focal model sheet");
});

check("Focal Electra 1027 Be uses its exact official table row and keeps amplifier recommendations out of power", () => {
  const s = allDb.find((item) => item.id === "legacy-focal-2");
  assert(s, "legacy-focal-2 must remain in the database");
  const source = "https://media.focal-naim.com/dam/electra-sw1000-be/notice_electra1000_be-s.pdf";
  nodeAssert.equal(s.model, "Electra 1027Be");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.category, "hifi");
  nodeAssert.equal(s.active, false);
  nodeAssert.equal(s.driverCount, 4);
  nodeAssert.equal(s.frequencyResponse.low_hz, 38);
  nodeAssert.equal(s.frequencyResponse.high_hz, 40000);
  nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.equal(s.sensitivity.value, 91);
  nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.impedance.value, 8);
  nodeAssert.equal(s.impedance.source, source);
  nodeAssert.equal(s.woofer.value, 6.5);
  nodeAssert.equal(s.woofer.source, source);
  nodeAssert.equal(s.power.value, null, "40–300 W is recommended amplifier power, not speaker handling");
  nodeAssert.equal(s.power.status, "UNAVAILABLE");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  nodeAssert.match(s.notes, /exact Electra 1027 Be row/i);
  nodeAssert.match(s.notes, /recommended amplifier power, not speaker power handling/i);
  nodeAssert.match(s.notes, /no response points are digitized/i);
  nodeAssert.match(s.notes, /no directivity dataset is imported/i);
  assert(s.notes.includes(source), "Electra 1027Be notes must cite the exact official manual");
});

check("Focal Chorus 707 is not merged with 707 S and retains exact legacy source roles", () => {
  const s = allDb.find((item) => item.id === "legacy-focal-1");
  assert(s, "legacy-focal-1 must remain in the database");
  const source = "https://www.tnt-audio.com/casse/jmchorus707_e.html";
  nodeAssert.equal(s.model, "Chorus 707");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.category, "hifi");
  nodeAssert.equal(s.active, null, "do not infer the nullable active/passive flag from a review");
  nodeAssert.equal(s.driverCount, 2);
  nodeAssert.equal(s.frequencyResponse.low_hz, 54);
  nodeAssert.equal(s.frequencyResponse.high_hz, 22000);
  nodeAssert.equal(s.frequencyResponse.status, "REPUTABLE_DATABASE_VERIFIED");
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.equal(s.sensitivity.value, 91.5);
  nodeAssert.equal(s.sensitivity.reference, "1W/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.sensitivity.status, "REPUTABLE_DATABASE_VERIFIED");
  nodeAssert.equal(s.impedance.value, 8);
  nodeAssert.equal(s.impedance.source, source);
  nodeAssert.equal(s.power.value, 100);
  nodeAssert.equal(s.power.role, "program_rating");
  nodeAssert.equal(s.power.source, source);
  nodeAssert.equal(s.woofer.value, 178);
  nodeAssert.equal(s.woofer.unit, "mm", "retain the exact published driver unit");
  nodeAssert.equal(s.woofer.source, source);
  nodeAssert.match(s.notes, /not Chorus 707 S/i);
  nodeAssert.match(s.notes, /100 W maximum permissible program-material power/i);
  nodeAssert.match(s.notes, /recommended amplifier range is not collapsed/i);
  nodeAssert.match(s.notes, /no response points are digitized/i);
  nodeAssert.match(s.notes, /no directivity dataset is imported/i);
  assert(s.notes.includes(source), "Chorus 707 notes must cite its exact-model review");
});

check("ADAM Audio exact active monitors retain published response cutoffs and amplifier-output roles", () => {
  const cases = [
    { id: "adam-a4v", model: "A4V", source: "https://www.adam-audio.com/en/a-series/a4v/", low: 52, high: 45000, cutoff: /at -6 dB/i, power: 130, powerType: /peak internal amplifier power/i, woofer: 4, drivers: 2 },
    { id: "adam-a8h", model: "A8H", source: "https://www.adam-audio.com/en/a-series/a8h/", low: 31, high: 45000, cutoff: /at -6 dB/i, power: 340, powerType: /peak internal amplifier power/i, woofer: 8, drivers: 3 },
    { id: "legacy-adam-4", model: "A7V", source: "https://www.adam-audio.com/en/a-series/a7v/", low: 40, high: 45000, cutoff: /at -6 dB/i, power: 130, powerType: /peak internal amplifier power/i, woofer: 7, drivers: 2 },
    { id: "legacy-adam-6", model: "S2V", source: "https://www.adam-audio.com/en/s-series/s2v/", low: 35, high: 50000, cutoff: /at -20 dB/i, power: 350, powerType: /350 W RMS sum/i, woofer: 7, drivers: 2 },
    { id: "adam-audio-s3h", model: "S3H", source: "https://www.adam-audio.com/en/s-series/s3h/", low: 30, high: 50000, cutoff: /at -20 dB/i, power: 1350, powerType: /1,350 W total RMS amplifier output/i, woofer: 7, drivers: 4 },
    { id: "adam-audio-s3v", model: "S3V", source: "https://www.adam-audio.com/en/s-series/s3v/", low: 32, high: 50000, cutoff: /at -20 dB/i, power: 850, powerType: /850 W total/i, woofer: 9, drivers: 3 },
    { id: "adam-audio-s5h", model: "S5H", source: "https://www.adam-audio.com/en/s-series/s5h/", low: 22, high: 50000, cutoff: /at -20 dB/i, power: 1100, powerType: /1,100 W total RMS/i, woofer: 10, drivers: 4 },
    { id: "adam-audio-t7v", model: "T7V", source: "https://www.adam-audio.com/en/t-series/t7v/", low: 39, high: 25000, cutoff: /at -6 dB/i, power: 70, powerType: /70 W total RMS/i, woofer: 7, drivers: 2 },
    { id: "adam-audio-t8v", model: "T8V", source: "https://www.adam-audio.com/en/t-series/t8v/", low: 33, high: 25000, cutoff: /at -6 dB/i, power: 90, powerType: /90 W total RMS/i, woofer: 8, drivers: 2 },
    { id: "adam-audio-a44h", model: "A44H", source: "https://www.adam-audio.com/en/a-series/a44h/", low: 46, high: 45000, cutoff: /at -6 dB/i, power: 130, powerType: /peak internal amplifier power/i, woofer: 4, drivers: 3 },
    { id: "adam-audio-a77h", model: "A77H", source: "https://www.adam-audio.com/en/a-series/a77h/", low: 34, high: 45000, cutoff: /at -6 dB/i, power: 340, powerType: /peak internal amplifier power/i, woofer: 7, drivers: 4 },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.category, "studio-monitor");
    nodeAssert.equal(s.active, true);
    nodeAssert.equal(s.driverCount, c.drivers);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.role, "amplifier_output");
    nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.woofer.value, c.woofer);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.sensitivity.value, null, `${c.id}: max SPL is not sensitivity`);
    nodeAssert.equal(s.impedance.value, null, `${c.id}: active line-input data is not driver impedance`);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    nodeAssert.match(s.notes, c.cutoff);
    nodeAssert.match(s.notes, c.powerType);
    nodeAssert.match(s.notes, /not sensitivity/i);
    nodeAssert.match(s.notes, /no response points or directivity dataset is imported/i);
    assert(s.notes.includes(c.source), `${c.id} notes must cite its exact official page`);
  }
  const s3h = allDb.find((item) => item.id === "adam-audio-s3h");
  assert(s3h, "adam-audio-s3h must remain in the database");
  nodeAssert.match(s3h.notes, /not summed or used to derive the total/i, "preserve the S3H page's component-versus-total amp-rating ambiguity");
});

check("ADAM archived monitors retain exact revision sources and leave unsupported fields unavailable", () => {
  const s3x = allDb.find((item) => item.id === "adam-s3x");
  assert(s3x, "adam-s3x must remain the S3X-V record");
  const s3xSource = "https://www.adam-audio.com/en/sx-series/s3x-v/";
  nodeAssert.equal(s3x.model, "S3X-V", "do not transfer S3V successor data to the S3X-V");
  nodeAssert.equal(s3x.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s3x.category, "studio-monitor");
  nodeAssert.equal(s3x.active, true);
  nodeAssert.equal(s3x.driverCount, 3);
  nodeAssert.equal(s3x.frequencyResponse.low_hz, 32);
  nodeAssert.equal(s3x.frequencyResponse.high_hz, 50000);
  nodeAssert.equal(s3x.frequencyResponse.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(s3x.frequencyResponse.source, s3xSource);
  nodeAssert.equal(s3x.frequencyResponse.points, undefined);
  nodeAssert.equal(s3x.woofer.value, 9);
  nodeAssert.equal(s3x.woofer.unit, "in");
  nodeAssert.equal(s3x.woofer.source, s3xSource);
  nodeAssert.equal(s3x.power.value, null, "do not derive a total from channel-specific amplifier ratings");
  nodeAssert.equal(s3x.sensitivity.value, null, "maximum SPL is not sensitivity");
  nodeAssert.equal(s3x.impedance.value, null, "line-input impedance is not transducer impedance");
  nodeAssert.equal(s3x.voiceCoil.value, null, "do not collapse multiple driver coil sizes into one scalar");
  nodeAssert.match(s3x.notes, /without a stated dB tolerance/i);
  nodeAssert.match(s3x.notes, /no total power value is imported/i);
  nodeAssert.match(s3x.notes, /not sensitivity/i);
  assert(s3x.notes.includes(s3xSource), "S3X-V notes must cite its exact archived product page");

  const a5x = allDb.find((item) => item.id === "adam-a5x");
  assert(a5x, "adam-a5x must remain in the database");
  const a5xSource = "https://www.adam-audio.com/en/ax-series/a5x/";
  nodeAssert.equal(a5x.model, "A5X");
  nodeAssert.equal(a5x.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(a5x.category, "studio-monitor");
  nodeAssert.equal(a5x.active, true);
  nodeAssert.equal(a5x.driverCount, 2);
  nodeAssert.equal(a5x.frequencyResponse.low_hz, 50);
  nodeAssert.equal(a5x.frequencyResponse.high_hz, 50000);
  nodeAssert.equal(a5x.frequencyResponse.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(a5x.frequencyResponse.source, a5xSource);
  nodeAssert.equal(a5x.frequencyResponse.points, undefined);
  nodeAssert.equal(a5x.power.value, 100);
  nodeAssert.equal(a5x.power.role, "amplifier_output");
  nodeAssert.equal(a5x.power.source, a5xSource);
  nodeAssert.equal(a5x.woofer.value, 5.5);
  nodeAssert.equal(a5x.woofer.unit, "in");
  nodeAssert.equal(a5x.woofer.source, a5xSource);
  nodeAssert.equal(a5x.sensitivity.value, null);
  nodeAssert.equal(a5x.impedance.value, null);
  nodeAssert.equal(a5x.voiceCoil.value, null, "do not resolve the source's in/mm discrepancy by conversion");
  nodeAssert.match(a5x.notes, /at -10 dB/i);
  nodeAssert.match(a5x.notes, /100 W RMS \/ 150 W music/i);
  nodeAssert.match(a5x.notes, /30 kOhm impedance.*not the driver impedance/i);
  nodeAssert.match(a5x.notes, /1.5 inches with 32 mm, which is inconsistent/i);
  nodeAssert.match(a5x.notes, /not sensitivity/i);
  assert(a5x.notes.includes(a5xSource), "A5X notes must cite its exact archived product page");

  const s3a = allDb.find((item) => item.id === "legacy-adam-1");
  assert(s3a, "legacy-adam-1 must remain the S3A record");
  const s3aSource = "https://www.soundonsound.com/reviews/adam-s3a";
  nodeAssert.equal(s3a.model, "S3A");
  nodeAssert.equal(s3a.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s3a.category, "studio-monitor");
  nodeAssert.equal(s3a.active, true);
  nodeAssert.equal(s3a.driverCount, 3);
  nodeAssert.equal(s3a.frequencyResponse.low_hz, 32);
  nodeAssert.equal(s3a.frequencyResponse.high_hz, 35000);
  nodeAssert.equal(s3a.frequencyResponse.status, "REPUTABLE_DATABASE_VERIFIED");
  nodeAssert.equal(s3a.frequencyResponse.sourceType, "REPUTABLE_DATABASE");
  nodeAssert.equal(s3a.frequencyResponse.source, s3aSource);
  nodeAssert.equal(s3a.frequencyResponse.points, undefined);
  nodeAssert.equal(s3a.woofer.value, 186);
  nodeAssert.equal(s3a.woofer.unit, "mm");
  nodeAssert.equal(s3a.woofer.source, s3aSource);
  nodeAssert.equal(s3a.voiceCoil.value, 39);
  nodeAssert.equal(s3a.voiceCoil.unit, "mm");
  nodeAssert.equal(s3a.voiceCoil.source, s3aSource);
  nodeAssert.equal(s3a.power.value, null, "do not sum per-section amplifier output into an unpublished total");
  nodeAssert.equal(s3a.sensitivity.value, null, "do not map review SPL wording to sensitivity");
  nodeAssert.equal(s3a.impedance.value, null);
  nodeAssert.equal(s3a.resonantFreq.value, null);
  nodeAssert.match(s3a.notes, /±3 dB/i);
  nodeAssert.match(s3a.notes, /A\/B variants differ/i);
  nodeAssert.match(s3a.notes, /no aggregate power value is derived/i);
  nodeAssert.match(s3a.notes, /response\/directivity datasets remain unavailable/i);
  assert(s3a.notes.includes(s3aSource), "S3A notes must cite the exact-model review");
  assert(s3a.notes.includes("https://www.adam-audio.com/content/uploads/2016/12/adam-audio-user-manual-S3A-en-de.pdf"), "S3A notes must retain the exact manufacturer manual");
});

check("JL Audio C1–C5 component-system manuals preserve exact model identity, power roles, and sensitivity references", () => {
  const cases = [
    {
      id: "jl-audio-c1-650", model: "C1-650", source: "https://www.bobscb.com/PDGManuals/C1-650_MAN.pdf",
      sensitivity: 90.5, low: 48, high: 24000, power: 50, voiceCoil: 1,
      responseContext: /48 Hz–24 kHz ±3 dB/i,
      sensitivityContext: /90\.5 dB @ 1 W\/1 m.*93\.0 dB @ 2\.83 V\/1 m/i,
    },
    {
      id: "jl-audio-c2-650", model: "C2-650", source: "https://www.customsounds.com/uploads/docs/c9cdf2869634c6380c417594003675792e7c0f6a.pdf",
      sensitivity: 91, low: 59, high: 22000, power: 60, voiceCoil: 1,
      responseContext: /59 Hz–22 kHz ±3 dB/i,
      sensitivityContext: /91\.0 dB @ 1 W\/1 m.*94\.0 dB @ 2\.83 V\/1 m/i,
    },
    {
      id: "jl-audio-c3-650", model: "C3-650", source: "https://tacotunes.com/wp-content/uploads/2013/02/JL-Audio-C3-650-Component-Speakers-Manual.pdf",
      sensitivity: 90, low: 48, high: 25000, power: 75, voiceCoil: 1.2,
      responseContext: /48 Hz–25 kHz ±3 dB/i,
      sensitivityContext: /90\.0 dB efficiency @ 1 W\/1 m/i,
    },
    {
      id: "jl-audio-c5-650", model: "C5-650", source: "https://tacotunes.com/wp-content/uploads/2013/02/JL-Audio-C5-650-Component-Speakers-Manual.pdf",
      sensitivity: 89.5, low: 48, high: 25000, power: 75, voiceCoil: 1,
      responseContext: /48 Hz–25 kHz ±3 dB/i,
      sensitivityContext: /89\.5 dB efficiency @ 1 W\/1 m/i,
    },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model, `${c.id}: do not transfer sibling or suffix-variant specifications`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.category, "car-audio");
    nodeAssert.equal(s.active, false, `${c.id}: manual identifies a passive, externally amplified component system`);
    nodeAssert.equal(s.driverCount, 2, `${c.id}: two-way transducer complement per speaker side`);
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "1W/1m");
    nodeAssert.equal(s.sensitivity.source, c.source);
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.power.value, c.power);
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.impedance.value, 4);
    nodeAssert.equal(s.impedance.unit, "ohm");
    nodeAssert.equal(s.impedance.source, c.source);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.source);
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${c.id}: response limits are not a response-point curve`);
    nodeAssert.equal(s.woofer.value, 6.5);
    nodeAssert.equal(s.woofer.unit, "in");
    nodeAssert.equal(s.woofer.source, c.source);
    nodeAssert.equal(s.voiceCoil.value, c.voiceCoil, `${c.id}: voice coil value refers to the woofer, not the tweeter`);
    nodeAssert.equal(s.voiceCoil.unit, "in");
    nodeAssert.equal(s.voiceCoil.source, c.source);
    nodeAssert.equal(s.resonantFreq.value, null, `${c.id}: no exact system resonance is entered`);
    nodeAssert.equal(s.resonantFreq.status, "UNAVAILABLE");
    nodeAssert.match(s.notes, c.responseContext);
    nodeAssert.match(s.notes, c.sensitivityContext);
    nodeAssert.match(s.notes, /recommended-amplifier range is not stored|recommended-amplifier figure is promoted|Only continuous power handling is stored/i);
    nodeAssert.match(s.notes, /no response points, resonance or directivity data are imported/i);
    assert(s.notes.includes(c.source), `${c.id} notes must cite its fetched exact-model JL Audio manual`);
  }

});

check("JL Audio W7AE exact variant and W3v3 family data preserve model and impedance distinctions", () => {
  const w7 = allDb.find((item) => item.id === "jl-audio-12w7");
  assert(w7, "jl-audio-12w7 must remain in the database");
  const w7Manual = "https://www.customsounds.com/uploads/docs/bfc1f121b179e56fca7601472aec1319b5338fcd.pdf";
  const w7Product = "https://www.garmin.com/en-US/p/1669677/pn/010-03031-00/";
  nodeAssert.equal(w7.model, "12W7AE-3", "the exact 3-ohm Anniversary Edition variant must be retained");
  nodeAssert.equal(w7.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(w7.category, "car-audio");
  nodeAssert.equal(w7.active, false, "12W7AE-3 is a passive driver, not a powered subwoofer");
  nodeAssert.equal(w7.driverCount, 1);
  nodeAssert.equal(w7.sensitivity.value, 86.2);
  nodeAssert.equal(w7.sensitivity.reference, "1W/1m", "retain the manual's explicit SPL reference");
  nodeAssert.equal(w7.sensitivity.source, w7Manual);
  nodeAssert.equal(w7.power.value, 1000);
  nodeAssert.equal(w7.power.role, "speaker_power_handling");
  nodeAssert.equal(w7.power.source, w7Manual);
  nodeAssert.equal(w7.impedance.value, 3);
  nodeAssert.equal(w7.impedance.source, w7Manual);
  nodeAssert.equal(w7.resonantFreq.value, 27.2);
  nodeAssert.equal(w7.resonantFreq.source, w7Manual);
  nodeAssert.equal(w7.woofer.value, 12);
  nodeAssert.equal(w7.woofer.source, w7Product, "nominal size comes from the exact JL Audio product page");
  nodeAssert.equal(w7.voiceCoil.value, null, "no physical voice-coil diameter is published in the manual");
  nodeAssert.equal(w7.frequencyResponse.low_hz, null, "do not infer response bounds from recommended amplifier settings");
  nodeAssert.equal(w7.frequencyResponse.high_hz, null);
  assert(w7.notes.includes(w7Manual), "W7AE provenance note must retain the exact manual URL");
  assert(w7.notes.includes(w7Product), "W7AE provenance note must retain the exact product-page URL");

  const familyCases = [
    {
      id: "jl-audio-10w3v3", model: "10W3v3", size: 10,
      source: "https://www.customsounds.com/uploads/docs/377c821058ecf356e1c0be4aa8bd69a2260bcc04.pdf",
      variants: /10W3v3-2, -4, and -8/i,
      variantEvidence: /85\.37\/84\.87\/85\.22 dB.*32\.97\/31\.49\/32\.60 Hz.*2\/4\/8 ohms/i,
    },
    {
      id: "jl-audio-12w3v3", model: "12W3v3", size: 12,
      source: "https://onlinecarstereo.blob.core.windows.net/www/cms/2024/JL%20Audio/13612W3V32.pdf",
      variants: /12W3v3-2, -4, and -8/i,
      variantEvidence: /87\.15\/87\.15\/87\.02 dB.*27\.97\/26\.72\/28\.28 Hz.*2\/4\/8 ohms/i,
    },
  ];
  for (const c of familyCases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model, `${c.id} remains the unsuffixed family record`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.category, "car-audio");
    nodeAssert.equal(s.active, false);
    nodeAssert.equal(s.driverCount, 1);
    nodeAssert.equal(s.power.value, 500, "500 W continuous handling is common to every listed variant");
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.power.source, c.source);
    nodeAssert.equal(s.woofer.value, c.size, "nominal diameter is common across all listed variants");
    nodeAssert.equal(s.woofer.source, c.source);
    for (const f of ["sensitivity", "impedance", "resonantFreq", "voiceCoil"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}.${f} remains N/A where the family variants differ or the manual is silent`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null, "enclosure F3 is not the driver's standardized response limit");
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    assert(s.notes.includes(c.source), `${c.id} notes must cite its exact v3 family manual`);
    nodeAssert.match(s.notes, c.variants);
    nodeAssert.match(s.notes, c.variantEvidence);
    nodeAssert.match(s.notes, /remain N\/A on this unsuffixed record/i);
  }
});

check("unresolved JL Audio suffix and component identities remain individually documented and unpopulated", () => {
  const cases = [
    {
      id: "jl-audio-10w0v3", model: "10W0v3",
      sources: ["https://www.garmin.com/en-US/p/1666237/pn/010-03039-00/", "https://www.customsounds.com/uploads/docs/41f18bef9ad076e32518791d7cd04729dccfb9fd.pdf"],
      exactOtherModel: /10WØv3-4/,
    },
    {
      id: "jl-audio-12w0v3", model: "12W0v3",
      sources: ["https://www.garmin.com/en-US/p/1666237/pn/010-03040-00/", "https://www.customsounds.com/uploads/docs/6701ce5b41180ad749fd5ed190e4d4992bcde6b9.pdf"],
      exactOtherModel: /12WØv3-4/,
    },
    {
      id: "jl-audio-13w7ae", model: "13W7AE",
      sources: ["https://www.garmin.com/en-US/p/1669677/pn/010-03032-00/", "https://www.customsounds.com/uploads/docs/bfc1f121b179e56fca7601472aec1319b5338fcd.pdf"],
      exactOtherModel: /13W7AE-D1\.5/,
    },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model, `${c.id} model identity must not be silently rewritten`);
    nodeAssert.equal(s.overallStatus, "UNAVAILABLE", `${c.id} exact suffix remains unresolved rather than borrowing sibling/variant data`);
    const ledger = unresolvedAll as Record<string, any>;
    nodeAssert.equal(s.notes, ledger[c.id].note, `${c.id} needs a matching individual unresolved-identity entry`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}.${f} remains N/A without exact-model support`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.match(s.notes, c.exactOtherModel, `${c.id} notes must identify the exact documented neighboring model/variant`);
    for (const source of c.sources) assert(s.notes.includes(source), `${c.id} notes must retain ${source}`);
    nodeAssert.match(s.notes, /remain N\/A|remain unavailable|all acoustic fields remain N\/A/i);
  }
});

check("Peavey SP 2 and 6505 412 remain unavailable when manufacturer documentation proves revision ambiguity", () => {
  const cases = [
    {
      id: "peavey-sp2", model: "SP 2",
      sources: [
        "https://peavey.com/products/sp-2-1000-watt-2-way-pa-speaker",
        "https://assets.peavey.com/literature/manuals/sp2_specs.pdf",
        "https://assets.peavey.com/literature/manuals/80304850.pdf",
        "https://assets.peavey.com/literature/manuals/118801_31284.pdf",
        "https://assets.peavey.com/literature/manuals/118999_36461.pdf",
      ],
      revisionEvidence: /SP 2X specification.*SP 2 specifications over time.*SP 2P/i,
    },
    {
      id: "peavey-6505-412", model: "6505 412",
      sources: [
        "https://assets.peavey.com/literature/manuals/116183_14326.pdf",
        "https://assets.peavey.com/literature/specs/116183_16124.pdf",
        "https://assets.peavey.com/literature/manuals/119280_38585.pdf",
        "https://peavey.com/products/6505-reissue-412-straight-guitar-cabinet",
      ],
      revisionEvidence: /Sheffield 1200.*Celestion Greenback 25.*Sheffield 1230\+/i,
    },
  ];
  const ledger = unresolvedAll as Record<string, any>;
  for (const c of cases) {
    const s = allDb.find((record) => record.id === c.id);
    assert(s, `${c.id} must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
    nodeAssert.equal(s.notes, ledger[c.id].note);
    nodeAssert.match(s.notes, c.revisionEvidence, `${c.id} needs specific official revision evidence`);
    for (const source of c.sources) assert(s.notes.includes(source), `${c.id} must retain ${source}`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(s[f].value, null, `${c.id}.${f} must stay N/A`);
      nodeAssert.equal(s[f].source, null, `${c.id}.${f} must not inherit revision-specific provenance`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.equal(s.driverCount, null);
    nodeAssert.equal(s.active, null);
  }
});

check("Electro-Voice Force i and SB122 retain manufacturer response tables with context", () => {
  const force = allDb.find((s) => s.id === "eV-force-i");
  const sb122 = allDb.find((s) => s.id === "electro-voice-sb122");
  assert(force, "Force i record must remain in the database");
  assert(sb122, "SB122 record must remain in the database");

  nodeAssert.equal(force.model, "Force i");
  nodeAssert.equal(force.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(force.sensitivity.value, 100);
  nodeAssert.equal(force.sensitivity.reference, "1W/1m");
  nodeAssert.equal(force.power.value, 250, "continuous handling, not program/short-term power");
  nodeAssert.equal(force.power.role, "speaker_power_handling");
  nodeAssert.equal(force.impedance.value, 8);
  nodeAssert.equal(force.woofer.value, 15);
  nodeAssert.equal(force.active, false);
  nodeAssert.equal(force.driverCount, 2);
  nodeAssert.equal(force.frequencyResponse.low_hz, 40);
  nodeAssert.equal(force.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(force.frequencyResponse.pointsStatus, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(force.frequencyResponse.pointsSource, "https://products.electrovoice.com/binary/Force_i_E_EDS.pdf");
  assert(force.frequencyResponse.pointsContext?.includes("Half Space (SPL)"));
  assert(force.frequencyResponse.pointsContext?.includes("does not state an input/reference level"));
  nodeAssert.deepEqual(
    force.frequencyResponse.points?.map((p: { hz: number; db: number }) => [p.hz, p.db]),
    [
      [20, 73.5], [30, 85], [40, 90], [50, 95], [60, 97.5], [70, 99.5], [80, 101],
      [90, 102.5], [100, 104], [200, 100.5], [300, 100.5], [400, 98], [500, 97],
      [600, 98.5], [700, 99], [800, 98.5], [900, 98.5], [1000, 100], [2000, 101],
      [3000, 101], [4000, 99], [5000, 99], [6000, 101], [7000, 103], [8000, 102],
      [9000, 101.5], [10000, 101], [20000, 100],
    ],
  );
  assert(force.notes.includes("https://products.electrovoice.com/binary/Force_i_E_EDS.pdf"));

  nodeAssert.equal(sb122.model, "Sb122");
  nodeAssert.equal(sb122.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(sb122.sensitivity.value, 99);
  nodeAssert.equal(sb122.sensitivity.reference, "1W/1m");
  nodeAssert.equal(sb122.power.value, 400);
  nodeAssert.equal(sb122.power.role, "speaker_power_handling");
  nodeAssert.equal(sb122.impedance.value, 8);
  nodeAssert.equal(sb122.woofer.value, 12);
  nodeAssert.equal(sb122.active, false);
  nodeAssert.equal(sb122.driverCount, 1);
  nodeAssert.equal(sb122.frequencyResponse.low_hz, 43);
  nodeAssert.equal(sb122.frequencyResponse.high_hz, 200);
  nodeAssert.equal(sb122.frequencyResponse.pointsStatus, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(sb122.frequencyResponse.pointsSource, "https://products.electrovoice.com/binary/SB122%20EDS.pdf");
  assert(sb122.frequencyResponse.pointsContext?.includes("Half Space (SPL, 1W/1m, dB)"));
  nodeAssert.deepEqual(
    sb122.frequencyResponse.points?.map((p: { hz: number; db: number }) => [p.hz, p.db]),
    [
      [20, 80.3], [30, 80.5], [40, 85], [50, 92], [60, 96.5], [70, 97.5], [80, 99.5],
      [90, 101], [100, 102], [200, 94], [300, 88], [400, 82], [500, 82],
      [600, 81.5], [700, 79], [800, 76.5],
    ],
  );
  assert(sb122.notes.includes("https://products.electrovoice.com/binary/SB122%20EDS.pdf"));
});

check("Electro-Voice Sentry 500, Sx100+, and Sx300E keep exact-model fields and unavailable caveats", () => {
  const sentry = allDb.find((s) => s.id === "eV-sentry-500");
  const sx100 = allDb.find((s) => s.id === "electro-voice-sx100");
  const sx300e = allDb.find((s) => s.id === "electro-voice-sx300e");
  assert(sentry, "Sentry 500 record must remain in the database");
  assert(sx100, "Sx100+ record must remain in the database");
  assert(sx300e, "Sx300E record must remain in the database");

  nodeAssert.equal(sentry.model, "Sentry 500");
  nodeAssert.equal(sentry.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(sentry.sensitivity.value, 96);
  nodeAssert.equal(sentry.sensitivity.reference, "1W/1m");
  nodeAssert.equal(sentry.power.value, 100);
  nodeAssert.equal(sentry.power.role, "speaker_power_handling");
  nodeAssert.equal(sentry.impedance.value, 8);
  nodeAssert.equal(sentry.woofer.value, 12);
  nodeAssert.equal(sentry.active, false);
  nodeAssert.equal(sentry.driverCount, 2);
  nodeAssert.equal(sentry.frequencyResponse.low_hz, null, "ambiguous +3 dB tolerance must not be assumed to mean ±3 dB");
  nodeAssert.equal(sentry.frequencyResponse.high_hz, null);
  nodeAssert.match(sentry.notes, /300–2,000 Hz/);
  nodeAssert.match(sentry.notes, /renders its response tolerance as '\+3 dB'/);
  assert(sentry.notes.includes("https://manualzz.com/doc/22701574/electro-voice-sentry500-data-sheet"));

  nodeAssert.equal(sx100.model, "Sx100+");
  nodeAssert.equal(sx100.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(sx100.power.value, 200);
  nodeAssert.equal(sx100.power.role, "speaker_power_handling");
  nodeAssert.equal(sx100.impedance.value, 8);
  nodeAssert.equal(sx100.woofer.value, 12);
  nodeAssert.equal(sx100.active, false);
  nodeAssert.equal(sx100.driverCount, 2);
  nodeAssert.equal(sx100.frequencyResponse.low_hz, 60);
  nodeAssert.equal(sx100.frequencyResponse.high_hz, 25000);
  nodeAssert.equal(sx100.sensitivity.value, null, "98 dB has no measurement reference in the source");
  nodeAssert.match(sx100.notes, /sensitivity as 98 dB but gives no measurement reference/i);
  const sx100Source = "https://manualzz.com/doc/3125205/electro-voice-sx100--user-s-manual";
  nodeAssert.equal(sx100.power.source, sx100Source);
  nodeAssert.equal(sx100.impedance.source, sx100Source);
  nodeAssert.equal(sx100.woofer.source, sx100Source);
  nodeAssert.equal(sx100.frequencyResponse.source, sx100Source);
  assert(sx100.notes.includes(sx100Source));
  assert(sx100.notes.includes("https://manualzz.com/doc/3125205/electrovoice-sx100--user-s-manual"));
  nodeAssert.match(sx100.notes, /Both fetched Manualzz URLs/);

  nodeAssert.equal(sx300e.model, "Sx300E");
  nodeAssert.equal(sx300e.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(sx300e.sensitivity.value, 99);
  nodeAssert.equal(sx300e.sensitivity.reference, "1W/1m");
  nodeAssert.equal(sx300e.power.value, 300);
  nodeAssert.equal(sx300e.power.role, "speaker_power_handling");
  nodeAssert.equal(sx300e.impedance.value, 8);
  nodeAssert.equal(sx300e.woofer.value, 12);
  nodeAssert.equal(sx300e.active, false);
  nodeAssert.equal(sx300e.driverCount, 2);
  nodeAssert.equal(sx300e.frequencyResponse.low_hz, 50);
  nodeAssert.equal(sx300e.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(sx300e.frequencyResponse.points, undefined, "do not import ambiguous multi-column table points");
  assert(sx300e.notes.includes("Sx300E (11053031, black)"));
  assert(sx300e.notes.includes("https://products.electrovoice.com/binary/Sx300_Engineering_Data_Sheet.pdf"));
  const genericSx300 = allDb.find((s) => s.brand === "Electro-Voice" && s.model.toLowerCase() === "sx300");
  assert(genericSx300, "the separate generic Sx300 record must remain");
  assert(genericSx300.id !== sx300e.id, "Sx300E must not overwrite or merge with generic Sx300");
});

check("Electro-Voice Sx300PI and Sx300PIX remain distinct where transformer data differs", () => {
  const pi = allDb.find((s) => s.id === "electro-voice-sx300pi");
  const pix = allDb.find((s) => s.id === "electro-voice-sx300pix");
  assert(pi, "Sx300PI record must remain in the database");
  assert(pix, "Sx300PIX record must remain in the database");
  nodeAssert.equal(pi.model, "Sx300PI");
  nodeAssert.equal(pix.model, "Sx300PIX");
  assert(pi.id !== pix.id);

  nodeAssert.equal(pi.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(pi.sensitivity.value, 99);
  nodeAssert.equal(pi.sensitivity.reference, "1W/1m");
  nodeAssert.equal(pi.power.value, 300);
  nodeAssert.equal(pi.power.role, "speaker_power_handling");
  nodeAssert.equal(pi.impedance.value, 8);
  nodeAssert.equal(pi.woofer.value, 12);
  nodeAssert.equal(pi.active, false);
  nodeAssert.equal(pi.driverCount, 2);
  nodeAssert.equal(pi.frequencyResponse.low_hz, 80);
  nodeAssert.equal(pi.frequencyResponse.high_hz, 25000);
  nodeAssert.equal(pi.frequencyResponse.points, undefined, "published plots are not digitized");
  assert(pi.notes.includes("Sx300PIX"));

  nodeAssert.equal(pix.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(pix.woofer.value, 12);
  nodeAssert.equal(pix.active, false);
  nodeAssert.equal(pix.driverCount, 2);
  for (const f of ["sensitivity", "power", "impedance"]) {
    nodeAssert.equal(pix[f].value, null, `Sx300PIX.${f} must not inherit a non-transformer/tap-inappropriate scalar`);
  }
  nodeAssert.equal(pix.frequencyResponse.low_hz, null, "PI response data must not be transferred to PIX");
  nodeAssert.equal(pix.frequencyResponse.high_hz, null);
  nodeAssert.equal(pix.frequencyResponse.points, undefined);
  nodeAssert.match(pix.notes, /50\/70\/100 W and 100\/140\/200 W/);
  nodeAssert.match(pix.notes, /tap-dependent/);
  assert(pix.notes.includes("https://products.electrovoice.com/binary/Sx300PI_PIX_EDS.pdf"));
});

check("Electro-Voice Sx600 exact data are retained while unresolved Live X X2 remains unavailable", () => {
  const sx600 = allDb.find((item) => item.id === "electro-voice-sx600");
  assert(sx600, "exact-model Sx600 data must remain in the database");
  nodeAssert.equal(sx600.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(sx600.frequencyResponse.pointsSource, "https://products.electrovoice.com/binary/Sx600_High_Output_Two-way_Loudspeaker_Datasheet_51_en_9006674443.pdf");
  assertPreservedUnavailable("eV-live-x2");
  nodeAssert.equal(removedById.get("eV-live-x2")?.disposition, "unconfirmed-identity");
  nodeAssert.match(removedById.get("eV-live-x2")?.researchNote ?? "", /does not identify a product named “Live X X2\.”/i);
});

check("Martin Audio W8LM and d&b T10 exact manufacturer fields preserve context and unsupported values", () => {
  const w8lm = allDb.find((item) => item.id === "legacy-ma-3");
  const t10 = allDb.find((item) => item.id === "dandb-t10");
  const w8Source = "https://martin-audio.com/products/archive/w8lm";
  const w8Sheet = "https://martin-audio.com/downloads/datasheets/W8LMdatasheet.pdf";
  const t10Source = "https://www.dbaudio.com/assets/products/downloads/manuals-documentation/t-series/dbaudio-datasheet-t10-1.1-en.pdf";
  assert(w8lm && t10, "both exact model records must remain in the database");
  nodeAssert.equal(w8lm.model, "W8LM");
  nodeAssert.equal(w8lm.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(w8lm.frequencyResponse.low_hz, 60);
  nodeAssert.equal(w8lm.frequencyResponse.high_hz, 18000);
  nodeAssert.equal(w8lm.frequencyResponse.source, w8Source);
  nodeAssert.equal(w8lm.power.value, 400);
  nodeAssert.equal(w8lm.power.role, "speaker_power_handling");
  nodeAssert.equal(w8lm.impedance.value, 12);
  nodeAssert.equal(w8lm.woofer.value, 8);
  nodeAssert.equal(w8lm.voiceCoil.value, 50);
  nodeAssert.equal(w8lm.driverCount, 4);
  nodeAssert.equal(w8lm.active, false);
  nodeAssert.equal(w8lm.sensitivity.value, null, "band/mode-specific sensitivity is not collapsed to a scalar");
  nodeAssert.equal(w8lm.frequencyResponse.points, undefined, "partial 2–20 kHz data must not replace full-band limits");
  nodeAssert.match(w8lm.notes, /open 4π space, measured at 2 m and referred to 1 m/);
  nodeAssert.match(w8lm.notes, /LF\+MF \(100 dB\).*HF \(106 dB\).*99 dB rising to 105 dB/);
  assert(w8lm.notes.includes(w8Sheet));
  const w8Lead = (directivityLeads as any[]).find((lead) => lead.id === "legacy-ma-3");
  assert(w8Lead, "W8LM partial polar/beamwidth evidence must remain recorded as a lead");
  nodeAssert.equal(w8Lead.status, "LEAD_NOT_IMPORTED");
  assert(w8Lead.sources.includes(w8Sheet));

  nodeAssert.equal(t10.model, "T10");
  nodeAssert.equal(t10.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(t10.frequencyResponse.low_hz, 68);
  nodeAssert.equal(t10.frequencyResponse.high_hz, 18000);
  nodeAssert.equal(t10.frequencyResponse.source, t10Source);
  nodeAssert.equal(t10.power.value, 200);
  nodeAssert.equal(t10.power.role, "speaker_power_handling");
  nodeAssert.equal(t10.impedance.value, 16);
  nodeAssert.equal(t10.woofer.value, 6.5);
  nodeAssert.equal(t10.driverCount, 3);
  nodeAssert.equal(t10.active, false);
  nodeAssert.equal(t10.sensitivity.value, null, "maximum SPL is not sensitivity");
  nodeAssert.equal(t10.frequencyResponse.points, undefined);
  nodeAssert.match(t10.notes, /-5 dB in standard mode/);
  nodeAssert.match(t10.notes, /CUT mode changes the low-frequency limit to 120 Hz/);
  const t10Lead = (directivityLeads as any[]).find((lead) => lead.id === "dandb-t10");
  assert(t10Lead, "T10 configuration-specific dispersion must remain a directivity lead");
  nodeAssert.equal(t10Lead.status, "LEAD_NOT_IMPORTED");
  assert(t10Lead.sources.includes(t10Source));
});

check("RCF NX 45-A, Behringer B215XL, and DAS Aero 12A retain exact sourced fields and rating limits", () => {
  const rcf = allDb.find((item) => item.id === "rcf-nx45a");
  const behringer = allDb.find((item) => item.id === "behringer-b215xl");
  const aero = allDb.find((item) => item.id === "das-audio-aero-12a");
  const rcfSource = "https://www.rcf.it/en/products/product-detail/nx-45-a";
  const behringerSource = "https://www.behringer.com/en/products/0313-ACS";
  const aeroSource = "https://www.dasaudio.com/wp-content/uploads/2011/11/TECNOLOGIAS_AERO_12A_V1.pdf";
  assert(rcf && behringer && aero, "all exact-model records must remain in the database");
  nodeAssert.equal(rcf.model, "NX 45-A");
  nodeAssert.equal(rcf.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(rcf.frequencyResponse.low_hz, 45);
  nodeAssert.equal(rcf.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(rcf.frequencyResponse.source, rcfSource);
  nodeAssert.equal(rcf.power.value, 700);
  nodeAssert.equal(rcf.power.role, "amplifier_output");
  nodeAssert.equal(rcf.woofer.value, 15);
  nodeAssert.equal(rcf.voiceCoil.value, 3.5, "voice-coil scalar is the LF woofer's published value");
  nodeAssert.equal(rcf.driverCount, 2);
  nodeAssert.equal(rcf.active, true);
  nodeAssert.equal(rcf.sensitivity.value, null, "input dBu is not acoustic sensitivity");
  nodeAssert.equal(rcf.impedance.value, null, "active system input is not a passive speaker impedance");
  nodeAssert.equal(rcf.frequencyResponse.points, undefined);
  const rcfLead = (directivityLeads as any[]).find((lead) => lead.id === "rcf-nx45a");
  assert(rcfLead, "nominal coverage remains an unimported directivity lead");
  nodeAssert.equal(rcfLead.status, "LEAD_NOT_IMPORTED");

  nodeAssert.equal(behringer.model, "B215XL");
  nodeAssert.equal(behringer.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(behringer.power.value, 1000);
  nodeAssert.equal(behringer.power.role, "speaker_power_handling");
  nodeAssert.equal(behringer.power.source, behringerSource);
  nodeAssert.equal(behringer.woofer.value, 15);
  nodeAssert.equal(behringer.driverCount, 2);
  nodeAssert.equal(behringer.active, false);
  nodeAssert.equal(behringer.sensitivity.value, null);
  nodeAssert.equal(behringer.frequencyResponse.low_hz, null);
  nodeAssert.match(behringer.notes, /without assigning a continuous, program, peak, or test-standard convention/i);

  nodeAssert.equal(aero.model, "Aero 12A");
  nodeAssert.equal(aero.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(aero.power.value, 600);
  nodeAssert.equal(aero.power.role, "amplifier_output");
  nodeAssert.equal(aero.power.source, aeroSource);
  nodeAssert.equal(aero.woofer.value, 12);
  nodeAssert.equal(aero.driverCount, 2);
  nodeAssert.equal(aero.active, true);
  nodeAssert.equal(aero.frequencyResponse.low_hz, null, "a design statement about 60 Hz is not stored as a formal response bound");
  nodeAssert.equal(aero.sensitivity.value, null);
  nodeAssert.match(aero.notes, /does not supply a formal measured response limit\/tolerance/i);
});

check("base NEXO PS15 and Turbosound iP15B keep exact revision, response provenance, and unavailable scalars", () => {
  const nexo = allDb.find((item) => item.id === "nexo-ps15");
  const turbo = allDb.find((item) => item.id === "turbosound-ip15b");
  const nexoSource = "https://www.fullcompass.com/common/files/9194-PSSeriesBrochure.pdf";
  const turboSource = "https://monthany.com/wp-content/uploads/2022/12/Turbosound_iP15B_datasheet_monthany.pdf";
  assert(nexo && turbo, "both exact subwoofer records must remain in the database");
  nodeAssert.equal(nexo.model, "PS15");
  nodeAssert.equal(nexo.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(nexo.frequencyResponse.low_hz, 50);
  nodeAssert.equal(nexo.frequencyResponse.high_hz, 18000);
  nodeAssert.equal(nexo.frequencyResponse.source, nexoSource);
  nodeAssert.equal(nexo.sensitivity.value, 99, "wideband sensitivity is used instead of the 300 Hz–3 kHz nominal figure");
  nodeAssert.equal(nexo.sensitivity.reference, "1W/1m");
  nodeAssert.equal(nexo.sensitivity.source, nexoSource);
  nodeAssert.equal(nexo.impedance.value, 8, "published passive-mode system impedance");
  nodeAssert.equal(nexo.woofer.value, 15);
  nodeAssert.equal(nexo.driverCount, 2);
  nodeAssert.equal(nexo.active, false);
  nodeAssert.equal(nexo.power.value, null, "recommended amplifier range is not speaker power handling");
  nodeAssert.equal(nexo.frequencyResponse.points, undefined);
  nodeAssert.match(nexo.notes, /base PS15 \(not PS15-R2\)/);
  nodeAssert.match(nexo.notes, /102 dB SPL nominal and 99 dB SPL wideband/);
  const nexoLead = (directivityLeads as any[]).find((lead) => lead.id === "nexo-ps15");
  assert(nexoLead, "base PS15 directivity source must remain recorded without a fabricated polar");
  nodeAssert.equal(nexoLead.status, "LEAD_NOT_IMPORTED");

  nodeAssert.equal(turbo.model, "iP15B");
  nodeAssert.equal(turbo.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(turbo.frequencyResponse.low_hz, 45);
  nodeAssert.equal(turbo.frequencyResponse.high_hz, 150);
  nodeAssert.equal(turbo.frequencyResponse.source, turboSource);
  nodeAssert.equal(turbo.frequencyResponse.points?.length, 10);
  nodeAssert.equal(turbo.frequencyResponse.points?.[0].hz, 20);
  nodeAssert.equal(turbo.frequencyResponse.points?.[0].db, 66.5);
  nodeAssert.equal(turbo.frequencyResponse.points?.[9].hz, 200);
  nodeAssert.equal(turbo.frequencyResponse.pointsStatus, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(turbo.frequencyResponse.pointsSource, turboSource);
  nodeAssert.equal(turbo.frequencyResponse.pointsSourceType, "MANUFACTURER");
  nodeAssert.match(turbo.frequencyResponse.pointsContext, /Full Range \(Sound Pressure Level, dB\)/);
  nodeAssert.equal(turbo.sensitivity.value, null, "the powered sub's electrical 4 dBu input sensitivity is not acoustic sensitivity");
  nodeAssert.equal(turbo.power.value, null, "conflicting internal amplifier ratings are not collapsed");
  nodeAssert.equal(turbo.impedance.value, null);
  nodeAssert.equal(turbo.woofer.value, 15);
  nodeAssert.equal(turbo.driverCount, 1);
  nodeAssert.equal(turbo.active, true);
  nodeAssert.match(turbo.notes, /differing power labels/);
  assert(turbo.notes.includes("https://media63.musictribe.com/media/PLM/data/docs/P0BKV/TURBOSOUND_iP15B%20P0BKV_Product%20Information%20Document.pdf"));
});

check("Sonus faber Olympica Nova I, II, III, and V retain exact manufacturer-manual rows", () => {
  const cases = [
    {
      id: "sonus-faber-olympica-nova-i", model: "Olympica Nova I", sensitivity: 87,
      low: 45, high: 35000, woofer: 5.91, driverCount: 2, ampRange: /35–250 W/,
      manual: "https://a.storyblok.com/f/259299/x/2e9356d7ba/owners_olympica_nova_low-3.pdf",
      page: "https://www.manualslib.com/manual/1744876/Sonus-Faber-Olympica-Nova.html?page=43#manual",
    },
    {
      id: "sonus-faber-olympica-nova-ii", model: "Olympica Nova II", sensitivity: 88,
      low: 40, high: 35000, woofer: 7.09, driverCount: 3, ampRange: /50–250 W/,
      manual: "https://a.storyblok.com/f/259299/x/0c43f45653/owners_olympica_nova_low-2.pdf",
      page: "https://www.manualslib.com/manual/1744876/Sonus-Faber-Olympica-Nova.html?page=43#manual",
    },
    {
      id: "sonus-faber-olympica-nova-iii", model: "Olympica Nova III", sensitivity: 90,
      low: 35, high: 35000, woofer: 7.09, driverCount: 4, ampRange: /50–300 W/,
      manual: "https://a.storyblok.com/f/259299/x/905b48db22/owners_olympica_nova_low-1.pdf",
      page: "https://www.manualslib.com/manual/1744876/Sonus-Faber-Olympica-Nova.html?page=42#manual",
    },
    {
      id: "sonus-faber-olympica-nova-v", model: "Olympica Nova V", sensitivity: 90,
      low: 32, high: 35000, woofer: 7.09, driverCount: 5, ampRange: /60–400 W/,
      manual: "https://a.storyblok.com/f/259299/x/3ed2428d5f/owners_olympica_nova_low.pdf",
      page: "https://www.manualslib.com/manual/1744876/Sonus-Faber-Olympica-Nova.html?page=42#manual",
    },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} record must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
    nodeAssert.equal(s.sensitivity.source, c.manual);
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.impedance.value, 4);
    nodeAssert.equal(s.impedance.source, c.manual);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.manual);
    nodeAssert.equal(s.frequencyResponse.points, undefined, "do not invent a response curve from frequency limits");
    nodeAssert.equal(s.woofer.value, c.woofer, "manufacturer-stated metric driver size is converted to inches");
    nodeAssert.equal(s.woofer.source, c.manual);
    nodeAssert.equal(s.driverCount, c.driverCount);
    nodeAssert.equal(s.active, false);
    nodeAssert.equal(s.power.value, null, "recommended amplifier output is not speaker power handling");
    nodeAssert.equal(resolveSensitivity(s).isFallback, false);
    nodeAssert.ok(
      Math.abs(resolveSensitivity(s).valueDb - (c.sensitivity - 10 * Math.log10((2.83 * 2.83) / 4))) < 1e-12,
      `${c.model} sensitivity must use the stored 2.83V reference and sourced 4-ohm impedance`,
    );
    nodeAssert.match(s.notes, c.ampRange);
    assert(s.notes.includes(c.manual));
    assert(s.notes.includes(c.page));
    nodeAssert.match(s.notes, /no tolerance is specified for the published response range/i);
  }
});

check("Sonus faber Homage Tradition Amati, Guarneri, and Serafino retain their exact manual rows", () => {
  const cases = [
    {
      id: "sonus-faber-homage-tradition-amati", model: "Homage Tradition Amati", sensitivity: 90,
      low: 28, high: 35000, woofer: 8.66, driverCount: 4, ampRange: /100–500 W/,
      page: "https://www.manualslib.com/manual/1290952/Sonus-Faber-Serafino-Tradition.html?page=29#manual",
    },
    {
      id: "sonus-faber-homage-tradition-guarneri", model: "Homage Tradition Guarneri", sensitivity: 87,
      low: 40, high: 35000, woofer: 5.91, driverCount: 2, ampRange: /30–250 W/,
      page: "https://www.manualslib.com/manual/1290952/Sonus-Faber-Serafino-Tradition.html?page=30#manual",
    },
    {
      id: "sonus-faber-homage-tradition-serafino", model: "Homage Tradition Serafino", sensitivity: 90,
      low: 30, high: 35000, woofer: 7.09, driverCount: 4, ampRange: /80–350 W/,
      page: "https://www.manualslib.com/manual/1290952/Sonus-Faber-Serafino-Tradition.html?page=30#manual",
    },
  ];
  for (const c of cases) {
    const s = allDb.find((item) => item.id === c.id);
    assert(s, `${c.id} record must remain in the database`);
    nodeAssert.equal(s.model, c.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.sensitivity.value, c.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
    nodeAssert.equal(s.sensitivity.source, c.page);
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.impedance.value, 4);
    nodeAssert.equal(s.impedance.source, c.page);
    nodeAssert.equal(s.frequencyResponse.low_hz, c.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, c.high);
    nodeAssert.equal(s.frequencyResponse.source, c.page);
    nodeAssert.equal(s.frequencyResponse.points, undefined, "do not invent a response curve from frequency limits");
    nodeAssert.equal(s.woofer.value, c.woofer, "manufacturer-stated metric driver size is converted to inches");
    nodeAssert.equal(s.woofer.source, c.page);
    nodeAssert.equal(s.driverCount, c.driverCount);
    nodeAssert.equal(s.active, false);
    nodeAssert.equal(s.power.value, null, "recommended amplifier output is not speaker power handling");
    nodeAssert.equal(resolveSensitivity(s).isFallback, false);
    nodeAssert.ok(
      Math.abs(resolveSensitivity(s).valueDb - (c.sensitivity - 10 * Math.log10((2.83 * 2.83) / 4))) < 1e-12,
      `${c.model} sensitivity must use the stored 2.83V reference and sourced 4-ohm impedance`,
    );
    nodeAssert.match(s.notes, c.ampRange);
    assert(s.notes.includes(c.page));
    nodeAssert.match(s.notes, /passive-loudspeaker manual/i);
    nodeAssert.match(s.notes, /no stated tolerance/i);
  }
});

check("Sonus faber first-generation Olympica III uses its exact manual data-sheet row", () => {
  const s = allDb.find((item) => item.id === "sonus-faber-olympica3");
  const source = "https://www.manualslib.com/manual/886578/Sonus-Faber-Olympica-I.html?page=13#manual";
  assert(s, "Olympica III record must remain in the database");
  nodeAssert.equal(s.model, "Olympica III");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.sensitivity.value, 90);
  nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
  nodeAssert.equal(s.impedance.value, 4);
  nodeAssert.equal(s.impedance.source, source);
  nodeAssert.equal(s.frequencyResponse.low_hz, 35);
  nodeAssert.equal(s.frequencyResponse.high_hz, 30000);
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.equal(s.woofer.value, 7.09, "180 mm source size is converted to inches");
  nodeAssert.equal(s.woofer.source, source);
  nodeAssert.equal(s.driverCount, 4);
  nodeAssert.equal(s.active, null, "do not infer active/passive status when the table does not label it");
  nodeAssert.equal(s.power.value, null, "suggested amplifier output is not speaker power handling");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  nodeAssert.equal(resolveSensitivity(s).isFallback, false);
  nodeAssert.ok(
    Math.abs(resolveSensitivity(s).valueDb - (90 - 10 * Math.log10((2.83 * 2.83) / 4))) < 1e-12,
    "Olympica III sensitivity must use its published 2.83V reference and sourced 4-ohm impedance",
  );
  assert(s.notes.includes(source));
  nodeAssert.match(s.notes, /35–30,000 Hz frequency response with the tuning port included/);
  nodeAssert.match(s.notes, /no tolerance is stated/i);
  nodeAssert.match(s.notes, /50–300 W suggested amplifier output/);
  nodeAssert.match(s.notes, /22 Vrms long-term maximum input voltage/);
});

check("Sonus faber Guarneri Evolution uses its exact manufacturer data sheet without inventing a power role", () => {
  const s = allDb.find((item) => item.id === "sonus-faber-guarneri");
  const source = "https://www.mono.no/media/multicase/documents/sonus%20faber/produktark/sonus_faber_guarneri_evolution_produktblad.pdf";
  assert(s, "Guarneri Evolution record must remain in the database");
  nodeAssert.equal(s.model, "Guarneri Evolution");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.sensitivity.value, 86);
  nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
  nodeAssert.equal(s.impedance.value, 4);
  nodeAssert.equal(s.impedance.source, source);
  nodeAssert.equal(s.frequencyResponse.low_hz, 40);
  nodeAssert.equal(s.frequencyResponse.high_hz, 30000);
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.equal(s.woofer.value, 7.05, "179 mm source size is converted to inches");
  nodeAssert.equal(s.woofer.source, source);
  nodeAssert.equal(s.driverCount, 2);
  nodeAssert.equal(s.active, null, "do not infer active/passive status when the data sheet does not label it");
  nodeAssert.equal(s.power.value, null, "do not collapse the qualified 25–200W range into a scalar power rating");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  nodeAssert.equal(resolveSensitivity(s).isFallback, false);
  nodeAssert.ok(
    Math.abs(resolveSensitivity(s).valueDb - (86 - 10 * Math.log10((2.83 * 2.83) / 4))) < 1e-12,
    "Guarneri Evolution sensitivity must use the published 2.83V reference and sourced 4-ohm impedance",
  );
  assert(s.notes.includes(source));
  nodeAssert.match(s.notes, /40–30,000 Hz frequency response with the Stealth reflex included/);
  nodeAssert.match(s.notes, /no response tolerance is stated/i);
  nodeAssert.match(s.notes, /POWER HANDLING entry is a 25–200 W range/);
  nodeAssert.match(s.notes, /does not explicitly label it/i);
});

check("first-generation Sonetto I, II, III, and V retain exact 2018 launch-table limits without assuming sensitivity references", () => {
  const source = "https://www.audioholics.com/tower-speaker-reviews/sonus-faber-sonetto-speaker-collection";
  const expected = [
    { id: "sonus-faber-sonetto-i", model: "Sonetto I", low: 45, high: 25000, sensitivity: 87 },
    { id: "sonus-faber-sonetto-ii", model: "Sonetto II", low: 42, high: 25000, sensitivity: 87 },
    { id: "sonus-faber-sonetto-iii", model: "Sonetto III", low: 42, high: 25000, sensitivity: 89 },
    { id: "sonus-faber-sonetto-v", model: "Sonetto V", low: 38, high: 25000, sensitivity: 90 },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.model} record must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.source, source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "REPUTABLE_DATABASE");
    nodeAssert.equal(s.frequencyResponse.status, "REPUTABLE_DATABASE_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, "published bandwidth limits are not a response curve");
    nodeAssert.equal(s.impedance.value, 4);
    nodeAssert.equal(s.impedance.unit, "ohm");
    nodeAssert.equal(s.impedance.source, source);
    nodeAssert.equal(s.impedance.sourceType, "REPUTABLE_DATABASE");
    nodeAssert.equal(s.impedance.status, "REPUTABLE_DATABASE_VERIFIED");
    nodeAssert.equal(s.sensitivity.value, null, "the source's dB figure has no stated reference standard");
    nodeAssert.equal(s.power.value, null, "do not turn amplifier recommendations into speaker power");
    nodeAssert.match(s.notes, /July 4, 2018/);
    nodeAssert.match(s.notes, /not Sonetto G2/);
    nodeAssert.match(s.notes, new RegExp(`sensitivity as ${item.sensitivity} dB`));
    nodeAssert.match(s.notes, /sensitivity field remains N\/A/);
    nodeAssert.match(s.notes, /No response tolerance or test condition is stated/);
    assert(s.notes.includes(source));
  }
});

check("TRIANGLE Borea BR02, BR03, and Comète Ez retain exact manufacturer limits and power roles", () => {
  const expected = [
    { id: "triangle-borea-br02", model: "Borea BR02", low: 51, high: 22000, sensitivity: 89, power: 80, woofer: 5, minimumOhms: "3.6 Ω minimum", ampRange: "15–100 W" },
    { id: "triangle-borea-br03", model: "Borea BR03", low: 46, high: 22000, sensitivity: 90, power: 100, woofer: 6, minimumOhms: "4.2 Ω minimum", ampRange: "25–130 W" },
    { id: "triangle-comete-ez", model: "Comete Ez", low: 49, high: 22000, sensitivity: 89, power: 80, woofer: 6.5, minimumOhms: "4.2 Ω minimum", ampRange: "25–130 W" },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    const source = s?.frequencyResponse.source;
    assert(s, `${item.model} record must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.active, false);
    nodeAssert.equal(s.driverCount, 2);
    nodeAssert.equal(s.sensitivity.value, item.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, "1W/1m");
    nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.power.value, item.power);
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.impedance.value, 8);
    nodeAssert.equal(s.impedance.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    assert(typeof source === "string" && source.startsWith("https://trianglehifi.com/"));
    assert(s.notes.includes(source));
    nodeAssert.match(s.notes, /±3 dB/);
    nodeAssert.match(s.notes, /scalar impedance field records the stated nominal value/);
    nodeAssert.match(s.notes, /not imported as speaker power/);
    nodeAssert.match(s.notes, new RegExp(item.minimumOhms.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    nodeAssert.match(s.notes, new RegExp(item.ampRange.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const comete = allDb.find((record) => record.id === "triangle-comete-ez");
  assert(comete, "Comète Ez record must remain in the database");
  nodeAssert.match(comete.notes, /not the 40th-anniversary Comète 40th/);
});

check("JBL EON15 uses the exact passive non-G2 manufacturer sheet, not the powered G2 revision", () => {
  const source = "https://www.warehousesound.com/r/jblEon15.pdf";
  const s = allDb.find((record) => record.id === "jbl-eon15");
  assert(s, "JBL EON15 record must remain in the database");
  nodeAssert.equal(s.model, "EON15");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.active, false);
  nodeAssert.equal(s.driverCount, 2);
  nodeAssert.equal(s.frequencyResponse.low_hz, 80);
  nodeAssert.equal(s.frequencyResponse.high_hz, 16000);
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
  nodeAssert.equal(s.sensitivity.value, 100);
  nodeAssert.equal(s.sensitivity.reference, "1W/1m");
  nodeAssert.equal(s.power.value, 250);
  nodeAssert.equal(s.power.role, "speaker_power_handling");
  nodeAssert.equal(s.impedance.value, 8);
  nodeAssert.equal(s.woofer.value, 15);
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  assert(s.notes.includes(source));
  nodeAssert.match(s.notes, /frequency response.*−3 dB/i);
  nodeAssert.match(s.notes, /60 Hz–18 kHz \(−10 dB\)/);
  nodeAssert.match(s.notes, /passive 15-inch two-way/);
  nodeAssert.match(s.notes, /powered EON15 G2 is a distinct later model/);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
});

check("JBL Paragon D44000 keeps common ratings and does not merge revision-specific driver data", () => {
  const source = "https://audio-database.com/JBL/speaker/paragon.html";
  const officialIdentity = "https://jp.jbl.com/jamaica.html";
  const s = allDb.find((record) => record.id === "jbl-paragon");
  assert(s, "JBL Paragon D44000 record must remain in the database");
  nodeAssert.equal(s.model, "Paragon D44000");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 6);
  nodeAssert.equal(s.active, null, "do not infer active/passive classification from an incomplete description");
  nodeAssert.equal(s.sensitivity.value, 96);
  nodeAssert.equal(s.sensitivity.reference, "1W/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.sensitivity.sourceType, "REPUTABLE_DATABASE");
  nodeAssert.equal(s.power.value, 125);
  nodeAssert.equal(s.power.role, "program_rating");
  nodeAssert.equal(s.impedance.value, 8);
  nodeAssert.equal(s.frequencyResponse.low_hz, null);
  nodeAssert.equal(s.frequencyResponse.high_hz, null);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.equal(s.woofer.value, null, "the source distinguishes revision-dependent low-frequency drivers");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  assert(s.notes.includes(source));
  assert(s.notes.includes(officialIdentity));
  nodeAssert.match(s.notes, /initial D44000, mid-term D44000, and late D44000WXA revisions/);
  nodeAssert.match(s.notes, /no frequency-response limits, response curve, or directivity data/i);
  assertPreservedUnavailable("legacy-jbl-2");
});

check("Rockford Fosgate and Pioneer car-speaker fields preserve exact ratings, references, and unmodeled data", () => {
  const expected = [
    { id: "rockford-fosgate-r165x3", model: "R165X3", source: "https://rockfordfosgate.com/products/details/r165x3/", sensitivity: 91, reference: "1W/1m", power: 45, role: "speaker_power_handling", impedance: 4, low: 52, high: 20000, woofer: 6.5, wooferUnit: "in", drivers: 3 },
    { id: "rockford-fosgate-r1675x2", model: "R1675X2", source: "https://rockfordfosgate.com/products/details/r1675x2/", sensitivity: 91, reference: "1W/1m", power: 45, role: "speaker_power_handling", impedance: 4, low: 52, high: 20000, woofer: 6.75, wooferUnit: "in", drivers: 2 },
    { id: "rockford-fosgate-t1650", model: "T1650", source: "https://rockfordfosgate.com/products/details/t1650/", sensitivity: 88, reference: "1W/1m", power: 75, role: "speaker_power_handling", impedance: 4, low: 44, high: 20000, woofer: 6.5, wooferUnit: "in", drivers: 2 },
    { id: "rockford-fosgate-t1650-s", model: "T1650-S", source: "https://rockfordfosgate.com/products/details/t1650-s/", sensitivity: 88, reference: "1W/1m", power: 80, role: "speaker_power_handling", impedance: 4, low: 47, high: 20000, woofer: 6.5, wooferUnit: "in", drivers: 2 },
    { id: "pioneer-ts-z65f", model: "TS-Z65F", source: "https://pioneer-car.eu/ts-z65f/ts-z65f", sensitivity: null, reference: undefined, power: 110, role: "allowable_input", impedance: 4, low: 32, high: 96000, woofer: 17, wooferUnit: "cm", drivers: 2 },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.model} record must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.driverCount, item.drivers);
    nodeAssert.equal(s.sensitivity.value, item.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, item.reference);
    nodeAssert.equal(s.power.value, item.power);
    nodeAssert.equal(s.power.role, item.role);
    nodeAssert.equal(s.impedance.value, item.impedance);
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.source, item.source);
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.woofer.unit, item.wooferUnit);
    assert(s.notes.includes(item.source));
    nodeAssert.match(s.notes, /no tolerance|no response tolerance/i);
    nodeAssert.match(s.notes, /not (?:treated as )?a measured (?:response )?curve/i);
  }
  const p3 = allDb.find((record) => record.id === "rockford-fosgate-p3");
  assert(p3, "Rockford Fosgate P3D4-12 record must remain in the database");
  nodeAssert.equal(p3.model, "Punch P3D4-12 (Dual 4Ω)");
  nodeAssert.equal(p3.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(p3.driverCount, 1);
  nodeAssert.equal(p3.sensitivity.value, 85);
  nodeAssert.equal(p3.sensitivity.reference, "1W/1m");
  nodeAssert.equal(p3.power.value, 600);
  nodeAssert.equal(p3.power.role, "speaker_power_handling");
  nodeAssert.equal(p3.impedance.value, null, "dual 4-ohm voice coils have multiple possible wiring loads");
  nodeAssert.equal(p3.resonantFreq.value, 27.7);
  nodeAssert.equal(p3.voiceCoil.value, 2.5);
  nodeAssert.equal(p3.woofer.value, 12);
  nodeAssert.equal(p3.frequencyResponse.low_hz, null, "Fs is not a standardized response cutoff");
  nodeAssert.equal(p3.frequencyResponse.high_hz, null);
  nodeAssert.equal(p3.frequencyResponse.source, null);
  nodeAssert.match(p3.notes, /dual 4-ohm voice coils/);
  nodeAssert.match(p3.notes, /Fs is retained as resonant frequency/);
  nodeAssert.match(p3.notes, /No standardized response limits/);
  const pioneer = allDb.find((record) => record.id === "pioneer-ts-z65f");
  assert(pioneer, "Pioneer TS-Z65F record must remain in the database");
  nodeAssert.equal(pioneer.sensitivity.value, null, "manufacturer's 85 dB value has no stated reference");
  nodeAssert.equal(pioneer.power.value, 110, "retain nominal input power, not the 330 W maximum");
  nodeAssert.equal(pioneer.power.role, "allowable_input");
  nodeAssert.match(pioneer.notes, /sensitivity field remains N\/A/);
  nodeAssert.match(pioneer.notes, /330 W maximum is not substituted/);
  const t1650 = allDb.find((record) => record.id === "rockford-fosgate-t1650");
  const t1650s = allDb.find((record) => record.id === "rockford-fosgate-t1650-s");
  assert(t1650 && t1650s, "both exact T1650 revisions must remain separately represented");
  nodeAssert.notEqual(t1650.model, t1650s.model);
  nodeAssert.notEqual(t1650.frequencyResponse.low_hz, t1650s.frequencyResponse.low_hz);
});

check("Kali LP-6 uses the original-generation manual and keeps active-monitor ratings in their correct roles", () => {
  const lp6 = allDb.find((s) => s.id === "kali-lp6");
  assert(lp6, "Kali LP-6 record must remain in the database");
  const source = "https://static1.squarespace.com/static/5a6a2d73bff200e7e9dde1f9/t/5b5b68456d2a73ca7faa5fbd/1532717141711/LP-6+User%27s+Manual.pdf";
  nodeAssert.equal(lp6.model, "LP-6");
  nodeAssert.equal(lp6.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(lp6.active, true);
  nodeAssert.equal(lp6.driverCount, 2);
  nodeAssert.equal(lp6.woofer.value, 6.5);
  nodeAssert.equal(lp6.woofer.source, source);
  nodeAssert.equal(lp6.power.value, 80);
  nodeAssert.equal(lp6.power.role, "amplifier_output");
  nodeAssert.equal(lp6.power.source, source);
  nodeAssert.equal(lp6.frequencyResponse.low_hz, 45);
  nodeAssert.equal(lp6.frequencyResponse.high_hz, 21000);
  nodeAssert.equal(lp6.frequencyResponse.source, source);
  nodeAssert.equal(lp6.frequencyResponse.points, undefined);
  nodeAssert.equal(lp6.sensitivity.value, null, "acoustic sensitivity is not inferred from SPL output or input sensitivity");
  nodeAssert.equal(lp6.impedance.value, null, "active-monitor input or amplifier ratings are not driver impedance");
  nodeAssert.match(lp6.notes, /original version.*LP-6 V2/i);
  nodeAssert.match(lp6.notes, /45 Hz–21 kHz as the ±3 dB frequency range/);
  nodeAssert.match(lp6.notes, /38 Hz–25 kHz as the separate -10 dB/);
  nodeAssert.match(lp6.notes, /no points or directivity are imported/i);
});

check("L-Acoustics K1, K2, and Syva use exact manufacturer limits without flattening multiway loads or directivity", () => {
  const expected = [
    { id: "legacy-la-4", model: "K1", source: "https://www.l-acoustics.com/products/k1/", low: 35, high: 20000, woofer: 15, drivers: 9, impedance: null, active: null },
    { id: "legacy-la-5", model: "K2", source: "https://www.l-acoustics.com/products/k2/", low: 35, high: 20000, woofer: 12, drivers: 8, impedance: null, active: null },
    { id: "legacy-la-6", model: "Syva", source: "https://www.l-acoustics.com/products/syva/", low: 87, high: 20000, woofer: null, drivers: 9, impedance: 8, active: false },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.model} record must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.driverCount, item.drivers);
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.source, item.source);
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.impedance.value, item.impedance);
    nodeAssert.equal(s.active, item.active);
    nodeAssert.equal(s.sensitivity.value, null, "maximum SPL is not sensitivity");
    nodeAssert.equal(s.power.value, null, "external amplifier output is not speaker power handling");
    nodeAssert.match(s.notes, /-10 dB/);
    nodeAssert.match(s.notes, /No response-point or polar\/directivity data are imported/);
  }
  const k1 = allDb.find((record) => record.id === "legacy-la-4");
  const k2 = allDb.find((record) => record.id === "legacy-la-5");
  const syva = allDb.find((record) => record.id === "legacy-la-6");
  assert(k1 && k2 && syva, "exact L-Acoustics records must exist");
  nodeAssert.match(k1.notes, /LF\/MF\/HF impedance is specified separately/);
  nodeAssert.match(k2.notes, /LF\/MF\/HF impedance is specified separately/);
  nodeAssert.match(syva.notes, /mid-frequency transducers, not a dedicated woofer/);
});

check("Yamaha NS-series and Pioneer TS-D65C ratings retain exact references and input-power roles", () => {
  const expected = [
    { id: "yamaha-ns-5000", model: "NS-5000", source: "https://usa.yamaha.com/products/audio_visual/speaker_systems/ns-5000/specs.html", sensitivity: 88, reference: "2.83V/1m", power: 200, impedance: 6, low: 26, high: 40000, woofer: 12, wooferUnit: "in", drivers: 3 },
    { id: "yamaha-ns-777", model: "NS-777", source: "https://usa.yamaha.com/products/audio_visual/speaker_systems/ns-777/specs.html", sensitivity: 89, reference: "2.83V/1m", power: 100, impedance: 6, low: 30, high: 35000, woofer: 8, wooferUnit: "in", drivers: 4 },
    { id: "yamaha-ns-6490", model: "NS-6490", source: "https://usa.yamaha.com/products/audio_visual/speaker_systems/ns-6490/specs.html", sensitivity: 90, reference: "2.83V/m", power: 70, impedance: null, low: 45, high: 23000, woofer: 8, wooferUnit: "in", drivers: 3 },
    { id: "pioneer-ts-d65c", model: "TS-D65C", source: "https://pioneer-car.eu/ts-d65c/ts-d65c", sensitivity: null, reference: undefined, power: 90, impedance: 4, low: 32, high: 49000, woofer: 17, wooferUnit: "cm", drivers: 2 },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.model} record must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.sensitivity.value, item.sensitivity);
    nodeAssert.equal(s.sensitivity.reference, item.reference);
    nodeAssert.equal(s.power.value, item.power);
    nodeAssert.equal(s.power.role, "allowable_input");
    nodeAssert.equal(s.impedance.value, item.impedance);
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.source, item.source);
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.woofer.unit, item.wooferUnit);
    nodeAssert.equal(s.driverCount, item.drivers);
    nodeAssert.equal(s.active, null, "do not infer onboard amplification status");
    assert(s.notes.includes(item.source));
  }
  const ns5000 = allDb.find((record) => record.id === "yamaha-ns-5000");
  const ns777 = allDb.find((record) => record.id === "yamaha-ns-777");
  const ns6490 = allDb.find((record) => record.id === "yamaha-ns-6490");
  const tsd65c = allDb.find((record) => record.id === "pioneer-ts-d65c");
  assert(ns5000 && ns777 && ns6490 && tsd65c, "all exact-model records must exist");
  nodeAssert.match(ns5000.notes, /26 Hz–40 kHz at -10 dB/);
  nodeAssert.match(ns5000.notes, /100 kHz at -30 dB is not combined/);
  nodeAssert.match(ns5000.notes, /600 W; only the nominal input figure is stored as allowable_input/);
  nodeAssert.match(ns6490.notes, /official manufacturer sources conflict/);
  nodeAssert.match(ns6490.notes, /impedance field remains N\/A/);
  nodeAssert.equal(tsd65c.sensitivity.value, null, "Pioneer's 84 dB sensitivity has no stated measurement reference");
  nodeAssert.match(tsd65c.notes, /90 W nominal input power and 270 W maximum input power/);
  nodeAssert.match(tsd65c.notes, /84 dB but states no measurement reference/);
});

check("Electro-Voice Sx600 uses exact manufacturer response data while preserving PI/PIX distinctions", () => {
  const sx600 = allDb.find((record) => record.id === "electro-voice-sx600");
  assert(sx600, "the exact unsuffixed Sx600 family record must remain");
  const source = "https://products.electrovoice.com/binary/Sx600_High_Output_Two-way_Loudspeaker_Datasheet_51_en_9006674443.pdf";
  nodeAssert.equal(sx600.model, "Sx600");
  nodeAssert.equal(sx600.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(sx600.year, null, "a manual revision date is not a launch year");
  nodeAssert.equal(sx600.driverCount, 3, "two 12-inch LF/midbass drivers plus one HF compression driver");
  nodeAssert.equal(sx600.active, false);
  nodeAssert.equal(sx600.frequencyResponse.low_hz, 100);
  nodeAssert.equal(sx600.frequencyResponse.high_hz, 14000);
  nodeAssert.equal(sx600.frequencyResponse.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(sx600.frequencyResponse.source, source);
  nodeAssert.equal(sx600.frequencyResponse.pointsSourceType, "MANUFACTURER");
  nodeAssert.equal(sx600.frequencyResponse.pointsSource, source);
  nodeAssert.equal(sx600.frequencyResponse.points.length, 26, "only populated source-table rows are retained; blank rows are not interpolated");
  nodeAssert.deepEqual(sx600.frequencyResponse.points[0], { hz: 40, db: 72 });
  nodeAssert.deepEqual(sx600.frequencyResponse.points.at(-1), { hz: 20000, db: 82 });
  nodeAssert.match(sx600.frequencyResponse.pointsContext, /anechoic chamber according to EN 54-24/);
  nodeAssert.match(sx600.frequencyResponse.pointsContext, /105 dB.*1 kHz.*103 dB/);
  nodeAssert.equal(sx600.sensitivity.value, 105);
  nodeAssert.equal(sx600.sensitivity.reference, "1W/1m");
  nodeAssert.equal(resolveSensitivity(sx600).isFallback, false);
  nodeAssert.equal(sx600.power.value, 600);
  nodeAssert.equal(sx600.power.role, "speaker_power_handling");
  nodeAssert.equal(sx600.impedance.value, null, "4 ohms is PI-only; do not assign it to the unspecified PI/PIX family row");
  nodeAssert.equal(sx600.woofer.value, 12);
  nodeAssert.equal(sx600.woofer.unit, "in");
  nodeAssert.match(sx600.notes, /2400 W peak is noted but not stored/);
  nodeAssert.match(sx600.notes, /beamwidth and DI\/Q tables; they are recorded as a directivity lead only/);
  const lead = (directivityLeads as any[]).find((item) => item.id === "electro-voice-sx600");
  assert(lead, "published directivity evidence is retained for review without inventing a polar payload");
  nodeAssert.equal(lead.status, "LEAD_NOT_IMPORTED");
  nodeAssert.match(lead.note, /not a complete angle-resolved polar response/);
});

check("unqualified Electro-Voice EVF-1152D remains unavailable without a pattern and configuration suffix", () => {
  const row = allDb.find((record) => record.id === "electro-voice-evf-1152d");
  const unresolved = (unresolvedAll as Record<string, any>)["electro-voice-evf-1152d"];
  const lead = (directivityLeads as any[]).find((item) => item.id === "electro-voice-evf-1152d");
  const exact96 = allDb.find((record) => record.id === "electro-voice-evf-1152d-96");
  assert(row && unresolved && lead && exact96, "the EVF-1152D row, exact /96 record, identity disposition, and directivity lead must all remain separate");
  nodeAssert.equal(exact96.model, "EVF-1152D/96");
  nodeAssert.equal(exact96.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(exact96.frequencyResponse.source, "https://www.fullcompass.com/prod/221561-electro-voice-evf-1152d-96-15-2-way-loudspeaker-with-90x60-evcoat-black");
  nodeAssert.equal(exact96.frequencyResponse.points, undefined, "do not import text-extracted points while the manufacturer table contains unresolved low-frequency anomalies");
  nodeAssert.equal(row.model, "EVF-1152D");
  nodeAssert.equal(row.overallStatus, "UNAVAILABLE");
  nodeAssert.equal(unresolved.status, "UNAVAILABLE");
  nodeAssert.equal(row.notes, unresolved.note);
  nodeAssert.equal(row.driverCount, null, "no variant-specific driver configuration is assigned to the unresolved catalog row");
  nodeAssert.equal(row.active, null, "the source documents a configurable passive/active mode but the row does not identify the setting");
  for (const field of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"] as const) {
    nodeAssert.equal(row[field].value, null, `${field} must remain N/A for the unresolved suffix`);
    nodeAssert.equal(row[field].source, null, `${field} must not claim a variant-specific source`);
  }
  nodeAssert.equal(row.frequencyResponse.low_hz, null);
  nodeAssert.equal(row.frequencyResponse.high_hz, null);
  nodeAssert.equal(row.frequencyResponse.source, null);
  nodeAssert.match(row.notes, /slash suffix in the model number as the coverage-pattern code/);
  nodeAssert.match(row.notes, /\/43, \/64, \/66, \/94, \/96, and \/99/);
  nodeAssert.match(row.notes, /does not identify its pattern, environmental suffix, or operating configuration/);
  nodeAssert.match(row.notes, /EVF-1152D\/96 as the separate record `electro-voice-evf-1152d-96`/);
  nodeAssert.match(row.notes, /suffix-specific values are not transferred to this bare row/);
  nodeAssert.match(row.notes, /Review of all text-extractable chunks of the official \/43, \/66, \/94, and \/96 engineering sheets/);
  nodeAssert.match(row.notes, /no response points are digitized/);
  nodeAssert.equal(lead.status, "LEAD_NOT_IMPORTED");
  nodeAssert.match(lead.note, /frequency-dependent on\/off-axis response tables and 1\/3-octave polar plots/);
  nodeAssert.match(lead.note, /not digitized, assigned, or converted into a synthetic pattern/);
  nodeAssert.match(lead.note, /the extracted \/94 and \/96 low-frequency rows include values inconsistent/);
  nodeAssert.match(lead.note, /no directivity payload is imported/);
  nodeAssert.ok(lead.sources.includes("https://products.electrovoice.com/binary/EVF-1152D_94_EDS_en.pdf"));
  nodeAssert.ok(unresolved.sources.includes("https://products.electrovoice.com/binary/F01U310062%20EVF-EVH%20User%20Manual.pdf"));
});

check("Pioneer CS, Elite, and Andrew Jones records keep exact identity, rating roles, and honest sensitivity references", () => {
  const cs99 = allDb.find((record) => record.id === "legacy-pio-1");
  const hpm100 = allDb.find((record) => record.id === "legacy-pio-2");
  const cs88 = allDb.find((record) => record.id === "legacy-pio-3");
  const s1ex = allDb.find((record) => record.id === "legacy-pio-4");
  const bs22 = allDb.find((record) => record.id === "legacy-pio-5");
  const fs52 = allDb.find((record) => record.id === "legacy-pio-6");
  assert(cs99 && hpm100 && cs88 && s1ex && bs22 && fs52, "all six exact Pioneer speakers must remain");

  nodeAssert.equal(cs99.model, "CS-99A");
  nodeAssert.equal(cs99.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(cs99.year, null, "the source gives a production span, not one release year");
  nodeAssert.equal(cs99.driverCount, 6);
  nodeAssert.equal(cs99.active, null, "do not infer powered/passive status");
  nodeAssert.equal(cs99.frequencyResponse.low_hz, 25);
  nodeAssert.equal(cs99.frequencyResponse.high_hz, 22000);
  nodeAssert.equal(cs99.frequencyResponse.source, "https://www.hifiengine.com/manual_library/pioneer/cs-99a.shtml");
  nodeAssert.equal(cs99.sensitivity.value, 97);
  nodeAssert.equal(cs99.sensitivity.reference, "Measurement reference/distance not stated");
  nodeAssert.equal(resolveSensitivity(cs99).isFallback, true, "unreferenced sensitivity must not be normalized");
  nodeAssert.equal(cs99.power.value, 100);
  nodeAssert.equal(cs99.power.role, "allowable_input");
  nodeAssert.equal(cs99.impedance.value, 8);
  nodeAssert.equal(cs99.woofer.value, 380);
  nodeAssert.equal(cs99.woofer.unit, "mm");

  nodeAssert.equal(hpm100.model, "HPM-100");
  nodeAssert.equal(hpm100.year, 1976);
  nodeAssert.equal(hpm100.driverCount, 4);
  nodeAssert.equal(hpm100.active, null);
  nodeAssert.equal(hpm100.frequencyResponse.low_hz, 30);
  nodeAssert.equal(hpm100.frequencyResponse.high_hz, 25000);
  nodeAssert.equal(hpm100.sensitivity.value, 92.5);
  nodeAssert.equal(hpm100.sensitivity.reference, "Measurement reference/distance not stated");
  nodeAssert.equal(resolveSensitivity(hpm100).isFallback, true);
  nodeAssert.equal(hpm100.power.value, 50);
  nodeAssert.equal(hpm100.power.role, "speaker_power_handling");
  nodeAssert.equal(hpm100.impedance.value, 8);
  nodeAssert.equal(hpm100.woofer.value, 300);
  nodeAssert.equal(hpm100.woofer.unit, "mm");
  nodeAssert.match(hpm100.notes, /100 watt.*without defining that figure's role/);

  nodeAssert.equal(cs88.model, "CS-88A");
  nodeAssert.equal(cs88.year, 1971);
  nodeAssert.equal(cs88.driverCount, 6);
  nodeAssert.equal(cs88.active, null);
  nodeAssert.equal(cs88.frequencyResponse.low_hz, 25);
  nodeAssert.equal(cs88.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(cs88.sensitivity.value, null);
  nodeAssert.equal(cs88.power.value, 80);
  nodeAssert.equal(cs88.power.role, "speaker_power_handling");
  nodeAssert.equal(cs88.impedance.value, 8);
  nodeAssert.equal(cs88.woofer.value, 12);
  nodeAssert.equal(cs88.woofer.unit, "in");

  nodeAssert.equal(s1ex.model, "Elite S-1EX");
  nodeAssert.equal(s1ex.year, null);
  nodeAssert.equal(s1ex.driverCount, 4);
  nodeAssert.equal(s1ex.active, false);
  nodeAssert.equal(s1ex.frequencyResponse.low_hz, 28);
  nodeAssert.equal(s1ex.frequencyResponse.high_hz, 100000);
  nodeAssert.equal(s1ex.sensitivity.value, 88.5);
  nodeAssert.equal(s1ex.sensitivity.reference, "2.83V/m");
  nodeAssert.equal(resolveSensitivity(s1ex).isFallback, true, "do not infer a 1 m sensitivity reference");
  nodeAssert.equal(s1ex.impedance.value, 6);
  nodeAssert.equal(s1ex.power.value, null, "maximum power lacks an explicit input/handling role");
  nodeAssert.equal(s1ex.woofer.value, 180);
  nodeAssert.equal(s1ex.woofer.unit, "mm");
  nodeAssert.equal(s1ex.voiceCoil.value, 2.5);
  nodeAssert.equal(s1ex.voiceCoil.unit, "in");

  nodeAssert.equal(bs22.model, "SP-BS22-LR");
  nodeAssert.equal(bs22.year, 2012);
  nodeAssert.equal(bs22.driverCount, 2);
  nodeAssert.equal(bs22.active, false);
  nodeAssert.equal(bs22.frequencyResponse.low_hz, 55);
  nodeAssert.equal(bs22.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(bs22.frequencyResponse.source, "https://www.parts-express.com/pedocs/brochures/pioneer-andrew-jones-designed-speakers-brochure.pdf");
  nodeAssert.equal(bs22.sensitivity.value, 85);
  nodeAssert.equal(bs22.sensitivity.reference, "2.83V; measurement distance not stated");
  nodeAssert.equal(resolveSensitivity(bs22).isFallback, true, "do not normalize without a published distance");
  nodeAssert.equal(bs22.power.value, 80);
  nodeAssert.equal(bs22.power.role, "allowable_input");
  nodeAssert.equal(bs22.impedance.value, 6);
  nodeAssert.equal(bs22.woofer.value, 4);
  nodeAssert.equal(bs22.woofer.unit, "in");

  nodeAssert.equal(fs52.model, "SP-FS52");
  nodeAssert.equal(fs52.year, 2012);
  nodeAssert.equal(fs52.driverCount, 4);
  nodeAssert.equal(fs52.active, false);
  nodeAssert.equal(fs52.frequencyResponse.low_hz, 40);
  nodeAssert.equal(fs52.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(fs52.frequencyResponse.source, "https://www.bhphotovideo.com/lit_files/258913.pdf");
  nodeAssert.equal(fs52.sensitivity.value, 87);
  nodeAssert.equal(fs52.sensitivity.reference, "2.83V; measurement distance not stated");
  nodeAssert.equal(resolveSensitivity(fs52).isFallback, true, "do not normalize without a published distance");
  nodeAssert.equal(fs52.power.value, 130);
  nodeAssert.equal(fs52.power.role, "allowable_input");
  nodeAssert.equal(fs52.impedance.value, 6);
  nodeAssert.equal(fs52.woofer.value, 5.25);
  nodeAssert.equal(fs52.woofer.unit, "in");
  nodeAssert.match(fs52.notes, /two 5-1\/4-inch woofer units, one 5-1\/4-inch midrange/);
});

check("Yamaha NS-500, original NS-10M, and first-generation NS-690 keep revision-specific evidence and honest gaps", () => {
  const ns500 = allDb.find((record) => record.id === "yamaha-ns500");
  const ns10m = allDb.find((record) => record.id === "legacy-yam-2");
  const ns690 = allDb.find((record) => record.id === "legacy-yam-3");
  assert(ns500 && ns10m && ns690, "all three exact Yamaha speaker records must remain present");

  nodeAssert.equal(ns500.model, "NS-500");
  nodeAssert.equal(ns500.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(ns500.driverCount, 2);
  nodeAssert.equal(ns500.active, null, "do not infer powered status from a vintage passive design");
  nodeAssert.equal(ns500.frequencyResponse.low_hz, 40);
  nodeAssert.equal(ns500.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(ns500.frequencyResponse.source, "https://audio-heritage.jp/YAMAHA/speaker/ns-500.html");
  nodeAssert.equal(ns500.frequencyResponse.sourceType, "REPUTABLE_DATABASE");
  nodeAssert.equal(ns500.frequencyResponse.points, undefined);
  nodeAssert.equal(ns500.sensitivity.value, 91);
  nodeAssert.equal(ns500.sensitivity.reference, "1W/1m");
  nodeAssert.equal(ns500.sensitivity.sourceType, "REPUTABLE_DATABASE");
  nodeAssert.equal(ns500.power.value, 60);
  nodeAssert.equal(ns500.power.role, "allowable_input");
  nodeAssert.equal(ns500.impedance.value, 8);
  nodeAssert.equal(ns500.woofer.value, 25);
  nodeAssert.equal(ns500.woofer.unit, "cm");
  nodeAssert.equal(ns500.voiceCoil.value, null);
  nodeAssert.equal(ns500.year, null, "available production dates are approximate/inconsistent");
  nodeAssert.match(ns500.notes, /30 W as “Power Handling”/);
  nodeAssert.match(ns500.notes, /60 W maximum allowable input/);

  nodeAssert.equal(ns10m.model, "NS-10M");
  nodeAssert.equal(ns10m.year, 1978);
  nodeAssert.equal(ns10m.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(ns10m.driverCount, 2);
  nodeAssert.equal(ns10m.active, null, "do not classify the original model as active/passive without an explicit exact-model source");
  nodeAssert.equal(ns10m.woofer.value, 18);
  nodeAssert.equal(ns10m.woofer.unit, "cm");
  nodeAssert.equal(ns10m.woofer.sourceType, "MANUFACTURER");
  nodeAssert.equal(ns10m.sensitivity.value, 90);
  nodeAssert.equal(ns10m.sensitivity.reference, "1W/1m");
  nodeAssert.equal(ns10m.impedance.value, 8);
  nodeAssert.equal(ns10m.power.value, 50);
  nodeAssert.equal(ns10m.power.role, "allowable_input");
  nodeAssert.equal(ns10m.frequencyResponse.low_hz, null, "conflicting published lower bounds are not selected");
  nodeAssert.equal(ns10m.frequencyResponse.high_hz, null);
  nodeAssert.equal(ns10m.voiceCoil.value, null, "the 27 mm figure is for the tweeter, not the LF woofer");
  nodeAssert.match(ns10m.notes, /60 Hz–20 kHz/);
  nodeAssert.match(ns10m.notes, /85 Hz–20 kHz/);
  nodeAssert.match(ns10m.notes, /does not explicitly establish powered\/passive status/);
  nodeAssert.match(ns10m.notes, /not the separately named 1987 NS-10M STUDIO/);

  nodeAssert.equal(ns690.model, "NS-690");
  nodeAssert.equal(ns690.year, 1973);
  nodeAssert.equal(ns690.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(ns690.driverCount, 3);
  nodeAssert.equal(ns690.active, null, "powered status is not inferred");
  nodeAssert.equal(ns690.frequencyResponse.low_hz, 35);
  nodeAssert.equal(ns690.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(ns690.frequencyResponse.sourceType, "REPUTABLE_DATABASE");
  nodeAssert.equal(ns690.frequencyResponse.points, undefined);
  nodeAssert.equal(ns690.sensitivity.value, 90);
  nodeAssert.equal(ns690.sensitivity.reference, "1W/1m");
  nodeAssert.equal(ns690.impedance.value, 8);
  nodeAssert.equal(ns690.power.value, 60);
  nodeAssert.equal(ns690.power.role, "allowable_input");
  nodeAssert.equal(ns690.resonantFreq.value, 40);
  nodeAssert.equal(ns690.voiceCoil.value, null, "66φ does not state a unit; do not convert it to millimetres");
  nodeAssert.equal(ns690.voiceCoil.sourceType, "NONE");
  nodeAssert.equal(ns690.woofer.value, 30);
  nodeAssert.equal(ns690.woofer.unit, "cm");
  nodeAssert.equal(ns690.woofer.sourceType, "MANUFACTURER");
  nodeAssert.match(ns690.notes, /NS-690 II \(1976\) and NS-690 III \(1980\)/);
  nodeAssert.match(ns690.notes, /96 dB.*without a measurement reference/);
  nodeAssert.match(ns690.notes, /66φ.*does not state a unit/);
});

check("Orange PPC, VOX V212, and Mesa 2x12 cabs retain exact sourced ratings without invented response data", () => {
  const expected = [
    { id: "orange-orange-ppc108", source: "https://orangeamps.com/en-us/products/ppc108", sourceType: "MANUFACTURER", power: 20, powerRole: "speaker_power_handling", impedance: 8, woofer: 8, drivers: 1 },
    { id: "orange-orange-ppc112", source: "https://orangeamps.com/en-us/products/ppc112", sourceType: "MANUFACTURER", power: 60, powerRole: "speaker_power_handling", impedance: 16, woofer: 12, drivers: 1 },
    { id: "orange-ppc212", source: "https://orangeamps.com/en-us/products/ppc212", sourceType: "MANUFACTURER", power: 120, powerRole: "speaker_power_handling", impedance: 16, woofer: 12, drivers: 2 },
    { id: "orange-ppc212v", source: "https://orangeamps.com/en-us/products/ppc212v", sourceType: "MANUFACTURER", power: 120, powerRole: "speaker_power_handling", impedance: 16, woofer: 12, drivers: 2 },
    { id: "orange-ppc412", source: "https://orangeamps.com/en-us/products/ppc412", sourceType: "MANUFACTURER", power: 240, powerRole: "speaker_power_handling", impedance: 16, woofer: 12, drivers: 4 },
    { id: "vox-v212c", source: "https://voxamps.com/product/v212c-extension-cabinet/", sourceType: "MANUFACTURER", power: 50, powerRole: "allowable_input", impedance: null, woofer: 12, drivers: 2 },
    { id: "vox-v212hwx", source: "https://voxamps.com/wp-content/uploads/support/AC15_30HW_V212HWX_OM_EFGS2.pdf", sourceType: "MANUFACTURER", power: null, powerRole: undefined, impedance: 16, woofer: 12, drivers: 2 },
    { id: "vox-v212bn", source: "https://www.zzounds.com/item--VOXV212", sourceType: "REPUTABLE_DATABASE", power: 60, powerRole: "speaker_power_handling", impedance: 16, woofer: 12, drivers: 2 },
    { id: "mesa-boogie-fillmore-2x12", source: "https://legacy.mesaboogie.com/cabinets--simulators/guitar-cabinets--simulators/fillmore-series/2x12-fillmore.html", sourceType: "MANUFACTURER", power: 180, powerRole: "speaker_power_handling", impedance: 8, woofer: 12, drivers: 2 },
    { id: "mesa-boogie-lone-star-2x12", source: "https://legacy.mesaboogie.com/cabinets--simulators/guitar-cabinets--simulators/lone-star-series/2x12-lone-star.html", sourceType: "MANUFACTURER", power: null, powerRole: undefined, impedance: 8, woofer: 12, drivers: 2 },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.id} must remain in the database`);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.driverCount, item.drivers);
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.woofer.source, item.source);
    nodeAssert.equal(s.woofer.sourceType, item.sourceType);
    nodeAssert.equal(s.power.value, item.power);
    nodeAssert.equal(s.power.role, item.powerRole);
    nodeAssert.equal(s.impedance.value, item.impedance);
    nodeAssert.equal(s.active, null, "no explicit active/passive classification is asserted");
    assert(s.notes.includes(item.source), `${item.id} must retain its exact source in notes`);
    for (const f of ["sensitivity", "resonantFreq", "voiceCoil"]) {
      nodeAssert.equal(s[f].value, null, `${item.id}.${f} remains N/A without a published exact value`);
      nodeAssert.equal(s[f].source, null);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null, `${item.id}: no response bound is invented`);
    nodeAssert.equal(s.frequencyResponse.high_hz, null, `${item.id}: no response bound is invented`);
    nodeAssert.equal(s.frequencyResponse.points, undefined, `${item.id}: no response curve is inferred`);
    if (item.power === null) {
      nodeAssert.equal(s.power.status, "UNAVAILABLE");
      nodeAssert.equal(s.power.source, null);
    } else {
      nodeAssert.equal(s.power.source, item.source);
      nodeAssert.equal(s.power.sourceType, item.sourceType);
      nodeAssert.equal(s.power.status, item.sourceType === "MANUFACTURER" ? "MANUFACTURER_VERIFIED" : "REPUTABLE_DATABASE_VERIFIED");
    }
    if (item.impedance === null) {
      nodeAssert.equal(s.impedance.status, "UNAVAILABLE");
      nodeAssert.equal(s.impedance.source, null);
    } else {
      nodeAssert.equal(s.impedance.source, item.source);
      nodeAssert.equal(s.impedance.sourceType, item.sourceType);
    }
  }
  const v212c = allDb.find((record) => record.id === "vox-v212c");
  const v212hwx = allDb.find((record) => record.id === "vox-v212hwx");
  const v212bn = allDb.find((record) => record.id === "vox-v212bn");
  const ppc412 = allDb.find((record) => record.id === "orange-ppc412");
  const loneStar = allDb.find((record) => record.id === "mesa-boogie-lone-star-2x12");
  assert(v212c && v212hwx && v212bn && ppc412 && loneStar, "variant-sensitive cabinet records must exist");
  nodeAssert.match(v212c.notes, /8 or 16 Ohms.*no single scalar impedance/i);
  nodeAssert.match(v212hwx.notes, /30 Watts RMS.*power field remains N\/A/i);
  nodeAssert.match(v212bn.notes, /No manufacturer specification page.*was located/i);
  nodeAssert.match(ppc412.notes, /8-ohm total load applies only when daisy-chaining/i);
  nodeAssert.match(loneStar.notes, /power remains N\/A rather than selecting one option/i);
});

check("REL S/812 keeps its powered-subwoofer output role and one-sided published extension", () => {
  const s = allDb.find((item) => item.id === "rel-s812");
  const source = "https://rel.net/wp-content/uploads/2019/08/S812-brochure.pdf";
  assert(s, "REL S/812 record must remain in the database");
  nodeAssert.equal(s.model, "S/812");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.active, true);
  nodeAssert.equal(s.power.value, 800);
  nodeAssert.equal(s.power.role, "amplifier_output");
  nodeAssert.equal(s.power.source, source);
  nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
  nodeAssert.equal(s.woofer.value, 12);
  nodeAssert.equal(s.woofer.source, source);
  nodeAssert.equal(s.frequencyResponse.low_hz, 19);
  nodeAssert.equal(s.frequencyResponse.high_hz, null, "do not invent an upper-frequency limit");
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.equal(s.sensitivity.value, null);
  nodeAssert.equal(s.impedance.value, null);
  nodeAssert.equal(s.driverCount, null, "retain uncertainty between the active woofer and passive radiator count");
  assert(s.notes.includes(source));
  nodeAssert.match(s.notes, /800 W RMS output from a NextGen5 Class D amplifier/);
  nodeAssert.match(s.notes, /-6 dB at 19 Hz/);
  nodeAssert.match(s.notes, /power role is integrated amplifier output/);
  nodeAssert.match(s.notes, /one active woofer from one passive radiator/);
});

check("Revel, ATC, PMC, and KRK Batch 099 specs retain exact source context and honest rating roles", () => {
  const expected: Array<any> = [
    { id: "revel-f206", model: "F206", source: "https://www.revelspeakers.com/products/in-room-loudspeakers/F206-.html", low: 52, high: null, woofer: 6.5, wooferUnit: "in", drivers: 4, active: null, sensitivity: null, impedance: 8, power: null },
    { id: "revel-m106", model: "M106", source: "https://www.revelspeakers.com/products/in-room-loudspeakers/M106-.html", low: 59, high: null, woofer: 6.5, wooferUnit: "in", drivers: 2, active: null, sensitivity: null, impedance: 8, power: null },
    { id: "atc-scm19", model: "SCM19", source: "https://atc.audio/hi-fi/loudspeakers/entry-series/scm19/", low: 54, high: 22000, woofer: 150, wooferUnit: "mm", drivers: 2, active: null, sensitivity: 85, sensitivityReference: "1W/1m", impedance: 8, power: null },
    { id: "atc-scm45a-pro", model: "SCM45A Pro", source: "https://atc.audio/professional/loudspeakers/scm45a-pro/", low: 42, high: 25000, woofer: 6.5, wooferUnit: "in", drivers: 3, active: true, sensitivity: null, impedance: null, power: null },
    { id: "atc-scm50asl-pro", model: "SCM50ASL Pro", source: "https://atc.audio/professional/loudspeakers/scm50a-pro/", low: 38, high: 25000, woofer: 9, wooferUnit: "in", drivers: 3, active: true, sensitivity: null, impedance: null, power: null },
    { id: "atc-scm100asl-pro", model: "SCM100ASL Pro", source: "https://atc.audio/professional/loudspeakers/scm100asl-pro/", low: 32, high: 25000, woofer: 12, wooferUnit: "in", drivers: 3, active: true, sensitivity: null, impedance: null, power: null },
    { id: "pmc-result6", model: "result6", source: "https://pmc-speakers.com/studio/active/result6", low: 45, high: 22000, woofer: 170, wooferUnit: "mm", drivers: 2, active: true, sensitivity: null, impedance: null, power: null },
    { id: "pmc-pmc6-2", model: "PMC6-2", source: "https://pmc-speakers.com/studio/pmc-6-2/", low: 33, high: 25000, woofer: 6, wooferUnit: "in", drivers: 4, active: true, sensitivity: null, impedance: null, power: null },
    { id: "pmc-pmc8-2", model: "PMC8-2", source: "https://pmc-speakers.com/studio/pmc-8-2/", low: 25, high: 25000, woofer: 8, wooferUnit: "in", drivers: 4, active: true, sensitivity: null, impedance: null, power: null },
    { id: "krk-v6-s4", model: "V6 S4", source: "https://www.krkmusic.com/products/v6-series-4-powered-studio-monitor", low: 49, high: 19000, woofer: 6.5, wooferUnit: "in", drivers: 2, active: true, sensitivity: null, impedance: null, power: 155, powerRole: "amplifier_output" },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.id} must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.source, item.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.points, undefined, "published range limits are not a measured response curve");
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.woofer.unit, item.wooferUnit);
    nodeAssert.equal(s.woofer.source, item.source);
    nodeAssert.equal(s.woofer.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.driverCount, item.drivers);
    nodeAssert.equal(s.active, item.active);
    nodeAssert.equal(s.sensitivity.value, item.sensitivity);
    nodeAssert.equal(s.impedance.value, item.impedance);
    nodeAssert.equal(s.power.value, item.power);
    assert(s.notes.includes(item.source), `${item.id} notes must retain the exact model source`);
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    if (item.sensitivity !== null) {
      nodeAssert.equal(s.sensitivity.reference, item.sensitivityReference);
      nodeAssert.equal(s.sensitivity.source, item.source);
      nodeAssert.equal(s.sensitivity.sourceType, "MANUFACTURER");
    } else {
      nodeAssert.equal(s.sensitivity.source, null, `${item.id} must not infer a sensitivity value or reference`);
    }
    if (item.impedance !== null) {
      nodeAssert.equal(s.impedance.source, item.source);
      nodeAssert.equal(s.impedance.sourceType, "MANUFACTURER");
    } else {
      nodeAssert.equal(s.impedance.source, null, `${item.id} input impedance is not speaker-load impedance`);
    }
    if (item.power !== null) {
      nodeAssert.equal(s.power.role, item.powerRole);
      nodeAssert.equal(s.power.source, item.source);
      nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
    } else {
      nodeAssert.equal(s.power.source, null, `${item.id} recommendations or channel ratings are not a scalar speaker rating`);
    }
  }

  const f206 = allDb.find((record) => record.id === "revel-f206");
  const scm19 = allDb.find((record) => record.id === "atc-scm19");
  const scm45 = allDb.find((record) => record.id === "atc-scm45a-pro");
  const scm50 = allDb.find((record) => record.id === "atc-scm50asl-pro");
  const scm100 = allDb.find((record) => record.id === "atc-scm100asl-pro");
  const result6 = allDb.find((record) => record.id === "pmc-result6");
  const pmc6 = allDb.find((record) => record.id === "pmc-pmc6-2");
  const pmc8 = allDb.find((record) => record.id === "pmc-pmc8-2");
  const krk = allDb.find((record) => record.id === "krk-v6-s4");
  assert(f206 && scm19 && scm45 && scm50 && scm100 && result6 && pmc6 && pmc8 && krk, "all Batch 099 speakers must exist");
  nodeAssert.match(f206.notes, /33 Hz \(-10 dB\).*40 Hz \(-6 dB\).*52 Hz \(-3 dB\)/);
  nodeAssert.match(f206.notes, /stores the explicit -3 dB point, 52 Hz/);
  const m106 = allDb.find((record) => record.id === "revel-m106");
  assert(m106, "Revel M106 must remain in the database");
  nodeAssert.match(m106.notes, /39 Hz \(-10 dB\).*54 Hz \(-6 dB\).*59 Hz \(-3 dB\)/);
  nodeAssert.match(m106.notes, /stores the explicit -3 dB point, 59 Hz/);
  nodeAssert.match(f206.notes, /50–200 W recommended-amplifier range is not speaker power handling/i);
  nodeAssert.match(scm19.notes, /75–300 W recommended amplifier range is not speaker power handling/i);
  for (const s of [scm45, scm50, scm100]) {
    nodeAssert.match(s.notes, /separate LF\/mid\/HF amplifier-channel outputs|LF\/mid\/HF amplifier outputs are separately specified/i);
    nodeAssert.match(s.notes, /input-sensitivity figure is not acoustic sensitivity/i);
    nodeAssert.match(s.notes, /not speaker-load impedance/i);
  }
  nodeAssert.match(result6.notes, /without stating a tolerance or measurement condition/i);
  for (const s of [pmc6, pmc8]) {
    nodeAssert.match(s.notes, /at -3 dB, measured at 1 m full-space, on-axis/i);
    nodeAssert.match(s.notes, /not entered as passive 1 W\/1 m sensitivity/i);
  }
  nodeAssert.equal(krk.power.value, 155);
  nodeAssert.equal(krk.power.role, "amplifier_output");
  nodeAssert.match(krk.notes, /125 W LF \+ 30 W HF/);
  nodeAssert.match(krk.notes, /separate 40 Hz–24 kHz -10 dB range is not substituted/i);
});

check("KICKER Batch 100 automotive speakers retain exact model limits and separate peak-input from continuous ratings", () => {
  const expected: Array<any> = [
    { id: "kicker-43dsc6504", model: "43DSC6504", source: "https://www.kicker.com/ds-coaxial-speakers-65", drivers: 2, woofer: 6.5, low: 40, high: 20000, sensitivity: 90, impedance: 4, power: 240, powerRole: "allowable_input" },
    { id: "kicker-47ksc6504", model: "47KSC6504", source: "https://www.kicker.com/47KSC650", drivers: 2, woofer: 6.5, low: 43, high: 21000, sensitivity: 90, impedance: 4, power: null },
    { id: "kicker-46csc654", model: "46CSC654", source: "https://www.kicker.com/CSC65-Coaxial-Speakers-4-Ohm", drivers: 2, woofer: 6.5, low: 40, high: 20000, sensitivity: 90, impedance: 4, power: 300, powerRole: "allowable_input" },
    { id: "kicker-46css674", model: "46CSS674", source: "https://www.kicker.com/CSS67-Component-System-4-Ohm", drivers: 2, woofer: 6.75, low: 35, high: 21000, sensitivity: null, impedance: 4, power: 300, powerRole: "allowable_input" },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.id} must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.active, null, "do not infer active/passive classification from a car-speaker product page");
    nodeAssert.equal(s.driverCount, item.drivers);
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.woofer.source, item.source);
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.source, item.source);
    nodeAssert.equal(s.frequencyResponse.points, undefined, "published range is not a response curve");
    nodeAssert.equal(s.impedance.value, item.impedance);
    nodeAssert.equal(s.impedance.source, item.source);
    nodeAssert.equal(s.sensitivity.value, item.sensitivity);
    if (item.sensitivity !== null) {
      nodeAssert.equal(s.sensitivity.reference, "1W/1m");
      nodeAssert.equal(s.sensitivity.source, item.source);
    } else {
      nodeAssert.equal(s.sensitivity.source, null, "no exact sensitivity is published for CSS67");
    }
    nodeAssert.equal(s.power.value, item.power);
    if (item.power !== null) {
      nodeAssert.equal(s.power.role, item.powerRole);
      nodeAssert.equal(s.power.source, item.source);
    } else {
      nodeAssert.equal(s.power.source, null, "recommended amplifier power is not speaker handling");
    }
    nodeAssert.equal(s.resonantFreq.value, null);
    nodeAssert.equal(s.voiceCoil.value, null);
    assert(s.notes.includes(item.source), `${item.id} notes must retain exact-model source`);
  }
  const ds = allDb.find((record) => record.id === "kicker-43dsc6504");
  const ks = allDb.find((record) => record.id === "kicker-47ksc6504");
  const csc = allDb.find((record) => record.id === "kicker-46csc654");
  const css = allDb.find((record) => record.id === "kicker-46css674");
  assert(ds && ks && csc && css, "all exact KICKER product records must exist");
  nodeAssert.match(ds.notes, /240 W figure is a peak input rating per ANSI\/CTA-2031-A/i);
  nodeAssert.match(ds.notes, /60 W RMS recommended-amplifier figure is not substituted/i);
  nodeAssert.match(ks.notes, /15–100 W RMS figure is recommended amplifier power/i);
  nodeAssert.match(csc.notes, /3\.3-ohm table entry is DC resistance, not substituted for nominal impedance/i);
  nodeAssert.match(csc.notes, /300 W peak rating is per ANSI\/CTA-2031-A/i);
  nodeAssert.match(css.notes, /the full kit is sold as a pair/i);
  nodeAssert.match(css.notes, /does not publish a sensitivity value/i);
});

check("Alpine, Hertz, and Audison Batch 101 values use exact model sources and continuous power roles", () => {
  const expected: Array<any> = [
    { id: "alpine-s-s65", model: "S-S65", source: "https://www.alpine-usa.com/company/press/2018/new-s-series-speakers-subwoofers-and-tough-power-pack-amplifiers-from-alpine-electronics", low: 70, high: 22000, power: 80, impedance: 4, woofer: 6.5, wooferUnit: "in", voiceCoil: 35, voiceCoilUnit: "mm", resonance: null, drivers: 2, active: null },
    { id: "alpine-r-s65c", model: "R-S65C", source: "https://www.alpine-usa.com/company/press/2018/new-s-series-speakers-subwoofers-and-tough-power-pack-amplifiers-from-alpine-electronics", low: 65, high: 29000, power: 100, impedance: 4, woofer: 6.5, wooferUnit: "in", voiceCoil: null, voiceCoilUnit: "in", resonance: null, drivers: 2, active: null },
    { id: "alpine-x-s65c", model: "X-S65C", source: "https://www.alpine-usa.com/company/press/2017/alpine-electronics-now-shipping-x-series-speakers", low: 60, high: 40000, power: 120, impedance: 4, woofer: 6.5, wooferUnit: "in", voiceCoil: null, voiceCoilUnit: "in", resonance: null, drivers: 2, active: null },
    { id: "hertz-dieci-dsk-165-3", model: "Dieci DSK 165.3", source: "https://static.hertz-audio.com/media/2021/04/DIECI3_TechSheet_DSK-165_3.pdf", low: 50, high: 23000, power: 80, impedance: 4, woofer: 165, wooferUnit: "mm", voiceCoil: 25, voiceCoilUnit: "mm", resonance: 67, drivers: 2, active: null },
    { id: "hertz-cento-ck-165", model: "Cento CK 165", source: "https://static.hertz-audio.com/media/2021/04/Hertz_CK165_Tech_Sheet_rev18A.pdf", low: 55, high: 22500, power: 95, impedance: 4, woofer: 165, wooferUnit: "mm", voiceCoil: 25, voiceCoilUnit: "mm", resonance: 60, drivers: 2, active: null },
    { id: "hertz-mille-pro-mpk-165-3", model: "Mille Pro MPK 165.3", source: "https://static.hertz-audio.com/media/2021/04/HERTZ_Mille-PRO_MPK165_Tech_Sheet.pdf", low: 40, high: 22500, power: 110, impedance: 4, woofer: 165, wooferUnit: "mm", voiceCoil: 25, voiceCoilUnit: "mm", resonance: 70, drivers: 2, active: null },
    { id: "audison-prima-apk-165", model: "Prima APK 165", source: "https://audison.com/product/apk-165/", low: 60, high: 20000, power: 100, impedance: 4, woofer: 165, wooferUnit: "mm", voiceCoil: 32, voiceCoilUnit: "mm", resonance: 80, drivers: 2, active: false },
    { id: "audison-voce-av-k6", model: "Voce AV K6", source: "https://audison.com/product/av-k6/", low: 50, high: 22000, power: 125, impedance: 4, woofer: 165, wooferUnit: "mm", voiceCoil: 30, voiceCoilUnit: "mm", resonance: 68, drivers: 2, active: null },
  ];
  for (const item of expected) {
    const s = allDb.find((record) => record.id === item.id);
    assert(s, `${item.id} must remain in the database`);
    nodeAssert.equal(s.model, item.model);
    nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
    nodeAssert.equal(s.frequencyResponse.low_hz, item.low);
    nodeAssert.equal(s.frequencyResponse.high_hz, item.high);
    nodeAssert.equal(s.frequencyResponse.source, item.source);
    nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
    nodeAssert.equal(s.frequencyResponse.points, undefined, "published bounds are not a response-point curve");
    nodeAssert.equal(s.power.value, item.power);
    nodeAssert.equal(s.power.role, "speaker_power_handling");
    nodeAssert.equal(s.power.source, item.source);
    nodeAssert.equal(s.impedance.value, item.impedance);
    nodeAssert.equal(s.impedance.source, item.source);
    nodeAssert.equal(s.woofer.value, item.woofer);
    nodeAssert.equal(s.woofer.unit, item.wooferUnit);
    nodeAssert.equal(s.woofer.source, item.source);
    nodeAssert.equal(s.voiceCoil.value, item.voiceCoil);
    nodeAssert.equal(s.voiceCoil.unit, item.voiceCoilUnit);
    nodeAssert.equal(s.resonantFreq.value, item.resonance);
    nodeAssert.equal(s.driverCount, item.drivers);
    nodeAssert.equal(s.active, item.active);
    nodeAssert.equal(s.sensitivity.value, null, "published SPL figures without a sensitivity reference remain N/A");
    nodeAssert.equal(s.sensitivity.source, null);
    nodeAssert.equal(s.notes.includes(item.source), true, `${item.id} notes must retain the exact source`);
    for (const field of ["frequencyResponse", "power", "impedance", "woofer"]) {
      nodeAssert.equal(s[field].sourceType, "MANUFACTURER");
      nodeAssert.equal(s[field].status, "MANUFACTURER_VERIFIED");
    }
    if (item.voiceCoil !== null) {
      nodeAssert.equal(s.voiceCoil.source, item.source);
      nodeAssert.equal(s.voiceCoil.sourceType, "MANUFACTURER");
    } else {
      nodeAssert.equal(s.voiceCoil.source, null);
    }
    if (item.resonance !== null) {
      nodeAssert.equal(s.resonantFreq.source, item.source);
      nodeAssert.equal(s.resonantFreq.sourceType, "MANUFACTURER");
    } else {
      nodeAssert.equal(s.resonantFreq.source, null);
    }
  }
  const s65 = allDb.find((record) => record.id === "alpine-s-s65");
  const dsk = allDb.find((record) => record.id === "hertz-dieci-dsk-165-3");
  const ck = allDb.find((record) => record.id === "hertz-cento-ck-165");
  const mpk = allDb.find((record) => record.id === "hertz-mille-pro-mpk-165-3");
  const apk = allDb.find((record) => record.id === "audison-prima-apk-165");
  const avk6 = allDb.find((record) => record.id === "audison-voce-av-k6");
  assert(s65 && dsk && ck && mpk && apk && avk6, "exact Batch 101 entries must exist");
  nodeAssert.match(s65.notes, /35 mm voice coil for its S-Series 6.5-inch speakers/i);
  nodeAssert.match(s65.notes, /80 W RMS, 240 W peak/);
  nodeAssert.match(dsk.notes, /80 W continuous \/ 160 W peak/);
  nodeAssert.match(ck.notes, /95 W continuous \/ 285 W peak/);
  nodeAssert.match(mpk.notes, /110 W continuous \/ 220 W peak/);
  nodeAssert.match(apk.notes, /supplied passive crossovers/);
  nodeAssert.equal(apk.active, false, "the manufacturer's explicit passive crossover description supports passive status");
  for (const s of [dsk, ck, mpk, apk, avk6]) {
    nodeAssert.match(s.notes, /without a measurement reference|has no measurement reference/i);
  }
});

check("Yamaha DXS12 source-backed specifications retain -10 dB and amplifier-output context", () => {
  const s = allDb.find((record) => record.id === "yamaha-dxs12");
  assert(s, "Yamaha DXS12 must remain in the database");
  nodeAssert.equal(s.model, "DXS12");
  nodeAssert.equal(s.category, "subwoofer");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  const source = "https://data.yamaha.com/files/download/other_assets/3/325553/dxr-dxs_en_om_c0.pdf";
  nodeAssert.equal(s.frequencyResponse.low_hz, 47);
  nodeAssert.equal(s.frequencyResponse.high_hz, 160);
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.sourceType, "MANUFACTURER");
  nodeAssert.equal(s.frequencyResponse.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(s.frequencyResponse.points, undefined, "published frequency bounds are not response-curve measurements");
  nodeAssert.equal(s.power.value, 600);
  nodeAssert.equal(s.power.role, "amplifier_output");
  nodeAssert.equal(s.power.source, source);
  nodeAssert.equal(s.power.sourceType, "MANUFACTURER");
  nodeAssert.equal(s.power.status, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(s.woofer.value, 12);
  nodeAssert.equal(s.woofer.unit, "in");
  nodeAssert.equal(s.woofer.source, source);
  nodeAssert.equal(s.voiceCoil.value, 2.5);
  nodeAssert.equal(s.voiceCoil.unit, "in");
  nodeAssert.equal(s.voiceCoil.source, source);
  nodeAssert.equal(s.driverCount, 1);
  nodeAssert.equal(s.active, true);
  nodeAssert.equal(s.impedance.value, null, "10 kΩ input impedance is not loudspeaker load impedance");
  nodeAssert.equal(s.sensitivity.value, null, "peak SPL and line-input sensitivity are not acoustic sensitivity");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.match(s.notes, /47–160 Hz \(-10 dB\)/);
  nodeAssert.match(s.notes, /950 W dynamic and 600 W continuous/);
  nodeAssert.match(s.notes, /Source: https:\/\/data\.yamaha\.com\/files\/download\/other_assets\/3\/325553\/dxr-dxs_en_om_c0\.pdf/);
});

check("zero duplicate IDs", () => {
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const s of db) {
    assert(typeof s.id === "string" && s.id.length > 0, `record with missing id: ${JSON.stringify(s).slice(0, 80)}`);
    if (seen.has(s.id)) dupes.push(s.id);
    seen.set(s.id, (seen.get(s.id) || 0) + 1);
  }
  assert(dupes.length === 0, `duplicate ids: ${dupes.join(", ")}`);
});

check("zero duplicate brand + model pairs", () => {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const s of db) {
    const key = `${String(s.brand).trim().toLowerCase()}|${String(s.model).trim().toLowerCase()}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  assert(dupes.length === 0, `duplicate brand|model pairs: ${dupes.join(", ")}`);
});

check("Morel Elate Carbon 62A uses its exact system row without inferring powered operation or system impedance", () => {
  const s = allDb.find((x) => x.id === "morel-elate-carbon-62a");
  assert(s, "morel-elate-carbon-62a must remain in the database");
  const source = "https://www.morelhifi.com/en/products/car-audio/reference-9/elate-carbon-16/elate-carbon-62-6-2-way-158";
  nodeAssert.equal(s.model, "Elate Carbon 62A");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.sensitivity.value, 87);
  nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.power.value, 180);
  nodeAssert.equal(s.power.role, "speaker_power_handling");
  nodeAssert.equal(s.woofer.value, 6.5);
  nodeAssert.equal(s.voiceCoil.value, 3);
  nodeAssert.equal(s.driverCount, 2);
  nodeAssert.equal(s.active, null, "the manufacturer's 'active' configuration describes external crossover use, not a built-in amplifier");
  nodeAssert.equal(s.impedance.value, null, "do not substitute component-driver impedance for the unlisted system impedance");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.frequencyResponse.low_hz, 30);
  nodeAssert.equal(s.frequencyResponse.high_hz, 25000);
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.frequencyResponse.points, undefined, "published limits are not measured response points");
  nodeAssert.match(s.notes, /180 W RMS power handling \/ 1000 W peak/i);
  nodeAssert.match(s.notes, /no response tolerance/i);
  nodeAssert.match(s.notes, /external electronic network/i);
  nodeAssert.match(s.notes, /system nominal impedance or system resonant frequency/i);
  const resolved = resolveSensitivity(s);
  nodeAssert.equal(resolved.isFallback, true, "2.83 V sensitivity must not be converted without a sourced system impedance");
  nodeAssert.equal(resolved.source, "none");
});

check("HEDD Type 20 original manual stays distinct from MK2/A-CORE and preserves its active-input sensitivity reference", () => {
  const s = allDb.find((x) => x.id === "hedd-type-20");
  assert(s, "hedd-type-20 must remain in the database");
  const source = "https://arispro.ru/pdf/HEDD/HEDD_Type20_Manual.pdf";
  nodeAssert.equal(s.model, "Type 20");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.active, true);
  nodeAssert.equal(s.driverCount, 3);
  nodeAssert.equal(s.woofer.value, 7);
  nodeAssert.equal(s.voiceCoil.value, 2, "voice-coil scalar is the exact 7-inch woofer coil, not the separate 4-inch midrange coil");
  nodeAssert.equal(s.frequencyResponse.low_hz, 32);
  nodeAssert.equal(s.frequencyResponse.high_hz, 50000);
  nodeAssert.equal(s.power.value, 900);
  nodeAssert.equal(s.power.role, "amplifier_output", "sum the three published internal 300 W amplifier ratings only as amplifier output");
  nodeAssert.equal(s.sensitivity.value, 90);
  nodeAssert.equal(s.sensitivity.reference, "218mVrms (-11dBu) input, 0dB gain, 1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.impedance.value, null, "10/47 kOhm are input impedances, not speaker load impedance");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.match(s.notes, /not Type 20 MK2 or Type 20 A-CORE/i);
  nodeAssert.match(s.notes, /individual woofer\/midrange\/tweeter responses/i);
  const resolved = resolveSensitivity(s);
  nodeAssert.equal(resolved.isFallback, true, "active-monitor input-voltage sensitivity is not normalized to 1 W/1 m");
  nodeAssert.equal(resolved.source, "none");
});

check("ELAC original Uni-Fi UB5 uses the 2016 UB5 row and normalizes only its stated 2.83 V/1 m sensitivity", () => {
  const s = allDb.find((x) => x.id === "elac-uni-fi-ub5");
  assert(s, "elac-uni-fi-ub5 must remain in the database");
  const source = "https://cdn.elac.com/uploads/2016/08/29132944/Uni-Fi-Sell-Sheet.pdf";
  nodeAssert.equal(s.model, "Uni-Fi UB5");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 3);
  nodeAssert.equal(s.active, false);
  nodeAssert.equal(s.panel, false);
  nodeAssert.equal(s.frequencyResponse.low_hz, 46);
  nodeAssert.equal(s.frequencyResponse.high_hz, 25000);
  nodeAssert.equal(s.impedance.value, 4);
  nodeAssert.equal(s.sensitivity.value, 85);
  nodeAssert.equal(s.sensitivity.reference, "2.83V/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.power.value, 140);
  nodeAssert.equal(s.power.role, "allowable_input");
  nodeAssert.equal(s.woofer.value, 5.25);
  nodeAssert.match(s.notes, /not the later UB52\/Uni-Fi 2\.0/i);
  const resolved = resolveSensitivity(s);
  nodeAssert.equal(resolved.isFallback, false);
  nodeAssert.equal(resolved.source, "manufacturer");
  nodeAssert.ok(Math.abs(resolved.valueDb - (85 - 10 * Math.log10((2.83 * 2.83) / 4))) < 1e-9);
});

check("Avantone base Mixcube uses only the exact passive-page data", () => {
  const s = allDb.find((x) => x.id === "ath-avantone-mixcube");
  assert(s, "ath-avantone-mixcube must remain in the database");
  const source = "https://avantonepro.com/en/products/mixcube-passive";
  nodeAssert.equal(s.model, "Mixcube");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 1);
  nodeAssert.equal(s.active, false);
  nodeAssert.equal(s.panel, false);
  nodeAssert.equal(s.frequencyResponse.low_hz, 200);
  nodeAssert.equal(s.frequencyResponse.high_hz, 10000);
  nodeAssert.equal(s.impedance.value, 8);
  nodeAssert.equal(s.sensitivity.value, 93);
  nodeAssert.equal(s.sensitivity.reference, "1W/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.power.value, null, "10–200 W is recommended amplifier power, not speaker handling");
  nodeAssert.equal(s.woofer.value, 5.25);
  nodeAssert.match(s.notes, /not the separately documented Mixcube Active/i);
  nodeAssert.equal(resolveSensitivity(s).valueDb, 93);
  nodeAssert.equal(resolveSensitivity(s).isFallback, false);
});

check("Fostex 6301B preserves the old manual's exact sensitivity reference and active-system limits", () => {
  const s = allDb.find((x) => x.id === "fostex-6301b");
  assert(s, "fostex-6301b must remain in the database");
  const source = "https://tcfurlong.com/wp-content/uploads/Fostex-6301B-Rental-Manual.pdf";
  nodeAssert.equal(s.model, "6301B");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 1);
  nodeAssert.equal(s.active, true);
  nodeAssert.equal(s.panel, false);
  nodeAssert.equal(s.frequencyResponse.low_hz, 80);
  nodeAssert.equal(s.frequencyResponse.high_hz, 13000);
  nodeAssert.equal(s.sensitivity.value, 84);
  nodeAssert.equal(s.sensitivity.reference, "W/m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.impedance.value, null, "4 ohms is the internal transducer load, not the active monitor input");
  nodeAssert.equal(s.power.value, null, "the manual's >10 W RMS value is for the EXT SP output");
  nodeAssert.equal(s.woofer.value, 3.94, "the specified 10 cm unit is a full-range driver");
  nodeAssert.match(s.notes, /not the later 6301N\/6301NB series/i);
  const resolved = resolveSensitivity(s);
  nodeAssert.equal(resolved.valueDb, 89);
  nodeAssert.equal(resolved.isFallback, true, "the exact W/m source reference is not silently rewritten to 1W/1m");
  nodeAssert.equal(resolved.source, "none");
});

check("Auratone 5C is the exact passive base model and uses the manufacturer's current specification", () => {
  const s = allDb.find((x) => x.id === "auratone-5c");
  assert(s, "auratone-5c must remain in the database");
  const source = "https://www.auratoneaudio.com/products";
  nodeAssert.equal(s.model, "5C Sound Cube");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 1);
  nodeAssert.equal(s.active, false);
  nodeAssert.equal(s.panel, false);
  nodeAssert.equal(s.sensitivity.value, 90);
  nodeAssert.equal(s.sensitivity.reference, "1W/1m");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.impedance.value, 8);
  nodeAssert.equal(s.frequencyResponse.low_hz, 80, "use Auratone's direct current 80 Hz bound, not the conflicting older distributor 75 Hz figure");
  nodeAssert.equal(s.frequencyResponse.high_hz, 15000);
  nodeAssert.equal(s.power.value, 25);
  nodeAssert.equal(s.power.role, "speaker_power_handling");
  nodeAssert.equal(s.woofer.value, 4.5);
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  nodeAssert.match(s.notes, /5C Active Super Sound Cube.*separately/i);
  nodeAssert.match(s.notes, /75 Hz.*80 Hz/i);
});

check("Harbeth Super HL5 Plus fields remain tied to the original RADIAL2 generation", () => {
  const s = allDb.find((x) => x.id === "harbeth-shl5");
  assert(s, "harbeth-shl5 must remain in the database");
  nodeAssert.equal(s.model, "Super HL5 Plus");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 3);
  nodeAssert.equal(s.active, false);
  nodeAssert.equal(s.panel, false);
  nodeAssert.equal(s.frequencyResponse.low_hz, 40);
  nodeAssert.equal(s.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(s.impedance.value, 6);
  nodeAssert.equal(s.sensitivity.value, 86);
  nodeAssert.equal(s.sensitivity.reference, "1W/1m");
  nodeAssert.equal(s.sensitivity.source, "https://the-ear.net/review-hardware/harbeth-super-hl5-plus-loudspeaker/");
  nodeAssert.equal(s.power.value, 150);
  nodeAssert.equal(s.power.role, "program_rating");
  nodeAssert.equal(s.power.source, "https://the-ear.net/review-hardware/harbeth-super-hl5-plus-loudspeaker/");
  nodeAssert.equal(s.woofer.value, 7.8);
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  nodeAssert.equal(s.frequencyResponse.points, undefined, "published plotted response is not silently digitized as points");
  nodeAssert.match(s.notes, /12287L\/R/);
  nodeAssert.match(s.notes, /without XD\/XD2 suffix/i);
  nodeAssert.match(s.notes, /not digitized/i);
});

check("Meyer MJF-212 retains only uncontroversial exact non-A identity and amplifier data", () => {
  const s = allDb.find((x) => x.id === "meyer-mjf212");
  assert(s, "meyer-mjf212 must remain in the database");
  nodeAssert.equal(s.model, "MJF-212");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 3);
  nodeAssert.equal(s.active, true);
  nodeAssert.equal(s.panel, false);
  nodeAssert.equal(s.woofer.value, 12);
  nodeAssert.equal(s.power.value, 1275);
  nodeAssert.equal(s.power.role, "amplifier_output");
  nodeAssert.equal(s.power.source, "https://www.svconline.com/products/meyer-sound-announces-mjf-212-high-power-stage-monitor-366663");
  nodeAssert.equal(s.frequencyResponse.low_hz, null, "conflicting exact-model press releases are not collapsed to one response bound");
  nodeAssert.equal(s.frequencyResponse.high_hz, null);
  nodeAssert.equal(s.sensitivity.value, null);
  nodeAssert.equal(s.impedance.value, null);
  nodeAssert.equal(s.voiceCoil.value, null);
  nodeAssert.match(s.notes, /not the later MJF-212A/i);
  nodeAssert.match(s.notes, /55 Hz versus 60 Hz/i);
  nodeAssert.match(s.notes, /2,550 W versus 2,250 W/i);
});

check("Opera 405 is sourced as the no-suffix Live analog model, not the distinct 405D", () => {
  const s = allDb.find((x) => x.id === "dbtechnologies-opera-405");
  assert(s, "dbtechnologies-opera-405 must remain in the database");
  const source = "https://www.manualslib.com/manual/759581/Db-Technologies-Opera-Live.html?page=6";
  nodeAssert.equal(s.model, "Opera 405");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 2);
  nodeAssert.equal(s.active, true);
  nodeAssert.equal(s.panel, false);
  nodeAssert.equal(s.frequencyResponse.low_hz, 60);
  nodeAssert.equal(s.frequencyResponse.high_hz, 18000);
  nodeAssert.equal(s.frequencyResponse.source, source);
  nodeAssert.equal(s.power.value, 300);
  nodeAssert.equal(s.power.role, "amplifier_output");
  nodeAssert.equal(s.power.source, source);
  nodeAssert.equal(s.woofer.value, 15);
  nodeAssert.equal(s.voiceCoil.value, 2.5, "field refers to the documented LF woofer voice coil");
  nodeAssert.equal(s.sensitivity.value, null, "the mic/line input sensitivity switch is not acoustic sensitivity");
  nodeAssert.equal(s.impedance.value, null, "LINE/MIC electrical input impedance is not speaker load impedance");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.match(s.notes, /unsuffixed analog dB Technologies OPERA Live 405/i);
  nodeAssert.match(s.notes, /OPERA 405D/i);
  nodeAssert.match(s.notes, /not acoustic sensitivity/i);
});

check("Magnepan MG 1.7 uses the exact 1.7 manual and preserves its 500 Hz sensitivity reference", () => {
  const s = allDb.find((x) => x.id === "magnepan-mg1.7");
  assert(s, "magnepan-mg1.7 must remain in the database");
  const source = "https://magnepan.com/pages/manual-controller";
  nodeAssert.equal(s.model, "MG 1.7");
  nodeAssert.equal(s.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(s.driverCount, 3);
  nodeAssert.equal(s.active, false);
  nodeAssert.equal(s.panel, true);
  nodeAssert.equal(s.frequencyResponse.low_hz, 40);
  nodeAssert.equal(s.frequencyResponse.high_hz, 22000);
  nodeAssert.equal(s.impedance.value, 4);
  nodeAssert.equal(s.sensitivity.value, 86);
  nodeAssert.equal(s.sensitivity.reference, "2.83V/1m at 500Hz");
  nodeAssert.equal(s.sensitivity.source, source);
  nodeAssert.equal(s.power.value, null, "120 W is a recommended amplifier minimum, not loudspeaker power handling");
  nodeAssert.equal(s.woofer.value, null, "the manual specifies a quasi-ribbon panel, not a cone diameter");
  nodeAssert.equal(s.resonantFreq.value, null);
  nodeAssert.match(s.notes, /unsuffixed 1\.7, not the later 1\.7i/i);
  nodeAssert.match(s.notes, /at least 120 W RMS per channel/i);
  const resolved = resolveSensitivity(s);
  nodeAssert.equal(resolved.isFallback, true, "500 Hz point sensitivity must not be converted as broadband sensitivity");
  nodeAssert.equal(resolved.source, "none");
});

check("Batch 116 exact-model research preserves tolerance, subsystem, and revision distinctions", () => {
  const adamson = allDb.find((s) => s.id === "adamson-e15");
  const air8 = allDb.find((s) => s.id === "void-air-8");
  const danley = allDb.find((s) => s.id === "danley-sh96");
  const eaw = allDb.find((s) => s.id === "eaw-kf760");
  const res2 = allDb.find((s) => s.id === "funktion-one-res2");
  assert(adamson && air8 && danley && eaw && res2, "all five Batch 116 records must remain present");

  const adamsonSource = "https://legacy.adamson.ai/support/downloads-directory/e-series/e15/1-e15-technicaldata/file";
  nodeAssert.equal(adamson.model, "E15");
  nodeAssert.equal(adamson.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(adamson.frequencyResponse.low_hz, 60);
  nodeAssert.equal(adamson.frequencyResponse.high_hz, 18000);
  nodeAssert.equal(adamson.frequencyResponse.source, adamsonSource);
  nodeAssert.equal(adamson.driverCount, 6);
  nodeAssert.equal(adamson.active, false);
  nodeAssert.equal(adamson.panel, false);
  nodeAssert.equal(adamson.woofer.value, 15);
  nodeAssert.equal(adamson.voiceCoil.value, 4, "this is the published LF voice coil, not a universal coil for every band");
  nodeAssert.equal(adamson.sensitivity.value, null, "peak SPL is not sensitivity");
  nodeAssert.equal(adamson.power.value, null, "LF/MF/HF AES and peak ratings remain separate");
  nodeAssert.equal(adamson.impedance.value, null, "LF/MF/HF impedances remain separate");
  nodeAssert.match(adamson.notes, /2 × 800\/2 × 3200 W/);
  nodeAssert.match(adamson.notes, /not sensitivity/i);

  const airSource = "https://voidacoustics.com/products/air/air8/";
  nodeAssert.equal(air8.model, "Air 8");
  nodeAssert.equal(air8.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(air8.sensitivity.value, 95);
  nodeAssert.equal(air8.sensitivity.reference, "1W/1m");
  nodeAssert.equal(air8.sensitivity.source, airSource);
  nodeAssert.equal(air8.power.value, 300);
  nodeAssert.equal(air8.power.role, "speaker_power_handling");
  nodeAssert.equal(air8.impedance.value, 8);
  nodeAssert.equal(air8.woofer.value, 8);
  nodeAssert.equal(air8.driverCount, 2);
  nodeAssert.equal(air8.active, false);
  nodeAssert.equal(air8.panel, false);
  nodeAssert.equal(air8.frequencyResponse.low_hz, null, "current -10 dB IEC limits are not put in a tolerance-free response field");
  nodeAssert.equal(air8.frequencyResponse.high_hz, null);
  nodeAssert.equal(air8.frequencyResponse.points, undefined, "the old v1.0 curve is not transferred to the current v2.2 record");
  nodeAssert.equal(air8.voiceCoil.value, null, "the v1.0 voice-coil detail is not assumed current");
  nodeAssert.match(air8.notes, /80 Hz–20 kHz at -10 dB per IEC 60268-5/);
  nodeAssert.match(air8.notes, /2018.*v1\.0/);
  nodeAssert.match(air8.notes, /none of those points\/plots.*is imported/i);

  const danleySource = "https://www.danleysoundlabs.com/products/sh96/";
  const danleyPointsSource = "https://www.danleysoundlabs.com/wp-content/uploads/2022/02/SH-96-spec-sheet3.pdf";
  nodeAssert.equal(danley.model, "SH-96");
  nodeAssert.equal(danley.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(danley.frequencyResponse.low_hz, 50);
  nodeAssert.equal(danley.frequencyResponse.high_hz, 16000);
  nodeAssert.equal(danley.frequencyResponse.source, danleySource);
  nodeAssert.equal(danley.frequencyResponse.pointsSource, danleyPointsSource);
  nodeAssert.equal(danley.frequencyResponse.pointsSourceType, "MANUFACTURER");
  nodeAssert.equal(danley.frequencyResponse.pointsStatus, "MANUFACTURER_VERIFIED");
  nodeAssert.equal(danley.frequencyResponse.points.length, 34);
  nodeAssert.deepEqual(danley.frequencyResponse.points[0], { hz: 30, db: 87.5 });
  nodeAssert.deepEqual(danley.frequencyResponse.points.at(-1), { hz: 18000, db: 91.5 });
  nodeAssert.match(danley.frequencyResponse.pointsContext, /does not specify the table's smoothing, microphone distance, drive level, or on-axis setup/);
  nodeAssert.equal(danley.sensitivity.value, 101);
  nodeAssert.equal(danley.sensitivity.reference, "2.83V/1m", "keep the exact voltage reference even when nominal impedance permits a DSP conversion");
  nodeAssert.equal(danley.impedance.value, 8);
  nodeAssert.equal(danley.power.value, 1400);
  nodeAssert.equal(danley.power.role, "speaker_power_handling");
  nodeAssert.equal(danley.woofer.value, 15);
  nodeAssert.equal(danley.driverCount, 11);
  nodeAssert.equal(danley.active, false);
  nodeAssert.equal(danley.panel, false);
  nodeAssert.match(danley.notes, /2800 W program/);
  nodeAssert.match(danley.notes, /5600 W peak figure remain distinct/);
  nodeAssert.equal(resolveSensitivity(danley).isFallback, false);

  const eawSource = "https://eaw.com/wp-content/uploads/2013/12/KF760_SPECS_rev1.pdf";
  nodeAssert.equal(eaw.model, "KF760");
  nodeAssert.equal(eaw.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(eaw.frequencyResponse.low_hz, 80, "use the single-enclosure bound, not the eight-box array's 40 Hz bound");
  nodeAssert.equal(eaw.frequencyResponse.high_hz, 16000);
  nodeAssert.equal(eaw.frequencyResponse.source, eawSource);
  nodeAssert.equal(eaw.driverCount, 6);
  nodeAssert.equal(eaw.active, false);
  nodeAssert.equal(eaw.panel, false);
  nodeAssert.equal(eaw.woofer.value, 12);
  nodeAssert.equal(eaw.sensitivity.value, null, "single-enclosure and array subsystem sensitivities are distinct");
  nodeAssert.equal(eaw.power.value, null, "LF/MF/HF continuous power remains separate");
  nodeAssert.equal(eaw.impedance.value, null, "LF/MF/HF impedance entries are not collapsed");
  nodeAssert.equal(eaw.frequencyResponse.points, undefined, "the exact spec sheet publishes no numeric point curve");
  nodeAssert.match(eaw.notes, /eight-enclosure-array range is 40 Hz–16 kHz/);
  nodeAssert.match(eaw.notes, /planned; this does not confirm a KF760 file/);

  const resSource = "https://funktion-one.com/product/res-2/";
  nodeAssert.equal(res2.model, "Res 2");
  nodeAssert.equal(res2.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(res2.frequencyResponse.low_hz, 60);
  nodeAssert.equal(res2.frequencyResponse.high_hz, 18000);
  nodeAssert.equal(res2.frequencyResponse.source, resSource);
  nodeAssert.equal(res2.driverCount, 3);
  nodeAssert.equal(res2.active, false);
  nodeAssert.equal(res2.panel, false);
  nodeAssert.equal(res2.woofer.value, 15);
  nodeAssert.equal(res2.sensitivity.value, null, "voltage-referenced subsystem sensitivities are not a single 1W/1m rating");
  nodeAssert.equal(res2.power.value, null, "driver/band power ratings remain separate");
  nodeAssert.equal(res2.impedance.value, null, "driver/band impedances remain separate");
  nodeAssert.match(res2.notes, /current official figure is stored/);
  nodeAssert.match(res2.notes, /50 Hz–18 kHz as 'Frequency Response ±3 dB'/);
  nodeAssert.equal(res2.frequencyResponse.points, undefined);

  const leads = directivityLeads as any[];
  const airLead = leads.find((lead) => lead.id === "void-air-8");
  const adamsonLead = leads.find((lead) => lead.id === "adamson-e15");
  const danleyLead = leads.find((lead) => lead.id === "danley-sh96");
  const eawLead = leads.find((lead) => lead.id === "eaw-kf760");
  const resLead = leads.find((lead) => lead.id === "funktion-one-res2");
  assert(airLead && adamsonLead && danleyLead && eawLead && resLead, "all exact-model directivity leads must be recorded");
  nodeAssert.equal(airLead.gll, undefined, "no Air 8 GLL URL is verified");
  nodeAssert.match(airLead.note, /guessed Air_8_v2\.2\.gll URL returned page-not-found/i);
  nodeAssert.match(airLead.note, /no binary\/header or polar payload is confirmed/i);
  nodeAssert.match(adamsonLead.note, /complete GLL library/);
  nodeAssert.match(danleyLead.note, /HTTP 500/);
  nodeAssert.match(eawLead.note, /KF760 entry/);
  nodeAssert.match(resLead.note, /separate Res 2SH model/);

  const laCases = [
    { id: "lacoustics-arcs", archive: "ARCS%20WIFO", model: "ARCS Wide", status: "PARTIALLY_VERIFIED" },
    { id: "legacy-la-3", archive: "Kara", model: "Kara", status: "PARTIALLY_VERIFIED" },
    { id: "legacy-la-7", archive: null, model: "X15 HiQ", status: "PARTIALLY_VERIFIED" },
  ];
  for (const c of laCases) {
    const lead = leads.find((item) => item.id === c.id);
    const record = allDb.find((item) => item.id === c.id);
    assert(lead && record, `${c.id} exact-model directivity/documentation lead must be retained`);
    nodeAssert.equal(lead.status, "LEAD_NOT_IMPORTED");
    nodeAssert.equal(record.model, c.model);
    nodeAssert.equal(record.overallStatus, c.status, `${c.id} status must derive from its exact-model sourced fields`);
    nodeAssert.match(lead.note, /not imported|not be imported|not yet been inspected|have not been inspected|not inspected|No .* (imported|added)/i);
    if (c.archive) nodeAssert.match(lead.archive, new RegExp(c.archive));
  }
  // Narrow authenticated-copy rule for L-Acoustics: a third-party-hosted copy may supply a field only when it is an
  // identified manufacturer document (document reference, date, copyright, host identity) naming the exact model.
  const kara = allDb.find((item) => item.id === "legacy-la-3");
  const karaSource = "https://www.promusic.cz/sites/default/files/product/field_files/kara_um_en_2.1.pdf";
  nodeAssert.equal(kara.model, "Kara", "KARA rule applies only to the first-generation Kara record");
  nodeAssert.equal(kara.impedance.value, 8);
  nodeAssert.equal(kara.impedance.sourceType, "THIRD_PARTY");
  nodeAssert.equal(kara.impedance.source, karaSource);
  nodeAssert.equal(kara.woofer.value, 8);
  nodeAssert.equal(kara.woofer.sourceType, "THIRD_PARTY");
  nodeAssert.equal(kara.woofer.source, karaSource);
  nodeAssert.equal(kara.driverCount, 3, "2 LF + 1 HF transducers per the manual");
  nodeAssert.equal(kara.power.value, null, "per-band RMS power is not a single figure and is not stored");
  nodeAssert.equal(kara.sensitivity.value, null, "no sensitivity is published");
  nodeAssert.equal(kara.frequencyResponse.low_hz, null, "the -10 dB bandwidth is preset-dependent and is not stored");
  nodeAssert.match(kara.notes, /KARA_UM_EN_2\.1/);
  nodeAssert.match(kara.notes, /January 7, 2014/);
  nodeAssert.match(kara.notes, /PRO MUSIC/);
  nodeAssert.match(kara.notes, /third-party-hosted/);
  nodeAssert.match(kara.notes, /KARA II is not used/);

  const arcsWide = allDb.find((item) => item.id === "lacoustics-arcs");
  const arcsWideSource = "https://www.promusic.cz/sites/default/files/product/field_files/arcswide_sp_en_5.0.pdf";
  nodeAssert.equal(arcsWide.driverCount, 2, "the exact passive two-way enclosure contains one LF and one HF transducer");
  nodeAssert.equal(arcsWide.active, false, "the manufacturer describes ARCS WIDE as passive and externally amplified");
  nodeAssert.equal(arcsWide.power.value, 450);
  nodeAssert.equal(arcsWide.power.role, "speaker_power_handling");
  nodeAssert.equal(arcsWide.power.source, arcsWideSource);
  nodeAssert.match(arcsWide.notes, /450 W RMS power handling/);
  nodeAssert.equal(arcsWide.impedance.value, 8);
  nodeAssert.equal(arcsWide.impedance.source, arcsWideSource);
  nodeAssert.equal(arcsWide.woofer.value, 12);
  nodeAssert.equal(arcsWide.woofer.source, arcsWideSource);
  nodeAssert.equal(arcsWide.frequencyResponse.low_hz, null, "the -10 dB bandwidth is not flattened into tolerance-free fields");
  nodeAssert.equal(arcsWide.frequencyResponse.high_hz, null, "the -10 dB bandwidth is not flattened into tolerance-free fields");
  nodeAssert.equal(arcsWide.frequencyResponse.source, null);
  nodeAssert.equal(arcsWide.sensitivity.value, null, "no sensitivity is published for this exact model in the retained sheet");
  nodeAssert.equal(arcsWide.resonantFreq.value, null);
  nodeAssert.equal(arcsWide.voiceCoil.value, null);
  nodeAssert.match(arcsWide.notes, /55 Hz–20 kHz at -10 dB/);
  nodeAssert.match(arcsWide.notes, /-6 dB nominal coverage angle of 30° × 90°/);
  nodeAssert.match(arcsWide.notes, /not an angle-resolved polar-response dataset/);

  const x15 = leads.find((item) => item.id === "legacy-la-7");
  nodeAssert.match(x15.note, /X15 HiQ page/);
  nodeAssert.match(x15.note, /renamed from X15 to X15 HiQ/, "the owner-approved rename must be recorded in the lead");
  // Owner answer (2026-10-12): V-DOSC (legacy-la-1) is no longer live; it is archived unchanged.
  const removedRound5 = removedOwnerRound5 as any;
  const vdosc = removedRound5.records.find((item: any) => item.id === "legacy-la-1");
  nodeAssert.equal(vdosc?.model, "V-DOSC", "V-DOSC must be retained in the round 5 archive, not deleted");
  nodeAssert.equal(db.find((item) => item.id === "legacy-la-1"), undefined, "V-DOSC must not be live");
  nodeAssert.equal(db.find((item) => item.id === "legacy-la-2"), undefined, "ARCS must not be live");
  nodeAssert.equal(removedRound5.records.find((item: any) => item.id === "legacy-la-2")?.model, "ARCS", "ARCS must be retained in the round 5 archive, not deleted");
});

check("Batch 117 exact KRK and Fender sources preserve generation, power-role, and tolerance distinctions", () => {
  const krk7000 = allDb.find((s) => s.id === "krk-7000");
  const rok5 = allDb.find((s) => s.id === "krk-rokit-5");
  const rok8 = allDb.find((s) => s.id === "krk-rokit-8");
  const bluesJr = allDb.find((s) => s.id === "fender-blues-junior-iv");
  assert(krk7000 && rok5 && rok8 && bluesJr, "all Batch 117 records must remain present");

  const krk7000Source = "https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK-7000b_spec_sheet.pdf?v=1708102022";
  nodeAssert.equal(krk7000.model, "7000B");
  nodeAssert.equal(krk7000.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(krk7000.sensitivity.value, 91);
  nodeAssert.equal(krk7000.sensitivity.reference, "1W/1m");
  nodeAssert.equal(krk7000.sensitivity.source, krk7000Source);
  nodeAssert.equal(krk7000.power.value, 150);
  nodeAssert.equal(krk7000.power.role, "speaker_power_handling");
  nodeAssert.equal(krk7000.impedance.value, 8);
  nodeAssert.equal(krk7000.woofer.value, 7);
  nodeAssert.equal(krk7000.driverCount, 2);
  nodeAssert.equal(krk7000.active, false);
  nodeAssert.equal(krk7000.frequencyResponse.low_hz, null, "the published ±3 dB range is not stored without tolerance support");
  nodeAssert.equal(krk7000.frequencyResponse.points, undefined, "the table lacks response-point measurement context");
  nodeAssert.match(krk7000.notes, /7000BS is a separate variant/);

  const rok5Source = "https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK_ROKIT_Powered_G1_Series_Manual.pdf?v=1708098973";
  nodeAssert.equal(rok5.model, "Rokit 5 G1");
  nodeAssert.equal(rok5.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(rok5.driverCount, 2);
  nodeAssert.equal(rok5.active, true);
  nodeAssert.equal(rok5.woofer.value, 5);
  nodeAssert.equal(rok5.woofer.source, rok5Source);
  nodeAssert.equal(rok5.power.value, null, "G1 HF/LF amplifier ratings remain separate");
  nodeAssert.equal(rok5.impedance.value, null, "10 kΩ line input is not speaker impedance");
  nodeAssert.equal(rok5.frequencyResponse.low_hz, null, "the manual's ±2 dB range is not flattened");
  nodeAssert.match(rok5.notes, /Generation 1 RP5/);

  const rok8Source = "https://cdn.shopify.com/s/files/1/0566/0809/6342/files/KRK-ROKIT-Powered-Generation-3-Series-Info-Sheet.pdf?v=1708098409";
  nodeAssert.equal(rok8.model, "Rokit 8 G3");
  nodeAssert.equal(rok8.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(rok8.driverCount, 2);
  nodeAssert.equal(rok8.active, true);
  nodeAssert.equal(rok8.woofer.value, 8);
  nodeAssert.equal(rok8.power.value, 100);
  nodeAssert.equal(rok8.power.role, "amplifier_output");
  nodeAssert.equal(rok8.power.source, rok8Source);
  nodeAssert.equal(rok8.frequencyResponse.low_hz, null, "the -10 dB frequency range is not flattened");
  nodeAssert.match(rok8.notes, /75 W LF \+ 25 W HF/);
  nodeAssert.match(rok8.notes, /peak SPL is not acoustic sensitivity/);

  const bluesJrSource = "https://www.fmicassets.com/Damroot/Original/10001/2231500_gamp_manual.pdf";
  nodeAssert.equal(bluesJr.model, "Blues Junior IV");
  nodeAssert.equal(bluesJr.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(bluesJr.power.value, 15);
  nodeAssert.equal(bluesJr.power.role, "amplifier_output");
  nodeAssert.equal(bluesJr.power.source, bluesJrSource);
  nodeAssert.equal(bluesJr.impedance.value, 8);
  nodeAssert.equal(bluesJr.woofer.value, 12);
  nodeAssert.equal(bluesJr.driverCount, 1);
  nodeAssert.equal(bluesJr.active, true);
  nodeAssert.equal(bluesJr.sensitivity.value, null);
  nodeAssert.equal(bluesJr.frequencyResponse.low_hz, null);
  nodeAssert.match(bluesJr.notes, /not as the speaker's power handling/);
});

check("Fender Bassman 410 uses its exact passive-cabinet manual and the other unqualified Fender revisions remain unavailable", () => {
  const bassman = allDb.find((record) => record.id === "fender-bassman-410");
  assert(bassman, "fender-bassman-410 must remain in the database");
  const source = "https://www.fmicassets.com/Damroot/Original/10001/OM_leg_bassamp_Bassman_115__410_2005.pdf";
  nodeAssert.equal(bassman.model, "Bassman 410");
  nodeAssert.equal(bassman.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(bassman.sensitivity.value, 96);
  nodeAssert.equal(bassman.sensitivity.reference, "1W/1m");
  nodeAssert.equal(bassman.sensitivity.source, source);
  nodeAssert.equal(bassman.sensitivity.sourceType, "MANUFACTURER");
  nodeAssert.equal(bassman.power.value, 350, "continuous handling, not the separately published 700 W program rating");
  nodeAssert.equal(bassman.power.role, "speaker_power_handling");
  nodeAssert.equal(bassman.power.source, source);
  nodeAssert.equal(bassman.impedance.value, 8);
  nodeAssert.equal(bassman.impedance.source, source);
  nodeAssert.equal(bassman.woofer.value, 10);
  nodeAssert.equal(bassman.woofer.source, source);
  nodeAssert.equal(bassman.active, false);
  nodeAssert.equal(bassman.driverCount, null, "the source mentions a horn but does not state an unambiguous total driver count");
  nodeAssert.equal(bassman.frequencyResponse.low_hz, null);
  nodeAssert.equal(bassman.frequencyResponse.high_hz, null);
  nodeAssert.equal(bassman.frequencyResponse.points, undefined);
  nodeAssert.match(bassman.notes, /part number 2347000000/);
  nodeAssert.match(bassman.notes, /700 W program rating/);
  nodeAssert.match(bassman.notes, /distinct from the separately documented Bassman 410 Neo/);

  const expected = [
    "fender-twin-reverb",
    "fender-deluxe-reverb",
    "fender-hot-rod-deluxe",
    "fender-princeton-reverb",
    "fender-super-reverb",
  ];
  const ledger = unresolvedAll as Record<string, any>;
  for (const id of expected) {
    const s = allDb.find((record) => record.id === id);
    assert(s, `${id} must be preserved`);
    nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
    nodeAssert.equal(s.notes, ledger[id].note);
    assert(ledger[id].sources.length >= 2, `${id} needs individual generation/revision sources`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(s[f].value, null, `${id}.${f} must remain N/A`);
      nodeAssert.equal(s[f].source, null, `${id}.${f} must not borrow another revision's provenance`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.equal(s.driverCount, null);
    nodeAssert.equal(s.active, null);
  }
  nodeAssert.match(allDb.find((s) => s.id === "fender-twin-reverb").notes, /Twin Reverb \(1976\).*Twin Reverb II/);
  nodeAssert.match(allDb.find((s) => s.id === "fender-hot-rod-deluxe").notes, /Hot Rod Deluxe Rev A.*Hot Rod Deluxe.*III/);
});

check("PreSonus Eris E4.5 uses exact non-Bluetooth product documentation; shortened E5, E6, and E8 rows stay unavailable", () => {
  const e45 = allDb.find((record) => record.id === "presonus-eris-4-5");
  assert(e45, "presonus-eris-4-5 must remain in the database");
  const source = "https://www.fmicassets.com/Damroot/Original/10017/OM_2777500103_PreSonus-Eris-E4.5_EN.pdf";
  nodeAssert.equal(e45.model, "Eris 4.5");
  nodeAssert.equal(e45.overallStatus, "PARTIALLY_VERIFIED");
  nodeAssert.equal(e45.power.value, 50, "pair-level amplifier output is distinct from speaker handling");
  nodeAssert.equal(e45.power.role, "amplifier_output");
  nodeAssert.equal(e45.power.source, source);
  nodeAssert.equal(e45.frequencyResponse.low_hz, 70);
  nodeAssert.equal(e45.frequencyResponse.high_hz, 20000);
  nodeAssert.equal(e45.frequencyResponse.source, source);
  nodeAssert.equal(e45.frequencyResponse.points, undefined, "published limits are not turned into response points");
  nodeAssert.equal(e45.woofer.value, 4.5);
  nodeAssert.equal(e45.woofer.source, source);
  nodeAssert.equal(e45.driverCount, 2);
  nodeAssert.equal(e45.active, true);
  nodeAssert.equal(e45.sensitivity.value, null, "peak SPL is not sensitivity");
  nodeAssert.equal(e45.impedance.value, null, "10 kΩ is line-input impedance, not speaker impedance");
  nodeAssert.match(e45.notes, /SKU 2777500103/);
  nodeAssert.match(e45.notes, /50 W amplifier power for the pair \(25 W per speaker\)/);
  nodeAssert.match(e45.notes, /no tolerance is stated/);

  const expected = ["presonus-eris-5", "presonus-eris-6", "presonus-eris-8"];
  const ledger = unresolvedAll as Record<string, any>;
  for (const id of expected) {
    const s = allDb.find((record) => record.id === id);
    assert(s, `${id} must be preserved`);
    nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
    nodeAssert.equal(s.notes, ledger[id].note);
    assert(ledger[id].sources.length >= 2, `${id} needs manufacturer revision/variant research sources`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(s[f].value, null, `${id}.${f} must remain N/A`);
      nodeAssert.equal(s[f].source, null, `${id}.${f} must not borrow another variant's provenance`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.equal(s.driverCount, null);
    nodeAssert.equal(s.active, null);
  }
  nodeAssert.match(allDb.find((s) => s.id === "presonus-eris-5").notes, /E5 XT update/);
  nodeAssert.match(allDb.find((s) => s.id === "presonus-eris-6").notes, /Eris E66 MTM monitor.*Eris Pro 6/);
  nodeAssert.match(allDb.find((s) => s.id === "presonus-eris-8").notes, /explicitly third-generation Eris Studio 8/);
});

check("PreSonus Eris 3.5 remains unavailable until the original-versus-2nd-generation identity is resolved", () => {
  const s = allDb.find((record) => record.id === "presonus-eris-3-5");
  assert(s, "presonus-eris-3-5 must be preserved");
  const ledger = unresolvedAll as Record<string, any>;
  nodeAssert.equal(s.model, "Eris 3.5");
  nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
  nodeAssert.equal(s.notes, ledger["presonus-eris-3-5"].note);
  assert(ledger["presonus-eris-3-5"].sources.length >= 4, "reviewed original and 2nd-generation product/manual sources must be retained");
  nodeAssert.match(s.notes, /SKU 2777500101/);
  nodeAssert.match(s.notes, /Eris 3.5 2nd Gen \(Pair\)/);
  nodeAssert.match(s.notes, /E3\.5BT is a separate Bluetooth model/);
  nodeAssert.match(s.notes, /not a directivity dataset/);
  for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
    nodeAssert.equal(s[f].value, null, `${f} must remain N/A until generation is known`);
    nodeAssert.equal(s[f].source, null, `${f} cannot borrow a revision-specific source`);
  }
  nodeAssert.equal(s.frequencyResponse.low_hz, null);
  nodeAssert.equal(s.frequencyResponse.high_hz, null);
  nodeAssert.equal(s.frequencyResponse.source, null);
  nodeAssert.equal(s.frequencyResponse.points, undefined);
  nodeAssert.equal(s.driverCount, null);
  nodeAssert.equal(s.active, null);
  nodeAssert.equal(s.panel, null);
});

check("Community CS215 and bare Turbosound TCS-115 remain preserved as individually researched unavailable identities", () => {
  const expected = ["community-cs215", "turbosound-tcs-115"];
  const ledger = unresolvedAll as Record<string, any>;
  for (const id of expected) {
    const s = allDb.find((record) => record.id === id);
    assert(s, `${id} must not be removed`);
    nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
    nodeAssert.equal(s.notes, ledger[id].note);
    assert(s.notes.length > 100, `${id} needs an individual research note`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(s[f].value, null, `${id}.${f} must remain N/A`);
      nodeAssert.equal(s[f].source, null, `${id}.${f} cannot claim unverified provenance`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.equal(s.frequencyResponse.source, null);
    nodeAssert.equal(s.driverCount, null);
    nodeAssert.equal(s.active, null);
    nodeAssert.equal(s.panel, null);
    assert(ledger[id].sources.length > 0, `${id} must cite individually reviewed sources`);
  }
  nodeAssert.match(allDb.find((s) => s.id === "community-cs215").notes, /no source establishes that V2-215S is the intended CS215/i);
  nodeAssert.match(allDb.find((s) => s.id === "community-cs215").notes, /SLS CSB215 is a different manufacturer/i);
  nodeAssert.match(allDb.find((s) => s.id === "turbosound-tcs-115").notes, /TCS-115C.*with the C suffix/i);
  nodeAssert.match(allDb.find((s) => s.id === "turbosound-tcs-115").notes, /TCS115B-AN/);
});

check("Monitor Audio Bronze and Silver generation-ambiguous records are individually preserved as unavailable", () => {
  const expected = [
    "monitor-audio-bronze-50",
    "monitor-audio-bronze-100",
    "monitor-audio-bronze-200",
    "monitor-audio-bronze-500",
    "monitor-audio-silver-50",
    "monitor-audio-silver-100",
    "monitor-audio-silver-300",
    "monitor-audio-silver-500",
  ];
  const ledger = unresolvedAll as Record<string, any>;
  for (const id of expected) {
    const s = allDb.find((record) => record.id === id);
    assert(s, `${id} must be preserved`);
    nodeAssert.equal(s.overallStatus, "UNAVAILABLE");
    nodeAssert.equal(s.notes, ledger[id].note);
    assert(s.notes.length > 150, `${id} needs its own exact-revision research note`);
    assert(ledger[id].sources.length >= 2, `${id} must cite the reviewed generation-specific sources`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq", "voiceCoil", "woofer"]) {
      nodeAssert.equal(s[f].value, null, `${id}.${f} must remain N/A`);
      nodeAssert.equal(s[f].source, null, `${id}.${f} must not claim another generation's source`);
    }
    nodeAssert.equal(s.frequencyResponse.low_hz, null);
    nodeAssert.equal(s.frequencyResponse.high_hz, null);
    nodeAssert.equal(s.frequencyResponse.points, undefined);
    nodeAssert.equal(s.driverCount, null);
    nodeAssert.equal(s.active, null);
    nodeAssert.equal(s.panel, null);
  }
  nodeAssert.match(allDb.find((s) => s.id === "monitor-audio-bronze-50").notes, /Bronze 50 6G.*Bronze 50 7G/);
  nodeAssert.match(allDb.find((s) => s.id === "monitor-audio-silver-500").notes, /Silver 6G.*Silver 7G/);
});

check("known Jensen P10R corrections preserved", () => {
  const s = allDb.find((x) => x.id === "jensen-p10r");
  assert(s, "jensen-p10r record is missing");
  assert(s.sensitivity.value === 94.2, `sensitivity ${s.sensitivity.value} != 94.2 dB`);
  assert(s.power.value === 25, `power ${s.power.value} != 25 W`);
  assert(s.resonantFreq.value === 97, `Fs ${s.resonantFreq.value} != 97 Hz`);
  assert(s.impedance.value === 8, `impedance ${s.impedance.value} != 8 ohm`);
});

check("known Jensen P12N corrections preserved", () => {
  const s = allDb.find((x) => x.id === "jensen-p12n");
  assert(s, "jensen-p12n record is missing");
  assert(s.sensitivity.value === 97.5, `sensitivity ${s.sensitivity.value} != 97.5 dB`);
  assert(s.power.value === 50, `power ${s.power.value} != 50 W`);
  assert(s.resonantFreq.value === 90, `Fs ${s.resonantFreq.value} != 90 Hz`);
  assert(s.impedance.value === 8, `impedance ${s.impedance.value} != 8 ohm`);
});

check("every record has the fields the app reads", () => {
  const bad: string[] = [];
  for (const s of db) {
    if (typeof s.brand !== "string" || typeof s.model !== "string") bad.push(`${s.id}: brand/model`);
    if (s.year !== null && typeof s.year !== "number") bad.push(`${s.id}: year must be number|null`);
    for (const f of ["sensitivity", "power", "impedance", "resonantFreq"]) {
      if (s[f] == null) bad.push(`${s.id}: missing ${f}`);
      else if (s[f].value !== null && !Number.isFinite(s[f].value)) bad.push(`${s.id}: ${f}.value not finite`);
    }
  }
  assert(bad.length === 0, `malformed records:\n        ${bad.slice(0, 10).join("\n        ")}`);
});

check("no NaN values anywhere in the database", () => {
  const found: string[] = [];
  const walk = (node: any, path: string) => {
    if (typeof node === "number" && !Number.isFinite(node)) found.push(path);
    else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) walk(node[k], `${path}.${k}`);
    }
  };
  db.forEach((s, i) => walk(s, s.id || `#${i}`));
  assert(found.length === 0, `non-finite numbers at: ${found.join(", ")}`);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
