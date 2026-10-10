import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, Volume2, Zap, Calendar, Radio, ArrowLeftRight, Sliders, CheckCircle2, Info, Activity } from "lucide-react";
import { buildSpeakerChain, SpeakerSpec, SpeakerAudioChain } from "../lib/speakerDSP";
import { SPEAKER_SPECS } from "../lib/speakers";
import { formatSensitivity, formatFrequencyRange, formatPower, formatWooferSize } from "../lib/speakerDisplay";
import { getSpeakerResponseModel, interpolateLogFrequency, STANDARD_FREQUENCIES_HZ, type ResponsePoint } from "../lib/speakerResponse";

// Filter out legacy and unresolved catalog entries from the primary picker/audition view
const speakerData = SPEAKER_SPECS.filter((s) => s.overallStatus !== "LEGACY" && s.overallStatus !== "UNAVAILABLE");
const speakers = speakerData as SpeakerSpec[];

const CATEGORIES = [
  "all",
  "studio-monitor",
  "floor-standing",
  "bookshelf",
  "pa",
  "subwoofer",
  "ceiling",
  "in-wall",
  "portable",
  "guitar-cab",
  "car-audio",
  "soundbar",
  "smart-speaker",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  all: "All",
  "studio-monitor": "Studio Monitor",
  "floor-standing": "Floor-standing",
  bookshelf: "Bookshelf",
  pa: "PA / Live Sound",
  subwoofer: "Subwoofer",
  ceiling: "Ceiling",
  "in-wall": "In-wall",
  portable: "Portable",
  "guitar-cab": "Guitar Cab",
  "car-audio": "Car Audio",
  soundbar: "Soundbar",
  "smart-speaker": "Smart Speaker",
};

