// Display formatting for speaker specifications. Missing data is shown as unavailable, never as a plausible number.

/** Sensitivity is shown only when the database holds a value; a missing value is never rendered as a number. */
export function formatSensitivity(value: number | null | undefined, reference?: string | null, sourceType?: string | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'Unavailable — simulation uses a neutral reference level (modeled, not a speaker spec)';
  }
  const suffix = sourceType === 'REPUTABLE_DATABASE' ? ' (secondary source)' : sourceType === 'MEASUREMENT' ? ' (measurement)' : '';
  return reference ? `${value} dB @ ${reference}${suffix}` : `${value} dB (source reference not specified)${suffix}`;
}

/** Shows whichever bound(s) exist; never turns a missing bound into 0 Hz / 0.0 kHz. */
export function formatFrequencyRange(low: number | null | undefined, high: number | null | undefined): string {
  const has = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const fmtHigh = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}kHz` : `${v}Hz`);
  if (has(low) && has(high)) return `${low}Hz – ${fmtHigh(high)}`;
  if (has(low)) return `${low}Hz – N/A`;
  if (has(high)) return `N/A – ${fmtHigh(high)}`;
  return 'N/A';
}

export function formatPower(value: number | null | undefined, role?: string | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'N/A';
  switch (role) {
    case 'amplifier_output': return `${value}W amplifier output`;
    case 'recommended_amplifier': return `${value}W recommended amplifier`;
    case 'program_rating': return `${value}W program rating`;
    case 'allowable_input': return `${value}W allowable input`;
    case 'speaker_power_handling': return `${value}W power handling`;
    default: return `${value}W`;
  }
}

/** Displays the source's actual LF-driver unit; inches retain the compact quote notation used by the picker. */
export function formatWooferSize(value: number | null | undefined, unit?: string | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'N/A';
  const normalizedUnit = unit?.trim();
  if (!normalizedUnit || ['in', 'inch', 'inches', '"'].includes(normalizedUnit.toLowerCase())) return `${value}"`;
  return `${value} ${normalizedUnit}`;
}
