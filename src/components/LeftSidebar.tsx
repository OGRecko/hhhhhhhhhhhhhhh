import React, { useState, useEffect } from 'react';
import { useStore, type Receiver } from '../store/useStore';
import { 
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, 
  PointElement, Title, Tooltip, Legend
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import { X, Download, Camera, Search, Maximize, MoveUp, Move, Play } from 'lucide-react';
import { computeRT60, BAND_LABELS, computeEstimatedGAndSPL } from '../lib/roomAcoustics';
import { computeRealSTI } from '../lib/sti';
import { computeImpulseResponseParams, computePerBandImpulseResponseParams } from '../lib/impulseResponseParams';
import ReceiverTable from './ReceiverTable';
import SpatialHeatmap from './SpatialHeatmap';
import { sourceSensitivityDb } from '../lib/sourceSensitivity';
import { planReceiverGrid, strictNumber } from '../lib/receiverGrid';
import { LIMITS } from '../lib/publicLimits';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend);

// Parameters not computable from this app's current single-channel,
// non-calibrated solver output. Rather than fabricate plausible-looking
// numbers, these are surfaced as "not yet available" wherever selected.
// G (Strength) needs a calibrated free-field reference measurement at 10m;
// LF (Lateral Fraction) needs a figure-of-eight/lateral microphone signal.
// LJ ("loudness"? / OOP) are not standard ISO 3382 parameters and have no
// defined calculation in this codebase either — same treatment.
const UNAVAILABLE_PARAMS = new Set<string>(['LF']);
const UNAVAILABLE_PLOTS = new Set<string>(['Frequency response', 'Spatial decay']);

/**
 * Numeric text input that keeps what the user is typing while it is being edited and only commits a value that
 * is a real number inside [min, max]. Invalid or blank text is flagged (aria-invalid) and reverted on blur; it is
 * never turned into 0, so a legitimate 0 stays distinguishable from "nothing valid entered".
 */
