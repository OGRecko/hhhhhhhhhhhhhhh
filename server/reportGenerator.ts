// Client-ready PDF report generation for a Cavity project.
//
// IMPORTANT — content honesty:
// - Only include data the project actually has. Don't fabricate speaker
//   specs, material names, or simulation results that weren't provided.
// - RT60/STI numbers are labeled with their calculation method and, for
//   STI, an explicit non-compliance disclaimer (see roomAcoustics.ts).
// - Never state or imply ISO 3382 compliance/certification. This report
//   references ISO 3382 as the standard reverberation-time measurement
//   convention RT60 figures are meant to be compared against — it does not
//   claim the app's calculation method is an ISO 3382-compliant
//   measurement (ISO 3382 describes measuring RT60 from a real room with
//   real instrumentation; this app computes a theoretical estimate from
//   modeled geometry and published material data instead).

import { APP_VERSION, SOLVER_VERSION, SPEAKER_DATABASE_VERSION } from '../src/lib/version.js';
import PDFDocument from 'pdfkit';
import {
  computeRT60,
  computeSTIProxy,
  BAND_LABELS,
  type RoomGeometryInput,
} from '../src/lib/roomAcoustics';
import { computeRealSTI } from '../src/lib/sti';

/** Height text for a table cell: the explicit value (including 0), or an honest "not set" with the assumed value when known. */
function zText(z: number | null | undefined, assumptions: ReportPositionAssumption[], kind: 'source' | 'receiver', index: number): string {
  if (typeof z === 'number' && Number.isFinite(z)) return `Z: ${z.toFixed(2)} m`;
  const a = assumptions.find(x => x.kind === kind && x.index === index);
  return a ? `Z: not set (assumed ${a.assumedMeters.toFixed(2)} m)` : 'Z: not set';
}

export interface ReportSpeaker {
  brand: string;
  model: string;
  type?: string;
  sens?: number | null;
  sensitivityStatus?: string;
  x: number;
  y: number;
  /** Height in metres. Absent/null means the request did not specify it (see positionAssumptions). */
  z?: number | null;
}

/** Mirrors PositionAssumption in solverWorker.ts (kept structural so the report has no dependency on the worker). */
export interface ReportPositionAssumption {
  kind: 'source' | 'receiver';
  id: string | null;
  index: number;
  axis: 'z';
  assumedMeters: number;
  rule: string;
}

/** Only the per-receiver solver fields the report reads. */
export interface ReportSolverReceiver {
  name?: string;
  receiverTrace?: number[];
  decay?: { preferred?: { status?: string; rt60Sec?: number | null } | null } | null;
}

export interface ReportReceiver {
  name: string;
  x: number;
  y: number;
  z?: number | null;
}

export interface ReportInput {
  projectName: string;
  roomName: string;
  room: RoomGeometryInput;
  speakers: ReportSpeaker[];
  receivers: ReportReceiver[];
  // Optional: if the client already ran the dedicated, long-duration
  // impulse response solver (/api/solver/impulse-response — NOT the quick
  // preview /api/solver/wave, which only simulates ~1ms and cannot produce
  // a meaningful simulatedRt60), include that result here for the
  // "simulation results" section.
  solverResult?: {
    rt60?: number | null;
    simulatedRt60?: number | null;
    // Full provenance for simulatedRt60 (see src/lib/decay.ts). Optional so
    // records persisted before this field existed still render — they just
    // fall back to the unlabelled figure below, same as before.
    decay?: {
      method: string;
      dynamicRangeDb: number;
      preferred: {
        metric: string;
        rt60Sec: number | null;
        r2: number | null;
        status: "VALIDATED" | "LIMITED" | "UNAVAILABLE";
        reason: string | null;
        fitRangeDb: [number, number];
      } | null;
    } | null;
    gridDims?: [number, number, number];
    tier?: string;
    // Present only when solverResult comes from the long-duration impulse
    // response endpoint (not the quick preview). When available, the
    // report uses these to compute a real MTF-based STI (see src/lib/sti.ts)
    // instead of the RT60-based proxy, so the report matches whatever the
    // in-app Results panel is showing for the same room.
    receiverTrace?: number[];
    dtEstimate?: number;

    actualDurationSec?: number;
    targetDurationSec?: number;
    steps?: number;
    actualFmax?: number;
    cellSizeM?: number;

    // When the impulse-response solver hit its step cap before the decay
    // curve reached its target duration, reachedTarget is false and warning
    // carries a human-readable explanation. Must be rendered, not dropped --
    // see the "IR truncated" note near the RT60/C80/D50/STI figures below.
    reachedTarget?: boolean;
    warning?: string | null;
    /** Per-receiver results (traces are attached server-side from stored artifacts). */
    receivers?: ReportSolverReceiver[];
    /** Every source/receiver whose Z was not supplied and was placed by the solver's documented assumption. */
    positionAssumptions?: ReportPositionAssumption[];
  } | null;
  // Assumed SNR for the STI proxy, since the app doesn't currently measure
  // real ambient noise. Defaulting to a reasonable "quiet room" assumption
  // and always labeling it as an assumption in the report, not a measurement.
  assumedSnrDb?: number;
  generatedForEmail?: string;

