import { create } from 'zustand';
import { SPEAKERS } from '../lib/speakers';
import { UXMode, MultiReceiverResult, SimulationJobState, ReceiverGridDef, HeatmapData } from '../lib/sharedTypes';
import { APP_VERSION, SCHEMA_VERSION } from '../lib/version';
import { LocalStore } from './idbHelper';
import { audioEngine } from '../lib/audioEngine';
import { validateProjectData } from '../lib/projectValidation';
import { LIMITS, type DirectivityDataInput } from '../lib/publicLimits';

export interface Point { x: number; y: number; }
export type WallOpening = 'full' | { start: number; end: number };
export interface Source {
  id: string; speakerId?: string; brand: string; model: string; type?: string; sens?: number | null; manufacturerSensitivityDb?: number | null; sensitivityStatus?: string; manufacturerSensitivityReference?: string | null; speakerImpedanceOhm?: number | null;
  x: number; y: number; z?: number; yawDeg?: number; pitchDeg?: number; rollDeg?: number;
  gainDb?: number; delayMs?: number; muted?: boolean; soundType?: string;
  isDirectional?: boolean;
  directivityData?: DirectivityDataInput;
  // Display name for a user-uploaded audio file when soundType === 'custom'.
  // The decoded audio itself lives only in audioEngine.customBuffers (an
  // AudioBuffer can't be persisted to the JSON project store) — this field
  // is just what to show in the UI; re-opening a saved project with
  // soundType 'custom' will need the user to re-upload the file.
  customFileName?: string;
}
export interface Receiver { id: string; name: string; x: number; y: number; z?: number; }
export interface Simulation { id: string; name: string; sourceId: string; receiverId: string; }

export interface AppState {
  fdtdImpulseBuffer: AudioBuffer | null;
  setFdtdImpulseBuffer: (buffer: AudioBuffer | null) => void;
  receiverImpulseBuffers: Record<string, AudioBuffer>;
  receiverTraces: Record<string, number[]>;
  setReceiverImpulseBuffers: (buffers: Record<string, AudioBuffer>, traces?: Record<string, number[]>) => void;
  past: Partial<AppState>[];
  future: Partial<AppState>[];
  undo: () => void;
  redo: () => void;
  saveHistory: () => void;
  invalidateSimulationResults: () => void;

  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;
  view: 'dashboard' | 'editor' | 'results';
  viewMode: '3d' | '2d'; setViewMode: (v: '3d'|'2d') => void;
  showMixer: boolean; setShowMixer: (b: boolean) => void;
  
  
  setView: (view: 'dashboard' | 'editor' | 'results') => void;
  projectName: string; setProjectName: (name: string) => void; roomName: string; setRoomName: (name: string) => void;
  poly: Point[]; setPoly: (poly: Point[]) => void;
  updatePoint: (index: number, point: Point) => void;
  addPoint: (index: number, point: Point) => void;
  removePoint: (index: number) => void;
  L: number; W: number; H: number;
  fmax: number; setFmax: (f: number) => void;
  confirmReducedResolution: boolean; setConfirmReducedResolution: (b: boolean) => void;
  solverResult: any; setSolverResult: (r: any) => void;
  accuracyMode: 'fast' | 'balanced' | 'high'; setAccuracyMode: (mode: 'fast' | 'balanced' | 'high') => void;
  setL: (L: number) => void; setW: (W: number) => void; setH: (H: number) => void;
  wallMaterial: string; wallSegMats: (string | null)[];
  setWallSegMat: (index: number, mat: string | null) => void;
  setWallMaterial: (mat: string) => void;
  // Per-wall-segment opening: 'full' removes the entire wall (open
  // archway/missing wall), or {start,end} (0-1 fraction along the segment)
  // cuts a partial gap (doorway/window) out of it. null/undefined = solid.
  wallOpenings: (WallOpening | null)[];
  setWallOpening: (index: number, opening: WallOpening | null) => void;
  floorMaterial: string; setFloorMaterial: (mat: string) => void;
  ceilMaterial: string; setCeilMaterial: (mat: string) => void;
  scatter: { walls: number; floor: number; ceiling: number };
  setScatter: (scatter: { walls: number; floor: number; ceiling: number }) => void;
  sources: Source[]; addSource: (source: Source) => void;
  updateSource: (id: string, updates: Partial<Source>) => void;
  removeSource: (id: string) => void;
  receivers: Receiver[]; addReceiver: (receiver: Receiver) => void;
  /** Replace ALL receivers at once (e.g. a generated grid). Enforces the receiver limit and clears stale results. */
  replaceReceivers: (receivers: Receiver[]) => void;
  updateReceiver: (id: string, updates: Partial<Receiver>) => void;
  removeReceiver: (id: string) => void;
  simulations: Simulation[]; addSimulation: () => void;
  removeSimulation: (id: string) => void;
  updateSimulation: (id: string, updates: Partial<Simulation>) => void;
  selectedWallSeg: number | null; setSelectedWallSeg: (index: number | null) => void;
  addingReceiver: boolean; setAddingReceiver: (adding: boolean) => void;
  activeReceiverId: string | null; setActiveReceiverId: (id: string | null) => void;
  isPlaying: boolean; setIsPlaying: (playing: boolean) => void;
  audioSourceType: string; setAudioSourceType: (type: string) => void;
  availableMics: MediaDeviceInfo[]; setAvailableMics: (mics: MediaDeviceInfo[]) => void;
  selectedMicId: string; setSelectedMicId: (id: string) => void;
  activeParam: string; setActiveParam: (param: string) => void;
  transitionFreqMode: string; setTransitionFreqMode: (mode: string) => void;
  saveProject: () => void; loadProject: () => void; newProject: () => void;
  saveLocalProject: () => Promise<void>;
  listLocalProjects: () => Promise<import('./idbHelper').ProjectRecord[]>;
  saveNamedLocalProject: (name?: string) => Promise<string>;
  loadLocalProject: (id: string) => Promise<boolean>;
  renameLocalProject: (id: string, name: string) => Promise<boolean>;
  duplicateLocalProject: (id: string, name?: string) => Promise<string | null>;
  deleteLocalProject: (id: string) => Promise<boolean>;
  recoverAutosave: () => Promise<boolean>;
  // Most recent /api/solver/wave response, so other components (LeftSidebar's
  // real IR/EDC/C50/C80/D50/Ts charts) can use actual simulation output
  // instead of placeholder data. null until a run has completed.
  lastSolverResult: any | null;
  setLastSolverResult: (result: any | null) => void;
  // Separate from lastSolverResult: populated only by the dedicated
  // /api/solver/impulse-response run (coarse grid, long duration). Kept
  // distinct so the quick preview solver (fine grid, ~1ms simulated —
  // useless for decay metrics) can never silently overwrite a real,
  // long-duration trace that C50/C80/D50/Ts/RT60 depend on.
  lastImpulseResponseResult: any | null;
  setLastImpulseResponseResult: (result: any | null) => void;

