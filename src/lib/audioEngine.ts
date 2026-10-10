
import { Source, Receiver, Point, useStore } from '../store/useStore';
import { buildSpeakerChain } from './speakerDSP';
import { sourceSensitivityDb, sensitivityOffsetDb } from './sourceSensitivity';

/** Deterministic PRNG (mulberry32): the same room / RT60 always produces the same diffuse reverb tail. */
function seededRandom(seed: number) {
  let a = seed >>> 0;
  if (a === 0) a = 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
import { SPEAKER_SPECS as speakerData } from './speakers'; // typed SpeakerSpec[] (same data as speakers.json)
import { MATERIALS } from './materials';
import { getAbsorption as getAbsorptionCoeffs, UnknownMaterialError } from './absorption';
import { computeRoomSurfaces, computeRT60 } from './roomAcoustics';

// Broadband (500 Hz) absorption used for this real-time RT60 approximation,
// sourced from the same shared per-octave-band table (src/lib/absorption.ts)
// that roomAcoustics.ts and server.ts's FDTD solver both use — not the
// separate flat single-value table in materials.ts. Those two tables are
// independently maintained and their numbers diverge per material (e.g.
// acoustic_panel: 0.70 in materials.ts vs the shared table's 500Hz value
// of 0.75), so using materials.ts here meant the live audio preview's RT60
// could quietly disagree with the RT60 shown in the room-acoustics UI/PDF
// report for the exact same room and materials. See server.ts's
// getAbsorptionAt500Hz for the same fix applied there previously.
function getAbsorption(materialId: string | null | undefined): number {
  return getAbsorptionCoeffs(materialId).hz500;
}

/** Oscillators, buffer sources and constant sources have stop(); plain gain/filter nodes do not. */
function isStoppable(n: AudioNode): n is AudioNode & { stop: () => void } {
  return typeof (n as { stop?: unknown }).stop === 'function';
}

/**
 * The AudioContext constructor for this browser. Older Safari only exposes the prefixed `webkitAudioContext`,
 * which is not in the DOM typings, so it is declared here once instead of casting `window` to `any`.
 */
export function getAudioContextCtor(): typeof AudioContext {
  const w = window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is not supported in this browser.');
  return Ctor;
}

class AudioEngine {
  ctx: AudioContext | null = null;
  masterGain: GainNode | null = null;
  limiter: DynamicsCompressorNode | null = null;
  convolver: ConvolverNode | null = null;
  micSourceNode: MediaStreamAudioSourceNode | null = null;
  sourceNodes: Map<string, { panner: PannerNode, gain: GainNode, extraNodes: AudioNode[], mediaStream?: MediaStream }> = new Map();
  // Decoded audio for sources using a user-uploaded file instead of a
  // built-in generated sound. Keyed by source id. Populated by
  // loadCustomAudioFile(); cleared if the source's soundType is changed
  // away from 'custom' or the source is removed.
  customBuffers: Map<string, AudioBuffer> = new Map();
  isPlaying: boolean = false;
  // Bumped on every play() call so an in-flight call (e.g. one awaiting a
  // mic permission prompt) can tell it's been superseded by a newer call
  // and bail out instead of clobbering/duplicating what the newer call set up.
  playGeneration: number = 0;
  // 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported'
  micStatus: 'idle' | 'requesting' | 'active' | 'denied' | 'unsupported' = 'idle';
  onMicStatusChange: ((status: AudioEngine['micStatus']) => void) | null = null;

  setMicStatus(status: AudioEngine['micStatus']) {
    this.micStatus = status;
    if (this.onMicStatusChange) this.onMicStatusChange(status);
  }

  // Decodes a user-uploaded audio file and stores it for the given source
  // so play() can use it (soundType 'custom') instead of a built-in
  // generated sound. Throws on decode failure — the caller should catch
  // this and show a real error rather than assume success.
  async loadCustomAudioFile(sourceId: string, file: File): Promise<{ durationSec: number }> {
    this.init(); // ensures this.ctx exists
    const arrayBuffer = await file.arrayBuffer();
    // decodeAudioData needs a copy in some browsers since it can detach
    // the original buffer.
    const audioBuffer = await this.ctx!.decodeAudioData(arrayBuffer.slice(0));
    this.customBuffers.set(sourceId, audioBuffer);
    return { durationSec: audioBuffer.duration };
  }

  clearCustomAudioFile(sourceId: string) {
    this.customBuffers.delete(sourceId);
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (getAudioContextCtor())();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    // Brick-wall-ish limiter on the master bus. Without this, cranking the
    // overall level (and having several sources play at once) starts
    // hard-clipping, which sounds like harsh digital distortion rather than
    // just "loud". A fast-attack compressor with a high ratio catches peaks
    // before they clip while barely touching normal program level.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    
    this.convolver = this.ctx.createConvolver();
    // Use the FDTD buffer if available; otherwise the same RT60-derived (or dry) buffer updateFdtdIR() builds.
    this.updateFdtdIR(useStore.getState().fdtdImpulseBuffer ?? null);

    const dryGain = this.ctx.createGain();
    const wetGain = this.ctx.createGain();
    dryGain.gain.value = 0.7;
    wetGain.gain.value = 0.4;

    this.convolver.connect(wetGain);
    wetGain.connect(this.masterGain);
    dryGain.connect(this.masterGain);
    
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);
    
    useStore.subscribe((state, prevState) => {
        if (state.fdtdImpulseBuffer !== prevState.fdtdImpulseBuffer || state.activeReceiverId !== prevState.activeReceiverId) {
            this.updateFdtdIR(state.fdtdImpulseBuffer || null);
        }

        // A simulated IR belongs to one exact room/source/receiver state.
        // Keep it from silently surviving an edit and being reused for a new
        // geometry or listener position. The next play falls back to the
        // canonical real-time room model until a fresh IR is computed.
        const acousticInputsChanged =
          state.L !== prevState.L || state.W !== prevState.W || state.H !== prevState.H ||
          state.poly !== prevState.poly ||
          state.wallMaterial !== prevState.wallMaterial ||
          state.wallSegMats !== prevState.wallSegMats ||
          state.wallOpenings !== prevState.wallOpenings ||
          state.floorMaterial !== prevState.floorMaterial ||
          state.ceilMaterial !== prevState.ceilMaterial ||
          state.sources !== prevState.sources ||
          state.receivers !== prevState.receivers;
        if (acousticInputsChanged && (state.fdtdImpulseBuffer || Object.keys(state.receiverImpulseBuffers).length > 0)) {
          state.invalidateSimulationResults();
        }
    });
  }

  /**
   * RT60 (s) computed from the current room model at 500 Hz, or null when it cannot be computed. No
   * RT60 is invented: callers must handle null (updateFdtdIR falls back to a dry, reverb-free impulse).
   */
  getAcousticFallbackRT60(): number | null {
    try {
      const state = useStore.getState();
      const rt = computeRT60({
        L: state.L, W: state.W, H: state.H,
        poly: state.poly,
        wallMaterial: state.wallMaterial,
        wallSegMats: state.wallSegMats,
        wallOpenings: state.wallOpenings,
        floorMaterial: state.floorMaterial,
        ceilMaterial: state.ceilMaterial,
      });
      const val = rt.eyring['500 Hz'] ?? rt.sabine['500 Hz'];
      if (val !== null && Number.isFinite(val) && val > 0.05 && val < 20) return val;
      return null;
    } catch (err) {
      console.warn('[audioEngine] Could not compute RT60 for the playback reverb; playing dry.', err);
      return null;
    }
  }

  /** A one-sample unit impulse: convolution with it is the identity (no reverb is added). */
  private createDryImpulse(ctx: AudioContext): AudioBuffer {
    const impulse = ctx.createBuffer(2, 1, ctx.sampleRate);
    impulse.getChannelData(0)[0] = 1;
    impulse.getChannelData(1)[0] = 1;
    return impulse;
  }

  updateFdtdIR(buffer: AudioBuffer | null) {
    // Guard on ctx as well as convolver. This is reached from a store
    // a browser audio event, which can fire before init() has run (or after a context
    // teardown), and generateImpulseResponse dereferences ctx.sampleRate
    // immediately — so a null ctx here was a live TypeError, not a
    // theoretical one.
    if (!this.convolver || !this.ctx) return;
    if (buffer) {
      this.convolver.buffer = buffer;
    } else {
      const rt60 = this.getAcousticFallbackRT60();
      this.convolver.buffer = rt60 === null ? this.createDryImpulse(this.ctx) : this.generateImpulseResponse(this.ctx, rt60);
    }
  }

  generateImpulseResponse(ctx: AudioContext, rt60: number) {
    const sampleRate = ctx.sampleRate;
    // A non-finite or non-positive RT60 would make createBuffer() throw; substituting a made-up value would
    // hide the bad input, so reject it.
    if (!Number.isFinite(rt60) || rt60 <= 0) throw new RangeError(`generateImpulseResponse: rt60 must be a finite number > 0 (got ${String(rt60)}).`);
    const safeRt60 = rt60;
    const length = Math.max(1, Math.ceil(sampleRate * safeRt60));
    const impulse = ctx.createBuffer(2, length, sampleRate);
    // Time constant chosen so the envelope actually reaches -60dB at t=rt60,
    // matching what "RT60" means by definition (time to decay 60dB from the
    // direct sound). amplitude(t) = exp(-t/tau); solving
    // 20*log10(exp(-t/tau)) = -60 at t=rt60 gives tau = rt60 * ln(10)/(3*ln(10)) ...
    // more directly: tau = rt60 / (60 / (20/ln(10))) = rt60 * 20 / (60*ln(10)).
    // (The previous rt60/6 constant only reached about -52dB at t=rt60, ~8dB
    // short of a true 60dB decay -- verified numerically, not just derived.)
    const tau = safeRt60 * (20 / (60 * Math.log(10)));
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      const rand = seededRandom(Math.round(safeRt60 * 1000) * 2 + channel);
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const decay = Math.exp(-t / tau);
        channelData[i] = (rand() * 2 - 1) * decay;
      }
    }
    return impulse;
  }

  createNoiseBuffer(ctx: AudioContext, type: 'white'|'pink'|'brown') {
    const bufferSize = ctx.sampleRate * 2; // 2 seconds loop
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
        let white = Math.random() * 2 - 1;
        if (type === 'pink') {
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            output[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
            output[i] *= 0.11;
            b6 = white * 0.115926;
        } else if (type === 'brown') {
            output[i] = (lastOut + (0.02 * white)) / 1.02;
            lastOut = output[i];
            output[i] *= 3.5; 
        } else {
            output[i] = white;
        }
    }
    return buffer;
  }

  // --- Synthesized instrument loops (no external audio files) ---

  createBassLoopBuffer(ctx: AudioContext) {
    // Simple walking bass pattern, 4 notes, looped
    const bpm = 92;
    const beat = 60 / bpm;
    const bars = 2;
    const notesPerBar = 4;
    const total = beat * notesPerBar * bars;
    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    const freqs = [55, 55, 82.41, 73.42, 55, 55, 61.74, 65.41]; // A1 A1 E2 D2 A1 A1 B1 C2-ish walking line
    for (let n = 0; n < freqs.length; n++) {
      const startT = n * beat;
      const dur = beat * 0.9;
      const f = freqs[n];
      const startSample = Math.floor(startT * sampleRate);
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.min(1, t * 40) * Math.exp(-t * 3.2); // plucky decay
        // slightly detuned saw-ish tone for warmth
        const s = Math.sin(2 * Math.PI * f * t) * 0.6 + Math.sin(2 * Math.PI * f * 2 * t) * 0.25 + Math.sin(2 * Math.PI * f * 3 * t) * 0.1;
        data[i] += s * env * 0.9;
      }
    }
    return buffer;
  }

  createPianoLoopBuffer(ctx: AudioContext) {
    // Simple arpeggio chord progression: Am - F - C - G, each 1 second
    const sampleRate = ctx.sampleRate;
    const chordDur = 1.0;
    const chords = [
      [220.00, 261.63, 329.63], // Am
      [174.61, 220.00, 261.63], // F
      [261.63, 329.63, 392.00], // C
      [196.00, 246.94, 392.00], // G
    ];
    const total = chordDur * chords.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    chords.forEach((chord, ci) => {
      chord.forEach((f, ni) => {
        const startT = ci * chordDur + ni * 0.08; // slight arpeggio stagger
        const startSample = Math.floor(startT * sampleRate);
        const dur = chordDur - ni * 0.08;
        const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
        for (let i = startSample; i < endSample; i++) {
          const t = (i - startSample) / sampleRate;
          const env = Math.min(1, t * 200) * Math.exp(-t * 2.0); // hammer strike + decay
          const s = Math.sin(2 * Math.PI * f * t) * 0.5
                  + Math.sin(2 * Math.PI * f * 2 * t) * 0.2
                  + Math.sin(2 * Math.PI * f * 4 * t) * 0.08;
          data[i] += s * env * 0.5;
        }
      });
    });
    return buffer;
  }

  createViolinLoopBuffer(ctx: AudioContext) {
    // Sustained bowed melody line with vibrato, 4 notes
    const sampleRate = ctx.sampleRate;
    const noteDur = 1.1;
    const freqs = [440.00, 493.88, 523.25, 587.33]; // A4 B4 C5 D5
    const total = noteDur * freqs.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    freqs.forEach((f, ni) => {
      const startT = ni * noteDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = noteDur * 0.95;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const attack = Math.min(1, t / 0.15); // slow bow attack
        const release = Math.min(1, (dur - t) / 0.15);
        const env = Math.max(0, Math.min(attack, release));
        const vibrato = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t);
        const s = Math.sin(2 * Math.PI * f * vibrato * t) * 0.5
                + Math.sin(2 * Math.PI * f * 2 * vibrato * t) * 0.25
                + Math.sin(2 * Math.PI * f * 3 * vibrato * t) * 0.12;
        data[i] += s * env * 0.6;
      }
    });
    return buffer;
  }

  createGuitarLoopBuffer(ctx: AudioContext) {
    // Electric guitar power-chord riff with mild distortion via waveshaping
    const sampleRate = ctx.sampleRate;
    const bpm = 100;
    const beat = 60 / bpm;
    const notes = [82.41, 82.41, 110.00, 98.00]; // E2 E2 A2 G2 riff
    const total = beat * notes.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    const shape = (x: number) => Math.tanh(x * 3.5); // soft clip distortion
    notes.forEach((f, ni) => {
      const startT = ni * beat;
      const dur = beat * 0.85;
      const startSample = Math.floor(startT * sampleRate);
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.min(1, t * 60) * Math.exp(-t * 4.5);
        // power chord: root + fifth
        const raw = Math.sin(2 * Math.PI * f * t) * 0.6
                  + Math.sin(2 * Math.PI * f * 1.5 * t) * 0.4
                  + Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
        data[i] += shape(raw) * env * 0.45;
      }
    });
    return buffer;
  }

  createDrumBeatBuffer(ctx: AudioContext) {
    // Basic 4-on-the-floor kick/snare/hihat pattern, 2 bars, looped
    const bpm = 120;
    const beat = 60 / bpm;
    const step = beat / 2; // 8th notes
    const steps = 16;
    const total = step * steps;
    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);

    const addKick = (startT: number) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = 0.18;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const freq = 120 * Math.exp(-t * 25) + 40;
        const env = Math.exp(-t * 18);
        data[i] += Math.sin(2 * Math.PI * freq * t) * env * 0.9;
      }
    };
    const addSnare = (startT: number) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = 0.15;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.exp(-t * 22);
        const tone = Math.sin(2 * Math.PI * 180 * t) * 0.3;
        data[i] += ((Math.random() * 2 - 1) * 0.7 + tone) * env * 0.6;
      }
    };
    const addHihat = (startT: number, open: boolean) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = open ? 0.12 : 0.045;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.exp(-t * (open ? 25 : 70));
        data[i] += (Math.random() * 2 - 1) * env * 0.25;
      }
    };

    for (let bar = 0; bar < 2; bar++) {
      const barStart = bar * 8 * step;
      addKick(barStart + 0 * step);
      addKick(barStart + 4 * step);
      addSnare(barStart + 2 * step);
      addSnare(barStart + 6 * step);
      for (let h = 0; h < 8; h++) addHihat(barStart + h * step, h === 7);
    }
    return buffer;
  }

  createSynthLeadLoopBuffer(ctx: AudioContext) {
    // Bright EDM-style synth lead arpeggio
    const sampleRate = ctx.sampleRate;
    const noteDur = 0.2;
    const freqs = [523.25, 659.25, 783.99, 659.25, 523.25, 659.25, 987.77, 783.99]; // C5 E5 G5 ... arp
    const total = noteDur * freqs.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    freqs.forEach((f, ni) => {
      const startT = ni * noteDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = noteDur * 0.9;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.min(1, t * 100) * Math.exp(-t * 6);
        const s = Math.sin(2 * Math.PI * f * t) * 0.5 + (2 * ((f * t) % 1) - 1) * 0.3;
        data[i] += s * env * 0.6;
      }
    });
    return buffer;
  }

  createCelloLoopBuffer(ctx: AudioContext) {
    // Low sustained cello-like drone melody
    const sampleRate = ctx.sampleRate;
    const noteDur = 1.4;
    const freqs = [110.00, 130.81, 146.83, 98.00]; // A2 C3 D3 G2
    const total = noteDur * freqs.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    freqs.forEach((f, ni) => {
      const startT = ni * noteDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = noteDur * 0.95;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const attack = Math.min(1, t / 0.25);
        const release = Math.min(1, (dur - t) / 0.25);
        const env = Math.max(0, Math.min(attack, release));
        const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 4.5 * t);
        const s = Math.sin(2 * Math.PI * f * vibrato * t) * 0.6
                + Math.sin(2 * Math.PI * f * 2 * vibrato * t) * 0.2;
        data[i] += s * env * 0.6;
      }
    });
    return buffer;
  }

  createFluteLoopBuffer(ctx: AudioContext) {
    // Airy flute-like melody, higher register
    const sampleRate = ctx.sampleRate;
    const noteDur = 0.5;
    const freqs = [783.99, 880.00, 987.77, 1046.50, 987.77, 880.00]; // G5 A5 B5 C6 B5 A5
    const total = noteDur * freqs.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    freqs.forEach((f, ni) => {
      const startT = ni * noteDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = noteDur * 0.9;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const attack = Math.min(1, t / 0.08);
        const release = Math.min(1, (dur - t) / 0.15);
        const env = Math.max(0, Math.min(attack, release));
        const breath = (Math.random() * 2 - 1) * 0.03;
        const s = Math.sin(2 * Math.PI * f * t) * 0.55 + breath;
        data[i] += s * env * 0.6;
      }
    });
    return buffer;
  }

  createOrganLoopBuffer(ctx: AudioContext) {
    // Sustained church-organ style chord pad
    const sampleRate = ctx.sampleRate;
    const chordDur = 2.0;
    const chords = [
      [130.81, 164.81, 196.00], // C3 E3 G3
      [146.83, 174.61, 220.00], // D3 F3 A3
    ];
    const total = chordDur * chords.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    chords.forEach((chord, ci) => {
      const startT = ci * chordDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = chordDur * 0.98;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const attack = Math.min(1, t / 0.3);
        const release = Math.min(1, (dur - t) / 0.3);
        const env = Math.max(0, Math.min(attack, release));
        let s = 0;
        chord.forEach(f => {
          s += Math.sin(2 * Math.PI * f * t) * 0.3 + Math.sin(2 * Math.PI * f * 2 * t) * 0.1;
        });
        data[i] += s * env * 0.35;
      }
    });
    return buffer;
  }

  createMarimbaLoopBuffer(ctx: AudioContext) {
    // Plucky wooden marimba-style melodic pattern
    const sampleRate = ctx.sampleRate;
    const noteDur = 0.28;
    const freqs = [392.00, 466.16, 523.25, 392.00, 349.23, 392.00, 466.16, 523.25]; // G4 Bb4 C5 ...
    const total = noteDur * freqs.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    freqs.forEach((f, ni) => {
      const startT = ni * noteDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = noteDur * 0.8;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.min(1, t * 300) * Math.exp(-t * 9);
        const s = Math.sin(2 * Math.PI * f * t) * 0.6 + Math.sin(2 * Math.PI * f * 4 * t) * 0.15;
        data[i] += s * env * 0.6;
      }
    });
    return buffer;
  }

  createSynthPadLoopBuffer(ctx: AudioContext) {
    // Slow evolving ambient synth pad
    const sampleRate = ctx.sampleRate;
    const chordDur = 3.0;
    const chords = [
      [261.63, 329.63, 392.00, 493.88], // Cmaj7
      [220.00, 261.63, 329.63, 415.30], // Am7-ish
    ];
    const total = chordDur * chords.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    chords.forEach((chord, ci) => {
      const startT = ci * chordDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = chordDur * 0.98;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const attack = Math.min(1, t / 0.8);
        const release = Math.min(1, (dur - t) / 0.8);
        const env = Math.max(0, Math.min(attack, release));
        const shimmer = 1 + 0.002 * Math.sin(2 * Math.PI * 0.3 * t);
        let s = 0;
        chord.forEach(f => { s += Math.sin(2 * Math.PI * f * shimmer * t) * 0.22; });
        data[i] += s * env * 0.4;
      }
    });
    return buffer;
  }

  createHipHopBeatLoopBuffer(ctx: AudioContext) {
    // Boom-bap style beat with swung hihats
    const bpm = 90;
    const beat = 60 / bpm;
    const step = beat / 4; // 16th notes
    const steps = 16;
    const total = step * steps;
    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);

    const addKick = (startT: number) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = 0.22;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const freq = 100 * Math.exp(-t * 20) + 35;
        const env = Math.exp(-t * 14);
        data[i] += Math.sin(2 * Math.PI * freq * t) * env;
      }
    };
    const addSnare = (startT: number) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = 0.16;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.exp(-t * 16);
        data[i] += (Math.random() * 2 - 1) * env * 0.65;
      }
    };
    const addHihat = (startT: number) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = 0.04;
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.exp(-t * 90);
        data[i] += (Math.random() * 2 - 1) * env * 0.2;
      }
    };

    addKick(0 * step);
    addKick(3 * step);
    addKick(10 * step);
    addSnare(4 * step);
    addSnare(12 * step);
    for (let h = 0; h < steps; h++) addHihat(h * step);
    return buffer;
  }

  createBellsLoopBuffer(ctx: AudioContext) {
    // Bright bell/glockenspiel-style tinkling pattern
    const sampleRate = ctx.sampleRate;
    const noteDur = 0.35;
    const freqs = [1046.50, 1318.51, 1567.98, 1318.51, 1046.50, 783.99]; // C6 E6 G6 ...
    const total = noteDur * freqs.length;
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    freqs.forEach((f, ni) => {
      const startT = ni * noteDur;
      const startSample = Math.floor(startT * sampleRate);
      const dur = noteDur * 1.3; // let it ring past its slot
      const endSample = Math.min(data.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.exp(-t * 5.5);
        const s = Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2.76 * t) * 0.2;
        data[i] += s * env * 0.5;
      }
    });
    return buffer;
  }

  createOceanWavesLoopBuffer(ctx: AudioContext) {
    // Filtered brown-noise "ocean waves" ambience
    const sampleRate = ctx.sampleRate;
    const total = 6; // 6 second loop, slow swell
    const buffer = ctx.createBuffer(1, Math.ceil(sampleRate * total), sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * t / total - Math.PI / 2);
      data[i] = lastOut * 3.2 * (0.3 + 0.7 * swell);
    }
    return buffer;
  }

  createFullSongLoopBuffer(ctx: AudioContext) {
    // A ~30 second fully arranged song (drums + bass + chords + lead
    // melody) rather than a 1-4 second riff, so "Song" actually sounds
    // like a piece of music playing and repeating rather than a stutter
    // loop. Structure: 4-bar intro (drums+bass only) -> 8-bar verse (add
    // chords) -> 8-bar chorus (add lead melody, fuller drums) -> repeat
    // verse+chorus once more, all in Am, 100bpm, ending back at bar 1 so
    // the loop point is seamless.
    const sampleRate = ctx.sampleRate;
    const bpm = 100;
    const beat = 60 / bpm; // 0.6s
    const bar = beat * 4; // 2.4s per bar
    const bars = 13; // 13 bars * 2.4s = 31.2s ≈ 30s, loop point lands cleanly on a downbeat
    const total = bar * bars;
    const buffer = ctx.createBuffer(2, Math.ceil(sampleRate * total), sampleRate);
    const dataL = buffer.getChannelData(0);
    const dataR = buffer.getChannelData(1);
    const write = (i: number, v: number, pan: number = 0) => {
      // simple equal-power-ish stereo spread for width
      dataL[i] += v * (1 - Math.max(0, pan));
      dataR[i] += v * (1 + Math.min(0, pan));
    };

    const kick = (startT: number, amp = 1) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = 0.2;
      const endSample = Math.min(dataL.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const freq = 130 * Math.exp(-t * 22) + 42;
        const env = Math.exp(-t * 16);
        write(i, Math.sin(2 * Math.PI * freq * t) * env * 0.95 * amp);
      }
    };
    const snare = (startT: number, amp = 1) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = 0.16;
      const endSample = Math.min(dataL.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.exp(-t * 20);
        const tone = Math.sin(2 * Math.PI * 190 * t) * 0.3;
        write(i, ((Math.random() * 2 - 1) * 0.75 + tone) * env * 0.7 * amp);
      }
    };
    const hihat = (startT: number, open = false, amp = 1) => {
      const startSample = Math.floor(startT * sampleRate);
      const dur = open ? 0.12 : 0.045;
      const endSample = Math.min(dataL.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.exp(-t * (open ? 22 : 65));
        write(i, (Math.random() * 2 - 1) * env * 0.22 * amp);
      }
    };
    const bassNote = (startT: number, f: number, dur: number) => {
      const startSample = Math.floor(startT * sampleRate);
      const endSample = Math.min(dataL.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const env = Math.min(1, t * 30) * Math.exp(-t * 2.4);
        const s = Math.sin(2 * Math.PI * f * t) * 0.65 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
        write(i, s * env * 0.8);
      }
    };
    const chord = (startT: number, freqs: number[], dur: number, pan: number, amp = 1) => {
      const startSample = Math.floor(startT * sampleRate);
      const endSample = Math.min(dataL.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const attack = Math.min(1, t / 0.4);
        const release = Math.min(1, (dur - t) / 0.6);
        const env = Math.max(0, Math.min(attack, release));
        let s = 0;
        freqs.forEach(f => { s += Math.sin(2 * Math.PI * f * t) * 0.18; });
        write(i, s * env * 0.55 * amp, pan);
      }
    };
    const lead = (startT: number, f: number, dur: number) => {
      const startSample = Math.floor(startT * sampleRate);
      const endSample = Math.min(dataL.length, Math.floor((startT + dur) * sampleRate));
      for (let i = startSample; i < endSample; i++) {
        const t = (i - startSample) / sampleRate;
        const attack = Math.min(1, t / 0.05);
        const release = Math.min(1, (dur - t) / 0.12);
        const env = Math.max(0, Math.min(attack, release));
        const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t);
        const s = Math.sin(2 * Math.PI * f * vibrato * t) * 0.5 + Math.sin(2 * Math.PI * f * 2 * vibrato * t) * 0.15;
        write(i, s * env * 0.5, 0.3);
      }
    };

    // Am - F - C - G progression, one chord per bar
    const progression = [
      { root: 110.00, chord: [220.00, 261.63, 329.63] }, // Am
      { root: 87.31, chord: [174.61, 220.00, 261.63] },  // F
      { root: 130.81, chord: [261.63, 329.63, 392.00] }, // C
      { root: 98.00, chord: [196.00, 246.94, 392.00] },  // G
    ];
    // Simple 8-note melodic motif (scale degrees over Am), reused/varied each chorus bar
    const leadMotif = [440.00, 523.25, 493.88, 440.00, 392.00, 440.00, 523.25, 587.33];

    for (let b = 0; b < bars; b++) {
      const barStart = b * bar;
      const prog = progression[b % 4];
      const isIntro = b < 1;
      const isChorus = b >= 5 && b < 9; // bars 5-8 = chorus with lead + fuller drums
      const drumAmp = isIntro ? 0.7 : (isChorus ? 1.0 : 0.85);

      // Drums (every bar except keep intro sparse)
      kick(barStart + 0 * beat, drumAmp);
      if (!isIntro) kick(barStart + 2 * beat, drumAmp * 0.9);
      snare(barStart + 1 * beat, drumAmp);
      snare(barStart + 3 * beat, drumAmp);
      for (let h = 0; h < 8; h++) hihat(barStart + h * (beat / 2), h === 7 && isChorus, isIntro ? 0.6 : 1);

      // Bass: walking quarter notes outlining the chord root/fifth
      bassNote(barStart + 0 * beat, prog.root, beat * 0.9);
      bassNote(barStart + 1 * beat, prog.root, beat * 0.9);
      bassNote(barStart + 2 * beat, prog.root * 1.5, beat * 0.9);
      bassNote(barStart + 3 * beat, prog.root, beat * 0.9);

      // Chords come in from the verse onward (skip the drum/bass-only intro bar)
      if (!isIntro) {
        chord(barStart, prog.chord, bar * 0.95, -0.25, isChorus ? 1.1 : 0.85);
      }

      // Lead melody only during the chorus section
      if (isChorus) {
        const noteDur = beat / 2;
        for (let n = 0; n < 8; n++) {
          lead(barStart + n * noteDur, leadMotif[n], noteDur * 0.92);
        }
      }
    }

    return buffer;
  }

  lineIntersect(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number) {
    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
    if (denom === 0) return null;
    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
    const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) return ub; // position along the wall segment (x3,y3)->(x4,y4)
    return null;
  }

  checkWallIntersections(sx: number, sz: number, rx: number, rz: number, poly: Point[], wallSegMats: (string|null)[], globalWallMat: string, L: number, W: number, wallOpenings: (import('../store/useStore').WallOpening | null)[] = []) {
    let lossDb = 0;
    // L/W are normally clamped to a sane minimum by useStore's setL/setW, but
    // a project loaded from disk (import, or a hand-edited/corrupted saved
    // project) sets room dimensions directly via applyProjectData(), which
    // only guards against null/undefined -- not 0 or negative. Dividing by a
    // zero L or W below would produce Infinity/NaN that silently propagates
    // through every wall-intersection check for this source/receiver pair
    // (wrong occlusion results, not a crash) rather than failing loudly.
    // Guard here, at the actual point of failure, so it's safe regardless of
    // which caller let a bad dimension through.
    if (!Number.isFinite(L) || !Number.isFinite(W) || L <= 0 || W <= 0) {
      return 0;
    }
    const p1x = (sx / L) + 0.5;
    const p1z = (sz / W) + 0.5;
    const p2x = (rx / L) + 0.5;
    const p2z = (rz / W) + 0.5;

    for (let i = 0; i < poly.length; i++) {
      const nextI = (i + 1) % poly.length;
      const opening = wallOpenings[i];
      if (opening === 'full') continue; // whole wall removed, sound passes freely
      const hitAt = this.lineIntersect(p1x, p1z, p2x, p2z, poly[i].x, poly[i].y, poly[nextI].x, poly[nextI].y);
      if (hitAt === null) continue;
      if (opening && typeof opening === 'object' && hitAt >= opening.start && hitAt <= opening.end) {
        continue; // sound path passes through the doorway/window gap
      }
      const matId = wallSegMats[i] || globalWallMat;
      const mat = MATERIALS.walls.find(m => m.id === matId);
      if (!mat || !Number.isFinite(mat.tl)) {
        throw new Error(`Unknown wall material "${matId}" — cannot compute transmission loss`);
      }
      lossDb += mat.tl;
    }
    return lossDb;
  }

  async play(sources: Source[], receiver: Receiver | null, L: number, W: number, sourceType: string, poly: Point[], wallSegMats: (string|null)[], globalWallMat: string, wallOpenings: (import('../store/useStore').WallOpening | null)[] = [], H: number = 3, floorMaterial: string = 'wood_floor', ceilMaterial: string = 'stonewool') {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this.stop();
    this.isPlaying = true;
    // Claim this call's generation. If another play() call starts (e.g.
    // the mixer re-renders while this one is still awaiting a mic
    // permission prompt), that call bumps the counter, and this call can
    // detect after its await that it's stale and bail out cleanly instead
    // of building a second, duplicate/racing audio graph on top of the
    // newer call's.
    const myGeneration = ++this.playGeneration;

    let rx = 0, ry = 1.6, rz = 0;
    if (receiver && this.ctx.listener) {
      const listener = this.ctx.listener;
      rx = (receiver.x - 0.5) * L;
      rz = (receiver.y - 0.5) * W;
      
      if (listener.positionX) {
        listener.positionX.value = rx;
        listener.positionY.value = ry;
        listener.positionZ.value = rz;
      } else {
        listener.setPosition(rx, ry, rz);
      }
    }

    let micStream: MediaStream | null = null;
    // A source needs the mic if it's explicitly set to mic, OR if it has no
    // per-source override and the global Audio Source Mode is mic. Checking
    // only `sourceType === 'mic'` missed the per-source override case, so a
    // source's own "Microphone (Hear Yourself)" pick in the Mixer never
    // actually requested the mic stream.
    const needsMic = sourceType === 'mic' || sources.some(s => !s.muted && s.soundType === 'mic');
    if (needsMic) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.setMicStatus('unsupported');
        alert("This browser/connection doesn't support microphone capture here (it needs HTTPS or localhost). Falling back to Song mode.");
        if (sourceType === 'mic') sourceType = 'song';
      } else {
        this.setMicStatus('requesting');
        try {
          const selectedMicId = useStore.getState().selectedMicId;
          const audioConstraints: MediaTrackConstraints = {
            echoCancellation: false, noiseSuppression: false, autoGainControl: false
          };
          if (selectedMicId) {
            audioConstraints.deviceId = { exact: selectedMicId };
          }
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints
          });
          // A newer play() call superseded this one while the permission
          // prompt was up (e.g. the user toggled Play off, or something
          // else re-triggered the mixer effect). Don't build a graph on
          // top of - or fight with - whatever that newer call has already
          // set up; just release the mic we just acquired and stop.
          if (myGeneration !== this.playGeneration) {
            micStream.getTracks().forEach(t => t.stop());
            return;
          }
          this.setMicStatus('active');
        } catch (e) {
          if (myGeneration !== this.playGeneration) return;
          this.setMicStatus('denied');
          console.warn("Microphone not available", e);
          alert("Microphone access denied or not available. Falling back to Song mode. Use headphones with Hear Yourself to avoid feedback/echo.");
          if (sourceType === 'mic') sourceType = 'song';
        }
      }
    } else {
      this.setMicStatus('idle');
    }

    sources.forEach(s => {
      if (s.muted) return;
      
      const panner = this.ctx!.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 100;
      panner.rolloffFactor = 1;

      const sx = (s.x - 0.5) * L;
      const sy = 2.5; 
      const sz = (s.y - 0.5) * W;

      if (panner.positionX) {
        panner.positionX.value = sx;
        panner.positionY.value = sy;
        panner.positionZ.value = sz;
      } else {
        panner.setPosition(sx, sy, sz);
      }

      
      const gain = this.ctx!.createGain();
      
      const wallLossDb = this.checkWallIntersections(sx, sz, rx, rz, poly, wallSegMats, globalWallMat, L, W, wallOpenings);
      const sensDb = sensitivityOffsetDb(sourceSensitivityDb(s)); // 0 dB offset when the source has no usable sensitivity
      const userGainDb = typeof s.gainDb === 'number' && Number.isFinite(s.gainDb) ? s.gainDb : 0;
      
      const totalGainDb = userGainDb + sensDb - wallLossDb;
      // 0.7 base level = full, comfortably loud output at 0dB user gain /
      // reference sensitivity with no wall in the path, while still leaving
      // headroom so several simultaneous sources don't clip.
      gain.gain.value = Math.pow(10, totalGainDb / 20) * 0.7;

      // Material simulation filters
      const wallFilter = this.ctx!.createBiquadFilter();
      wallFilter.type = 'lowpass';
      wallFilter.frequency.value = wallLossDb > 0 ? 500 : 20000;
      
      
      // --- STAGE 2/3 UPGRADE: TRUE PHYSICAL DSP CHAIN ---
      // Instead of generic +/- bass EQ, we load the exact speaker spec and pass it to the physical DSP engine.
      const specData = speakerData.find(d => d.id === s.speakerId) || speakerData.find(d => d.brand === s.brand && d.model === s.model);
      let speakerOut = panner as AudioNode;
      let speakerChainNodes: AudioNode[] = [];
      
      if (specData) {
         try {
             // Pass loudnessMatched: true since gain.gain.value above already incorporates sensDb
             const dspChain = buildSpeakerChain(this.ctx!, specData, { loudnessMatched: true });
             // Wire the panner (spatial location) into the speaker DSP input
             panner.connect(dspChain.input);
             speakerOut = dspChain.output;
             speakerChainNodes = dspChain.nodes;
         } catch (e) {
             console.error("Failed to build DSP chain for speaker:", s.speakerId, e);
         }
      }
      // ---------------------------------------------------

      
      // Dynamic Echo / Reflection Simulation using Convolver (IR)
      if (!this.convolver!.buffer) {
        
        // STAGE 3 UPGRADE: 
        // We no longer blindly synthesize fake reverb.
        // We will check if a TRUE physical FDTD simulation impulse response is available in the store.
        // If not, we generate a real-time approximation and clearly label it internally.
        
        const storeState = useStore.getState();
        const usePhysicalSimulation = storeState.fdtdImpulseBuffer !== undefined && storeState.fdtdImpulseBuffer !== null;
        
        if (usePhysicalSimulation && storeState.fdtdImpulseBuffer) {
           console.log("[AUDIO ENGINE] Mode: PHYSICAL SIMULATION. Loading true FDTD Wave Solver impulse response.");
           
           // We need to decode the WAV buffer from the store, but we can't do it synchronously here.
           // However, if the store already provides an AudioBuffer, we use it directly.
           // If the store provides an ArrayBuffer (WAV), we need to decode it.
           // Assuming the store will hold the decoded AudioBuffer for us to keep play() fast.
           if (storeState.fdtdImpulseBuffer instanceof AudioBuffer) {
               this.convolver!.buffer = storeState.fdtdImpulseBuffer;
           }
        } 
        
        if (!this.convolver!.buffer) {
            console.log("[AUDIO ENGINE] Mode: REAL-TIME APPROXIMATION. Calculating synthetic Sabine RT60.");
            try {
            // Calculate RT60 from the actual room dimensions and the materials
            // the person picked for walls/floor/ceiling (Sabine equation:
            // RT60 = 0.161 * V / A, where A is total absorption in sabins).
            // Keep the live audio fallback on the same canonical room geometry
            // as the acoustic UI/report. A rectangular L/W approximation here
            // would make custom footprints, per-wall materials, and openings
            // sound different from the values shown elsewhere in the app.
            const surfaces = computeRoomSurfaces({
              poly, L, W, H, wallMaterial: globalWallMat, wallSegMats, wallOpenings,
              floorMaterial, ceilMaterial,
            });
            const volume = surfaces.volume;
            const floorArea = surfaces.floorArea;
            const ceilArea = surfaces.ceilArea;
            const wallAbsByMaterial = (materialId: string) => getAbsorption(materialId);
            // Openings are treated as alpha=1 energy loss in the real-time
            // fallback, matching the analytical room model: sound leaves the
            // modeled room instead of reflecting from an imaginary wall.
            const totalSabins =
              floorArea * getAbsorption(floorMaterial) +
              ceilArea * getAbsorption(ceilMaterial) +
              surfaces.wallSegments.reduce((sum, seg) =>
                sum + seg.lengthM * H * wallAbsByMaterial(seg.materialId) + seg.openingLengthM * H, 0);
            let rt60 = (0.161 * volume) / Math.max(totalSabins, 0.01);
            rt60 = Math.min(Math.max(rt60, 0.1), 5.0); // Clamp between 0.1 and 5 seconds
            
            const sampleRate = this.ctx!.sampleRate;
            const length = Math.floor(sampleRate * rt60); // Ensure integer length
            const impulse = this.ctx!.createBuffer(2, length, sampleRate);
            const left = impulse.getChannelData(0);
            const right = impulse.getChannelData(1);
            const randL = seededRandom(Math.round(rt60 * 1000) * 2), randR = seededRandom(Math.round(rt60 * 1000) * 2 + 1);
            for (let i = 0; i < length; i++) {
              const t = i / sampleRate;
              const decay = Math.exp(-t * (6.91 / rt60));
              left[i] = (randL() * 2 - 1) * decay;
              right[i] = (randR() * 2 - 1) * decay;
            }
            this.convolver!.buffer = impulse;
            } catch (err) {
              // Unknown material / inconsistent room: skip the synthetic reverb
              // (dry signal only) instead of inventing an absorption value.
              if (err instanceof UnknownMaterialError) {
                console.warn("[AUDIO ENGINE] Synthetic reverb skipped:", err.message);
              } else {
                throw err;
              }
            }
        }
      }


      
      speakerOut.connect(wallFilter);
      wallFilter.connect(gain);
      gain.connect(this.masterGain!);
      gain.connect(this.convolver!);

      const extraNodes: AudioNode[] = [wallFilter, ...speakerChainNodes];

      // Per-source sound selection overrides the global mode when set
      const effectiveType = s.soundType || sourceType;

      if (effectiveType === 'mic' && micStream) {
        if (!this.micSourceNode) {
          this.micSourceNode = this.ctx!.createMediaStreamSource(micStream);
        }
        // Raw mic capture is typically much quieter than the synthesized
        // tones/loops, so give it its own boost stage before it hits the
        // shared gain node - otherwise "Hear Yourself" is technically wired
        // up correctly but effectively silent next to everything else.
        const micBoost = this.ctx!.createGain();
        micBoost.gain.value = 6;
        this.micSourceNode.connect(micBoost);
        micBoost.connect(panner);
        extraNodes.push(micBoost);
        this.sourceNodes.set(s.id, { panner, gain, extraNodes, mediaStream: micStream });
      } else if (effectiveType.startsWith('noise_')) {
        const noiseType = effectiveType.split('_')[1] as 'white'|'pink'|'brown';
        const buffer = this.createNoiseBuffer(this.ctx!, noiseType);
        const sourceNode = this.ctx!.createBufferSource();
        sourceNode.buffer = buffer;
        sourceNode.loop = true;
        sourceNode.connect(panner);
        sourceNode.start();
        extraNodes.push(sourceNode);
        this.sourceNodes.set(s.id, { panner, gain, extraNodes });
      } else if (effectiveType === 'custom' && this.customBuffers.has(s.id)) {
        const sourceNode = this.ctx!.createBufferSource();
        sourceNode.buffer = this.customBuffers.get(s.id)!;
        sourceNode.loop = true;
        sourceNode.connect(panner);
        sourceNode.start();
        extraNodes.push(sourceNode);
        this.sourceNodes.set(s.id, { panner, gain, extraNodes });
      } else if (['bass', 'piano', 'violin', 'guitar', 'drumbeat', 'synthlead', 'cello', 'flute', 'organ', 'marimba', 'synthpad', 'hiphopbeat', 'bells', 'oceanwaves', 'song'].includes(effectiveType)) {
        const bufferMakers: Record<string, () => AudioBuffer> = {
          bass: () => this.createBassLoopBuffer(this.ctx!),
          piano: () => this.createPianoLoopBuffer(this.ctx!),
          violin: () => this.createViolinLoopBuffer(this.ctx!),
          guitar: () => this.createGuitarLoopBuffer(this.ctx!),
          drumbeat: () => this.createDrumBeatBuffer(this.ctx!),
          synthlead: () => this.createSynthLeadLoopBuffer(this.ctx!),
          cello: () => this.createCelloLoopBuffer(this.ctx!),
          flute: () => this.createFluteLoopBuffer(this.ctx!),
          organ: () => this.createOrganLoopBuffer(this.ctx!),
          marimba: () => this.createMarimbaLoopBuffer(this.ctx!),
          synthpad: () => this.createSynthPadLoopBuffer(this.ctx!),
          hiphopbeat: () => this.createHipHopBeatLoopBuffer(this.ctx!),
          bells: () => this.createBellsLoopBuffer(this.ctx!),
          oceanwaves: () => this.createOceanWavesLoopBuffer(this.ctx!),
          song: () => this.createFullSongLoopBuffer(this.ctx!),
        };
        const buffer = bufferMakers[effectiveType]();
        const sourceNode = this.ctx!.createBufferSource();
        sourceNode.buffer = buffer;
        sourceNode.loop = true;
        sourceNode.connect(panner);
        sourceNode.start();
        extraNodes.push(sourceNode);
        this.sourceNodes.set(s.id, { panner, gain, extraNodes });
      } else if (effectiveType === 'testing123') {
        // Browsers don't allow capturing SpeechSynthesis output into a
        // Web Audio graph, so this can't be run through the spatial panner.
        // Instead we play it directly via the Speech API (mono, not
        // positioned) and keep a silent buffer on the panner chain so this
        // source still counts toward wall-loss / mixer routing.
        const silent = this.ctx!.createBuffer(1, this.ctx!.sampleRate, this.ctx!.sampleRate);
        const sourceNode = this.ctx!.createBufferSource();
        sourceNode.buffer = silent;
        sourceNode.loop = true;
        sourceNode.connect(panner);
        sourceNode.start();
        extraNodes.push(sourceNode);
        this.sourceNodes.set(s.id, { panner, gain, extraNodes });

        const speak = () => {
          if (!this.isPlaying || !this.sourceNodes.has(s.id)) return;
          if ('speechSynthesis' in window) {
            const utter = new SpeechSynthesisUtterance('Testing, 1, 2, 3.');
            utter.rate = 0.95;
            utter.pitch = 1.0;
            utter.volume = Math.max(0, Math.min(1, gain.gain.value * 5));
            window.speechSynthesis.speak(utter);
            utter.onend = () => {
              if (this.isPlaying && this.sourceNodes.has(s.id)) {
                setTimeout(speak, 800);
              }
            };
          }
        };
        speak();
      } else if (effectiveType === 'pulse') {
        const osc = this.ctx!.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 440;
        
        const lfo = this.ctx!.createOscillator();
        lfo.type = 'square';
        lfo.frequency.value = 2; // Beep twice a second
        
        const oscGain = this.ctx!.createGain();
        lfo.connect(oscGain.gain);
        osc.connect(oscGain);
        oscGain.connect(panner);
        
        osc.start();
        lfo.start();
        extraNodes.push(osc, lfo, oscGain);
        this.sourceNodes.set(s.id, { panner, gain, extraNodes });
      } else {
        const baseFreq = 220 + Math.random() * 100;
        const chords = [baseFreq, baseFreq * 1.25, baseFreq * 1.5];
        
        chords.forEach((freq, i) => {
          const osc = this.ctx!.createOscillator();
          osc.type = i === 0 ? 'triangle' : 'sine';
          osc.frequency.value = freq;
          
          const lfo = this.ctx!.createOscillator();
          lfo.type = 'sine';
          lfo.frequency.value = 0.5 + Math.random();
          const lfoGain = this.ctx!.createGain();
          lfoGain.gain.value = 0.5;
          lfo.connect(lfoGain.gain);
          
          const oscGain = this.ctx!.createGain();
          oscGain.gain.value = 0.3;
          lfoGain.connect(oscGain);
          
          osc.connect(oscGain);
          oscGain.connect(panner);
          
          osc.start();
          lfo.start();
          extraNodes.push(osc, lfo);
        });

        this.sourceNodes.set(s.id, { panner, gain, extraNodes });
      }
    });
  }

  updateListener(receiver: Receiver, L: number, W: number) {
    if (!this.ctx || !this.ctx.listener) return;
    const listener = this.ctx.listener;
    const rx = (receiver.x - 0.5) * L;
    const ry = 1.6;
    const rz = (receiver.y - 0.5) * W;
    
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(rx, this.ctx.currentTime, 0.1);
      listener.positionY.setTargetAtTime(ry, this.ctx.currentTime, 0.1);
      listener.positionZ.setTargetAtTime(rz, this.ctx.currentTime, 0.1);
    } else {
      listener.setPosition(rx, ry, rz);
    }
  }

  updateSourcePosition(id: string, sx: number, sy: number, sz: number) {
    const node = this.sourceNodes.get(id);
    if (node && this.ctx) {
      if (node.panner.positionX) {
        node.panner.positionX.setTargetAtTime(sx, this.ctx.currentTime, 0.1);
        node.panner.positionY.setTargetAtTime(sy, this.ctx.currentTime, 0.1);
        node.panner.positionZ.setTargetAtTime(sz, this.ctx.currentTime, 0.1);
      } else {
        node.panner.setPosition(sx, sy, sz);
      }
    }
  }

  updateSourceVolume(id: string, gainDb: number, sensDb?: number | null) {
    const node = this.sourceNodes.get(id);
    if (node && this.ctx) {
      if (!Number.isFinite(gainDb)) throw new RangeError(`updateSourceVolume: gainDb must be finite (got ${String(gainDb)}).`);
      const total = gainDb + sensitivityOffsetDb(sensDb);
      node.gain.gain.setTargetAtTime(Math.pow(10, total / 20) * 0.7, this.ctx.currentTime, 0.1);
    }
  }

  stop() {
    this.isPlaying = false;
    this.playGeneration++;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    // Tear every node down independently so one failure cannot leave the rest connected/playing.
    // InvalidStateError is the expected result of stop() on a source that already ended; anything else is reported.
    const teardown = (what: string, fn: () => void) => {
      try { fn(); }
      catch (e) {
        if (!(e instanceof DOMException && e.name === 'InvalidStateError')) console.warn(`audioEngine.stop: failed to ${what}`, e);
      }
    };
    this.sourceNodes.forEach(node => {
      node.extraNodes.forEach(o => {
        if (isStoppable(o)) teardown('stop an audio node', () => o.stop());
        teardown('disconnect an audio node', () => o.disconnect());
      });
      if (node.mediaStream) {
        node.mediaStream.getTracks().forEach(t => teardown('stop a media track', () => t.stop()));
      }
      teardown('disconnect a panner', () => node.panner.disconnect());
      teardown('disconnect a gain node', () => node.gain.disconnect());
    });
    this.sourceNodes.clear();
    if (this.micSourceNode) {
      const mic = this.micSourceNode;
      teardown('disconnect the microphone source', () => mic.disconnect());
      this.micSourceNode = null;
    }
    if (this.micStatus === 'active' || this.micStatus === 'requesting') {
      this.setMicStatus('idle');
    }
  }
}

export const audioEngine = new AudioEngine();
