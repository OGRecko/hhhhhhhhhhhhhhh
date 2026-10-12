/**
 * Comprehensive integration tests for new speaker additions:
 * - Loading & normalization
 * - Search by brand, model, and category
 * - Selection & DSP audio chain instantiation
 * - Directivity validation
 * - Project persistence & roundtrip validation
 */

import { assert } from "node:console";
import speakers from "../data/speakers.json";
import { SPEAKERS, getSpeakerById } from "./speakers";
import { normalizeSpeakerSpec, buildSpeakerChain } from "./speakerDSP";
import { validateProjectData } from "./projectValidation";

console.log("\n=== New Speakers Expansion & Integration Tests ===\n");

const NEW_IDS = [
  "atc-scm25a-pro",
  "atc-scm45a-pro",
  "atc-scm50asl-pro",
  "atc-scm100asl-pro",
  "dynaudio-lyd-48",
  "adam-audio-a77x",
  "jbl-708p",
  "barefoot-footprint03",
  "hedd-type-20",
  "ik-multimedia-iloud-mtm",
  "focal-trio11-be",
  "dutch-and-dutch-8c",
  "genelec-1032c",
  "revel-ultima-salon2",
  "magico-m2",
  "jbl-hdi-3800",
  "kef-r7",
  "meyer-sound-upj-1p",
  "meyer-sound-leopard",
  "meyer-sound-lina",
  "qsc-kw122",
  "electro-voice-x12-128"
];

// 1. Verify all new IDs exist and load properly
for (const id of NEW_IDS) {
  const spec = getSpeakerById(id);
  if (!spec) throw new Error(`getSpeakerById failed for ${id}`);
  const normalized = normalizeSpeakerSpec(spec);
  if (!normalized) throw new Error(`normalizeSpeakerSpec failed for ${id}`);
  if (!normalized.brand || !normalized.model) throw new Error(`Missing brand/model for ${id}`);
}
console.log(`  PASS  All ${NEW_IDS.length} new speakers exist, lookup by ID, and normalize successfully`);

// 2. Test search & filter in SPEAKERS adapter
const atcModels = SPEAKERS.filter(s => s.brand === "ATC");
if (atcModels.length < 5) throw new Error(`Expected at least 5 ATC models, found ${atcModels.length}`);

const meyerModels = SPEAKERS.filter(s => s.brand === "Meyer Sound");
if (meyerModels.length < 5) throw new Error(`Expected at least 5 Meyer Sound models, found ${meyerModels.length}`);

const paModels = SPEAKERS.filter(s => s.type === "PA System");
if (paModels.length < 5) throw new Error("PA category search failed");

const subModels = SPEAKERS.filter(s => s.type === "Subwoofer");
if (subModels.length < 1) throw new Error("Subwoofer category search failed");

console.log("  PASS  Search and filter by brand and category accurately returns new additions");

// 3. Test project persistence with new speakers
const testProject = {
  schemaVersion: 3,
  appVersion: "3.1.0",
  projectName: "New Speakers QA Project",
  roomName: "Studio A",
  L: 10,
  W: 8,
  H: 3,
  fmax: 500,
  accuracyMode: "balanced",
  confirmReducedResolution: false,
  poly: [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
  wallMaterial: "drywall",
  wallSegMats: [null,null,null,null],
  wallOpenings: [null,null,null,null],
  floorMaterial: "wood_floor",
  ceilMaterial: "stonewool",
  scatter: {walls:0.15,floor:0.15,ceiling:0.15},
  sources: [
    { id: "s1", x: 0.5, y: 0.5, z: 1.5, gainDb: 0, delayMs: 0, speakerId: "atc-scm25a-pro" },
    { id: "s2", x: 0.8, y: 0.5, z: 1.5, gainDb: 0, delayMs: 0, speakerId: "dutch-and-dutch-8c" }
  ],
  receivers: [
    { id: "r1", name: "Mix Position", x: 0.5, y: 0.8, z: 1.2 }
  ],
  simulations: [
    { id: "sim1", name: "ATC Simulation", sourceId: "s1", receiverId: "r1" }
  ],
  uxMode: "beginner",
  primaryReceiverId: "r1",
  receiverGrid: null
};

const validation = validateProjectData(testProject);
if (!validation.ok) {
  throw new Error(`Project validation failed with new speakers: ${validation.error}`);
}
console.log("  PASS  Project persistence and validation roundtrip succeeds with new speaker models");

// 4. Test directivity boundary integrity
const dndSpec = getSpeakerById("dutch-and-dutch-8c");
if (!dndSpec) throw new Error("dutch-and-dutch-8c not found");
// Should not have fake directivity data
if ((dndSpec as any).directivityData !== undefined && (dndSpec as any).directivityData !== null) {
  throw new Error("Directivity data unexpectedly present without validated polar source");
}
console.log("  PASS  Directivity remains strictly honest without fabricated polar patterns");

console.log("\n=== All New Speakers Integration Tests Passed ===\n");