  uxMode: UXMode;
  setUxMode: (mode: UXMode) => void;
  primaryReceiverId: string | null;
  setPrimaryReceiverId: (id: string | null) => void;
  multiReceiverResult: MultiReceiverResult | null;
  setMultiReceiverResult: (r: MultiReceiverResult | null) => void;
  simulationJobState: SimulationJobState;
  setSimulationJobState: (s: SimulationJobState) => void;
  jobId: string | null;
  jobToken: string | null;
  setJobId: (id: string | null, token?: string | null) => void;
  jobProgress: number;
  setJobProgress: (p: number) => void;
  receiverGrid: ReceiverGridDef | null;
  setReceiverGrid: (g: ReceiverGridDef | null) => void;
  heatmapData: HeatmapData | null;
  setHeatmapData: (h: HeatmapData | null) => void;
  heatmapMetric: string;
  setHeatmapMetric: (m: string) => void;
}

const getDefaultSources = (id: string = crypto.randomUUID()) => {
  return [{
    id,
    brand: "Cavity Audio",
    model: "Unspecified Source",
    x: 0.3,
    y: 0.3,
    gainDb: 0,
    muted: false,
    sens: null, manufacturerSensitivityDb: null, sensitivityStatus: 'UNAVAILABLE', manufacturerSensitivityReference: null, speakerImpedanceOhm: null,
    type: "Generic Reference Source"
  }];
};

const defaultPoly = [
  {x: 0.1, y: 0.1}, {x: 0.4, y: 0.1}, {x: 0.4, y: 0.4}, {x: 0.9, y: 0.4},
  {x: 0.9, y: 0.6}, {x: 0.4, y: 0.6}, {x: 0.4, y: 0.9}, {x: 0.1, y: 0.9}
];
const defaultWallMats = [null, null, null, null, null, null, null, null];
const defaultWallOpenings: (WallOpening | null)[] = [null, null, null, null, null, null, null, null];

