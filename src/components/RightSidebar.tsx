import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useStore, type Source, type Receiver } from '../store/useStore';
import type { LucideIcon } from 'lucide-react';
import { Cpu, Settings, Layers, Speaker, User, X, Activity, Headphones, Eye, Search, ChevronDown } from 'lucide-react';
import { MATERIALS } from '../lib/materials';
import { SPEAKERS } from '../lib/speakers';
import type { SpeakerSpec } from '../lib/speakerDSP';
import type { SimulationJobState } from '../lib/sharedTypes';
import { audioEngine, getAudioContextCtor } from '../lib/audioEngine';
import { LIMITS } from '../lib/publicLimits';
import LeftSidebar from './LeftSidebar';
import SpeakerPicker from './SpeakerPicker';
import { shouldApplyJobResult } from '../lib/jobFreshness';
import { sourceSensitivityDb } from '../lib/sourceSensitivity';


function decodeFloat32Artifact(buffer: ArrayBuffer): number[] {
  if (buffer.byteLength === 0 || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('Invalid simulation trace artifact.');
  }
  const view = new DataView(buffer);
  const out = new Array<number>(buffer.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function resampleTrace(trace: number[], sourceRate: number, targetRate: number): Float32Array {
  if (!trace.length) return new Float32Array(0);
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0 || Math.abs(sourceRate - targetRate) < 0.5) {
    return Float32Array.from(trace);
  }
  const outLength = Math.max(1, Math.round(trace.length * targetRate / sourceRate));
  const out = new Float32Array(outLength);
  const scale = sourceRate / targetRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * scale;
    const lo = Math.floor(pos);
    const hi = Math.min(trace.length - 1, lo + 1);
    const frac = pos - lo;
    out[i] = trace[lo] * (1 - frac) + trace[hi] * frac;
  }
  return out;
}

/** The only parts of a solver result that trace hydration reads. */
interface TraceBearingResult { traceObjectIds?: unknown; receivers?: Array<{ id?: string }> }

