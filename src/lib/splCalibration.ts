export interface SplCalibration { measuredDb: number; simulatedRelativeDb: number; offsetDb: number; calibratedDb: number; reference: string; }
export function calibrateRelativeLevel(simulatedRelativeDb:number, measuredDb:number): SplCalibration {
  if(!Number.isFinite(simulatedRelativeDb)||!Number.isFinite(measuredDb)) throw new Error('Calibration values must be finite.');
  const offsetDb=measuredDb-simulatedRelativeDb; return {measuredDb,simulatedRelativeDb,offsetDb,calibratedDb:simulatedRelativeDb+offsetDb,reference:'user-supplied microphone measurement'};
}