export const useStore = create<AppState>((set, get) => ({
  fdtdImpulseBuffer: null,
  receiverImpulseBuffers: {},
  receiverTraces: {},
  setFdtdImpulseBuffer: (buffer) => set({ fdtdImpulseBuffer: buffer }),
  setReceiverImpulseBuffers: (buffers, traces = {}) => set((state) => {
    const activeId = state.activeReceiverId || state.receivers[0]?.id;
    const activeBuf = activeId && buffers[activeId] ? buffers[activeId] : null;
    return {
      receiverImpulseBuffers: buffers,
      receiverTraces: traces,
      fdtdImpulseBuffer: activeBuf,
    };
  }),
  past: [],
  future: [],
  saveHistory: () => {
    const state = get();
    const snapshot = {
      sources: JSON.parse(JSON.stringify(state.sources)),
      receivers: JSON.parse(JSON.stringify(state.receivers)),
      poly: JSON.parse(JSON.stringify(state.poly)),
      wallSegMats: JSON.parse(JSON.stringify(state.wallSegMats)),
      wallOpenings: JSON.parse(JSON.stringify(state.wallOpenings)),
      wallMaterial: state.wallMaterial,
      floorMaterial: state.floorMaterial,
      ceilMaterial: state.ceilMaterial,
      scatter: JSON.parse(JSON.stringify(state.scatter)),
      simulations: JSON.parse(JSON.stringify(state.simulations)),
      receiverGrid: JSON.parse(JSON.stringify(state.receiverGrid)),
      projectName: state.projectName, roomName: state.roomName,
      L: state.L, W: state.W, H: state.H,
      fmax: state.fmax, accuracyMode: state.accuracyMode, confirmReducedResolution: state.confirmReducedResolution,
    };
    set({ past: [...state.past || [], snapshot], future: [] });
  },
  invalidateSimulationResults: () => set({
    solverResult: null,
    lastSolverResult: null,
    lastImpulseResponseResult: null,
    multiReceiverResult: null,
    heatmapData: null,
    fdtdImpulseBuffer: null,
    receiverImpulseBuffers: {},
    receiverTraces: {},
    simulationJobState: 'idle',
    jobId: null,
    jobToken: null,
    jobProgress: 0,
  }),
  undo: () => {
    const state = get();
    if (!state.past || state.past.length === 0) return;
    const prev = state.past[state.past.length - 1];
    const newPast = state.past.slice(0, state.past.length - 1);
    const currentSnapshot = {
      sources: JSON.parse(JSON.stringify(state.sources)),
      receivers: JSON.parse(JSON.stringify(state.receivers)),
      poly: JSON.parse(JSON.stringify(state.poly)),
      wallSegMats: JSON.parse(JSON.stringify(state.wallSegMats)),
      wallOpenings: JSON.parse(JSON.stringify(state.wallOpenings)),
      wallMaterial: state.wallMaterial,
      floorMaterial: state.floorMaterial,
      ceilMaterial: state.ceilMaterial,
      scatter: JSON.parse(JSON.stringify(state.scatter)),
      simulations: JSON.parse(JSON.stringify(state.simulations)),
      receiverGrid: JSON.parse(JSON.stringify(state.receiverGrid)),
      projectName: state.projectName, roomName: state.roomName,
      L: state.L, W: state.W, H: state.H,
      fmax: state.fmax, accuracyMode: state.accuracyMode, confirmReducedResolution: state.confirmReducedResolution,
    };
    set({ 
      ...prev, 
      past: newPast, 
      future: [currentSnapshot, ...(state.future || [])] 
    });
    get().invalidateSimulationResults();
  },
  redo: () => {
    const state = get();
    if (!state.future || state.future.length === 0) return;
    const next = state.future[0];
    const newFuture = state.future.slice(1);
    const currentSnapshot = {
      sources: JSON.parse(JSON.stringify(state.sources)),
      receivers: JSON.parse(JSON.stringify(state.receivers)),
      poly: JSON.parse(JSON.stringify(state.poly)),
      wallSegMats: JSON.parse(JSON.stringify(state.wallSegMats)),
      wallOpenings: JSON.parse(JSON.stringify(state.wallOpenings)),
      wallMaterial: state.wallMaterial,
      floorMaterial: state.floorMaterial,
      ceilMaterial: state.ceilMaterial,
      scatter: JSON.parse(JSON.stringify(state.scatter)),
      simulations: JSON.parse(JSON.stringify(state.simulations)),
      receiverGrid: JSON.parse(JSON.stringify(state.receiverGrid)),
      projectName: state.projectName, roomName: state.roomName,
      L: state.L, W: state.W, H: state.H,
      fmax: state.fmax, accuracyMode: state.accuracyMode, confirmReducedResolution: state.confirmReducedResolution,
    };
    set({ 
      ...next, 
      past: [...(state.past || []), currentSnapshot], 
      future: newFuture 
    });
    get().invalidateSimulationResults();
  },

  theme: 'dark', setTheme: (theme) => {
    set({ theme });
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  },
  view: 'dashboard', setView: (view) => set({ view }),
  viewMode: '3d', setViewMode: (viewMode) => set({ viewMode }),
  showMixer: false, setShowMixer: (showMixer) => set({ showMixer }),
  
  
  projectName: 'My Project', setProjectName: (projectName) => set({ projectName }),
  roomName: 'Space 1', setRoomName: (roomName) => set({ roomName }),
  poly: defaultPoly,
  setPoly: (poly) => { get().saveHistory(); get().invalidateSimulationResults(); set({ poly }); },
  updatePoint: (index, point) => { get().saveHistory(); get().invalidateSimulationResults(); set((state) => { const newPoly = [...state.poly]; if (index < 0 || index >= newPoly.length) return state; newPoly[index] = point; return { poly: newPoly }; }); },
  addPoint: (index, point) => {
    get().saveHistory();
    get().invalidateSimulationResults();
    set((state) => {
      if (index < 0 || index > state.poly.length) return state;
      const newPoly = [...state.poly]; newPoly.splice(index, 0, point);
      const newWallSegMats = [...state.wallSegMats]; newWallSegMats.splice(index, 0, null);
      const newWallOpenings = [...state.wallOpenings]; newWallOpenings.splice(index, 0, null);
      return { poly: newPoly, wallSegMats: newWallSegMats, wallOpenings: newWallOpenings };
    });
  },
  removePoint: (index) => {
    get().saveHistory();
    get().invalidateSimulationResults();
    set((state) => {
      if (state.poly.length <= 3 || index < 0 || index >= state.poly.length) return state;
      const newPoly = [...state.poly]; newPoly.splice(index, 1);
      const newWallSegMats = [...state.wallSegMats]; newWallSegMats.splice(index, 1);
      const newWallOpenings = [...state.wallOpenings]; newWallOpenings.splice(index, 1);
      return { poly: newPoly, wallSegMats: newWallSegMats, wallOpenings: newWallOpenings };
    });
  },
  L: 10, W: 8, H: 3,
  fmax: 500, setFmax: (f) => { get().saveHistory(); get().invalidateSimulationResults(); set({ fmax: f }); },
  confirmReducedResolution: false, setConfirmReducedResolution: (b) => { get().saveHistory(); get().invalidateSimulationResults(); set({ confirmReducedResolution: b }); },
  solverResult: null, setSolverResult: (r) => set({ solverResult: r }),
  accuracyMode: 'balanced', setAccuracyMode: (mode) => { get().saveHistory(); get().invalidateSimulationResults(); set({ accuracyMode: mode }); },
  // Real-world room dimensions in meters. `poly` points are normalized
  // (0-1) footprint coordinates; L/W scale them to real X/Y meters, H is
  // ceiling height. These were previously unused/unsettable state (dead
  // defaults) — added setters here so dimension-dependent calculations
  // (RT60, volume, surface area) and any dimensions UI have a real,
  // user-editable source of truth. Purely additive: does not change any
  // existing field, default value, or persisted shape.
  setL: (L) => { get().saveHistory(); get().invalidateSimulationResults(); set({ L: Math.max(0.1, L) }); },
  setW: (W) => { get().saveHistory(); get().invalidateSimulationResults(); set({ W: Math.max(0.1, W) }); },
  setH: (H) => { get().saveHistory(); get().invalidateSimulationResults(); set({ H: Math.max(0.1, H) }); },
  wallMaterial: 'drywall', wallSegMats: defaultWallMats,
  setWallSegMat: (index, mat) => { get().saveHistory(); get().invalidateSimulationResults(); set((state) => { const newMats = [...state.wallSegMats]; if (index < 0 || index >= newMats.length) return state; newMats[index] = mat; return { wallSegMats: newMats }; }); },
  wallOpenings: defaultWallOpenings,
  setWallOpening: (index, opening) => {
    get().saveHistory();
    get().invalidateSimulationResults();
    set((state) => {
      const newOpenings = [...state.wallOpenings]; if (index < 0 || index >= newOpenings.length) return state; newOpenings[index] = opening;
      return { wallOpenings: newOpenings };
    });
  },
  setWallMaterial: (wallMaterial) => { get().saveHistory(); get().invalidateSimulationResults(); set({ wallMaterial }); },
  floorMaterial: 'wood_floor', setFloorMaterial: (floorMaterial) => { get().saveHistory(); get().invalidateSimulationResults(); set({ floorMaterial }); },
  ceilMaterial: 'stonewool', setCeilMaterial: (ceilMaterial) => { get().saveHistory(); get().invalidateSimulationResults(); set({ ceilMaterial }); },
  scatter: { walls: 0.15, floor: 0.15, ceiling: 0.15 }, setScatter: (scatter) => { get().saveHistory(); get().invalidateSimulationResults(); set({ scatter }); },
  sources: getDefaultSources('1'),
  addSource: (source) => {
    // Same limit the API and worker enforce; the UI disables its add buttons at the limit, this is the safety net.
    if (get().sources.length >= LIMITS.MAX_SOURCES) throw new Error(`A project can have at most ${LIMITS.MAX_SOURCES} sources.`);
    get().saveHistory(); get().invalidateSimulationResults(); set((state) => ({ sources: [...state.sources, source] }));
  },
  updateSource: (id, updates) => { get().saveHistory(); get().invalidateSimulationResults(); set((state) => ({ sources: state.sources.map(s => s.id === id ? { ...s, ...updates } : s) })); },
  removeSource: (id) => {
    get().saveHistory(); get().invalidateSimulationResults();
    set((state) => {
      if (state.sources.length <= 1) return state;
      const sources = state.sources.filter(s => s.id !== id);
      const fallback = sources[0]?.id || '';
      return { sources, simulations: state.simulations.map(sim => sim.sourceId === id ? { ...sim, sourceId: fallback } : sim) };
    });
  },
  receivers: [{ id: '1', name: 'Receiver 1', x: 0.25, y: 0.5, z: 1.2 }],
  addReceiver: (receiver) => {
    if (get().receivers.length >= LIMITS.MAX_RECEIVERS) throw new Error(`A project can have at most ${LIMITS.MAX_RECEIVERS} receivers.`);
    get().saveHistory(); get().invalidateSimulationResults(); set((state) => ({ receivers: [...state.receivers, receiver] }));
  },
  replaceReceivers: (receivers) => {
    if (!Array.isArray(receivers) || receivers.length < LIMITS.MIN_RECEIVERS || receivers.length > LIMITS.MAX_RECEIVERS) {
      throw new Error(`Receivers must number between ${LIMITS.MIN_RECEIVERS} and ${LIMITS.MAX_RECEIVERS}.`);
    }
    get().saveHistory(); get().invalidateSimulationResults();
    set((state) => {
      const ids = new Set(receivers.map(r => r.id));
      const fallbackId = receivers[0].id;
      return {
        receivers,
        // Never leave a dangling reference to a receiver that no longer exists.
        activeReceiverId: state.activeReceiverId && ids.has(state.activeReceiverId) ? state.activeReceiverId : fallbackId,
        simulations: state.simulations.map(sim => ids.has(sim.receiverId) ? sim : { ...sim, receiverId: fallbackId }),
      };
    });
  },
  updateReceiver: (id, updates) => { get().saveHistory(); get().invalidateSimulationResults(); set((state) => ({ receivers: state.receivers.map(r => r.id === id ? { ...r, ...updates } : r) })); },
  removeReceiver: (id) => {
    get().saveHistory(); get().invalidateSimulationResults();
    set((state) => {
      if (state.receivers.length <= 1) return state;
      const receivers = state.receivers.filter(r => r.id !== id);
      const fallback = receivers[0]?.id || '';
      const newBuffers = { ...state.receiverImpulseBuffers };
      const newTraces = { ...state.receiverTraces };
      delete newBuffers[id];
      delete newTraces[id];
      const newActiveId = state.activeReceiverId === id ? fallback || null : state.activeReceiverId;
      const targetId = newActiveId || fallback;
      const buf = targetId && newBuffers[targetId] ? newBuffers[targetId] : null;
      return {
        receivers,
        activeReceiverId: newActiveId,
        primaryReceiverId: state.primaryReceiverId === id ? fallback || null : state.primaryReceiverId,
        simulations: state.simulations.map(sim => sim.receiverId === id ? { ...sim, receiverId: fallback } : sim),
        receiverImpulseBuffers: newBuffers,
        receiverTraces: newTraces,
        fdtdImpulseBuffer: buf,
      };
    });
  },
  simulations: [{ id: '1', name: 'Simulation 1', sourceId: '1', receiverId: '1' }],
  addSimulation: () => { get().saveHistory(); get().invalidateSimulationResults(); set((state) => ({
    simulations: [...state.simulations, {
      id: crypto.randomUUID(),
      name: `Simulation ${state.simulations.length + 1}`,
      sourceId: state.sources[0]?.id || '',
      receiverId: state.receivers[0]?.id || ''
    }]
  })); },
  removeSimulation: (id) => { get().saveHistory(); get().invalidateSimulationResults(); set((state) => ({ simulations: state.simulations.filter(s => s.id !== id) })); },
  updateSimulation: (id, updates) => { get().saveHistory(); get().invalidateSimulationResults(); set((state) => ({ simulations: state.simulations.map(s => s.id === id ? { ...s, ...updates } : s) })); },
  selectedWallSeg: null, setSelectedWallSeg: (selectedWallSeg) => set({ selectedWallSeg }),
  addingReceiver: false, setAddingReceiver: (addingReceiver) => set({ addingReceiver }),
  activeReceiverId: null,
  setActiveReceiverId: (activeReceiverId) => set((state) => {
    const targetId = activeReceiverId || state.receivers[0]?.id;
    const buf = targetId && state.receiverImpulseBuffers[targetId] ? state.receiverImpulseBuffers[targetId] : null;
    return {
      activeReceiverId,
      fdtdImpulseBuffer: buf,
    };
  }),
  isPlaying: false, setIsPlaying: (isPlaying) => set({ isPlaying }),
  audioSourceType: 'song', setAudioSourceType: (audioSourceType) => set({ audioSourceType }),
  availableMics: [], setAvailableMics: (availableMics) => set({ availableMics }),
  selectedMicId: '', setSelectedMicId: (selectedMicId) => set({ selectedMicId }),
  activeParam: 'STI', setActiveParam: (activeParam) => set({ activeParam }),
  transitionFreqMode: 'Default', setTransitionFreqMode: (transitionFreqMode) => set({ transitionFreqMode }),
  lastSolverResult: null, setLastSolverResult: (lastSolverResult) => set({ lastSolverResult }),
  lastImpulseResponseResult: null, setLastImpulseResponseResult: (lastImpulseResponseResult) => set({ lastImpulseResponseResult }),
  newProject: () => {
    audioEngine.stop(); // idempotent; tears down each node independently and reports unexpected failures
    set({
      view: 'editor',
      projectName: 'My Project',
      roomName: 'Space 1',
      L: 10, W: 8, H: 3, fmax: 500, accuracyMode: 'balanced', confirmReducedResolution: false,
      poly: defaultPoly,
      wallMaterial: 'drywall',
      wallSegMats: defaultWallMats,
      wallOpenings: defaultWallOpenings,
      floorMaterial: 'wood_floor',
      ceilMaterial: 'stonewool',
      scatter: { walls: 0.15, floor: 0.15, ceiling: 0.15 },
      sources: getDefaultSources('1'),
      receivers: [{ id: '1', name: 'Receiver 1', x: 0.25, y: 0.5 }],
      simulations: [{ id: '1', name: 'Simulation 1', sourceId: '1', receiverId: '1' }],
      primaryReceiverId: '1',
      activeReceiverId: null,
      addingReceiver: false,
      selectedWallSeg: null,
      receiverGrid: null,
      uxMode: 'beginner',
      isPlaying: false, solverResult: null, lastSolverResult: null, lastImpulseResponseResult: null, multiReceiverResult: null, heatmapData: null, fdtdImpulseBuffer: null,
      simulationJobState: 'idle', jobId: null, jobToken: null, jobProgress: 0, past: [], future: []
    });
  },
  listLocalProjects: async () => {
    return LocalStore.getProjects();
  },
  saveNamedLocalProject: async (name) => {
    const state = get();
    const now = Date.now();
    const id = `project-${crypto.randomUUID()}`;
    const projectName = (name ?? state.projectName ?? 'Untitled Project').trim().slice(0, 100) || 'Untitled Project';
    const data = { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, projectName, roomName: state.roomName, poly: state.poly, L: state.L, W: state.W, H: state.H, fmax: state.fmax, accuracyMode: state.accuracyMode, confirmReducedResolution: state.confirmReducedResolution, wallMaterial: state.wallMaterial, wallSegMats: state.wallSegMats, wallOpenings: state.wallOpenings, floorMaterial: state.floorMaterial, ceilMaterial: state.ceilMaterial, scatter: state.scatter, sources: state.sources, receivers: state.receivers, simulations: state.simulations, uxMode: state.uxMode, primaryReceiverId: state.primaryReceiverId, receiverGrid: state.receiverGrid };
    await LocalStore.saveProject({ id, name: projectName, createdAt: now, updatedAt: now, isArchived: false, data });
    await LocalStore.setActiveProjectId(id);
    return id;
  },
  loadLocalProject: async (id) => {
    if (id === 'autosave') return get().recoverAutosave();
    const rec = await LocalStore.getProject(id);
    if (!rec) return false;
    const checked = validateProjectData(rec.data);
    if (!checked.ok) return false;
    const data = checked.data;
    const sourceIds = new Set((data.sources || []).map((x:any) => x.id));
    const receiverIds = new Set((data.receivers || []).map((x:any) => x.id));
    set({ projectName: data.projectName || rec.name || 'My Project', roomName: data.roomName || 'Space 1', poly: data.poly, L: data.L, W: data.W, H: data.H, fmax: data.fmax, accuracyMode: data.accuracyMode, confirmReducedResolution: data.confirmReducedResolution, wallMaterial: data.wallMaterial, wallSegMats: data.wallSegMats, wallOpenings: data.wallOpenings, floorMaterial: data.floorMaterial, ceilMaterial: data.ceilMaterial, scatter: data.scatter, sources: data.sources, receivers: data.receivers, simulations: (data.simulations || []).filter((x:any) => sourceIds.has(x.sourceId) && receiverIds.has(x.receiverId)), uxMode: data.uxMode, primaryReceiverId: data.primaryReceiverId, receiverGrid: data.receiverGrid, solverResult: null, lastSolverResult: null, lastImpulseResponseResult: null, multiReceiverResult: null, heatmapData: null, fdtdImpulseBuffer: null, simulationJobState: 'idle', jobId: null, jobToken: null, jobProgress: 0, past: [], future: [] });
    await LocalStore.setActiveProjectId(id);
    return true;
  },
  renameLocalProject: async (id, name) => {
    if (id === 'autosave') return false;
    const rec = await LocalStore.getProject(id);
    if (!rec) return false;
    const clean = name.trim().slice(0, 100);
    if (!clean) return false;
    const checked = validateProjectData(rec.data);
    if (!checked.ok) return false;
    await LocalStore.saveProject({ ...rec, name: clean, updatedAt: Date.now(), data: { ...checked.data, projectName: clean } });
    const activeId = await LocalStore.getActiveProjectId();
    if (activeId === id) set({ projectName: clean });
    return true;
  },
  duplicateLocalProject: async (id, name) => {
    const rec = await LocalStore.getProject(id);
    if (!rec) return null;
    const checked = validateProjectData(rec.data);
    if (!checked.ok) return null;
    const now = Date.now();
    const clean = (name ?? `${rec.name} Copy`).trim().slice(0, 100) || `${rec.name} Copy`;
    const newId = `project-${crypto.randomUUID()}`;
    await LocalStore.saveProject({ id: newId, name: clean, createdAt: now, updatedAt: now, isArchived: false, data: { ...checked.data, projectName: clean } });
    return newId;
  },
  deleteLocalProject: async (id) => {
    if (id === 'autosave') return false;
    const active = await LocalStore.getActiveProjectId();
    await LocalStore.deleteProject(id);
    if (active === id) await LocalStore.setActiveProjectId(null);
    return true;
  },
  saveLocalProject: async () => {
    const state = get();
    const data = { schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, projectName: state.projectName, roomName: state.roomName, poly: state.poly, L: state.L, W: state.W, H: state.H, fmax: state.fmax, accuracyMode: state.accuracyMode, confirmReducedResolution: state.confirmReducedResolution, wallMaterial: state.wallMaterial, wallSegMats: state.wallSegMats, wallOpenings: state.wallOpenings, floorMaterial: state.floorMaterial, ceilMaterial: state.ceilMaterial, scatter: state.scatter, sources: state.sources, receivers: state.receivers, simulations: state.simulations, uxMode: state.uxMode, primaryReceiverId: state.primaryReceiverId, receiverGrid: state.receiverGrid };
    const now = Date.now();
    await LocalStore.saveProject({ id:'autosave', name:state.projectName || 'Autosave', createdAt:now, updatedAt:now, isArchived:false, data });
    await LocalStore.setActiveProjectId('autosave');
  },
  recoverAutosave: async () => {
    const rec = await LocalStore.getProject('autosave');
    if (!rec) return false;
    const checked = validateProjectData(rec.data);
    if (!checked.ok) return false;
    const data = checked.data; const current = get();
    const sourceIds = new Set((data.sources||[]).map((x:any)=>x.id)); const receiverIds = new Set((data.receivers||[]).map((x:any)=>x.id));
    set({ projectName:data.projectName||current.projectName, roomName:data.roomName||'Recovered Space', poly:data.poly, L:data.L,W:data.W,H:data.H,fmax:data.fmax,accuracyMode:data.accuracyMode||'balanced',confirmReducedResolution:data.confirmReducedResolution===true,wallMaterial:data.wallMaterial||'drywall',wallSegMats:data.wallSegMats,wallOpenings:data.wallOpenings,floorMaterial:data.floorMaterial||'wood_floor',ceilMaterial:data.ceilMaterial||'stonewool',scatter:data.scatter||current.scatter,sources:data.sources,receivers:data.receivers,simulations:(data.simulations||[]).filter((x:any)=>sourceIds.has(x.sourceId)&&receiverIds.has(x.receiverId)),uxMode:data.uxMode||'beginner',primaryReceiverId:data.primaryReceiverId||data.receivers?.[0]?.id||null,receiverGrid:data.receiverGrid||null,solverResult:null,lastSolverResult:null,lastImpulseResponseResult:null,multiReceiverResult:null,heatmapData:null,fdtdImpulseBuffer:null,simulationJobState:'idle',jobId:null,jobToken:null,jobProgress:0,past:[],future:[]});
    return true;
  },
  saveProject: () => {
    // Export only the actual project fields, matching the shape
    // useProjectsStore.ts's extractProjectData()/applyProjectData() and the
    // legacy /api/project endpoint already use. Previously this called
    // JSON.stringify(get()) directly on the whole Zustand store, which
    // dumped every field currently in state -- including this store's own
    // action functions (silently dropped by JSON.stringify, so not a
    // crash, but not intentional either), UI-only state (view, viewMode,
    // showMixer, selectedWallSeg, activeParam...), undo/redo history
    // snapshots (past/future), and even a live, non-serializable
    // MediaDeviceInfo[] (availableMics). The exported file was a leaky
    // dump of internal app state rather than a clean, portable project,
    // and per useProjectsStore.ts's own comment this was supposed to match
    // extractProjectData()'s shape -- it didn't.
    const state = get();
    const data = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      projectName: state.projectName,
      roomName: state.roomName,
      poly: state.poly,
      L: state.L, W: state.W, H: state.H,
      fmax: state.fmax, accuracyMode: state.accuracyMode, confirmReducedResolution: state.confirmReducedResolution,
      wallMaterial: state.wallMaterial,
      wallSegMats: state.wallSegMats,
      wallOpenings: state.wallOpenings,
      floorMaterial: state.floorMaterial,
      ceilMaterial: state.ceilMaterial,
      scatter: state.scatter,
      sources: state.sources,
      receivers: state.receivers,
      simulations: state.simulations,
      uxMode: state.uxMode,
      primaryReceiverId: state.primaryReceiverId,
      receiverGrid: state.receiverGrid,
    });
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${get().roomName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
  loadProject: () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = (e: any) => {
      const file = e.target.files[0];
      if (!file) return;
      const MAX_PROJECT_FILE_BYTES = 5 * 1024 * 1024;
      if (file.size > MAX_PROJECT_FILE_BYTES) {
        alert('Project file is too large. Maximum supported size is 5 MB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const str = e.target?.result as string;
          const parsed = JSON.parse(str);
          const checked = validateProjectData(parsed);
          if (!checked.ok) throw new Error(checked.error);
          const data = checked.data;
          const nextPoly = data.poly;
          const nextSources = data.sources;
          const nextReceivers = data.receivers;
          const sourceIds = new Set(nextSources.map((s: Source) => s.id));
          const receiverIds = new Set(nextReceivers.map((r: Receiver) => r.id));
          const nextSims = Array.isArray(data.simulations) ? data.simulations.filter((sim: Simulation) => sourceIds.has(sim.sourceId) && receiverIds.has(sim.receiverId)) : [];
          set({
            projectName: data.projectName || get().projectName,
            roomName: data.roomName || 'Loaded Space', poly: nextPoly,
            L: Number.isFinite(data.L) && data.L > 0 ? data.L : get().L,
            W: Number.isFinite(data.W) && data.W > 0 ? data.W : get().W,
            H: Number.isFinite(data.H) && data.H > 0 ? data.H : get().H,
            fmax: Number.isFinite(data.fmax) && data.fmax > 0 ? data.fmax : get().fmax,
            accuracyMode: ['fast','balanced','high'].includes(data.accuracyMode) ? data.accuracyMode : get().accuracyMode,
            confirmReducedResolution: data.confirmReducedResolution === true,
            wallMaterial: data.wallMaterial || 'drywall', wallSegMats: Array.isArray(data.wallSegMats) ? data.wallSegMats : new Array(nextPoly.length).fill(null),
            wallOpenings: Array.isArray(data.wallOpenings) ? data.wallOpenings : new Array(nextPoly.length).fill(null),
            floorMaterial: data.floorMaterial || 'wood_floor', ceilMaterial: data.ceilMaterial || 'stonewool',
            scatter: data.scatter || get().scatter,
            sources: nextSources, receivers: nextReceivers, simulations: nextSims,
            uxMode: data.uxMode || 'beginner', primaryReceiverId: data.primaryReceiverId && receiverIds.has(data.primaryReceiverId) ? data.primaryReceiverId : nextReceivers[0]?.id || null,
            receiverGrid: data.receiverGrid || null,
            solverResult: null, lastSolverResult: null, lastImpulseResponseResult: null, multiReceiverResult: null, heatmapData: null, fdtdImpulseBuffer: null, simulationJobState: 'idle', jobId: null, jobToken: null, jobProgress: 0, past: [], future: []
          });
          alert('Project loaded successfully!');
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid project file.';
          alert(`Failed to load project: ${message}`);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  },

  uxMode: 'beginner', setUxMode: (mode) => set({ uxMode: mode }),
  primaryReceiverId: null, setPrimaryReceiverId: (id) => set({ primaryReceiverId: id }),
  multiReceiverResult: null, setMultiReceiverResult: (r) => set({ multiReceiverResult: r }),
  simulationJobState: 'idle', setSimulationJobState: (s) => set({ simulationJobState: s }),
  jobId: null,
  jobToken: null, setJobId: (id, token = null) => set({ jobId: id, jobToken: token }),
  jobProgress: 0, setJobProgress: (p) => set({ jobProgress: p }),
  receiverGrid: null, setReceiverGrid: (g) => { get().saveHistory(); get().invalidateSimulationResults(); set({ receiverGrid: g }); },
  heatmapData: null, setHeatmapData: (h) => set({ heatmapData: h }),
  heatmapMetric: 'rt60', setHeatmapMetric: (m) => set({ heatmapMetric: m })
}));
