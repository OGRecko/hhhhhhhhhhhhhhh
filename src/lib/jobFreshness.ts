/**
 * A finished job's result may be applied to the editor only while the editor is still waiting for exactly that job.
 * Any edit, undo/redo or cancel clears the store's jobId (invalidateSimulationResults) and tears down the polling
 * effect, so a late response must not attach the OLD room's result to the NEW room.
 *
 * Every code path that stores a result after an `await` - including error/fallback paths - must use this check.
 */
export function shouldApplyJobResult(args: { effectActive: boolean; currentJobId: string | null | undefined; resultJobId: unknown }): boolean {
  const { effectActive, currentJobId, resultJobId } = args;
  return effectActive === true && typeof resultJobId === 'string' && resultJobId.length > 0 && currentJobId === resultJobId;
}
