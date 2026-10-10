// Single place where a Source's sensitivity is read for solver payloads and playback gain.
// The validity rule is the one resolveSensitivity() applies (a finite number > 0); nothing is invented here:
// a source without a usable value yields `null`, and callers decide how to report that (SPL = N/A).
import { SENSITIVITY_REFERENCE_DB } from './speakerResponse';

export interface SensitivityCarrier { manufacturerSensitivityDb?: unknown; sens?: unknown; manufacturerSensitivityReference?: unknown; speakerImpedanceOhm?: unknown }

/** A usable sensitivity (dB SPL @ 1 W / 1 m) or null. Rejects null, NaN, Infinity, strings, and values <= 0. */
export function validSensitivityDb(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** The sensitivity recorded on a store Source (manufacturer value first), or null when none is usable. */
export function sourceSensitivityDb(s: SensitivityCarrier | null | undefined): number | null {
  const raw = validSensitivityDb(s?.manufacturerSensitivityDb) ?? validSensitivityDb(s?.sens);
  if (raw === null) return null;
  const reference = typeof s?.manufacturerSensitivityReference === 'string' ? s.manufacturerSensitivityReference.trim() : '';
  if (!reference || /^1W\/1m$/i.test(reference)) return raw;
  if (/^2\.83(?:V|Vrms)\/1m$/i.test(reference)) {
    const impedance = typeof s?.speakerImpedanceOhm === 'number' && Number.isFinite(s.speakerImpedanceOhm) && s.speakerImpedanceOhm > 0 ? s.speakerImpedanceOhm : null;
    if (impedance === null) return null;
    const watts = (2.83 * 2.83) / impedance;
    if (!Number.isFinite(watts) || watts <= 0) return null;
    return raw - 10 * Math.log10(watts);
  }
  return null;
}

/**
 * Playback level offset (dB) relative to the resolver's unity reference. A source with no usable sensitivity
 * plays at unity (0 dB offset): playback level is a relative control, not a calibrated SPL.
 */
export function sensitivityOffsetDb(sens: unknown): number {
  const v = validSensitivityDb(sens);
  return v === null ? 0 : v - SENSITIVITY_REFERENCE_DB;
}
