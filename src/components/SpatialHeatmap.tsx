import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { generateInterpolationGrid, Point3D } from '../lib/interpolation';

export default function SpatialHeatmap() {
  const { multiReceiverResult, heatmapMetric, setHeatmapMetric } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showInterpolation, setShowInterpolation] = useState(true);

  // Redraw the canvas when data or metric changes
  useEffect(() => {
    if (!multiReceiverResult || !multiReceiverResult.receivers) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!showInterpolation) return;

    // Prepare points
    const points: Point3D[] = [];
    multiReceiverResult.receivers.forEach(r => {
      const val = r.metrics[heatmapMetric as keyof typeof r.metrics] as number;
      if (val != null && Number.isFinite(val)) {
        points.push({ x: r.position.x, y: r.position.y, z: r.position.z, value: val });
      }
    });

    if (points.length < 2) return;

    // Compute range for color mapping
    let min = Infinity;
    let max = -Infinity;
    points.forEach(p => {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    });

    // Generate grid
    const resolution = 64;
    const grid = generateInterpolationGrid(points, resolution);

    // Draw grid to canvas
    const cellW = canvas.width / resolution;
    const cellH = canvas.height / resolution;

    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const val = grid[y * resolution + x];
        if (val === null) continue;

        // Map value to color (blue -> red)
        const normalized = max > min ? (val - min) / (max - min) : 0.5;
        // Hue from 240 (blue) to 0 (red)
        const hue = 240 - normalized * 240;
        
        ctx.fillStyle = `hsla(${hue}, 100%, 50%, 0.4)`;
        ctx.fillRect(x * cellW, y * cellH, cellW + 1, cellH + 1); // +1 to avoid anti-aliasing gaps
      }
    }
  }, [multiReceiverResult, heatmapMetric, showInterpolation]);

  if (!multiReceiverResult || !multiReceiverResult.receivers || multiReceiverResult.receivers.length === 0) {
    return <div className="text-sm text-gray-500 italic p-4">Run a simulation with multiple receivers to view spatial heatmap.</div>;
  }

  const metricKeys = ['rt60', 'edt', 't20', 't30', 'c50', 'c80', 'd50', 'spl'];

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] p-4 text-white">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-bold text-sm">Spatial Heatmap</h2>
        <select 
          className="bg-[#2c2d30] text-xs p-1 rounded" 
          value={heatmapMetric}
          onChange={e => setHeatmapMetric(e.target.value)}
        >
          {metricKeys.map(k => <option key={k} value={k}>{k.toUpperCase()}</option>)}
        </select>
      </div>
      <div className="flex justify-between items-center mb-4 text-xs">
        <label className="flex items-center gap-2 cursor-pointer text-gray-400 hover:text-gray-200">
          <input 
            type="checkbox" 
            checked={showInterpolation} 
            onChange={e => setShowInterpolation(e.target.checked)} 
          />
          Interpolate (IDW)
        </label>
        <div className="text-[10px] text-gray-500">
          Circles = Measured, Background = Interpolated
        </div>
      </div>

      <div className="flex-1 relative bg-black/30 rounded border border-[#333] overflow-hidden">
        
        {/* Interpolated Canvas Background */}
        <canvas 
          ref={canvasRef}
          width={256}
          height={256}
          className="absolute inset-0 w-full h-full object-fill pointer-events-none"
        />

        {/* Discrete measured points overlay */}
        {multiReceiverResult.receivers.map(r => {
          const val = r.metrics[heatmapMetric as keyof typeof r.metrics] as number;
          const isValid = val != null && Number.isFinite(val);
          return (
            <div 
              key={r.id}
              className="absolute w-3 h-3 rounded-full -ml-1.5 -mt-1.5 transform transition-transform hover:scale-150 group border border-white/20"
              style={{
                left: `${r.position.x * 100}%`,
                top: `${r.position.y * 100}%`,
                backgroundColor: isValid ? '#2563eb' : '#ef4444',
                opacity: 0.9,
                boxShadow: '0 0 4px rgba(0,0,0,0.5)'
              }}
            >
              <div className="opacity-0 group-hover:opacity-100 absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-black text-white text-[10px] px-2 py-1 rounded whitespace-nowrap pointer-events-none z-10">
                {r.name || r.id}<br/>
                {isValid ? `Measured: ${val.toFixed(2)}` : 'Invalid Metric'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