function CoordInput({ label, value, min, max, step, theme, onCommit }: {
  /** null = the coordinate is unknown: the field is shown empty ("unknown") rather than filled with a guess. */
  label: string; value: number | null; min: number; max: number; step: number; theme: 'dark' | 'light'; onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const n = draft === null ? value : strictNumber(draft);
  const invalid = draft === null && value === null ? false : (n === null || n < min || n > max);
  return (
    <input
      aria-label={label}
      aria-invalid={invalid}
      title={invalid ? `Enter a number from ${min} to ${max}` : undefined}
      type="number" step={step} min={min} max={max}
      value={draft ?? (value === null ? '' : String(value))}
      placeholder={value === null ? 'unknown' : undefined}
      onChange={e => {
        setDraft(e.target.value);
        const parsed = strictNumber(e.target.value);
        if (parsed !== null && parsed >= min && parsed <= max) onCommit(parsed);
      }}
      onBlur={() => setDraft(null)}
      className={`w-full bg-transparent text-xs outline-none border-b ${invalid ? 'border-red-500' : theme === 'dark' ? 'border-[#2a2c30]' : 'border-[#e5e7eb]'} ${theme === 'dark' ? 'text-white' : 'text-black'}`}
    />
  );
}

export default function LeftSidebar() {
  const [activeTab, setActiveTab] = useState('parameters');
  const [activePlot, setActivePlot] = useState('IR');
  const {
    activeParam, setActiveParam, theme, simulations, addSimulation, removeSimulation, updateSimulation,
    sources, receivers, isPlaying, setIsPlaying,
    poly, L, W, H, wallMaterial, wallSegMats, wallOpenings, floorMaterial, ceilMaterial,
    uxMode, setUxMode, updateReceiver, removeReceiver, addReceiver, replaceReceivers,
  } = useStore();

  const [gridXMin, setGridXMin] = useState('0.1');
  const [gridXMax, setGridXMax] = useState('0.9');
  const [gridYMin, setGridYMin] = useState('0.1');
  const [gridYMax, setGridYMax] = useState('0.9');
  const [gridZ, setGridZ] = useState('1.2');
  const [gridSpacing, setGridSpacing] = useState('0.2');
  const [gridError, setGridError] = useState<string | null>(null);
  const MAX_RECEIVERS = LIMITS.MAX_RECEIVERS;

  const gridPlan = React.useMemo(
    () => planReceiverGrid({ xMin: gridXMin, xMax: gridXMax, yMin: gridYMin, yMax: gridYMax, z: gridZ, spacing: gridSpacing }, H, MAX_RECEIVERS),
    [gridXMin, gridXMax, gridYMin, gridYMax, gridZ, gridSpacing, H, MAX_RECEIVERS],
  );

  const handleGenerateGrid = () => {
    if (!gridPlan.ok) { setGridError(gridPlan.error); return; }
    const newRecs: Receiver[] = [];
    let id = 1;
    for (const x of gridPlan.xs) {
      for (const y of gridPlan.ys) {
        newRecs.push({ id: id.toString(), name: `Rec ${id}`, x, y, z: gridPlan.z });
        id++;
      }
    }
    try {
      replaceReceivers(newRecs); // validates the limit, records history, clears stale results
      setGridError(null);
    } catch (err) {
      setGridError(err instanceof Error ? err.message : 'Could not generate the receiver grid.');
    }
  };

  // Real per-band RT60/absorption from the room's actual geometry and
  // materials (src/lib/roomAcoustics.ts) — computed locally, no network
  // round-trip needed since it only depends on state already in the store.
  const rt60Result = React.useMemo(() => computeRT60({
    poly, L, W, H, wallMaterial, wallSegMats, wallOpenings, floorMaterial, ceilMaterial,
  }), [poly, L, W, H, wallMaterial, wallSegMats, wallOpenings, floorMaterial, ceilMaterial]);

  // Real decay-based metrics come ONLY from the dedicated, long-duration
  // impulse response run — never from the quick preview solver's ~1ms
  // trace, which is fine for visualizing the mesh but physically cannot
  // produce a meaningful RT60/C50/C80/Ts. See useStore's
  // lastImpulseResponseResult vs lastSolverResult for why these are kept
  // separate.
  const lastIrResult = useStore((s: any) => s.lastImpulseResponseResult);
  // A missing/non-finite time step means the IR timing is unknown: report N/A
  // rather than inventing dt = 0.1 ms.
  const irDtValid = Number.isFinite(lastIrResult?.dtEstimate) && lastIrResult.dtEstimate > 0;
  const irParams = React.useMemo(() => {
    if (!lastIrResult?.receiverTrace?.length || !irDtValid) return null;
    return computeImpulseResponseParams(lastIrResult.receiverTrace, lastIrResult.dtEstimate, lastIrResult.rt60);
  }, [lastIrResult, irDtValid]);

  // Real per-band C50/C80/D50/Ts (octave-filtered, ISO 3382-1 style) — used
  // for the per-band bar chart below instead of repeating irParams' single
  // broadband value across every column.
  const irParamsPerBand = React.useMemo(() => {
    if (!lastIrResult?.receiverTrace?.length || !irDtValid) return null;
    return computePerBandImpulseResponseParams(lastIrResult.receiverTrace, lastIrResult.dtEstimate, lastIrResult.rt60, (lastIrResult as any).reliableFmaxHz);
  }, [lastIrResult, irDtValid]);

  // Real MTF-based STI, computed directly from an actual long-duration impulse response run, and only when
  // that run has valid timing data (dt) and is long enough. Not an IEC 60268-16 certified value.
  const realSti = React.useMemo(() => {
    if (!lastIrResult?.receiverTrace?.length || !irDtValid) return null;
    const result = computeRealSTI(lastIrResult.receiverTrace, lastIrResult.dtEstimate);
    return result.sufficient ? result : null;
  }, [lastIrResult, irDtValid]);

  // STI is only reported from a real simulated impulse response with valid timing data. The RT60-based proxy
  // needs a signal-to-noise ratio and the UI has no SNR input (and no default is invented), so otherwise: N/A.
  const sti = realSti;
  const estimatedGAndSPL = React.useMemo(() => {
    const activeSim = simulations[0];
    if (!activeSim) return null;
    const src = sources.find(s => s.id === activeSim.sourceId);
    const rec = receivers.find(r => r.id === activeSim.receiverId);
    if (!src || !rec) return null;
    const sourceSens = sourceSensitivityDb(src); // null => flagged fallback in the result
    return computeEstimatedGAndSPL(rt60Result, { poly, L, W, H, wallMaterial, floorMaterial, ceilMaterial, wallSegMats, wallOpenings }, src, rec, sourceSens);
  }, [rt60Result, poly, L, W, H, wallMaterial, floorMaterial, ceilMaterial, wallSegMats, wallOpenings, simulations, sources, receivers]);

  const getBarData = (): (number | null)[] => {
    switch (activeParam) {
      // Real per-band values (octave-filtered per ISO 3382-1) — each band
      // is now a genuinely different number, not the same broadband value
      // repeated across every column. Falls back to null (not the
      // broadband figure) when no IR run has been computed yet, so the UI
      // shows "no data" rather than a misleading flat bar.
      case 'C50': return BAND_LABELS.map(l => irParamsPerBand?.c50[l] ?? null);
      case 'C80': return BAND_LABELS.map(l => irParamsPerBand?.c80[l] ?? null);
      case 'D50': return BAND_LABELS.map(l => irParamsPerBand?.d50[l] ?? null);
      case 'TS': return BAND_LABELS.map(l => irParamsPerBand?.centerTimeMs[l] ?? null);
      case 'SPL': return BAND_LABELS.map(l => estimatedGAndSPL?.SPL[l] ?? null);
      case 'STI': return BAND_LABELS.map(() => sti ? sti.value : null);
      case 'G': return BAND_LABELS.map(l => estimatedGAndSPL?.G[l] ?? null);
      case 'LF': return BAND_LABELS.map(() => null);
      default: return BAND_LABELS.map(() => null);
    }
  };

  const barDataRaw = getBarData();
  const hasBarData = barDataRaw.some(v => v != null);

  const barData = {
    labels: BAND_LABELS.map(l => l.replace(' Hz', '')),
    datasets: [{
      label: activeParam,
      data: barDataRaw.map(v => v ?? 0),
      backgroundColor: '#2563eb',
    }],
  };

  // Real IR/EDC from the solver's actual receiver trace when available;
  // otherwise an empty series rather than randomly-generated placeholder
  // data. Frequency response and Spatial decay have no real data source
  // yet (the solver returns a single receiver trace, not a swept frequency
  // measurement or multiple spatial samples) and are left empty too.
  const getLineData = (): number[] => {
    const trace: number[] = lastIrResult?.receiverTrace || [];
    switch (activePlot) {
      case 'IR':
        return trace;
      case 'IR [dB]':
        return trace.map(v => Math.max(-80, 20 * Math.log10(Math.abs(v) + 0.0001)));
      case 'EDC': {
        // Schroeder backward integration of the real trace's energy — a
        // genuine energy decay curve from actual simulated data, not a
        // fabricated exponential.
        if (trace.length === 0) return [];
        const energy = trace.map(v => v * v);
        const total = energy.reduce((a, b) => a + b, 0);
        if (total <= 0) return trace.map(() => 0);
        let cumulative = 0;
        const remaining = energy.map(e => { cumulative += e; return total - cumulative; });
        return remaining.map(r => 10 * Math.log10(Math.max(r, 1e-9) / total));
      }
      case 'Frequency response':
      case 'Spatial decay':
        return [];
      default:
        return [];
    }
  };

  const lineDataRaw = getLineData();
  const hasLineData = lineDataRaw.length > 0;
  const dt = irDtValid ? lastIrResult.dtEstimate : 0; // only used when irDtValid; otherwise time labels are blank

  const lineData = {
    labels: activePlot === 'Frequency response' ? BAND_LABELS.map(l => l.replace(' Hz', '')) : 
            activePlot === 'Spatial decay' ? lineDataRaw.map((_, i) => (i + 1) + 'm') :
            irDtValid ? lineDataRaw.map((_, i) => (i * dt * 1000).toFixed(1)) : lineDataRaw.map(() => ''),
    datasets: [{
      label: activePlot,
      data: lineDataRaw,
      borderColor: '#2563eb',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.1,
    }],
  };

  const commonOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
  };

  const barOptions = {
    ...commonOptions,
    scales: {
      x: { grid: { color: theme === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)", drawBorder: false }, ticks: { color: theme === 'dark' ? '#83868c' : '#6b7280', font: { size: 10 } }, title: { display: true, text: 'FREQUENCY [Hz]', color: theme === 'dark' ? '#83868c' : '#6b7280', font: { size: 10 } } },
      y: { grid: { color: theme === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)", drawBorder: false }, ticks: { color: theme === 'dark' ? '#83868c' : '#6b7280', font: { size: 10 } } },
    },
  };

  const lineOptions = {
    ...commonOptions,
    scales: {
      x: { grid: { color: theme === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)", drawBorder: false }, ticks: { color: theme === 'dark' ? '#83868c' : '#6b7280', font: { size: 10 }, maxTicksLimit: 6 }, title: { display: true, text: activePlot === 'Spatial decay' ? 'DISTANCE [m]' : activePlot === 'Frequency response' ? 'FREQUENCY [Hz]' : 'TIME [ms]', color: theme === 'dark' ? '#83868c' : '#6b7280', font: { size: 10 } } },
      y: { grid: { color: theme === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)", drawBorder: false }, ticks: { color: theme === 'dark' ? '#83868c' : '#6b7280', font: { size: 10 } }, title: { display: true, text: activePlot === 'IR' ? 'PRESSURE' : 'LEVEL [dB]', color: theme === 'dark' ? '#83868c' : '#6b7280', font: { size: 10 } } },
    },
  };

  return (
    <div className={`w-full ${theme === 'dark' ? 'bg-[#1a1b1e] text-[#e7e7e5]' : 'bg-[#ffffff] text-[#111827]'} flex flex-col flex-1 shrink-0 min-h-0`}>
      <div className={`flex border-b shrink-0 ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-[#e5e7eb]'}`}>
        <div 
          className={`flex-1 text-center py-4 cursor-pointer border-b-2 text-xs font-semibold tracking-wide transition-colors ${activeTab === 'parameters' ? `border-[#2563eb] ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-[#111827]'}` : `border-transparent ${theme === 'dark' ? 'text-[#83868c] hover:text-[#e7e7e5]' : 'text-[#6b7280] hover:text-[#111827]'}`}`}
          onClick={() => setActiveTab('parameters')}
        >
          Parameters
        </div>
        <div 
          className={`flex-1 text-center py-4 cursor-pointer border-b-2 text-xs font-semibold tracking-wide transition-colors ${activeTab === 'plots' ? `border-[#2563eb] ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-[#111827]'}` : `border-transparent ${theme === 'dark' ? 'text-[#83868c] hover:text-[#e7e7e5]' : 'text-[#6b7280] hover:text-[#111827]'}`}`}
          onClick={() => setActiveTab('plots')}
        >
          Plots
        </div>
      </div>

      <div className="flex-[0.55] p-5 flex flex-col overflow-y-auto min-h-0">
        {activeTab === 'parameters' && (
          <>
            <div className="flex justify-between items-center mb-6">
              <span className="text-xs font-bold tracking-wide">Select parameter</span>
              <select className={`${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#f9fafb] border-[#e5e7eb] text-[#111827]'} border text-xs p-1.5 rounded w-32 outline-none`}>
                <option>Source SPL level</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2 mb-8">
              {['EDT', 'T20', 'T30', 'C50', 'C80', 'D50', 'TS', 'G', 'SPL', 'STI', 'LF'].map(p => (
                <button 
                  key={p} 
                  onClick={() => setActiveParam(p)}
                  disabled={UNAVAILABLE_PARAMS.has(p)}
                  title={UNAVAILABLE_PARAMS.has(p) ? 'Not yet available — requires data this app does not currently produce' : undefined}
                  className={`text-[10px] font-bold px-2 py-1 rounded border ${activeParam === p ? 'bg-[#2563eb] text-[#0d0e0f] border-[#2563eb]' : `${theme === 'dark' ? 'border-[#2a2c30] text-[#83868c] hover:border-[#2563eb] hover:text-[#e7e7e5]' : 'border-[#e5e7eb] text-[#6b7280] hover:border-[#2563eb] hover:text-[#111827]'} bg-transparent`} ${UNAVAILABLE_PARAMS.has(p) ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  {p}
                </button>
              ))}
            </div>
            <div className="flex-1 relative min-h-[150px] mb-4">
              {(['LF', 'LJ', 'OOP'] as string[]).includes(activeParam) ? (
                <div className={`absolute inset-0 flex items-center justify-center text-center text-xs px-4 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                  {activeParam} is not available because this app does not currently compute true lateral energy fractions.
                </div>
              ) : UNAVAILABLE_PARAMS.has(activeParam) ? (
                <div className={`absolute inset-0 flex items-center justify-center text-center text-xs px-4 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                  {activeParam} is not yet available. It requires a calibrated reference measurement or lateral microphone data this simulator doesn't currently produce.
                </div>
              ) : !hasBarData ? (
                <div className={`absolute inset-0 flex items-center justify-center text-center text-xs px-4 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                  {irParams && !irParams.sufficient
                    ? irParams.limitations
                    : `Click "Compute Real Impulse Response" in the Settings panel to see real ${activeParam} results for this room.`}
                </div>
              ) : (
                <>
                  <Bar data={barData} options={barOptions} />
                  {activeParam === 'STI' && (
                    <div className={`text-[9px] mt-1 px-1 ${theme === 'dark' ? 'text-[#5c5f66]' : 'text-[#9ca3af]'}`}>
                      {!sti ? 'N/A — requires a simulated impulse response with valid timing data (run the impulse-response simulation).' : 'Computed from the actual impulse response (MTF method) — not an IEC 60268-16 certified value. See tooltip.'}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {activeTab === 'plots' && (
          <>
            <div className="flex justify-between items-center mb-4">
    <div className="text-xs font-bold tracking-wide">Select plot type</div>
    <div className="flex bg-[#141517] rounded border border-[#2a2c30] overflow-hidden">
      <button className="px-2 py-1 text-[9px] font-bold bg-[#202226] text-white">1/3 OCT</button>
      <button className="px-2 py-1 text-[9px] font-bold text-[#83868c] hover:text-white">OCT</button>
    </div>
  </div>
            <div className="flex flex-wrap gap-2 mb-4">
              {['EDC', 'IR', 'IR [dB]', 'Frequency response', 'Spatial decay'].map(p => (
                <button 
                  key={p} 
                  onClick={() => !UNAVAILABLE_PLOTS.has(p) && setActivePlot(p)}
                  className={`text-[10px] font-bold px-2 py-1 rounded border ${activePlot === p ? 'bg-[#2563eb] text-[#0d0e0f] border-[#2563eb]' : `${theme === 'dark' ? 'border-[#2a2c30] text-[#83868c] hover:border-[#2563eb] hover:text-[#e7e7e5]' : 'border-[#e5e7eb] text-[#6b7280] hover:border-[#2563eb] hover:text-[#111827]'} bg-transparent'} ${UNAVAILABLE_PLOTS.has(p) ? 'opacity-40 cursor-not-allowed' : ''}`}`}>
                  {p}
                </button>
              ))}
            </div>
            <div className={`flex justify-end space-x-3 mb-2 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
              <Camera size={14} className="cursor-pointer hover:text-[#2563eb]" onClick={() => alert('Screenshot captured')} />
              <Search size={14} className="cursor-pointer hover:text-[#2563eb]" />
              <Move size={14} className="cursor-pointer hover:text-[#2563eb]" />
              <Maximize size={14} className="cursor-pointer hover:text-[#2563eb]" />
              <MoveUp size={14} className="cursor-pointer hover:text-[#2563eb]" />
            </div>
            <div className="flex-1 relative min-h-[150px] mb-4">
              {UNAVAILABLE_PLOTS.has(activePlot) ? (
                <div className={`absolute inset-0 flex items-center justify-center text-center text-xs px-4 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                  {activePlot} is not available — the solver does not currently produce the measurement data required for this plot.
                </div>
              ) : !hasLineData ? (
                <div className={`absolute inset-0 flex items-center justify-center text-center text-xs px-4 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                  Click "Compute Real Impulse Response" in the Settings panel to see the real {activePlot} for this room.
                </div>
              ) : (
                <Line data={lineData} options={lineOptions} />
              )}
            </div>

            <div className="flex-1 min-h-[300px] mb-4 flex flex-col gap-4">
              <div className="flex-1 h-1/2 border border-[#2a2c30] rounded-md overflow-hidden">
                <ReceiverTable />
              </div>
              <div className="flex-1 h-1/2 border border-[#2a2c30] rounded-md overflow-hidden">
                <SpatialHeatmap />
              </div>
            </div>
          </>
        )}
      </div>
      
      <div className={`flex-[0.45] border-t ${theme === 'dark' ? 'border-[#2a2c30] bg-[#1a1b1e]' : 'border-[#e5e7eb] bg-[#ffffff]'} p-4 overflow-y-auto shrink-0 flex flex-col gap-4 min-h-0`}>
        <div className="flex justify-between items-center">
          <h3 className={`text-xs font-bold uppercase tracking-wider ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-[#111827]'}`}>Receiver Management</h3>
          <div className="flex bg-[#141517] rounded border border-[#2a2c30] overflow-hidden">
            <button 
              className={`px-2 py-1 text-[9px] font-bold ${uxMode === 'beginner' ? 'bg-[#2563eb] text-white' : 'text-[#83868c] hover:text-white'}`}
              onClick={() => setUxMode('beginner')}
            >
              BEGINNER
            </button>
            <button 
              className={`px-2 py-1 text-[9px] font-bold ${uxMode === 'engineering' ? 'bg-[#2563eb] text-white' : 'text-[#83868c] hover:text-white'}`}
              onClick={() => setUxMode('engineering')}
            >
              ENGINEERING
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {receivers.map((r, i) => (
            <div key={r.id} className={`${theme === 'dark' ? 'bg-[#141517] border-[#2563eb]' : 'bg-[#ffffff] border-[#2563eb]'} border rounded-md p-3 relative shadow-md flex flex-col shrink-0`}>
              <button aria-label={`Remove receiver ${r.id}`} onClick={(e) => { e.stopPropagation(); removeReceiver(r.id); }} className={`absolute top-2 right-2 z-50 p-2 cursor-pointer ${theme === 'dark' ? 'text-red-400 hover:text-red-300' : 'text-red-500 hover:text-red-700'}`}><X size={14} /></button>
              
              <div className={`flex items-center text-xs font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-[#111827]'} mb-2`}>
                <span className="w-4 h-4 rounded-full bg-[#6b7280] inline-flex items-center justify-center mr-2 text-white text-[9px] font-bold">{i + 1}</span>
                <input 
                  value={r.name} 
                  onChange={(e) => updateReceiver(r.id, { name: e.target.value })} 
                  className={`bg-transparent outline-none ${theme === 'dark' ? 'text-white' : 'text-black'}`}
                  placeholder="Receiver Name"
                />
              </div>

              {uxMode === 'engineering' && (
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <div>
                    <label className={`text-[9px] font-semibold tracking-wide ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>X (0–1)</label>
                    <CoordInput label={`Receiver ${r.name || r.id} X position`} value={r.x} min={0} max={1} step={0.05} theme={theme} onCommit={n => updateReceiver(r.id, { x: n })} />
                  </div>
                  <div>
                    <label className={`text-[9px] font-semibold tracking-wide ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>Y (0–1)</label>
                    <CoordInput label={`Receiver ${r.name || r.id} Y position`} value={r.y} min={0} max={1} step={0.05} theme={theme} onCommit={n => updateReceiver(r.id, { y: n })} />
                  </div>
                  <div>
                    <label className={`text-[9px] font-semibold tracking-wide ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>Z (m)</label>
                    <CoordInput label={`Receiver ${r.name || r.id} Z position`} value={r.z ?? null} min={0} max={H} step={0.05} theme={theme} onCommit={n => updateReceiver(r.id, { z: n })} />
                  </div>
                </div>
              )}
            </div>
          ))}

          <button 
            disabled={receivers.length >= MAX_RECEIVERS}
            title={receivers.length >= MAX_RECEIVERS ? `A project can have at most ${MAX_RECEIVERS} receivers.` : undefined}
            onClick={() => addReceiver({ id: crypto.randomUUID(), name: `Receiver ${receivers.length + 1}`, x: 0.5, y: 0.5, z: Math.min(1.2, H) })}
            className={`w-full mt-2 border border-dashed ${theme === 'dark' ? 'border-[#2a2c30] text-[#83868c] hover:border-[#2563eb] hover:text-[#2563eb]' : 'border-[#e5e7eb] text-[#6b7280] hover:border-[#2563eb] hover:text-[#2563eb]'} p-2 rounded text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            + Add Receiver
          </button>
        </div>

        {uxMode === 'engineering' && (
          <div className={`mt-4 p-4 rounded-md border ${theme === 'dark' ? 'border-[#2a2c30] bg-[#141517]' : 'border-[#e5e7eb] bg-[#f9fafb]'}`}>
            <h4 className={`text-xs font-bold mb-3 ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-[#111827]'}`}>Receiver Grid Generator</h4>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {([
                ['grid-x-min', 'X Min (0–1)', gridXMin, setGridXMin, '0', '1'],
                ['grid-x-max', 'X Max (0–1)', gridXMax, setGridXMax, '0', '1'],
                ['grid-y-min', 'Y Min (0–1)', gridYMin, setGridYMin, '0', '1'],
                ['grid-y-max', 'Y Max (0–1)', gridYMax, setGridYMax, '0', '1'],
                ['grid-z', 'Z Height (m)', gridZ, setGridZ, '0', String(H)],
                ['grid-spacing', 'Spacing (0–1)', gridSpacing, setGridSpacing, '0.01', '1'],
              ] as const).map(([id, text, value, setValue, min, max]) => (
                <div key={id}>
                  <label htmlFor={id} className={`text-[9px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>{text}</label>
                  <input id={id} type="number" step="0.05" min={min} max={max} value={value} onChange={e => { setValue(e.target.value); setGridError(null); }} className={`w-full text-xs p-1 rounded border ${theme === 'dark' ? 'bg-[#1a1b1e] border-[#2a2c30] text-white' : 'bg-white border-[#e5e7eb] text-black'}`} />
                </div>
              ))}
            </div>
            <p className={`text-[9px] mb-2 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>X, Y and spacing are fractions of the room footprint; Z is a height in metres.</p>

            <div role="status" aria-live="polite" className={`text-[10px] mb-3 ${!gridPlan.ok || gridError ? 'text-red-500 font-bold' : (theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]')}`}>
              {gridError ?? (gridPlan.ok ? `Will generate: ${gridPlan.count} receiver(s) (maximum ${MAX_RECEIVERS}).` : gridPlan.error)}
            </div>

            <button
              onClick={handleGenerateGrid}
              disabled={!gridPlan.ok}
              className={`w-full py-1.5 rounded text-xs font-bold transition-colors ${!gridPlan.ok ? 'bg-gray-500/20 text-gray-500 cursor-not-allowed' : 'bg-[#2563eb] text-white hover:bg-[#1d4ed8]'}`}
            >
              Generate Grid
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
