import React, { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { Play, Pause, Download, Globe } from 'lucide-react';
import { audioEngine } from '../lib/audioEngine';
import { sourceSensitivityDb } from '../lib/sourceSensitivity';

export default function Mixer() {
  const { sources, receivers, isPlaying, setIsPlaying, L, W, H, floorMaterial, ceilMaterial, updateSource, activeReceiverId, setActiveReceiverId, theme, audioSourceType, poly, wallSegMats, wallMaterial, wallOpenings, roomName, addSimulation } = useStore();

  

  const selectReceiver = (id: string) => {
    setActiveReceiverId(id);
  };

  return (
    <div className={`h-[280px] ${theme === 'dark' ? 'bg-[#1e2023] border-[#2a2c30]' : 'bg-[#ffffff] border-[#e5e7eb]'} border-t flex flex-col w-full shrink-0`}>
      
      {/* Top Bar - hidden for purity if we want strictly like the screenshot, but keeping play/pause is useful */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-[#e5e7eb]'}`}>
        <div className="flex items-center space-x-4">
          <button aria-label="Play mixer preview" onClick={() => setIsPlaying(true)} className={`${isPlaying ? 'text-[#2563eb]' : `${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'}`}`}>
            <Play size={18} fill="currentColor" />
          </button>
          <button aria-label="Stop mixer preview" onClick={() => setIsPlaying(false)} className={`${!isPlaying ? 'text-[#2563eb]' : `${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'}`}`}>
            <Pause size={18} fill="currentColor" />
          </button>
        </div>
      </div>
      
      <div className="flex-1 flex p-4 space-x-6 overflow-x-auto items-stretch">
        
        {/* Left Section - Space Name */}
        <div className={`w-[220px] shrink-0 border border-[#2563eb] rounded-lg ${theme === 'dark' ? 'bg-[#25282d]' : 'bg-[#f9fafb]'} p-4 flex flex-col justify-between`}>
          <div className="flex items-start justify-between">
             <div className={`flex items-center text-[13px] font-bold ${theme === 'dark' ? 'text-white' : 'text-black'}`}>
               <div className="w-6 h-6 bg-[#2563eb] rounded flex items-center justify-center mr-3 text-[#0d0e0f] text-sm">A</div>
               {roomName}
             </div>
             <Download size={14} className={`${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'} cursor-pointer mt-1`} />
          </div>
          <button
            onClick={() => addSimulation()}
            className={`text-xs ${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'} text-left mt-auto flex items-center`}
          >
             Add simulation <span className="ml-1 text-[10px]">⊕</span>
          </button>
        </div>
        
        {/* Receivers Column */}
        <div className={`flex flex-col space-y-4 px-2 min-w-[100px] shrink-0 border-r ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-[#e5e7eb]'}`}>
          {receivers.map((r, i) => (
            <div 
              key={r.id} 
              onClick={() => selectReceiver(r.id)}
              className={`flex items-center text-xs font-semibold cursor-pointer hover:underline ${activeReceiverId === r.id ? 'text-[#2563eb]' : (theme === 'dark' ? 'text-white' : 'text-black')}`}
              title="Click to select receiver"
            >
              <div className={`w-5 h-5 rounded-full flex items-center justify-center mr-3 font-bold text-[10px] ${activeReceiverId === r.id ? 'bg-[#2563eb] text-black' : 'bg-[#6b7280] text-white'}`}>{i + 1}</div>
              {r.name}
            </div>
          ))}
        </div>
        
        {/* Sources Row */}
        {sources.map((s, i) => (
          <div key={s.id} className={`w-[160px] shrink-0 ${theme === 'dark' ? 'bg-[#25282d] border-[#25282d]' : 'bg-[#f9fafb] border-[#e5e7eb]'} border rounded-lg p-4 flex flex-col`}>
            <div className={`flex items-center text-sm font-bold ${theme === 'dark' ? 'text-white' : 'text-[#111827]'} mb-4`}>
              <div className="w-5 h-5 rounded-full bg-[#2563eb] flex items-center justify-center mr-3 text-[#0d0e0f] text-[10px]">{i + 1}</div>
              <div className="truncate">{s.brand}</div>
            </div>
            
            <div className={`h-8 text-[11px] ${theme === 'dark' ? 'text-[#83868c] bg-[#1a1b1e]' : 'text-[#6b7280] bg-[#ffffff]'} mb-2 flex justify-between items-center px-3 rounded-md`}>
              <select
                value={s.soundType || ''}
                onChange={(e) => {
                  const val = e.target.value || undefined;
                  updateSource(s.id, { soundType: val });
                  if (isPlaying) {
                    audioEngine.play(sources.map(x => x.id === s.id ? { ...x, soundType: val } : x), receivers.find(r => r.id === activeReceiverId) || receivers[0], L, W, audioSourceType, poly, wallSegMats, wallMaterial, wallOpenings, H, floorMaterial, ceilMaterial);
                  }
                }}
                className={`w-full bg-transparent outline-none cursor-pointer ${theme === 'dark' ? 'text-[#e7e7e5]' : 'text-[#111827]'}`}
              >
                <option value="">Use global sound</option>
                <option value="custom">Custom (uploaded file)</option>
                <option value="bass">Bass</option>
                <option value="piano">Piano</option>
                <option value="violin">Violin</option>
                <option value="guitar">Electric guitar</option>
                <option value="cello">Cello</option>
                <option value="flute">Flute</option>
                <option value="organ">Organ</option>
                <option value="marimba">Marimba</option>
                <option value="synthlead">Synth lead (arp)</option>
                <option value="synthpad">Synth pad (ambient)</option>
                <option value="bells">Bells</option>
                <option value="drumbeat">Drum beat</option>
                <option value="hiphopbeat">Hip-hop beat</option>
                <option value="oceanwaves">Ocean waves</option>
                <option value="testing123">Testing, 1, 2, 3 (voice)</option>
                <option value="pulse">Pulse / beep</option>
                <option value="noise_white">White noise</option>
                <option value="noise_pink">Pink noise</option>
                <option value="noise_brown">Brown noise</option>
              </select>
            </div>

            <div className={`h-7 text-[11px] ${theme === 'dark' ? 'text-[#83868c] bg-[#1a1b1e]' : 'text-[#6b7280] bg-[#ffffff]'} mb-6 flex justify-between items-center px-3 rounded-md`}>
              <span className="truncate mr-2">{s.soundType === 'custom' ? (s.customFileName || 'Custom file loaded') : 'Or upload file'}</span>
              <label className={`cursor-pointer ${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'} flex items-center justify-center shrink-0`}>
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      await audioEngine.loadCustomAudioFile(s.id, file);
                      updateSource(s.id, { soundType: 'custom', customFileName: file.name });
                      if (isPlaying) {
                        audioEngine.play(sources.map(x => x.id === s.id ? { ...x, soundType: 'custom' as const } : x), receivers.find(r => r.id === activeReceiverId) || receivers[0], L, W, audioSourceType, poly, wallSegMats, wallMaterial, wallOpenings, H, floorMaterial, ceilMaterial);
                      }
                    } catch (err) {
                      console.error(err);
                      alert(`Couldn't load "${file.name}" — the file may be corrupted or in an unsupported format.`);
                    }
                  }}
                />
                <Globe size={12} />
              </label>
            </div>

            <div className="flex-1 flex justify-center items-center py-4 relative group">
               <div className="h-[80px] w-full flex justify-center items-center">
                 <input
                    type="range"
                    min="-20"
                    max="10"
                    value={s.gainDb ?? 0}
                   onChange={(e) => {
                     updateSource(s.id, { gainDb: parseFloat(e.target.value) });
                     if (isPlaying) audioEngine.updateSourceVolume(s.id, parseFloat(e.target.value), sourceSensitivityDb(s));
                   }}
                   className={`w-[100px] h-1.5 -rotate-90 appearance-none ${theme === 'dark' ? 'bg-[#3a3d42]' : 'bg-[#d1d5db]'} outline-none rounded-lg slider-thumb transition-colors`}
                  />
               </div>
            </div>
            
            <div className="flex justify-between items-center mt-6">
              <button 
                 onClick={() => {
                  updateSource(s.id, { muted: !s.muted });
                  if (isPlaying) audioEngine.play(sources.map(x => x.id === s.id ? {...x, muted: !x.muted} : x), receivers.find(r => r.id === activeReceiverId) || receivers[0], L, W, audioSourceType, poly, wallSegMats, wallMaterial, wallOpenings, H, floorMaterial, ceilMaterial);
                }}
                className={`w-6 h-6 text-[10px] font-bold rounded-md flex items-center justify-center ${s.muted ? 'bg-[#2563eb] text-black' : (theme === 'dark' ? 'bg-[#e7e7e5] text-black' : 'bg-[#111827] text-white')}`}
              >
                M
              </button>
              <div className={`text-[11px] ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'} font-mono`}>{s.gainDb ?? 0} dB</div>
            </div>
          </div>
        ))}
        
      </div>
    </div>
  );
}
