import React, { useEffect, useState, useRef } from 'react';
import { useStore } from '../store/useStore';

export default function WavefieldPlayer() {
  const lastSolverResult = useStore(state => state.lastSolverResult);
  const wavefield = lastSolverResult?.wavefield;
  const capabilityToken = lastSolverResult?.capabilityToken;
  
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Bounded buffer cache: { [frameIndex]: Float32Array }
  const frameCache = useRef<Record<number, Float32Array>>({});
  const numFrames = wavefield?.frameUris?.length ?? 0;

  // Preload and manage sliding window
  useEffect(() => {
    if (!wavefield?.frameUris || numFrames === 0) return;
    
    let active = true;
    
    const loadFrame = async (idx: number) => {
      if (frameCache.current[idx] || idx < 0 || idx >= numFrames) return;
      try {
        const uri = wavefield.frameUris[idx];
        const res = await fetch(`/api/storage?id=${encodeURIComponent(uri)}`, { headers: capabilityToken ? { Authorization: `Bearer ${capabilityToken}` } : undefined });
        if (res.ok && active) {
          const buf = await res.arrayBuffer();
          frameCache.current[idx] = new Float32Array(buf);
        }
      } catch (e) {
        console.error("Frame load error", e);
      }
    };

    const manageBuffer = async () => {
      // Maintain a sliding window of -1 to +10 frames
      for (let i = currentFrame - 1; i <= currentFrame + 10; i++) {
        if (active) await loadFrame(i);
      }
      
      // Evict old frames to prevent unbounded RAM growth
      for (const key of Object.keys(frameCache.current)) {
        const idx = parseInt(key);
        if (idx < currentFrame - 5 || idx > currentFrame + 20) {
          delete frameCache.current[idx];
        }
      }
    };
    
    manageBuffer();
    
    return () => { active = false; };
  }, [currentFrame, wavefield, numFrames, capabilityToken]);

  useEffect(() => {
    let interval: any;
    if (isPlaying && numFrames > 0) {
      interval = setInterval(() => {
        setCurrentFrame(prev => {
          if (prev >= numFrames - 1) {
            setIsPlaying(false);
            return prev;
          }
          // Only advance if the next frame is ready
          if (frameCache.current[prev + 1]) {
            return prev + 1;
          }
          return prev; // Buffer underrun, wait
        });
      }, 50); // 20 FPS
    }
    return () => clearInterval(interval);
  }, [isPlaying, numFrames]);

  // Render current frame
  useEffect(() => {
    if (!canvasRef.current || !wavefield) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    const frame = frameCache.current[currentFrame];
    if (!frame) {
      // Frame not loaded yet
      return;
    }

    const { outNx, outNz } = wavefield;
    if (!outNx || !outNz) return;

    const w = canvasRef.current.width;
    const h = canvasRef.current.height;
    const cellW = w / outNx;
    const cellH = h / outNz;

    ctx.clearRect(0, 0, w, h);

    for (let z = 0; z < outNz; z++) {
      for (let x = 0; x < outNx; x++) {
        const val = frame[z * outNx + x];
        const v = Math.max(-1, Math.min(1, val * 100)); 
        if (Math.abs(v) < 0.05) continue; 
        
        if (v > 0) {
          ctx.fillStyle = `rgba(255, 0, 0, ${v * 0.8})`;
        } else {
          ctx.fillStyle = `rgba(0, 0, 255, ${-v * 0.8})`;
        }
        
        ctx.fillRect(x * cellW, h - (z + 1) * cellH, cellW + 1, cellH + 1);
      }
    }
  }, [currentFrame, wavefield]);

  if (!wavefield) return null;

  return (
    <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-[#1b1c1d] rounded shadow-lg p-4 z-50 flex flex-col items-center border border-[#3b3c3d] w-96">
      <div className="text-white text-xs font-bold mb-2">Wave Propagation (Z-Slice)</div>
      
      <div className="relative w-full h-40 bg-black mb-3 border border-[#3b3c3d] overflow-hidden rounded">
        {!frameCache.current[currentFrame] && (
          <div className="absolute inset-0 flex items-center justify-center text-[#6b7280] text-xs">
            Buffering...
          </div>
        )}
        <canvas ref={canvasRef} width={256} height={256} className="w-full h-full object-contain" />
      </div>
      
      <div className="flex w-full items-center gap-3">
        <button 
          onClick={() => {
            if (currentFrame >= numFrames - 1) setCurrentFrame(0);
            setIsPlaying(!isPlaying);
          }}
          disabled={numFrames === 0}
          className="bg-[#2563eb] text-white px-3 py-1 rounded text-xs font-bold disabled:opacity-50"
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <input 
          type="range" 
          min={0} 
          max={Math.max(0, numFrames - 1)} 
          value={currentFrame}
          onChange={e => {
            setCurrentFrame(parseInt(e.target.value));
            setIsPlaying(false);
          }}
          disabled={numFrames === 0}
          className="flex-1"
        />
        <div className="text-[#a0a5aa] text-xs w-10 text-right">
          {currentFrame}/{Math.max(0, numFrames - 1)}
        </div>
      </div>
    </div>
  );
}
