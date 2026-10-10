import type { DecayFit } from './decay';

// ── Receiver Types ──────────────────────────────────────────────

/** Receiver input sent to the API. Extends the frontend Receiver with isPrimary. */
export interface ReceiverInput {
  id: string;
  name?: string;
  x: number;       // normalized 0..1
  y: number;       // normalized 0..1
  z?: number;      // meters; absent = unknown (a new receiver gets its starting height from the UI, not from analysis)
  isPrimary?: boolean;
}

// ── Structured Warnings ─────────────────────────────────────────

export type WarningSeverity = 'info' | 'warning' | 'error';

export type WarningCode =
  | 'INSUFFICIENT_DECAY_RANGE'
  | 'POOR_FIT'
  | 'SIMULATION_TRUNCATED'
  | 'STRONG_MODAL_BEHAVIOR'
  | 'OUT_OF_BOUNDS'
  | 'RESOURCE_LIMIT'
  | 'LOW_SPATIAL_RESOLUTION'
  | 'METRIC_UNAVAILABLE'
  | 'RECEIVER_AT_BOUNDARY'
  | 'RECEIVER_OUTSIDE_ROOM'
  | 'GRID_COARSE';

export interface StructuredWarning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  receiverId?: string;
  affectedMetric?: string;
}

// ── Per-Receiver Results ────────────────────────────────────────

export interface ReceiverMetrics {
  rt60?: number | null;
  edt?: number | null;
  t20?: number | null;
  t30?: number | null;
  c50?: number | null;
  c80?: number | null;
  d50?: number | null;
  /** Estimated/calibrated SPL from explicit source sensitivity calibration; never raw FDTD energy. */
  spl?: number | null;
  /** Raw simulation level, intentionally dimensionless/un-calibrated. */
  relativeLevelDb?: number | null;
  splBasis?: 'sensitivity_1w_1m_estimate' | 'calibrated_reference' | 'unavailable';
  centerTimeMs?: number | null;
  bands?: Record<string, ReceiverMetrics>;
}

export interface ReceiverDecayResult {
  edt: DecayFit;
  t20: DecayFit;
  t30: DecayFit;
  preferred: {
    metric: 'T30' | 'T20' | 'EDT';
    rt60Sec: number | null;
    r2: number | null;
    slopeDbPerSec: number | null;
    fitRangeDb: [number, number];
    sampleCount: number;
    status: 'VALIDATED' | 'LIMITED' | 'UNAVAILABLE';
    reason: string | null;
  } | null;
}

export interface ReceiverResult {
  id: string;
  name?: string;
  position: { x: number; y: number; z?: number };
  isPrimary: boolean;
  receiverTrace: number[];
  metrics: ReceiverMetrics;
  decay?: ReceiverDecayResult;
  warnings: StructuredWarning[];
  status: 'complete' | 'error';
}

// ── Spatial Summary ─────────────────────────────────────────────

export interface SpatialSummary {
  metric: string;
  min: number;
  max: number;
  mean: number;
  median?: number;
  stdDev: number;
  validCount: number;
}

// ── Receiver Grid ───────────────────────────────────────────────

export interface ReceiverGridDef {
  xMin: number;  // normalized 0..1
  xMax: number;
  yMin: number;
  yMax: number;
  zHeight: number;  // meters
  spacing: number;  // meters
}

// ── Heatmap ─────────────────────────────────────────────────────

export interface HeatmapPoint {
  x: number;
  y: number;
  /** null when the receiver's height is unknown (never substituted with a default height). */
  z: number | null;
  value: number;
  receiverId?: string;
}

export interface HeatmapData {
  metric: string;
  points: HeatmapPoint[];
  interpolated: boolean;
}

// ── Simulation Job State ────────────────────────────────────────

export type SimulationJobState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ── UX Mode ─────────────────────────────────────────────────────

export type UXMode = 'beginner' | 'engineering';

// ── Multi-Receiver Result Bundle ────────────────────────────────

export interface MultiReceiverResult {
  receivers: ReceiverResult[];
  spatialSummary: SpatialSummary[];
  warnings: StructuredWarning[];
}

// ── Resource Limits ─────────────────────────────────────────────

/** Maximum number of receivers per simulation request */
export const MAX_RECEIVERS = 64;

/** Maximum receivers for manual (non-grid) placement */
export const MAX_MANUAL_RECEIVERS = 16;

/** Maximum grid-generated receivers */
export const MAX_GRID_RECEIVERS = 64;