export default function SpeakerPicker({ onSelect }: { onSelect?: (spec: SpeakerSpec) => void } = {}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [era, setEra] = useState<"all" | "vintage" | "modern">("all");

  // Speaker A and Speaker B state for A/B testing
  const [speakerA, setSpeakerA] = useState<SpeakerSpec | null>(() => speakers[0] || null);
  const [speakerB, setSpeakerB] = useState<SpeakerSpec | null>(() => {
    // Default Speaker B to a contrasting reference model (e.g. Yamaha NS-10M or a Subwoofer if available)
    const ns10 = speakers.find((s) => s.id === "yamaha-ns10m");
    return ns10 || speakers[1] || null;
  });
  const [activeSlot, setActiveSlot] = useState<"A" | "B">("A");
  const [loudnessMatched, setLoudnessMatched] = useState<boolean>(true);
  const [showDifference, setShowDifference] = useState<boolean>(true);
  const [playing, setPlaying] = useState(false);

  const activeSpeaker = activeSlot === "A" ? speakerA : speakerB;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const chainRef = useRef<SpeakerAudioChain | null>(null);
  const noiseSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const noiseBufferRef = useRef<AudioBuffer | null>(null);

  const filtered = useMemo(() => {
    return speakers.filter((s) => {
      const matchesQuery =
        query.trim() === "" ||
        `${s.brand} ${s.model}`.toLowerCase().includes(query.toLowerCase());
      const matchesCategory = category === "all" || s.category === category;
      const matchesEra =
        era === "all" ||
        (s.year != null && era === "vintage" && s.year < 1990) ||
        (s.year != null && era === "modern" && s.year >= 1990);
      return matchesQuery && matchesCategory && matchesEra;
    });
  }, [query, category, era]);

  useEffect(() => {
    return () => {
      stopAudition();
      audioCtxRef.current?.close();
    };
  }, []);

  function ensureContext(): AudioContext {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    if (audioCtxRef.current.state === "suspended") {
      void audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }

  function getDeterministicPinkNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (noiseBufferRef.current) return noiseBufferRef.current;

    const sampleRate = ctx.sampleRate;
    const durationSec = 3.0;
    const buffer = ctx.createBuffer(1, Math.floor(sampleRate * durationSec), sampleRate);
    const data = buffer.getChannelData(0);

    // Deterministic pseudo-random seed generator for identical reproducible playback
    let seed = 123456789;
    const lcg = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 2147483648 - 1.0;
    };

    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = lcg();
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.96300 * b1 + white * 0.296516;
      b2 = 0.57000 * b2 + white * 1.052691;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.12;
    }

    noiseBufferRef.current = buffer;
    return buffer;
  }

  function stopAudition() {
    if (noiseSourceRef.current) {
      try {
        noiseSourceRef.current.stop();
        noiseSourceRef.current.disconnect();
      } catch {
        // Intentional: stop()/disconnect() throw InvalidStateError if the source already ended; nothing to undo.
      }
      noiseSourceRef.current = null;
    }
    if (chainRef.current) {
      chainRef.current.dispose();
      chainRef.current = null;
    }
    setPlaying(false);
  }

  function startAudition(spec: SpeakerSpec, matched = loudnessMatched) {
    stopAudition();
    if (!spec) return;

    const ctx = ensureContext();
    const chain = buildSpeakerChain(ctx, spec, { loudnessMatched: matched });
    chainRef.current = chain;
    chain.output.connect(ctx.destination);

    const buffer = getDeterministicPinkNoiseBuffer(ctx);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    noise.connect(chain.input);
    noise.start();
    noiseSourceRef.current = noise;

    setPlaying(true);
  }

  function handleToggleAB() {
    const nextSlot = activeSlot === "A" ? "B" : "A";
    setActiveSlot(nextSlot);
    const nextSpeaker = nextSlot === "A" ? speakerA : speakerB;

    if (playing && nextSpeaker) {
      startAudition(nextSpeaker, loudnessMatched);
    }
  }

  function handleToggleLoudnessMatch() {
    const next = !loudnessMatched;
    setLoudnessMatched(next);
    if (playing && activeSpeaker) {
      startAudition(activeSpeaker, next);
    }
  }

  // Response models
  const modelA = useMemo(() => (speakerA ? getSpeakerResponseModel(speakerA) : null), [speakerA]);
  const modelB = useMemo(() => (speakerB ? getSpeakerResponseModel(speakerB) : null), [speakerB]);

  return (
    <div className="w-full h-full bg-[#0a0a0c] text-white flex flex-col font-sans">
      {/* Header */}
      <div className="border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Volume2 className="w-5 h-5 text-blue-500" />
          <div>
            <h2 className="font-bold text-base flex items-center gap-2">
              Speaker Library & A/B Sound Tester
            </h2>
            <span className="text-white/40 text-xs">
              {speakers.length} catalog records • Source-backed specs shown when available
            </span>
          </div>
        </div>

        {/* Global A/B Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggleLoudnessMatch}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 border transition-all ${
              loudnessMatched
                ? "bg-blue-600/20 text-blue-400 border-blue-500/40"
                : "bg-white/5 text-white/60 border-white/10 hover:text-white"
            }`}
            title={loudnessMatched ? "Loudness matched: equalizes level to isolate tonal/timbre differences" : "Raw mode: preserves realistic physical sensitivity differences"}
          >
            <Sliders className="w-3.5 h-3.5" />
            {loudnessMatched ? "Loudness Matched" : "Raw Sensitivity SPL"}
          </button>

          <button
            onClick={handleToggleAB}
            className="px-3.5 py-1.5 rounded-full text-xs font-bold flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-sm hover:brightness-110 active:scale-95 transition-all"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            Switch A / B (Active: {activeSlot})
          </button>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Speaker Search and Selection */}
        <div className="w-5/12 flex flex-col border-r border-white/10">
          <div className="p-3 border-b border-white/10 space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by brand or model..."
                className="w-full bg-white/5 border border-white/10 rounded-full pl-9 pr-4 py-1.5 text-xs outline-none focus:border-blue-500/50 transition-colors"
              />
            </div>

            <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto py-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-colors ${
                    category === c ? "bg-blue-600 text-white" : "bg-white/5 hover:bg-white/10 text-white/60"
                  }`}
                >
                  {CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              {(["all", "vintage", "modern"] as const).map((e) => (
                <button
                  key={e}
                  onClick={() => setEra(e)}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-colors flex items-center gap-1 ${
                    era === e ? "bg-white/20 text-white" : "bg-white/5 hover:bg-white/10 text-white/50"
                  }`}
                >
                  <Calendar className="w-3 h-3" />
                  {e === "all" ? "All years" : e === "vintage" ? "Pre-1990" : "1990–now"}
                </button>
              ))}
            </div>
          </div>

          {/* List of Speakers */}
          <div className="flex-1 overflow-y-auto divide-y divide-white/5">
            {filtered.map((s) => {
              const isA = speakerA?.id === s.id;
              const isB = speakerB?.id === s.id;
              const isCurrent = activeSpeaker?.id === s.id;

              return (
                <div
                  key={s.id}
                  className={`p-2.5 flex items-center justify-between hover:bg-white/5 transition-colors ${
                    isCurrent ? "bg-white/10" : ""
                  }`}
                >
                  <div
                    className="flex-1 cursor-pointer pr-2"
                    onClick={() => {
                      if (activeSlot === "A") setSpeakerA(s);
                      else setSpeakerB(s);
                      if (playing) startAudition(s, loudnessMatched);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-white">
                        {s.brand} {s.model}
                      </span>
                      {s.year && <span className="text-[10px] text-white/40">{s.year}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-white/50">{CATEGORY_LABELS[s.category]}</span>
                      {s.overallStatus && (
                        <span
                          className={`text-[8px] uppercase tracking-wider px-1.5 py-0.2 rounded border ${
                            s.overallStatus.includes("VERIFIED")
                              ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                              : "border-blue-500/40 text-blue-400 bg-blue-500/10"
                          }`}
                        >
                          {s.overallStatus}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Slot Assignment Buttons */}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSpeakerA(s);
                        if (activeSlot === "A" && playing) startAudition(s, loudnessMatched);
                      }}
                      className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${
                        isA ? "bg-blue-600 text-white" : "bg-white/5 text-white/60 hover:bg-white/15"
                      }`}
                    >
                      A
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSpeakerB(s);
                        if (activeSlot === "B" && playing) startAudition(s, loudnessMatched);
                      }}
                      className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${
                        isB ? "bg-amber-600 text-white" : "bg-white/5 text-white/60 hover:bg-white/15"
                      }`}
                    >
                      B
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Sound Tester, A/B Response Graph & Audition */}
        <div className="w-7/12 flex flex-col overflow-y-auto p-4 space-y-4">
          {/* Slot Selector Tabs */}
          <div className="grid grid-cols-2 gap-2 p-1 bg-white/5 rounded-xl border border-white/10">
            <button
              onClick={() => {
                setActiveSlot("A");
                if (playing && speakerA) startAudition(speakerA, loudnessMatched);
              }}
              className={`p-2.5 rounded-lg text-left transition-all relative ${
                activeSlot === "A"
                  ? "bg-blue-600/30 border border-blue-500/60 text-white shadow-sm"
                  : "hover:bg-white/5 text-white/60"
              }`}
            >
              <div className="flex items-center justify-between text-xs font-bold mb-0.5">
                <span className="flex items-center gap-1.5 text-blue-400">
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  SPEAKER A
                </span>
                {activeSlot === "A" && <span className="text-[10px] uppercase text-blue-300">Auditioning</span>}
              </div>
              <div className="font-semibold text-sm truncate text-white">
                {speakerA ? `${speakerA.brand} ${speakerA.model}` : "Select speaker"}
              </div>
            </button>

            <button
              onClick={() => {
                setActiveSlot("B");
                if (playing && speakerB) startAudition(speakerB, loudnessMatched);
              }}
              className={`p-2.5 rounded-lg text-left transition-all relative ${
                activeSlot === "B"
                  ? "bg-amber-600/30 border border-amber-500/60 text-white shadow-sm"
                  : "hover:bg-white/5 text-white/60"
              }`}
            >
              <div className="flex items-center justify-between text-xs font-bold mb-0.5">
                <span className="flex items-center gap-1.5 text-amber-400">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  SPEAKER B
                </span>
                {activeSlot === "B" && <span className="text-[10px] uppercase text-amber-300">Auditioning</span>}
              </div>
              <div className="font-semibold text-sm truncate text-white">
                {speakerB ? `${speakerB.brand} ${speakerB.model}` : "Select speaker"}
              </div>
            </button>
          </div>

          {/* Interactive Frequency Response Visualizer */}
          <div className="bg-[#121217] p-3.5 rounded-xl border border-white/10 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold flex items-center gap-1.5 text-white/90">
                <Activity className="w-4 h-4 text-blue-400" />
                Modeled Frequency Response (20 Hz – 20 kHz)
              </span>

              <div className="flex items-center gap-3 text-[11px]">
                <label className="flex items-center gap-1 text-white/60 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showDifference}
                    onChange={(e) => setShowDifference(e.target.checked)}
                    className="rounded bg-white/10 border-white/20 text-emerald-500 focus:ring-0"
                  />
                  Show Difference (A - B)
                </label>
              </div>
            </div>

            {/* SVG Frequency Response Graph */}
            <div className="h-44 w-full bg-[#0a0a0e] rounded-lg border border-white/5 relative overflow-hidden flex items-center justify-center">
              <ResponseGraph
                modelA={modelA}
                modelB={modelB}
                showDiff={showDifference}
                activeSlot={activeSlot}
              />
            </div>

            {/* Response Legend and Data Provenance */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-white/50 border-t border-white/5">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-0.5 bg-blue-500 inline-block" />
                  Speaker A: {speakerA?.model}
                  {modelA?.isGenericReference && <GenericReferenceBadge model={modelA} slot="A" />}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-0.5 bg-amber-500 inline-block" />
                  Speaker B: {speakerB?.model}
                  {modelB?.isGenericReference && <GenericReferenceBadge model={modelB} slot="B" />}
                </span>
                {showDifference && (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-0.5 bg-emerald-500 inline-block" />
                    Delta (A - B)
                  </span>
                )}
              </div>

              {activeSpeaker && (
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="text-white/40">Provenance:</span>
                  <span className="text-blue-300 font-medium">
                    {activeSlot === "A" ? modelA?.sourceDescription : modelB?.sourceDescription}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Active Speaker Details */}
          {activeSpeaker && (
            <div className="bg-white/5 p-3.5 rounded-xl border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-bold text-sm text-white flex items-center gap-2">
                    {activeSpeaker.brand} {activeSpeaker.model}
                    <span className="text-[10px] text-white/50 font-normal">({activeSpeaker.year || "N/A"})</span>
                  </h4>
                  <p className="text-white/50 text-xs mt-0.5">{activeSpeaker.notes || "No notes available."}</p>
                </div>

                <div className="text-right">
                  <span className="text-[10px] text-white/40 block">Sensitivity</span>
                  <span className="font-bold text-xs text-white">
                    {formatSensitivity(activeSpeaker.sensitivity?.value, activeSpeaker.sensitivity?.reference, activeSpeaker.sensitivity?.sourceType)}
                  </span>
                </div>
              </div>

              {/* Specs Grid */}
              <div className="grid grid-cols-4 gap-2 text-xs">
                <SpecItem
                  label="Freq Range"
                  value={formatFrequencyRange(activeSpeaker.frequencyResponse?.low_hz, activeSpeaker.frequencyResponse?.high_hz)}
                />
                <SpecItem label="Power" value={formatPower(activeSpeaker.power?.value, activeSpeaker.power?.role)} />
                <SpecItem
                  label="LF Driver"
                  value={activeSpeaker.panel ? "Planar" : formatWooferSize(activeSpeaker.woofer?.value, activeSpeaker.woofer?.unit)}
                />
                <SpecItem
                  label="Impedance"
                  value={activeSpeaker.active ? "Active DSP" : activeSpeaker.impedance?.value != null ? `${activeSpeaker.impedance.value}Ω` : "N/A"}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => (playing ? stopAudition() : startAudition(activeSpeaker, loudnessMatched))}
                  className={`flex-1 py-2.5 rounded-lg font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-all ${
                    playing
                      ? "bg-red-600/20 text-red-400 border border-red-500/40 hover:bg-red-600/30"
                      : "bg-blue-600 hover:bg-blue-500 text-white"
                  }`}
                >
                  {playing ? <Radio className="w-4 h-4 animate-pulse" /> : <Zap className="w-4 h-4" />}
                  {playing ? `Stop Audition (${activeSlot}: ${activeSpeaker.model})` : `Audition Speaker ${activeSlot}`}
                </button>

                {onSelect && (
                  <button
                    onClick={() => onSelect(activeSpeaker)}
                    className="px-4 py-2.5 rounded-lg font-semibold text-xs border border-white/20 text-white hover:border-blue-500 hover:text-blue-400 transition-colors"
                  >
                    Select for Room
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SpecItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/5 rounded-lg p-2 border border-white/5">
      <div className="text-white/40 text-[10px]">{label}</div>
      <div className="font-bold text-xs text-white truncate">{value}</div>
    </div>
  );
}

/**
 * Shown next to a modeled response curve whose frequency limit(s) were not published. The curve is a neutral
 * reference, not this speaker's response, so it is flagged explicitly rather than left to the provenance text.
 */
function GenericReferenceBadge({ model, slot }: { model: import("../lib/speakerResponse").SpeakerResponseModel; slot: "A" | "B" }) {
  const sides = (model.referenceBounds ?? []).map((b) => (b === "low_hz" ? "low limit" : "high limit")).join(" and ");
  return (
    <span
      data-testid={`generic-reference-badge-${slot}`}
      title={`No published ${sides || "frequency limit"} for this speaker, so that side of the curve is a neutral generic reference, not the speaker's real response.`}
      className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[9px] font-bold uppercase tracking-wide"
    >
      Generic reference – not actual response
    </span>
  );
}

/**
 * Pure SVG Logarithmic Frequency Response Chart
 */
function ResponseGraph({
  modelA,
  modelB,
  showDiff,
  activeSlot,
}: {
  modelA: import("../lib/speakerResponse").SpeakerResponseModel | null;
  modelB: import("../lib/speakerResponse").SpeakerResponseModel | null;
  showDiff: boolean;
  activeSlot: "A" | "B";
}) {
  const W = 460;
  const H = 150;
  const minFreq = 20;
  const maxFreq = 20000;
  const logMin = Math.log10(minFreq);
  const logMax = Math.log10(maxFreq);
  const logRange = logMax - logMin;

  const minDb = -30;
  const maxDb = 15;
  const dbRange = maxDb - minDb;

  const xFromFreq = (f: number) => ((Math.log10(f) - logMin) / logRange) * W;
  const yFromDb = (db: number) => H - ((Math.max(minDb, Math.min(maxDb, db)) - minDb) / dbRange) * H;

  // Grid frequencies
  const gridFreqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const gridDbs = [-20, -10, 0, 10];

  // Build SVG path string from points
  const makePath = (points: ResponsePoint[] | undefined) => {
    if (!points || points.length === 0) return "";
    return points
      .map((p, idx) => {
        const x = xFromFreq(p.hz).toFixed(1);
        const y = yFromDb(p.db).toFixed(1);
        return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
      })
      .join(" ");
  };

  // Evaluate fine points for smooth curves
  const evalFreqs = useMemo(() => {
    const list: number[] = [];
    const steps = 70;
    for (let i = 0; i <= steps; i++) {
      const f = Math.pow(10, logMin + (i / steps) * logRange);
      list.push(f);
    }
    return list;
  }, [logMin, logRange]);

  const curveA = useMemo(() => {
    if (!modelA) return [];
    return evalFreqs.map((f) => ({ hz: f, db: interpolateLogFrequency(modelA.points, f) }));
  }, [modelA, evalFreqs]);

  const curveB = useMemo(() => {
    if (!modelB) return [];
    return evalFreqs.map((f) => ({ hz: f, db: interpolateLogFrequency(modelB.points, f) }));
  }, [modelB, evalFreqs]);

  const diffCurve = useMemo(() => {
    if (!modelA || !modelB || !showDiff) return [];
    return evalFreqs.map((f) => ({
      hz: f,
      db: interpolateLogFrequency(modelA.points, f) - interpolateLogFrequency(modelB.points, f),
    }));
  }, [modelA, modelB, showDiff, evalFreqs]);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full">
      {/* Background Grids */}
      {gridFreqs.map((f) => {
        const x = xFromFreq(f);
        return (
          <g key={f}>
            <line x1={x} y1={0} x2={x} y2={H} stroke="rgba(255,255,255,0.06)" strokeDasharray="2,2" />
            <text x={x} y={H - 4} fill="rgba(255,255,255,0.25)" fontSize="8" textAnchor="middle">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        );
      })}

      {gridDbs.map((db) => {
        const y = yFromDb(db);
        const isZero = db === 0;
        return (
          <g key={db}>
            <line
              x1={0}
              y1={y}
              x2={W}
              y2={y}
              stroke={isZero ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.06)"}
              strokeWidth={isZero ? 1 : 0.8}
            />
            <text x={4} y={y - 2} fill={isZero ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.25)"} fontSize="8">
              {db > 0 ? `+${db}` : db}dB
            </text>
          </g>
        );
      })}

      {/* Difference curve */}
      {showDiff && diffCurve.length > 0 && (
        <path
          d={makePath(diffCurve)}
          fill="none"
          stroke="#10b981"
          strokeWidth="1.2"
          strokeDasharray="3,2"
          opacity="0.75"
        />
      )}

      {/* Curve A */}
      {curveA.length > 0 && (
        <path
          d={makePath(curveA)}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={activeSlot === "A" ? 2.2 : 1.2}
          opacity={activeSlot === "A" ? 1.0 : 0.6}
        />
      )}

      {/* Curve B */}
      {curveB.length > 0 && (
        <path
          d={makePath(curveB)}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={activeSlot === "B" ? 2.2 : 1.2}
          opacity={activeSlot === "B" ? 1.0 : 0.6}
        />
      )}
    </svg>
  );
}
