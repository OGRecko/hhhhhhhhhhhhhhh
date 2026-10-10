import React from 'react';
import { useStore } from '../store/useStore';

export default function ReceiverTable() {
  const { multiReceiverResult, primaryReceiverId, setPrimaryReceiverId } = useStore();

  if (!multiReceiverResult || !multiReceiverResult.receivers || multiReceiverResult.receivers.length === 0) {
    return <div className="text-sm text-gray-500 italic p-4">No multi-receiver results available. Run a simulation first.</div>;
  }

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] text-white text-xs overflow-hidden">
      <div className="p-3 border-b border-[#333] flex justify-between items-center bg-[#252627]">
        <h3 className="font-bold">Receiver Results ({multiReceiverResult.receivers.length})</h3>
      </div>
      
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 bg-[#2c2d30] shadow z-10">
            <tr>
              <th className="p-2 font-semibold">Receiver</th>
              <th className="p-2 font-semibold text-right">RT60</th>
              <th className="p-2 font-semibold text-right">EDT</th>
              <th className="p-2 font-semibold text-right">C50</th>
              <th className="p-2 font-semibold text-right">D50</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#333]">
            {multiReceiverResult.receivers.map(r => {
              const isSelected = r.id === primaryReceiverId;
              const hasWarnings = r.warnings && r.warnings.length > 0;
              return (
                <tr 
                  key={r.id} 
                  className={`cursor-pointer hover:bg-[#333] ${isSelected ? 'bg-[#2563eb]/20' : ''}`}
                  onClick={() => setPrimaryReceiverId(r.id)}
                >
                  <td className="p-2 flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${hasWarnings ? 'bg-amber-500' : 'bg-green-500'}`}></span>
                    {r.name || r.id}
                  </td>
                  <td className="p-2 text-right">{r.metrics.rt60 != null ? r.metrics.rt60.toFixed(2) : '—'}</td>
                  <td className="p-2 text-right">{r.metrics.edt != null ? r.metrics.edt.toFixed(2) : '—'}</td>
                  <td className="p-2 text-right">{r.metrics.c50 != null ? r.metrics.c50.toFixed(1) : '—'}</td>
                  <td className="p-2 text-right">{r.metrics.d50 != null ? (r.metrics.d50 * 100).toFixed(0) + '%' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {multiReceiverResult.spatialSummary && multiReceiverResult.spatialSummary.length > 0 && (
        <div className="p-3 border-t border-[#333] bg-[#252627]">
          <h4 className="font-semibold mb-2 text-gray-300">Aggregate Statistics</h4>
          <div className="grid grid-cols-2 gap-2">
            {multiReceiverResult.spatialSummary.map(s => (
              <div key={s.metric} className="bg-[#1e1e1e] p-2 rounded border border-[#333]">
                <div className="text-[10px] text-gray-400 mb-1">{s.metric}</div>
                <div className="flex justify-between">
                  <span>Mean: {s.mean.toFixed(2)}</span>
                  <span className="text-gray-500">±{s.stdDev.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                  <span>Min: {s.min.toFixed(2)}</span>
                  <span>Max: {s.max.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