async function hydrateReceiverTraces(result: TraceBearingResult | null | undefined, token: string | null): Promise<Record<string, number[]>> {
  const traces: Record<string, number[]> = {};
  if (!token || !Array.isArray(result?.traceObjectIds) || !Array.isArray(result?.receivers)) return traces;

  const traceIds = result.traceObjectIds as unknown[];
  await Promise.all(result.receivers.map(async (rec, idx: number) => {
    const objectId = traceIds[idx];
    if (!objectId || typeof objectId !== 'string') return;
    try {
      const response = await fetch(`/api/storage?id=${encodeURIComponent(objectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = decodeFloat32Artifact(await response.arrayBuffer());
        if (data && data.length > 0) {
          const recId = rec.id || `r${idx + 1}`;
          traces[recId] = data;
        }
      }
    } catch (err) {
      console.warn(`Failed to hydrate trace for receiver ${rec.id}:`, err);
    }
  }));
  return traces;
}

function SearchableSpeakerSelect({ source }: { source: Source }) {
  const { theme, updateSource } = useStore();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredSpeakers = useMemo(() => {
    const q = search.toLowerCase();
    return SPEAKERS.filter(spk => spk.verificationStatus !== 'UNAVAILABLE' && `${spk.brand} ${spk.model}`.toLowerCase().includes(q));
  }, [search]);

  return (
    <div className="relative" ref={ref}>
      <div 
        className={`flex items-center justify-between cursor-pointer border text-xs p-1.5 rounded outline-none w-full ${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#ffffff] border-[#e5e7eb] text-black'}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="truncate pr-2">{source.brand} {source.model}</span>
        <ChevronDown size={14} className="shrink-0 opacity-50" />
      </div>

      {isOpen && (
        <div className={`absolute z-50 w-full mt-1 border rounded shadow-lg overflow-hidden ${theme === 'dark' ? 'bg-[#1a1b1e] border-[#2a2c30]' : 'bg-[#ffffff] border-[#e5e7eb]'}`}>
          <div className="p-2 border-b border-inherit">
            <div className={`flex items-center px-2 py-1 rounded bg-opacity-50 ${theme === 'dark' ? 'bg-[#141517]' : 'bg-[#f0f2f5]'}`}>
              <Search size={12} className="opacity-50 mr-2" />
              <input 
                type="text"
                autoFocus
                className="w-full bg-transparent text-xs outline-none"
                placeholder="Search speakers..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filteredSpeakers.map(spk => (
              <div 
                key={spk.id}
                className={`px-3 py-1.5 text-xs cursor-pointer truncate ${theme === 'dark' ? 'hover:bg-[#202226]' : 'hover:bg-[#f3f4f6]'}`}
                onClick={() => {
                  updateSource(source.id, { speakerId: spk.id, brand: spk.brand, model: spk.model, type: spk.type, sens: spk.manufacturerSensitivityDb, manufacturerSensitivityDb: spk.manufacturerSensitivityDb, sensitivityStatus: spk.sensitivityStatus, manufacturerSensitivityReference: spk.sensitivityReference ?? null, speakerImpedanceOhm: spk.impedanceOhm ?? null });
                  setIsOpen(false);
                  setSearch('');
                }}
              >
                {spk.brand} {spk.model}
              </div>
            ))}
            {filteredSpeakers.length === 0 && (
              <div className="px-3 py-2 text-xs opacity-50">No results found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RightSidebar() {
    const { isPlaying } = useStore();
  const [activeTab, setActiveTab] = useState('settings');

  const { jobId, jobToken, simulationJobState, jobProgress, setJobId, setSimulationJobState, setJobProgress } = useStore();
  const jobTypeRef = useRef<'wave' | 'ir' | null>(null);

  const [solverStatus, setSolverStatus] = useState<string>('Idle');
  const [irWarning, setIrWarning] = useState<string | null>(null);

  const handleCancelJob = async () => {
    if (jobId) {
      try {
        await fetch(`/api/jobs/${jobId}`, { method: 'DELETE', headers: jobToken ? { Authorization: `Bearer ${jobToken}` } : undefined });
      } catch (e) {
        console.error(e);
        setSolverStatus('Cancelled locally — the server could not be reached to confirm.');
      }
    }
    setSimulationJobState('cancelled');
  };

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let isActive = true;
    let consecutivePollFailures = 0; // a transient network blip is retried; a persistent one must surface
    const MAX_POLL_FAILURES = 15;

    const pollJob = async () => {
      if (!jobId || !['queued', 'running'].includes(simulationJobState)) return;
      
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { headers: jobToken ? { Authorization: `Bearer ${jobToken}` } : undefined });
        if (!res.ok) {
           if (isActive) setSimulationJobState('failed');
           return;
        }
        const data = await res.json();
        consecutivePollFailures = 0; // a readable response: the connection is healthy again
        
        if (!isActive) return;

        if (data.status) {
          setSimulationJobState(data.status as SimulationJobState); // server-provided status string
          if (data.status === 'failed' && data.error?.message) {
            setIrWarning(data.error.message);
          }
        }
        if (data.progress !== undefined) {
          setJobProgress(data.progress);
        }
        
        if (data.status === 'completed') {
          const result = data.result || data;
          const resultWithJob = { ...result, simulationId: data.simulationId, jobId: data.jobId };
          
          if (jobTypeRef.current === 'wave') {
            const rt60Text = typeof result.rt60 === 'number' ? ` | RT60 ${result.rt60.toFixed(2)}s` : '';
            
            
            const fmaxText = result.actualFmax ? ` | max ${Math.round(result.actualFmax)}Hz` : '';
            setSolverStatus(`Computed ${result.meshSize?.toLocaleString() ?? 0} elements (${result.gridDims?.join('x')})${rt60Text}${fmaxText}`);
            useStore.getState().setLastSolverResult({ ...resultWithJob, capabilityToken: jobToken });
          } else if (jobTypeRef.current === 'ir') {
            const token = jobToken;
            try {
              const traces = await hydrateReceiverTraces(resultWithJob, token);
              if (!shouldApplyJobResult({ effectActive: isActive, currentJobId: useStore.getState().jobId, resultJobId: data.jobId })) return;

              const ctx = new (getAudioContextCtor())();
              const sourceRate = Number(resultWithJob.dtEstimate) > 0 ? 1 / Number(resultWithJob.dtEstimate) : ctx.sampleRate;
              const impulseBuffers: Record<string, AudioBuffer> = {};
              for (const [recId, trace] of Object.entries(traces)) {
                if (trace && trace.length > 0) {
                  const samples = resampleTrace(trace, sourceRate, ctx.sampleRate);
                  const audioBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
                  audioBuffer.getChannelData(0).set(samples);
                  impulseBuffers[recId] = audioBuffer;
                }
              }

              const hydratedReceivers = (resultWithJob.receivers || []).map((r: { id: string }) => ({
                ...r,
                receiverTrace: traces[r.id] || null,
              }));
              const activeId = useStore.getState().activeReceiverId || hydratedReceivers[0]?.id;
              const primaryTrace = traces[activeId] || Object.values(traces)[0] || null;
              const hydrated = {
                ...resultWithJob,
                receivers: hydratedReceivers,
                receiverTrace: primaryTrace,
              };

              useStore.getState().setLastImpulseResponseResult({ ...hydrated, capabilityToken: token });
              useStore.getState().setMultiReceiverResult(hydrated);
              useStore.getState().setReceiverImpulseBuffers(impulseBuffers, traces);
              setIrWarning(result.warning || null);
            } catch (e) {
              // Error path: the room may have been edited while traces were downloading. Do not attach a stale result.
              if (!shouldApplyJobResult({ effectActive: isActive, currentJobId: useStore.getState().jobId, resultJobId: data.jobId })) return;
              console.error('Failed to load simulated impulse response:', e);
              useStore.getState().setLastImpulseResponseResult({ ...resultWithJob, capabilityToken: token });
              useStore.getState().setMultiReceiverResult(resultWithJob);
              setIrWarning(result.warning || 'Simulation completed, but the receiver trace could not be loaded.');
            }
          }
        } else if (data.status === 'queued' || data.status === 'running') {
          timeoutId = setTimeout(pollJob, 1000);
        }
      } catch (e) {
        if (!isActive) return;
        consecutivePollFailures++;
        console.warn(`[solver] job status poll failed (${consecutivePollFailures}/${MAX_POLL_FAILURES})`, e);
        if (consecutivePollFailures >= MAX_POLL_FAILURES) {
          setSolverStatus('Lost connection to the server — the job status can no longer be read.');
          setSimulationJobState('failed');
          return;
        }
        timeoutId = setTimeout(pollJob, 1000);
      }
    };

    if (jobId && ['queued', 'running'].includes(simulationJobState)) {
      pollJob();
    }

    return () => {
      isActive = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [jobId, simulationJobState, setSimulationJobState, setJobProgress]);

  const runImpulseResponse = async () => {
    setSimulationJobState('queued');
    setJobProgress(0);
    setIrWarning(null);
    jobTypeRef.current = 'ir';
    try {
      const state = useStore.getState();
      const activeSource = state.sources.find(s => !s.muted) || state.sources[0];
      const activeReceiver = state.receivers.find(r => r.id === state.activeReceiverId) || state.receivers[0];

      // Deliberately separate from the quick preview solver above: this
      // trades spatial resolution for enough simulated TIME to produce a
      // real decay curve (RT60/C50/C80/D50/Ts), which the quick preview
      // (fine grid, ~1ms of simulated time) cannot do. See server.ts's
      // /api/solver/impulse-response for the full reasoning.
      const res = await fetch('/api/solver/impulse-response', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: state.projectName, roomName: state.roomName,
          L: state.L, W: state.W, H: state.H,
          poly: state.poly,
          wallMaterial: state.wallMaterial,
          wallSegMats: state.wallSegMats,
          wallOpenings: state.wallOpenings,
          floorMaterial: state.floorMaterial,
          ceilMaterial: state.ceilMaterial,
          sources: state.sources.map((s) => ({ id: s.id, brand: s.brand, model: s.model, x: s.x, y: s.y, z: s.z, gainDb:s.gainDb ?? 0, delayMs:s.delayMs ?? 0, muted:s.muted === true, sensitivityDb: sourceSensitivityDb(s) ?? undefined, referencePowerW:1, isDirectional:s.isDirectional === true, directivityData:s.directivityData })),
          receivers: state.receivers.map((r) => ({ id: r.id, name: r.name, x: r.x, y: r.y, z: r.z })),
        })
      });
      const data = await res.json();
      if (res.ok && data.jobId) {
        setJobId(data.jobId, data.capabilityToken);
      } else if (res.status === 429) {
        setIrWarning(data.error || 'Server busy — please wait a moment and try again.');
        setSimulationJobState('failed');
      } else {
        setIrWarning(data.error || 'Failed to compute impulse response. Try again.');
        setSimulationJobState('failed');
      }
    } catch (e) {
      console.error(e);
      setSimulationJobState('failed');
    }
  };

  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'error'>('idle');
  const [exportError, setExportError] = useState<string | null>(null);
  const lastIrResultForExport = useStore((s) => s.lastImpulseResponseResult);

  const exportReport = async () => {
    setExportStatus('exporting');
    setExportError(null);
    try {
      const state = useStore.getState();
      const simId = lastIrResultForExport?.simulationId;
      const token = lastIrResultForExport?.capabilityToken || jobToken;
      if (!simId || !token) {
        throw new Error('Please click "Compute Real Impulse Response" first to generate a simulation report.');
      }

      const res = await fetch('/api/report/export', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          simulationId: simId,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Export failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(state.projectName || 'cavity-report').replace(/[^a-z0-9\-_]/gi, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportStatus('idle');
    } catch (e) {
      console.error(e);
      setExportError(e instanceof Error && e.message ? e.message : 'Failed to generate report.');
      setExportStatus('error');
    }
  };

  useEffect(() => {
    if (isPlaying) {
      setSolverStatus('Computing 3D Wave...');
      
      const runSolvers = async () => {
        try {
          const state = useStore.getState();
          // Read the server's entitlement decision rather than re-deriving
          // it. This only sizes the client's requested element budget as a
          // UX hint — server/solverWorker.ts enforces the real cap
          // independently and is authoritative.
          const elementBudget = LIMITS.MAX_GRID_CELLS;

          const activeSource = state.sources.find(s => !s.muted) || state.sources[0];
          const activeReceiver = state.receivers.find(r => r.id === state.activeReceiverId) || state.receivers[0];

          useStore.getState().setSimulationJobState('queued');
          useStore.getState().setJobProgress(0);
          jobTypeRef.current = 'wave';

          // Run CPU solver on the room the person actually built: real
          // dimensions, real wall/floor/ceiling materials, and the real
          // source/listener positions they placed — not a generic floating cube.
          const res = await fetch('/api/solver/wave', {
            method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              elements: elementBudget,
              steps: 20,
              fmax: useStore.getState().fmax,
              accuracyMode: useStore.getState().accuracyMode,
              confirmReducedResolution: useStore.getState().confirmReducedResolution,
              projectName: state.projectName, roomName: state.roomName,
              L: state.L, W: state.W, H: state.H,
              poly: state.poly,
              exportWavefield: true,
              wallMaterial: state.wallMaterial,
              wallSegMats: state.wallSegMats,
              wallOpenings: state.wallOpenings,
              floorMaterial: state.floorMaterial,
              ceilMaterial: state.ceilMaterial,
              source: activeSource ? { id: activeSource.id, brand: activeSource.brand, model: activeSource.model, x: activeSource.x, y: activeSource.y, z: activeSource.z, gainDb: activeSource.gainDb ?? 0, delayMs: activeSource.delayMs ?? 0, muted: activeSource.muted === true, sensitivityDb: sourceSensitivityDb(activeSource) ?? undefined, referencePowerW: 1, isDirectional: activeSource.isDirectional === true, directivityData: activeSource.directivityData } : null,
              sources: state.sources.map((s) => ({ id:s.id, brand:s.brand, model:s.model, x:s.x, y:s.y, z:s.z, gainDb:s.gainDb ?? 0, delayMs:s.delayMs ?? 0, muted:s.muted === true, sensitivityDb: sourceSensitivityDb(s) ?? undefined, referencePowerW:1, isDirectional:s.isDirectional === true, directivityData:s.directivityData })),
              receivers: state.receivers.map(r => ({ id: r.id, name: r.name, x: r.x, y: r.y, z: r.z })),
            })
          });
          const data = await res.json();

          if (res.ok && data.jobId) {
            useStore.getState().setJobId(data.jobId, data.capabilityToken);
          } else if (res.status === 429) {
            setSolverStatus(data.error || 'Server busy — please wait a moment and try again.');
            useStore.getState().setSimulationJobState('failed');
          } else {
            setSolverStatus('Computation Failed');
            useStore.getState().setSimulationJobState('failed');
          }
        } catch (e) {
          console.error('[solver] request failed', e);
          setSolverStatus('Network Error');
          useStore.getState().setSimulationJobState('failed'); // otherwise the UI would stay in a running state forever
        }
      };
      
      runSolvers();
    } else {
      setSolverStatus('Idle');
    }
  }, [isPlaying]);

  const [micStatus, setMicStatusState] = useState(audioEngine.micStatus);
  const { 
    view, setView, theme,
    sources, receivers, addSource, removeSource, addReceiver, removeReceiver, updateSource,
    wallMaterial, setWallMaterial, floorMaterial, setFloorMaterial, ceilMaterial, setCeilMaterial,
    selectedWallSeg, wallSegMats, setWallSegMat,
    wallOpenings, setWallOpening,
    L, W, H, setL, setW, setH, setPoly,
    audioSourceType, setAudioSourceType, transitionFreqMode, setTransitionFreqMode,
    availableMics, setAvailableMics, selectedMicId, setSelectedMicId,
    addingReceiver, accuracyMode,
  } = useStore();

  const [gapRange, setGapRange] = useState<{start: number, end: number}>({ start: 0.3, end: 0.7 });

  // Local text state for the dimension inputs so the user can type freely
  // (e.g. clear the field, type "3.") without the store's min-clamp fighting
  // every keystroke. Only commits to the store (and clamps) on blur/Enter.
  const [dimDraft, setDimDraft] = useState<{ L: string; W: string; H: string }>({
    L: String(L), W: String(W), H: String(H),
  });
  useEffect(() => {
    setDimDraft({ L: String(L), W: String(W), H: String(H) });
  }, [L, W, H]);

  const commitDim = (axis: 'L' | 'W' | 'H', raw: string) => {
    const n = parseFloat(raw);
    if (!isNaN(n) && n > 0) {
      if (axis === 'L') setL(n);
      else if (axis === 'W') setW(n);
      else setH(n);
    } else {
      // Invalid entry: revert the draft to the current committed value
      // rather than silently accepting garbage into the store.
      setDimDraft(d => ({ ...d, [axis]: String(axis === 'L' ? L : axis === 'W' ? W : H) }));
    }
  };

  const fetchMics = async () => {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      setAvailableMics(mics);
      // If we don't have a selected mic, or the selected one isn't in the list anymore
      if (mics.length > 0) {
        useStore.setState(state => {
          if (!state.selectedMicId || !mics.find(m => m.deviceId === state.selectedMicId)) {
            return { selectedMicId: mics[0].deviceId };
          }
          return {};
        });
      }
    }
  };

  useEffect(() => {
    fetchMics();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', fetchMics);
    }
    return () => {
      if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', fetchMics);
      }
    };
  }, [setAvailableMics]);

  useEffect(() => {
    audioEngine.onMicStatusChange = (status) => {
      setMicStatusState(status);
      if (status === 'active') {
        fetchMics(); // Labels might be populated now
      }
      // Keep the dropdown honest: if the mic request failed, don't leave it
      // showing "Microphone" while Song mode is actually what's playing.
      if (status === 'denied' || status === 'unsupported') {
        setAudioSourceType('song');
      }
    };
    return () => { audioEngine.onMicStatusChange = null; };
  }, [setAudioSourceType]);

  useEffect(() => {
    if (selectedWallSeg !== null) {
      setActiveTab('materials');
    }
  }, [selectedWallSeg]);

  const renderTabIcon = (id: string, Icon: LucideIcon, label: string) => (
    <div 
      className={`flex-1 flex flex-col items-center justify-center p-3 cursor-pointer border-b-2 text-[10px] uppercase font-bold tracking-wider transition-colors
        ${activeTab === id ? `border-[#2563eb] ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'}` : `border-transparent ${theme === 'dark' ? 'text-[#83868c] hover:text-[#e7e7e5]' : 'text-[#6b7280] hover:text-black'}`}`}
      onClick={() => setActiveTab(id)}
    >
      <Icon size={20} className={`mb-2 ${activeTab === id ? 'text-[#2563eb]' : ''}`} />
      {label}
    </div>
  );

  return (
    <div className={`w-[360px] ${theme === 'dark' ? 'bg-[#1a1b1e] border-[#2a2c30]' : 'bg-[#ffffff] border-[#e5e7eb]'} border-l flex flex-col h-full shrink-0`}>
      {view !== 'results' ? (
        <>
          <div className={`flex border-b ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-[#e5e7eb]'}`}>
            {renderTabIcon('materials', Layers, 'Materials')}
            {renderTabIcon('sources', Speaker, 'Sources')}
            {renderTabIcon('speakerLibrary', Headphones, 'Speakers')}
            {renderTabIcon('receivers', User, 'Receivers')}
            {renderTabIcon('solver', Cpu, 'Solver')}
            {renderTabIcon('settings', Settings, 'Settings')}
          </div>

          <div className="flex-1 p-5 overflow-y-auto">
            {activeTab === 'materials' && (
          <div>
            <h3 className={`text-xs font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} mb-4 uppercase tracking-wider`}>Room Dimensions</h3>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {([
                { axis: 'L' as const, label: 'Length (m)' },
                { axis: 'W' as const, label: 'Width (m)' },
                { axis: 'H' as const, label: 'Height (m)' },
              ]).map(({ axis, label }) => (
                <div key={axis}>
                  <div className={`text-[10px] mb-1 uppercase tracking-wider ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>{label}</div>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    className={`${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#f9fafb] border-[#e5e7eb] text-black'} border text-xs p-1.5 rounded outline-none w-full`}
                    value={dimDraft[axis]}
                    onChange={(e) => setDimDraft(d => ({ ...d, [axis]: e.target.value }))}
                    onBlur={(e) => commitDim(axis, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </div>
              ))}
            </div>

            <div className={`text-[10px] mb-2 uppercase tracking-wider ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>Starter Shape</div>
            <div className="flex flex-wrap gap-2 mb-6">
              {([
                { label: 'Square', poly: [{x: 0.1, y: 0.1}, {x: 0.9, y: 0.1}, {x: 0.9, y: 0.9}, {x: 0.1, y: 0.9}] },
                { label: 'L-Shape', poly: [{x: 0.3, y: 0.1}, {x: 0.7, y: 0.1}, {x: 0.7, y: 0.5}, {x: 0.9, y: 0.5}, {x: 0.9, y: 0.9}, {x: 0.3, y: 0.9}] },
                { label: 'Cross', poly: [{x: 0.4, y: 0.1}, {x: 0.6, y: 0.1}, {x: 0.6, y: 0.4}, {x: 0.9, y: 0.4}, {x: 0.9, y: 0.6}, {x: 0.6, y: 0.6}, {x: 0.6, y: 0.9}, {x: 0.4, y: 0.9}, {x: 0.4, y: 0.6}, {x: 0.1, y: 0.6}, {x: 0.1, y: 0.4}, {x: 0.4, y: 0.4}] },
                { label: 'U-Shape', poly: [{x: 0.2, y: 0.2}, {x: 0.4, y: 0.2}, {x: 0.4, y: 0.6}, {x: 0.6, y: 0.6}, {x: 0.6, y: 0.2}, {x: 0.8, y: 0.2}, {x: 0.8, y: 0.8}, {x: 0.2, y: 0.8}] },
                { label: 'H-Shape', poly: [{x: 0.2, y: 0.1}, {x: 0.4, y: 0.1}, {x: 0.4, y: 0.4}, {x: 0.6, y: 0.4}, {x: 0.6, y: 0.1}, {x: 0.8, y: 0.1}, {x: 0.8, y: 0.9}, {x: 0.6, y: 0.9}, {x: 0.6, y: 0.6}, {x: 0.4, y: 0.6}, {x: 0.4, y: 0.9}, {x: 0.2, y: 0.9}] },
              ]).map(shape => (
                <button
                  key={shape.label}
                  onClick={() => setPoly(shape.poly)}
                  className="flex-1 min-w-[70px] py-1 px-2 border border-[#2563eb] text-[#2563eb] rounded text-xs hover:bg-[#2563eb] hover:text-black"
                >
                  {shape.label}
                </button>
              ))}
            </div>

            <h3 className={`text-xs font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} mb-4 uppercase tracking-wider`}>Global Materials</h3>

            <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-4 items-center mb-6">
              <div className={`font-bold flex items-center ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'}`}><span className="text-[8px] mr-1">▶</span> A-WALL</div>
              <div className="flex items-center">
                 <select 
                    className={`${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#f9fafb] border-[#e5e7eb] text-black'} border text-xs p-1 rounded outline-none w-full appearance-none`}
                    value={wallMaterial}
                    onChange={(e) => setWallMaterial(e.target.value)}
                 >
                    {MATERIALS.walls.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                 </select>
              </div>
              <div className={`font-mono text-xs ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} text-right`}>0.15</div>
              
              <div className={`font-bold flex items-center ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'}`}><span className="text-[8px] mr-1">▶</span> A-FLOR</div>
              <div className="flex items-center">
                 <select 
                    className={`${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#f9fafb] border-[#e5e7eb] text-black'} border text-xs p-1 rounded outline-none w-full appearance-none`}
                    value={floorMaterial}
                    onChange={(e) => setFloorMaterial(e.target.value)}
                 >
                    {MATERIALS.floor.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                 </select>
              </div>
              <div className={`font-mono text-xs ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} text-right`}>0.15</div>
              
              <div className={`font-bold flex items-center ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'}`}><span className="text-[8px] mr-1">▶</span> A-CLNG</div>
              <div className="flex items-center">
                 <select 
                    className={`${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#f9fafb] border-[#e5e7eb] text-black'} border text-xs p-1 rounded outline-none w-full appearance-none`}
                    value={ceilMaterial}
                    onChange={(e) => setCeilMaterial(e.target.value)}
                 >
                    {MATERIALS.ceiling.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                 </select>
              </div>
              <div className={`font-mono text-xs ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} text-right`}>0.15</div>
            </div>

            {selectedWallSeg !== null && (
              <div className={`${theme === 'dark' ? 'bg-[#202226]' : 'bg-[#ffffff]'} p-4 rounded border border-[#2563eb]`}>
                <h4 className="text-xs font-bold text-[#2563eb] mb-3">Wall {selectedWallSeg + 1} Override</h4>
                <div className="flex items-center space-x-2">
                   <select 
                      className={`${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#ffffff] border-[#e5e7eb] text-black'} border text-xs p-2 rounded outline-none flex-1 appearance-none`}
                      value={wallSegMats[selectedWallSeg] || ''}
                      onChange={(e) => setWallSegMat(selectedWallSeg, e.target.value || null)}
                      disabled={wallOpenings[selectedWallSeg] === 'full'}
                   >
                      <option value="">-- Use Global Wall Material --</option>
                      {MATERIALS.walls.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                   </select>
                </div>

                <div className={`mt-4 pt-4 border-t ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-[#e5e7eb]'}`}>
                  <h5 className={`text-[10px] font-bold uppercase tracking-wider mb-3 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>Wall Opening</h5>

                  {wallOpenings[selectedWallSeg] === 'full' ? (
                    <div>
                      <p className="text-[10px] text-red-400 mb-3">This wall is fully removed (open).</p>
                      <button
                        onClick={() => setWallOpening(selectedWallSeg, null)}
                        className="w-full text-xs font-bold py-2 rounded border border-[#2563eb] text-[#2563eb] hover:bg-[#2563eb] hover:text-black transition-colors"
                      >
                        Restore Wall
                      </button>
                    </div>
                  ) : wallOpenings[selectedWallSeg] && typeof wallOpenings[selectedWallSeg] === 'object' ? (
                    <div>
                      {(() => {
                        const o = wallOpenings[selectedWallSeg] as { start: number; end: number };
                        return (
                          <p className="text-[10px] text-red-400 mb-3">
                            Section removed ({Math.round(o.start * 100)}%–{Math.round(o.end * 100)}% of wall length).
                          </p>
                        );
                      })()}
                      <div className="flex gap-2">
                        <button
                          onClick={() => setWallOpening(selectedWallSeg, null)}
                          className="flex-1 text-xs font-bold py-2 rounded border border-[#2563eb] text-[#2563eb] hover:bg-[#2563eb] hover:text-black transition-colors"
                        >
                          Restore Wall
                        </button>
                        <button
                          onClick={() => setWallOpening(selectedWallSeg, 'full')}
                          className="flex-1 text-xs font-bold py-2 rounded border border-red-400 text-red-400 hover:bg-red-400 hover:text-black transition-colors"
                        >
                          Delete Entire Wall
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <p className={`text-[10px] mb-3 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                        Cut a doorway/window out of part of this wall, or remove it entirely.
                      </p>
                      <div className="mb-4 space-y-3">
                        <div>
                          <div className={`flex justify-between text-[10px] mb-1 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                            <span>Gap Start</span>
                            <span>{Math.round(gapRange.start * 100)}%</span>
                          </div>
                          <input
                            type="range" min="0" max="0.95" step="0.05"
                            value={gapRange.start}
                            onChange={(e) => {
                              const start = parseFloat(e.target.value);
                              setGapRange(g => ({ start, end: Math.max(start + 0.05, g.end) }));
                            }}
                            className="w-full accent-[#2563eb]"
                          />
                        </div>
                        <div>
                          <div className={`flex justify-between text-[10px] mb-1 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
                            <span>Gap End</span>
                            <span>{Math.round(gapRange.end * 100)}%</span>
                          </div>
                          <input
                            type="range" min="0.05" max="1" step="0.05"
                            value={gapRange.end}
                            onChange={(e) => {
                              const end = parseFloat(e.target.value);
                              setGapRange(g => ({ start: Math.min(g.start, end - 0.05), end }));
                            }}
                            className="w-full accent-[#2563eb]"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setWallOpening(selectedWallSeg, { start: gapRange.start, end: gapRange.end })}
                          className="flex-1 text-xs font-bold py-2 rounded border border-[#2563eb] text-[#2563eb] hover:bg-[#2563eb] hover:text-black transition-colors"
                        >
                          Delete Section
                        </button>
                        <button
                          onClick={() => setWallOpening(selectedWallSeg, 'full')}
                          className="flex-1 text-xs font-bold py-2 rounded border border-red-400 text-red-400 hover:bg-red-400 hover:text-black transition-colors"
                        >
                          Delete Entire Wall
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {selectedWallSeg === null && (
               <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>Click on a specific wall in the 3D view to override its material, or delete part of it (doorway/window) or the entire wall.</p>
            )}
          </div>
        )}

        {activeTab === 'sources' && (
          <div>
            {sources.length === 0 ? (
              <p className={`text-[12px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mb-4`}>No sources added.</p>
            ) : (
              sources.map((s, i) => (
                <div key={s.id} className={`flex flex-col justify-between items-stretch ${theme === 'dark' ? 'bg-[#202226] border-[#2a2c30]' : 'bg-[#ffffff] border-[#e5e7eb]'} p-3 rounded mb-2 border shadow-sm`}>
                  <div className="flex justify-between items-center mb-2">
                    <span className={`text-sm font-semibold truncate ${theme === 'dark' ? 'text-white' : 'text-black'}`}>
                      <span className="w-4 h-4 rounded-full bg-[#2563eb] inline-flex items-center justify-center mr-2 text-[#0d0e0f] text-[9px] font-bold">{i + 1}</span>
                      Source {i + 1}
                    </span>
                    <button aria-label={`Remove source ${s.id}`} onClick={(e) => { e.stopPropagation(); removeSource(s.id); }} className="text-red-400 hover:text-red-300 cursor-pointer z-50 p-1"><X size={16} /></button>
                  </div>
                  <SearchableSpeakerSelect source={s} />
                  <span className={`text-[10px] mt-2 ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>{s.type}</span>
                </div>
              ))
            )}
            
            <button 
              disabled={sources.length >= LIMITS.MAX_SOURCES}
              title={sources.length >= LIMITS.MAX_SOURCES ? `A project can have at most ${LIMITS.MAX_SOURCES} sources.` : undefined}
              onClick={() => {
                // Use the first selectable speaker, not an unresolved catalog placeholder.
                // Keep the guard so a future empty database fails safely.
                const spk = SPEAKERS.find(s => s.verificationStatus !== 'UNAVAILABLE');
                if (!spk || sources.length >= LIMITS.MAX_SOURCES) return;
                addSource({
                  id: crypto.randomUUID(),
                  brand: spk.brand,
                  model: spk.model,
                  type: spk.type,
                  sens: spk.manufacturerSensitivityDb, manufacturerSensitivityDb: spk.manufacturerSensitivityDb, sensitivityStatus: spk.sensitivityStatus, manufacturerSensitivityReference: spk.sensitivityReference ?? null, speakerImpedanceOhm: spk.impedanceOhm ?? null,
                  x: Math.random() * 0.5 + 0.25,
                  y: Math.random() * 0.5 + 0.25,
                  gainDb: 0,
                  muted: false
                });
              }}
              className={`w-full mt-4 ${theme === 'dark' ? 'bg-[#202226] border-[#2563eb]' : 'bg-[#f9fafb] border-[#2563eb]'} border border-dashed text-[#2563eb] p-2 rounded text-xs hover:bg-[#2563eb] hover:text-black transition-colors`}
            >
              + Add Sound Source
            </button>

            <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mt-2 text-center`}>Drag sources in the 3D view to move them.</p>
          </div>
        )}

        {activeTab === 'speakerLibrary' && (
          <div>
            <h3 className={`text-xs font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} mb-4 uppercase tracking-wider`}>Speaker Library</h3>
            <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mb-4`}>
              Browse the speaker catalog and audition its derived DSP character. Source-backed specifications are labeled; unverified records use the generic reference model.
            </p>
            <SpeakerPicker
              onSelect={(spk: SpeakerSpec) => {
                const sources = useStore.getState().sources;
                const target = sources[0];
                if (target) {
                  // A SpeakerSpec stores sensitivity as { value, status }; it has no manufacturerSensitivityDb field.
                  const sensDb = spk.sensitivity?.value ?? null;
                  updateSource(target.id, { speakerId: spk.id, brand: spk.brand, model: spk.model, type: spk.category, sens: sensDb, manufacturerSensitivityDb: sensDb, sensitivityStatus: spk.sensitivity?.status ?? 'UNAVAILABLE', manufacturerSensitivityReference: spk.sensitivity?.reference ?? null, speakerImpedanceOhm: spk.impedance?.value ?? null });
                }
              }}
            />
          </div>
        )}

        {activeTab === 'receivers' && (
          <div>
            {receivers.map((r, i) => (
              <div key={r.id} className={`flex justify-between items-center ${theme === 'dark' ? 'bg-[#202226] border-[#2a2c30]' : 'bg-[#ffffff] border-[#e5e7eb]'} p-3 rounded mb-2 border shadow-sm`}>
                <span className={`text-sm ${theme === 'dark' ? 'text-white' : 'text-black'}`}>
                   <span className="w-4 h-4 rounded-full bg-[#6b7280] inline-flex items-center justify-center mr-2 text-white text-[9px] font-bold">{i + 1}</span>
                   {r.name}
                </span>
                <button aria-label={`Remove receiver ${r.id}`} onClick={(e) => { e.stopPropagation(); removeReceiver(r.id); }} className="text-red-400 hover:text-red-300 cursor-pointer z-50 p-1"><X size={16} /></button>
              </div>
            ))}
            
            <button 
              disabled={receivers.length >= LIMITS.MAX_RECEIVERS}
              title={receivers.length >= LIMITS.MAX_RECEIVERS ? `A project can have at most ${LIMITS.MAX_RECEIVERS} receivers.` : undefined}
              onClick={() => useStore.getState().setAddingReceiver(true)}
              className={`w-full mt-4 ${theme === 'dark' ? 'bg-[#202226] border-[#2a2c30] text-[#83868c]' : 'bg-[#f9fafb] border-[#e5e7eb] text-[#6b7280]'} border border-dashed p-2 rounded text-xs hover:border-[#2563eb] hover:text-[#2563eb] transition-colors`}>
              {addingReceiver ? 'Click in 3D View to Place...' : '+ Add Receiver'}
            </button>
            <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mt-2 text-center`}>Drag receivers to move them. Click one to select it.</p>
          </div>
        )}

        
        {activeTab === 'solver' && (
          <div>
            <h3 className={`text-xs font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} mb-4 uppercase tracking-wider`}>FDTD Solver Settings</h3>
            
            <div className="mb-6">
              <label className={`block text-xs font-bold mb-2 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>Accuracy Mode</label>
              <div className="flex gap-2">
                {(['fast', 'balanced', 'high'] as const).map(mode => {
                  const label = mode === 'fast' ? 'Fast' : mode === 'balanced' ? 'Balanced' : 'Fine';
                  return (
                  <button 
                    key={mode}
                    onClick={() => useStore.getState().setAccuracyMode(mode)}
                    className={`flex-1 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition-colors ${accuracyMode === mode ? 'bg-[#2563eb] text-black' : 'bg-white/5 text-gray-500 hover:bg-white/10'}`}
                  >
                    {label}
                  </button>
                )})}
              </div>
              <div className="text-[10px] text-gray-500 mt-2">
                {accuracyMode === 'fast' && 'FAST RESOLUTION (5 points/wavelength). Designed for interactive exploration.'}
                {accuracyMode === 'balanced' && 'BALANCED RESOLUTION (9 points/wavelength). Recommended default.'}
                {accuracyMode === 'high' && 'FINE RESOLUTION (13 points/wavelength). Designed for detailed simulations. Numerical limitations still apply.'}
              </div>
            </div>
            
            <div className="mb-6">
              <label className={`block text-xs font-bold mb-2 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>Target Max Frequency (Hz)</label>
              <input 
                type="range" min="100" max="2000" step="100"
                value={useStore.getState().fmax}
                onChange={(e) => useStore.getState().setFmax(Number(e.target.value))}
                className="w-full accent-[#2563eb]"
              />
              <div className="text-right text-xs font-mono text-[#2563eb] mt-1">{useStore.getState().fmax} Hz</div>
            </div>
            
            {useStore.getState().lastSolverResult && (
              <div className={`mt-8 p-4 rounded-lg border ${theme === 'dark' ? 'bg-[#1a1b1e] border-[#2a2c30]' : 'bg-gray-50 border-gray-200'}`}>
                <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-[#2563eb]">Last Run Parameters</h4>
                <div className="space-y-2 text-xs font-mono text-gray-400">
                  <div className="flex justify-between"><span>Solver:</span> <span className="text-white">FDTD Acoustic Simulation</span></div>
                  <div className="flex justify-between"><span>Grid Elements:</span> <span className="text-white">{useStore.getState().lastSolverResult.meshSize?.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span>Grid Dims:</span> <span className="text-white">{useStore.getState().lastSolverResult.gridDims?.join(' × ')}</span></div>
                  <div className="flex justify-between"><span>Resolution (dx):</span> <span className="text-white">{useStore.getState().lastSolverResult.cellSizeM?.toFixed(4)}m</span></div>
                  <div className="flex justify-between"><span>Steps:</span> <span className="text-white">{useStore.getState().lastSolverResult.steps}</span></div>
                  <div className="flex justify-between"><span>Points/Wavelength:</span> <span className="text-white">{accuracyMode === 'fast' ? 5 : accuracyMode === 'balanced' ? 9 : 13}</span></div>
                  <div className="flex justify-between"><span>Timestep (dt):</span> <span className="text-white">{(useStore.getState().lastSolverResult.dtEstimate * 1000)?.toFixed(4)}ms</span></div>
                  <div className="flex justify-between"><span>Req. Max Freq:</span> <span className="text-white">{useStore.getState().lastSolverResult.targetFmax} Hz</span></div>
                  <div className="flex justify-between"><span>Supported Freq:</span> <span className="text-white">{Math.round(useStore.getState().lastSolverResult.actualFmax)} Hz</span></div>
                  <div className="flex justify-between"><span>Compute Time:</span> <span className="text-white">{useStore.getState().lastSolverResult.durationMs} ms</span></div>
                </div>
                <div className="mt-3 pt-3 border-t border-white/10 text-[10px] leading-relaxed text-blue-400/90">
                  <span className="font-bold uppercase tracking-wider">Speaker model: conditional.</span>{' '}
                  {useStore.getState().lastSolverResult.speaker?.note ??
                    'The room simulation uses a generic omnidirectional point source unless validated directivity data covers the requested frequency band.'}
                </div>
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'settings' && (
          <div>
            <div className={`flex space-x-6 mb-8 border-b ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-[#e5e7eb]'} pb-6`}>
              {['Survey', 'Default', 'Advanced'].map(mode => (
                <label key={mode} onClick={() => setTransitionFreqMode(mode)} className={`flex items-center text-xs cursor-pointer ${transitionFreqMode === mode ? 'text-[#2563eb]' : (theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black')}`}>
                  <div className={`w-3 h-3 rounded-full border mr-2 flex items-center justify-center ${transitionFreqMode === mode ? 'border-[#2563eb]' : (theme === 'dark' ? 'border-[#83868c]' : 'border-[#6b7280]')}`}>
                    {transitionFreqMode === mode && <div className="w-1.5 h-1.5 rounded-full bg-[#2563eb]"></div>}
                  </div>
                  {mode}
                </label>
              ))}
            </div>
            
            <div className="mb-8">
              <h3 className={`text-xs font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} mb-4 uppercase tracking-wider`}>Audio Source Mode</h3>
              <select 
                className={`w-full ${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#f9fafb] border-[#e5e7eb] text-black'} border text-xs p-2 rounded outline-none`}
                value={audioSourceType}
                onChange={(e) => setAudioSourceType(e.target.value)}
              >
                <option value="song">Song (Full Band, ~30s Loop)</option>
                <option value="music">Music (Synth Chords)</option>
                <option value="bass">Bass</option>
                <option value="piano">Piano</option>
                <option value="violin">Violin</option>
                <option value="guitar">Electric Guitar</option>
                <option value="cello">Cello</option>
                <option value="flute">Flute</option>
                <option value="organ">Organ</option>
                <option value="marimba">Marimba</option>
                <option value="synthlead">Synth Lead (Arp)</option>
                <option value="synthpad">Synth Pad (Ambient)</option>
                <option value="bells">Bells</option>
                <option value="drumbeat">Drum Beat</option>
                <option value="hiphopbeat">Hip-Hop Beat</option>
                <option value="oceanwaves">Ocean Waves</option>
                <option value="pulse">Pulse (Beeping)</option>
                <option value="noise_white">White Noise</option>
                <option value="noise_pink">Pink Noise</option>
                <option value="noise_brown">Brown Noise</option>
                <option value="mic">Microphone (Hear Yourself)</option>
              </select>
              <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mt-2`}>
                Changes the audio content playing from the Sound Sources. Note: To use Microphone, you must click Allow when your browser asks for permission, and use headphones to avoid feedback/echo.
              </p>
              
              {availableMics.length > 0 && (
                <div className="mt-6">
                  <h4 className={`text-[10px] font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} mb-2 uppercase tracking-wider`}>Microphone Device</h4>
                  <select 
                    className={`w-full ${theme === 'dark' ? 'bg-[#141517] border-[#2a2c30] text-[#e7e7e5]' : 'bg-[#f9fafb] border-[#e5e7eb] text-black'} border text-xs p-2 rounded outline-none`}
                    value={selectedMicId}
                    onChange={(e) => {
                      setSelectedMicId(e.target.value);
                      const state = useStore.getState();
                      if (state.isPlaying) {
                        audioEngine.play(
                          state.sources, 
                          state.receivers.find(r => r.id === state.activeReceiverId) || state.receivers[0], 
                          state.L, state.W, state.audioSourceType, state.poly, state.wallSegMats, state.wallMaterial, state.wallOpenings,
                          state.H, state.floorMaterial, state.ceilMaterial
                        );
                      }
                    }}
                  >
                    {availableMics.map(mic => (
                      <option key={mic.deviceId} value={mic.deviceId}>
                        {mic.label || `Microphone ${mic.deviceId.slice(0, 5)}...`}
                      </option>
                    ))}
                  </select>
                  
                  {availableMics.every(m => !m.label) && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { alert('Microphone API is completely blocked by your browser in this environment. You may need to hard refresh the page (F5/Cmd+R) or open the app in a new tab.'); return; }
                        navigator.mediaDevices.getUserMedia({ audio: true })
                          .then(stream => {
                            stream.getTracks().forEach(t => t.stop());
                            fetchMics();
                          })
                          .catch(e => {
                            console.error("Mic permission error:", e);
                            alert("Microphone access failed: " + e.message + ". Please ensure your browser allows microphone access for this site.");
                          });
                      }}
                      className={`w-full mt-3 text-[10px] font-bold py-1.5 rounded border ${theme === 'dark' ? 'border-[#2563eb] text-[#2563eb] hover:bg-[#2563eb] hover:text-black' : 'border-[#2563eb] text-[#2563eb] hover:bg-[#2563eb] hover:text-white'} transition-colors`}
                    >
                      Reveal Microphone Names
                    </button>
                  )}
                </div>
              )}

              {audioSourceType === 'mic' && (
                <div className="mt-4">
                  <p className={`text-[10px] mb-2 font-semibold ${
                    micStatus === 'active' ? 'text-[#2563eb]'
                    : micStatus === 'denied' || micStatus === 'unsupported' ? 'text-red-400'
                    : theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'
                  }`}>
                    {micStatus === 'requesting' && 'Requesting microphone access…'}
                    {micStatus === 'active' && 'Microphone active — press Play to hear yourself.'}
                    {micStatus === 'denied' && "Microphone access was denied or unavailable. Switched to Song mode — pick Microphone again to retry."}
                    {micStatus === 'unsupported' && 'Microphone capture needs HTTPS or localhost. Switched to Song mode.'}
                    {micStatus === 'idle' && 'Press Play to request microphone access.'}
                  </p>
                </div>
              )}
            </div>

            <div className="mb-8 border-t border-[#2a2c30] pt-6">
              <h3 className={`text-xs font-bold ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-black'} mb-4 uppercase tracking-wider`}>Advanced Physics</h3>
              <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mb-3`}>
                3D Wave Solver (FDTD) is fully integrated. Geometry and sound data are processed automatically during playback.
              </p>
              <div className={`w-full py-3 px-4 rounded-lg flex flex-col ${theme === 'dark' ? 'bg-[#141517] border border-[#2a2c30]' : 'bg-gray-50 border border-gray-200'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity size={16} className={isPlaying ? 'text-[#2563eb] animate-pulse' : 'text-gray-500'} />
                    <span className={`text-xs font-semibold ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
                      {solverStatus}
                    </span>
                  </div>
                  <span className="text-[10px] font-bold text-[#2563eb] bg-[#2563eb]/10 px-2 py-1 rounded">50M CELLS MAX</span>
                </div>
                {['queued', 'running'].includes(simulationJobState) && jobTypeRef.current === 'wave' && (
                  <div className={`mt-3 pt-3 border-t ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-gray-200'}`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-bold uppercase text-[#2563eb]">
                        {simulationJobState === 'queued' ? 'Job is queued...' : 'Running simulation...'}
                      </span>
                      <span className="text-[10px] font-bold text-[#2563eb]">{Math.round(jobProgress)}%</span>
                    </div>
                    <div className={`w-full rounded-full h-1.5 mb-2 ${theme === 'dark' ? 'bg-[#2a2c30]' : 'bg-gray-200'}`}>
                      <div className="bg-[#2563eb] h-1.5 rounded-full" style={{ width: `${jobProgress}%` }}></div>
                    </div>
                    <button 
                      onClick={handleCancelJob}
                      className="text-[10px] font-bold text-red-500 hover:text-red-400 uppercase tracking-wider"
                    >
                      Cancel Job
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-4">
                <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mb-2`}>
                  The preview above runs a fast, high-resolution mesh for visualization but only simulates ~1ms of real time — not enough for RT60, C50, C80, or Ts to be meaningful. Compute a dedicated, longer-duration run (coarser mesh, thousands of time steps) to get real decay-based metrics for this room.
                </p>
                <button
                  onClick={runImpulseResponse}
                  disabled={['queued', 'running'].includes(simulationJobState)}
                  className={`w-full py-2 px-3 rounded text-xs font-bold transition-colors ${['queued', 'running'].includes(simulationJobState) ? 'bg-gray-500/20 text-gray-500 cursor-wait' : 'bg-[#2563eb] text-black hover:bg-[#1d4ed8]'}`}
                >
                  {['queued', 'running'].includes(simulationJobState) && jobTypeRef.current === 'ir' ? 'Computing Coarse-Grid IR… (this can take a while)' : 'Compute Real Impulse Response'}
                </button>
                {['queued', 'running'].includes(simulationJobState) && jobTypeRef.current === 'ir' && (
                  <div className="mt-3">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-bold uppercase text-[#2563eb]">
                        {simulationJobState === 'queued' ? 'Job is queued...' : 'Running simulation...'}
                      </span>
                      <span className="text-[10px] font-bold text-[#2563eb]">{Math.round(jobProgress)}%</span>
                    </div>
                    <div className={`w-full rounded-full h-1.5 mb-2 ${theme === 'dark' ? 'bg-[#2a2c30]' : 'bg-gray-200'}`}>
                      <div className="bg-[#2563eb] h-1.5 rounded-full" style={{ width: `${jobProgress}%` }}></div>
                    </div>
                    <button 
                      onClick={handleCancelJob}
                      className="text-[10px] font-bold text-red-500 hover:text-red-400 uppercase tracking-wider"
                    >
                      Cancel Job
                    </button>
                  </div>
                )}
                {simulationJobState === 'completed' && jobTypeRef.current === 'ir' && (
                  <p className={`text-[10px] mt-2 ${irWarning ? 'text-blue-500' : 'text-[#2563eb]'}`}>
                    {irWarning || 'Done — real decay-based metrics are now available in the Results panel and report export.'}
                  </p>
                )}
                {simulationJobState === 'failed' && jobTypeRef.current === 'ir' && (
                  <p className="text-[10px] mt-2 text-red-500">{irWarning || 'Failed to compute impulse response. Try again.'}</p>
                )}
                {simulationJobState === 'cancelled' && jobTypeRef.current === 'ir' && (
                  <p className="text-[10px] mt-2 text-yellow-500">Job cancelled.</p>
                )}
              </div>

              <div className="mt-6 pt-4 border-t border-[#2a2c30]">
                <p className={`text-[10px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} mb-2`}>
                  {lastIrResultForExport
                    ? "Generates a client-ready PDF with this room's computed RT60, STI, and speaker/receiver layout from the temporal FDTD simulation."
                    : 'Compute a real impulse response above to export a client-ready PDF report.'}
                </p>
                <button
                  onClick={exportReport}
                  disabled={exportStatus === 'exporting'}
                  className={`w-full py-2 px-3 rounded text-xs font-bold border transition-colors ${exportStatus === 'exporting' ? 'border-gray-500/30 text-gray-500 cursor-wait' : 'border-[#2563eb] text-[#2563eb] hover:bg-[#2563eb] hover:text-black'}`}
                >
                  {exportStatus === 'exporting' ? 'Generating PDF…' : 'Export Report (PDF)'}
                </button>
                {exportStatus === 'error' && (
                  <p className="text-[10px] mt-2 text-red-500">{exportError || 'Failed to generate report.'}</p>
                )}
              </div>
            </div>
          </div>
        )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <LeftSidebar />
        </div>
      )}

      <div className={`mt-auto border-t ${theme === 'dark' ? 'border-[#2a2c30] bg-[#1a1b1e]' : 'border-[#e5e7eb] bg-[#ffffff]'}`}>
        <div className={`flex items-center h-[60px] px-6 gap-2`}>
          <button 
            onClick={() => setView('editor')} 
            className={`flex items-center flex-1 justify-center text-[11px] font-bold transition-colors h-10 rounded ${
              view !== 'results' 
                ? 'bg-[#2563eb] text-black shadow-lg shadow-[#2563eb]/20' 
                : (theme === 'dark' ? 'text-[#83868c] hover:text-white hover:bg-white/5' : 'text-[#6b7280] hover:text-black hover:bg-black/5')
            }`}
          >
            <Headphones size={16} className="mr-2" /> Auralizer
          </button>
          
          <button 
            onClick={() => setView('results')} 
            className={`flex items-center flex-1 justify-center text-[11px] font-bold transition-colors h-10 rounded ${
              view === 'results' 
                ? 'bg-[#2563eb] text-black shadow-lg shadow-[#2563eb]/20' 
                : (theme === 'dark' ? 'text-[#83868c] hover:text-white hover:bg-white/5' : 'text-[#6b7280] hover:text-black hover:bg-black/5')
            }`}
          >
            <Activity size={16} className="mr-2" /> Results
          </button>
        </div>
      </div>
    </div>
  );
}