  simulationId?: string;
  appVersion?: string;
  solverVersion?: string;
  speakerDatabaseVersion?: string;

  // Server-issued timestamp and integrity hash (see server.ts's
  // /api/report/export handler). Optional so existing callers/tests that
  // don't pass them still work — the report just omits the hash line.
  generatedAt?: string;
  simulationHash?: string;
}

const CAVITY_AMBER = '#d97706';
const TEXT_DARK = '#1a1b1e';
const TEXT_MUTED = '#6b7280';

function drawHeader(doc: PDFKit.PDFDocument, title: string, subtitle: string) {
  doc.fontSize(20).fillColor(TEXT_DARK).font('Helvetica-Bold').text('Cavity', { continued: false });
  
  doc.fontSize(9).fillColor(TEXT_MUTED).font('Helvetica').text('Acoustic Simulation Report');
  
  // STAGE 21: Clearly label the mode (Physical Simulation vs Real-time Approximation)
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor(CAVITY_AMBER).text('STAGE 21 TECHNICAL COMPLIANCE');
  doc.fillColor(TEXT_MUTED).text('Metrics derived mathematically from the room model are labeled "Calculated". Metrics derived from the temporal FDTD solver are labeled "Computed from simulated IR". Speaker properties are labeled by their stored verification status; only fields explicitly marked manufacturer-verified are described as manufacturer specifications. The room simulation excites the model with an omnidirectional point source unless a validated directivity dataset is supplied for a source, and it does not use any speaker\'s frequency response. A speaker\'s sensitivity, when one is recorded, only scales the relative source level and the calibrated SPL estimate; without one, SPL is reported as N/A. Decay and energy-ratio metrics (RT60/EDT/T20/T30/C50/C80) do not depend on source level, so they differ between speakers only through supplied directivity data. Speaker specifications shown below are reference information only.');
  doc.moveDown();

  doc.moveDown(0.8);
  doc.fontSize(16).fillColor(TEXT_DARK).font('Helvetica-Bold').text(title);
  doc.fontSize(10).fillColor(TEXT_MUTED).font('Helvetica').text(subtitle);
  doc.moveDown(1);
  doc.strokeColor('#e5e7eb').lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(1);
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string) {
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor(TEXT_DARK).font('Helvetica-Bold').text(text.toUpperCase());
  doc.moveDown(0.3);
}

function labelValue(doc: PDFKit.PDFDocument, label: string, value: string) {
  doc.fontSize(9).font('Helvetica').fillColor(TEXT_MUTED).text(label, { continued: true });
  doc.font('Helvetica-Bold').fillColor(TEXT_DARK).text('  ' + value);
}

// Render a simple table: header row + data rows, fixed column widths.
function drawTable(doc: PDFKit.PDFDocument, headers: string[], rows: string[][], colWidths: number[]) {
  const startX = doc.page.margins.left;
  let y = doc.y;
  const rowHeight = 18;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(TEXT_DARK);
  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x, y, { width: colWidths[i], align: i === 0 ? 'left' : 'right' });
    x += colWidths[i];
  });
  y += rowHeight;
  doc.strokeColor('#e5e7eb').moveTo(startX, y - 4).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y - 4).stroke();

  doc.font('Helvetica').fontSize(8).fillColor(TEXT_DARK);
  rows.forEach(row => {
    x = startX;
    row.forEach((cell, i) => {
      doc.text(cell, x, y, { width: colWidths[i], align: i === 0 ? 'left' : 'right' });
      x += colWidths[i];
    });
    y += rowHeight;
  });

  // doc.text(cell, x, y) leaves doc.x at the last column; restore the left margin so
  // subsequent flowing text is not squeezed/clipped at the right page edge.
  doc.x = startX;
  doc.y = y + 8;
}

export function generateProjectReport(input: ReportInput): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });

  const rt60 = computeRT60(input.room);
  // No default SNR: the RT60-based proxy STI is only computed when the caller explicitly supplied one.
  const snr: number | null = typeof input.assumedSnrDb === 'number' && Number.isFinite(input.assumedSnrDb) ? input.assumedSnrDb : null;
  const midRt60: number | null = rt60.eyring[BAND_LABELS[3]] ?? rt60.sabine[BAND_LABELS[3]] ?? null; // 1000Hz; null => not computable, never invented
  const proxySti = midRt60 == null || snr === null ? null : computeSTIProxy(midRt60, snr);
  // Prefer the real MTF-based STI when a long-duration impulse response run
  // was supplied — same preference order as the in-app Results panel, so
  // the report and the UI never disagree about which number is "the" STI
  // for this project.
  const firstTrace = input.solverResult?.receivers?.[0]?.receiverTrace || input.solverResult?.receiverTrace;
  const irDt = input.solverResult?.dtEstimate;
  const irDtOk = typeof irDt === 'number' && Number.isFinite(irDt) && irDt > 0;
  const realStiResult = (firstTrace?.length && irDtOk)
    ? computeRealSTI(firstTrace, irDt as number)
    : null;
  const sti: { value: number; qualityLabel: string; disclaimer: string } | null = (realStiResult && realStiResult.sufficient) ? realStiResult : proxySti;
  const stiIsReal = realStiResult !== null && realStiResult.sufficient;

  const now = input.generatedAt ? new Date(input.generatedAt) : new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });  // --- Page 1: Project overview ---
  drawHeader(doc, input.projectName || 'Untitled Project', `Room: ${input.roomName || 'Untitled Room'} · Generated ${dateStr}`);

  sectionTitle(doc, 'Simulation Metadata');
  labelValue(doc, 'Application Version:', input.appVersion || APP_VERSION);
  labelValue(doc, 'Solver Version:', input.solverVersion || SOLVER_VERSION);
  labelValue(doc, 'Speaker DB Version:', input.speakerDatabaseVersion || SPEAKER_DATABASE_VERSION);
  if (input.simulationId) {
    labelValue(doc, 'Simulation ID:', input.simulationId);
  }
  if (input.simulationHash) {
    labelValue(doc, 'Integrity Hash:', input.simulationHash);
    doc.fontSize(8).fillColor(TEXT_MUTED).text('(This hash verifies that this PDF was generated directly from Cavity Audio server-owned simulation records without tampering.)', { indent: 160 }).moveDown(0.5);
  }
  if (input.solverResult) {
    const sr = input.solverResult;
    if (sr.gridDims) {
      labelValue(doc, 'Grid Resolution:', `${sr.gridDims[0]} x ${sr.gridDims[1]} x ${sr.gridDims[2]}`);
    }
    if (sr.cellSizeM) {
      labelValue(doc, 'Cell Size:', `${sr.cellSizeM.toFixed(3)} m`);
    }
    if (sr.actualDurationSec) {
      labelValue(doc, 'Simulated Duration:', `${sr.actualDurationSec.toFixed(2)}s`);
    }
    if (sr.targetDurationSec) {
      labelValue(doc, 'Target Duration:', `${sr.targetDurationSec.toFixed(2)}s`);
    }
    if (sr.reachedTarget !== undefined) {
      const status = sr.reachedTarget ? 'Completed (Reached Target)' : 'Truncated (Step Limit Reached)';
      labelValue(doc, 'Simulation Status:', status);
    }
  }

  sectionTitle(doc, 'Room Geometry');
  labelValue(doc, 'Dimensions (L x W x H):', `${input.room.L.toFixed(2)} m x ${input.room.W.toFixed(2)} m x ${input.room.H.toFixed(2)} m`);
  labelValue(doc, 'Floor area:', `${rt60.floorArea.toFixed(1)} m^2`);
  labelValue(doc, 'Volume:', `${rt60.volume.toFixed(1)} m^3`);
  doc.moveDown(0.5);

  sectionTitle(doc, 'Materials');
  labelValue(doc, 'Default wall material:', input.room.wallMaterial);
  labelValue(doc, 'Floor material:', input.room.floorMaterial);
  labelValue(doc, 'Ceiling material:', input.room.ceilMaterial);
  const distinctWallMats = Array.from(new Set((input.room.wallSegMats ?? []).filter((m): m is string => !!m)));
  if (distinctWallMats.length > 0) {
    labelValue(doc, 'Per-segment wall overrides:', distinctWallMats.join(', '));
  }
  doc.moveDown(0.5);

  const positionAssumptions = input.solverResult?.positionAssumptions ?? [];
  if (input.speakers.length > 0) {
    sectionTitle(doc, 'Speaker Configuration');
    drawTable(
      doc,
      ['Speaker', 'Type', 'Sensitivity', 'Position (x, y, z)'],
      input.speakers.map((s, i) => [`${s.brand} ${s.model}`, s.type || '—', `${s.sens ? s.sens + ' dB' : 'Unavailable'}\n(${s.sensitivityStatus || 'Unknown'})`, `${s.x.toFixed(2)}, ${s.y.toFixed(2)}\n${zText(s.z, positionAssumptions, 'source', i)}`]),
      [150, 100, 110, 130]
    );
  }

  if (input.receivers.length > 0) {
    sectionTitle(doc, 'Listening Positions');
    drawTable(
      doc,
      ['Receiver', 'Position (x, y, z)'],
      input.receivers.map((r, i) => [r.name, `${r.x.toFixed(2)}, ${r.y.toFixed(2)}\n${zText(r.z, positionAssumptions, 'receiver', i)}`]),
      [180, 190]
    );
  }
  if (positionAssumptions.length > 0) {
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#b45309').text(
      `\u26a0 Position assumption: ${positionAssumptions.length} source/receiver height(s) were not supplied. The solver placed them at a documented default height (${positionAssumptions.map(a => `${a.kind} ${a.id ?? a.index + 1}: ${a.assumedMeters.toFixed(2)} m`).join('; ')}). These heights are assumptions, not user-specified positions; set Z explicitly to remove the assumption.`,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  }

  // --- Page 2: Acoustic results ---
  doc.addPage();
  sectionTitle(doc, 'Reverberation Time (RT60)');
  doc.fontSize(8).font('Helvetica').fillColor(TEXT_MUTED).text(
    `Calculated using the ${rt60.recommendedMethod === 'eyring' ? 'Eyring' : 'Sabine'} equation, the recommended method for this room's average absorption level. ` +
    'Both classical reverberation-time formulas are shown below for reference; per-band absorption coefficients are drawn from standard published architectural acoustics references, not lab measurements of the specific materials used. ' +
    'This is a theoretical estimate from modeled geometry, not an on-site ISO 3382 measurement of a built space.',
    { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
  );
  doc.moveDown(0.5);

  drawTable(
    doc,
    ['Band', 'Sabine RT60 (s)', 'Eyring RT60 (s)', 'Avg. α'],
    BAND_LABELS.map(label => [
      label,
      rt60.sabine[label] == null ? 'N/A' : rt60.sabine[label]!.toFixed(2),
      rt60.eyring[label] == null ? 'N/A' : rt60.eyring[label]!.toFixed(2),
      rt60.avgAbsorption[label] == null ? 'N/A' : rt60.avgAbsorption[label]!.toFixed(3),
    ]),
    [100, 140, 140, 90]
  );

  sectionTitle(doc, 'Speech Transmission Index (Estimate)');
  const stiUnavailableReason = midRt60 == null
    ? 'RT60 could not be calculated — check wall/floor/ceiling materials'
    : (snr === null
      ? 'no simulated impulse response with valid timing data is available, and no signal-to-noise ratio was provided for an RT60-based estimate'
      : 'the RT60-based estimate could not be computed from the supplied inputs');
  labelValue(doc, stiIsReal ? 'STI (from simulated impulse response):' : 'STI (RT60-based proxy estimate):', sti ? `${sti.value.toFixed(2)} — ${sti.qualityLabel}` : `N/A (${stiUnavailableReason})`);
  if (!stiIsReal && sti && snr !== null) {
    labelValue(doc, 'Assumed signal-to-noise ratio:', `${snr} dB (user-supplied assumption, not measured)`);
  }
  doc.moveDown(0.3);
  doc.fontSize(8).font('Helvetica-Oblique').fillColor(TEXT_MUTED).text(sti ? sti.disclaimer : `STI is not reported: ${stiUnavailableReason}.`, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
  doc.moveDown(0.5);

  if (input.solverResult) {
    sectionTitle(doc, 'Wave Simulation (FDTD) Cross-Check');
    if (input.solverResult.rt60 != null) {
      labelValue(doc, 'Sabine RT60 (Calculated):', `${input.solverResult.rt60.toFixed(2)} s`);
    }
    if (input.solverResult.decay?.preferred) {
      // Preferred path: full provenance from Schroeder backward integration
      // (src/lib/decay.ts). Per §77, every important result gets value,
      // status, method and assumptions -- not a bare number.
      const d = input.solverResult.decay;
      const fit = d.preferred!;
      if (fit.status === 'UNAVAILABLE' || fit.rt60Sec == null) {
        labelValue(doc, `RT60 (${fit.metric}, from simulated IR):`, 'UNAVAILABLE');
        if (fit.reason) {
          doc.fontSize(8).font('Helvetica-Oblique').fillColor('#6b7280')
            .text(fit.reason, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        }
      } else {
        const statusLabel = fit.status === 'VALIDATED' ? '' : ` [${fit.status}]`;
        labelValue(
          doc,
          `RT60 (${fit.metric}, from simulated IR)${statusLabel}:`,
          `${fit.rt60Sec.toFixed(2)} s${fit.r2 != null ? `  (R\u00b2 = ${fit.r2.toFixed(3)})` : ''}`,
        );
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#6b7280').text(
          `Method: ${d.method}.` +
          (fit.fitRangeDb ? ` Fit range: ${fit.fitRangeDb[0]} to ${fit.fitRangeDb[1]} dB.` : '') +
          (d.dynamicRangeDb != null ? ` Usable dynamic range: ${d.dynamicRangeDb.toFixed(1)} dB.` : '') +
          (fit.status === 'LIMITED' && fit.reason ? ` ${fit.reason}` : ''),
          { width: doc.page.width - doc.page.margins.left - doc.page.margins.right },
        );
        doc.fillColor('#000000').font('Helvetica');
      }
    } else if (input.solverResult.simulatedRt60 != null) {
      // Legacy path: older persisted records have a bare simulatedRt60 with
      // no fit provenance (pre-Schroeder solver, or pre-this-field record).
      // Still rendered, but distinguishable from the labelled figure above.
      labelValue(doc, 'RT60 (from simulated IR, unlabelled legacy record):', `${input.solverResult.simulatedRt60.toFixed(2)} s`);
    }
    if (input.solverResult.gridDims) {
      labelValue(doc, 'Simulation grid:', input.solverResult.gridDims.join(' x '));
    }
    if (input.solverResult.reachedTarget === false) {
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#b45309').text(
        `\u26a0 IR TRUNCATED \u2014 ${input.solverResult.warning || 'the simulation was capped before the decay curve reached its target duration.'} All RT60/C80/D50/STI figures derived from this trace on this page may underestimate the room\u2019s true reverberance.`,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      );
    }
    if (input.solverResult.receivers && input.solverResult.receivers.length > 0) {
      doc.moveDown(0.5);
      sectionTitle(doc, 'Per-Receiver Simulated Metrics');
      const rows = input.solverResult.receivers.map((r, idx) => {
        const d = r.decay?.preferred;
        const rt60val = (d?.status !== 'UNAVAILABLE' && d?.rt60Sec != null) ? d.rt60Sec.toFixed(2) : 'N/A';
        const rowDt = input.solverResult?.dtEstimate;
        const stiVal = (r.receiverTrace?.length && typeof rowDt === 'number' && Number.isFinite(rowDt) && rowDt > 0) ? computeRealSTI(r.receiverTrace, rowDt).value.toFixed(2) : 'N/A';
        return [r.name || `Receiver ${idx+1}`, rt60val, stiVal];
      });
      drawTable(doc, ['Receiver', 'Simulated RT60 (s)', 'Simulated STI'], rows, [200, 140, 140]);
      
      doc.moveDown(0.3);
      doc.fontSize(8).font('Helvetica-Oblique').fillColor(TEXT_MUTED).text(
        'The simulated-decay figure is a rough cross-check extrapolated from a short time-domain run (single broadband absorption value per surface), not an independent, fully-converged measurement.',
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      );
    } else {
      doc.moveDown(0.3);
      doc.fontSize(8).font('Helvetica-Oblique').fillColor(TEXT_MUTED).text(
        'The simulated-decay figure is a rough cross-check extrapolated from a short time-domain run (single broadband absorption value per surface), not an independent, fully-converged measurement.',
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      );
    }
  }


  // --- Acoustic Rating & Diagnostics ---
  sectionTitle(doc, 'Scientific Acoustic Rating & Diagnostics');
  
  let ratingLabel = "Fair (Class C)";
  let ratingColor = "#eab308"; // yellow
  if (sti == null || midRt60 == null) {
    ratingLabel = midRt60 == null ? "N/A (RT60 not calculable)" : "N/A (STI not available)";
    ratingColor = "#6b7280";
  } else if (sti.value >= 0.75 && midRt60 < 1.0) {
    ratingLabel = "Excellent (Class A)";
    ratingColor = "#22c55e"; // green
  } else if (sti.value >= 0.6 && midRt60 < 1.5) {
    ratingLabel = "Good (Class B)";
    ratingColor = "#3b82f6"; // blue
  } else if (sti.value < 0.45 || midRt60 > 2.5) {
    ratingLabel = "Poor (Class D)";
    ratingColor = "#ef4444"; // red
  }

  doc.fontSize(12).font('Helvetica-Bold').fillColor(ratingColor).text(`Overall Acoustic Rating: ${ratingLabel}`);
  doc.moveDown(0.5);

  const diagnostics: string[] = [];
  
  // RT60 diagnosis
  if (midRt60 == null) diagnostics.push("• RT60 could not be calculated (unknown material or zero absorbing area), so no reverberation diagnosis is given.");
  else if (midRt60 < 0.5) diagnostics.push("• The room is highly damped (very short RT60), ideal for critical listening, studios, and cinemas.");
  else if (midRt60 < 1.2) diagnostics.push("• The room has a moderate reverberation time, suitable for general living spaces, classrooms, and speech.");
  else diagnostics.push("• The room is highly reverberant. Consider adding absorptive panels, acoustic clouds, or heavy curtains to reduce echo and improve clarity.");

  // Speaker placement diagnosis
  if (input.speakers.length > 0) {
    input.speakers.forEach((s, idx) => {
      // s.x/s.y are normalized (0-1) footprint coordinates -- the same
      // convention used everywhere else in the app (see roomAcoustics.ts's
      // RoomGeometryInput.poly, and how RightSidebar.tsx passes source.x/
      // source.y straight from the store's normalized Source.x/y). This
      // previously compared s.x/s.y directly against real-meter thresholds
      // (0.5m from a wall, room.L - 0.5m from the far wall) without ever
      // converting from normalized to real coordinates first. Since s.x is
      // always in [0,1] and room.L is typically 8-20m, `s.x < 0.5` was
      // true for roughly half of all speakers regardless of actual
      // placement, and `s.x > room.L - 0.5` was never true for any normal
      // room -- so the corner/near-wall/free-space diagnosis in the report
      // was essentially arbitrary rather than reflecting real placement.
      const realX = s.x * input.room.L;
      const realY = s.y * input.room.W;
      const isNearWallX = realX < 0.5 || realX > input.room.L - 0.5;
      const isNearWallY = realY < 0.5 || realY > input.room.W - 0.5;
      if (isNearWallX && isNearWallY) {
        diagnostics.push(`• Speaker ${idx + 1} (${s.brand} ${s.model}) is placed in a corner. This can increase low-frequency boundary reinforcement; the magnitude depends on room geometry, source directivity, and frequency.`);
      } else if (isNearWallX || isNearWallY) {
        diagnostics.push(`• Speaker ${idx + 1} (${s.brand} ${s.model}) is placed near a wall. This can increase boundary reinforcement and may introduce early reflections depending on geometry and the supplied directivity data.`);
      } else {
        diagnostics.push(`• Speaker ${idx + 1} (${s.brand} ${s.model}) is placed in free space (away from walls). This reduces immediate boundary interaction relative to near-wall placement; the resulting response still depends on room geometry and source characteristics.`);
      }
    });
  } else {
    diagnostics.push("• No speakers configured. Add speakers to evaluate placement acoustics.");
  }

  doc.fontSize(9).font('Helvetica').fillColor('#374151');
  diagnostics.forEach(diag => {
    doc.text(diag, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
    doc.moveDown(0.4);
  });
  doc.moveDown(0.5);

  // --- Methodology / references ---
  doc.moveDown(1);
  sectionTitle(doc, 'Methodology & References');
  doc.fontSize(8).font('Helvetica').fillColor(TEXT_MUTED).text(
    'Reverberation time is calculated using the Sabine (1898) and Eyring (1930) equations, standard methods in architectural acoustics. ' +
    'Material absorption coefficients are drawn from commonly published architectural acoustics references (ASTM C423-style octave-band data) rather than product-specific lab testing. ' +
    'ISO 3382 defines the standard convention for measuring and reporting reverberation time in a built space; the figures in this report are a theoretical estimate from modeled room geometry and reference material data, not an ISO 3382-compliant field measurement. ' +
    (stiIsReal
      ? 'The Speech Transmission Index figure was computed from this room\'s actual simulated impulse response using the modulation transfer function (indirect/Schroeder) method, but without the official IEC 60268-16 auditory masking correction, absolute threshold correction, or published band-importance weights — see the disclaimer above. It is not the certified IEC 60268-16 measurement and should not be used for compliance or certification purposes. '
      : 'The Speech Transmission Index figure, where reported, is a published proxy estimate derived from RT60 and a user-supplied signal-to-noise ratio, not the full IEC 60268-16 modulation transfer function measurement, and should not be used for compliance or certification purposes. ') +
    'This report is intended to support early-stage design decisions and client communication, not to replace on-site acoustic measurement or a licensed acoustical consultant\'s sign-off where required.',
    { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
  );

  doc.moveDown(1);
  doc.fontSize(7).fillColor(TEXT_MUTED).text(`Generated by Cavity on ${dateStr}${input.generatedForEmail ? ' for ' + input.generatedForEmail : ''}.`);
  if (input.simulationHash) {
    doc.fontSize(6).fillColor(TEXT_MUTED).text(
      `Report integrity reference: ${input.simulationHash} — this identifies the exact inputs used to generate this PDF; it does not certify the underlying simulation was independently re-run by the server.`
    );
  }

  // Do NOT call doc.end() here. This function's only caller (server.ts's
  // /api/report/export) does `doc.pipe(res); doc.end();` on the object this
  // returns -- calling .end() a second time on an already-finalized PDFKit
  // stream throws `ERR_STREAM_PUSH_AFTER_EOF` synchronously inside
  // PDFReference.finalize(), which the route's catch block turned into a
  // silent 500 "Failed to generate report." on every single call. There was
  // no test exercising this path end-to-end, so it went unnoticed.
  // Ending the stream is the caller's responsibility, once, after piping.
  return doc;
}
