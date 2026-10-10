import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import RightSidebar from './RightSidebar';
import Mixer from './Mixer';
import WavefieldPlayer from './WavefieldPlayer';
import ThreeView from './ThreeView';
import ViewportGuard from './ViewportGuard';
import { Logo } from './Logo';
import { BarChart2, Share2, Plus, Box, Rotate3D, Activity, Save, Download, Sun, Moon, Home, PenTool, Play, Pause } from 'lucide-react';
import { audioEngine } from '../lib/audioEngine';

function FolderIcon(props: any) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    </svg>
  );
}

import { DownloadExeButton } from './DownloadExeButton';
export default function Layout() {
  const { sources, receivers, L, W, H, floorMaterial, ceilMaterial, audioSourceType, poly, wallSegMats, wallMaterial, wallOpenings, view, setView, roomName, projectName, setProjectName, activeReceiverId, setActiveReceiverId, saveProject, loadProject, newProject, theme, setTheme, viewMode, setViewMode, showMixer, setShowMixer, undo, redo, past, future, isPlaying, setIsPlaying, saveLocalProject, listLocalProjects, saveNamedLocalProject, loadLocalProject, renameLocalProject, duplicateLocalProject, deleteLocalProject, recoverAutosave } = useStore();

  const hasFdtdIR = !!useStore((state) => state.fdtdImpulseBuffer);
  const recoveryDoneRef = useRef(false);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [localProjects, setLocalProjects] = useState<Awaited<ReturnType<typeof listLocalProjects>>>([]);
  const [localProjectName, setLocalProjectName] = useState('');
  useEffect(() => {
    void recoverAutosave().catch((err) => console.error('[autosave] recovery failed; starting from the current project', err)).finally(() => { recoveryDoneRef.current = true; });
  }, [recoverAutosave]);

  const refreshLocalProjects = async () => {
    try { setLocalProjects(await listLocalProjects()); } catch (err) { console.error('[projects] could not list saved projects', err); setLocalProjects([]); }
  };

  const openProjectManager = async () => {
    await refreshLocalProjects();
    setProjectManagerOpen(true);
  };

  const createLocalProject = async () => {
    const name = localProjectName.trim() || projectName || 'Untitled Project';
    await saveNamedLocalProject(name);
    setLocalProjectName('');
    await refreshLocalProjects();
  };

  useEffect(() => {
    if (!recoveryDoneRef.current) return;
    const timer = window.setTimeout(() => { void saveLocalProject().catch((err) => console.error('[autosave] FAILED — recent changes are not saved to this device', err)); }, 1200);
    return () => window.clearTimeout(timer);
  }, [projectName, roomName, L, W, H, JSON.stringify(poly), JSON.stringify(sources), JSON.stringify(receivers), JSON.stringify(wallSegMats), JSON.stringify(wallOpenings), wallMaterial, floorMaterial, ceilMaterial, saveLocalProject]);

  useEffect(() => {
    if (isPlaying) {
      const activeReceiver = receivers.find(r => r.id === activeReceiverId) || receivers[0];
      audioEngine.play(sources, activeReceiver, L, W, audioSourceType, poly, wallSegMats, wallMaterial, wallOpenings, H, floorMaterial, ceilMaterial);
    } else {
      audioEngine.stop();
    }
  }, [isPlaying, activeReceiverId, L, W, audioSourceType]);
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeReceiverId) setActiveReceiverId(null);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeReceiverId, setActiveReceiverId, undo, redo]);

  return (
    <div className={`h-screen w-full flex flex-col ${theme === 'dark' ? 'bg-[#141517] text-[#e7e7e5]' : 'bg-[#f0f2f5] text-[#111827]'} overflow-hidden font-sans`}>
      <div className={`h-12 border-b ${theme === 'dark' ? 'border-[#2a2c30] bg-[#1a1b1e]' : 'border-[#e5e7eb] bg-[#ffffff]'} flex items-center px-3 md:px-4 justify-between shrink-0 gap-2`}>
        <div className="flex items-center text-xs font-semibold space-x-2 md:space-x-4 min-w-0">
          <div className="hidden sm:flex items-center space-x-2 shrink-0">
            <a href="/" className={`flex items-center gap-2 font-bold hover:opacity-80 transition-opacity ${theme === 'dark' ? "text-white" : "text-black"}`}>
              <Logo className="w-4 h-4" />
              <span className="uppercase tracking-wide">Cavity</span>
            </a>
          </div>
          {false ? (null) : (
            <div className={`flex items-center space-x-2 min-w-0 overflow-hidden ${theme === 'dark' ? 'text-[#83868c]' : 'text-[#6b7280]'}`}>
              <button aria-label="Go to dashboard" onClick={() => setView('dashboard')} className="hover:text-[#2563eb] transition-colors shrink-0"><Home size={14}/></button>
              <span className="hidden md:inline">{'>'}</span>
              <span className="hidden md:inline truncate">{projectName}</span>
              <span className="hidden md:inline">{'>'}</span>
              <span className="truncate">{roomName}</span>
              <span className="shrink-0">{'>'}</span>
              <b className={`${theme === 'dark' ? 'text-white' : 'text-black'} flex items-center shrink-0`}><Activity size={14} className="mr-1"/> {view === 'results' ? 'Results' : 'Auralizer'}</b>
            </div>
          )}
        </div>
        <div className="flex items-center space-x-2 md:space-x-3 shrink-0">
          
          <div className={`w-px h-4 mx-1 ${theme === 'dark' ? 'bg-[#2a2c30]' : 'bg-gray-200'}`}></div>
          
          {isPlaying && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded mr-1 uppercase tracking-wider ${hasFdtdIR ? 'bg-[#2563eb]/10 text-[#2563eb] border border-[#2563eb]/30' : 'bg-orange-500/10 text-blue-400 border border-orange-500/30'}`}>
              {hasFdtdIR ? 'FDTD Acoustic Simulation' : 'Real-Time Acoustic Approximation'}
            </span>
          )}
          <button onClick={() => setIsPlaying(!isPlaying)} className={`p-1 rounded flex items-center gap-1 ${isPlaying ? 'text-[#2563eb]' : (theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black')}`} title={isPlaying ? 'Stop Sound' : 'Play Sound'}>{isPlaying ? <Pause size={16} fill={'currentColor'} /> : <Play size={16} fill={'currentColor'} />}</button>

          <div className={`w-px h-4 mx-1 ${theme === 'dark' ? 'bg-[#2a2c30]' : 'bg-gray-200'}`}></div>
          <button aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className={`p-1 rounded ${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'}`}> 
             {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button disabled={past?.length === 0} onClick={undo} className={`hidden sm:inline-flex p-1 rounded ${past?.length > 0 ? (theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black') : 'opacity-30 cursor-not-allowed'}`} title="Undo (Ctrl+Z)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/></svg></button>
          <button disabled={future?.length === 0} onClick={redo} className={`hidden sm:inline-flex p-1 rounded ${future?.length > 0 ? (theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black') : 'opacity-30 cursor-not-allowed'}`} title="Redo (Ctrl+Y)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7"/></svg></button>
          
          <DownloadExeButton compact className="hidden lg:flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold bg-emerald-600/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-600/30 transition-all shrink-0" />
          <button onClick={openProjectManager} className={`hidden md:flex items-center px-2 py-1 rounded text-xs transition-colors shrink-0 ${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'}`} title="Local Projects">
            <FolderIcon className="w-3.5 h-3.5 mr-1" /> Projects
          </button>
          <button onClick={loadProject} className={`hidden md:flex items-center px-2 py-1 rounded text-xs transition-colors shrink-0 ${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'}`} title="Load Project">
            <Download size={14} className="mr-1" /> Load
          </button>
          <button onClick={saveProject} className={`hidden md:flex items-center px-2 py-1 rounded text-xs transition-colors shrink-0 ${theme === 'dark' ? 'text-[#83868c] hover:text-white' : 'text-[#6b7280] hover:text-black'}`} title="Save Project">
            <Save size={14} className="mr-1" /> Save
          </button>
          <button onClick={newProject} className="flex items-center border border-[#2563eb] text-[#2563eb] px-2 md:px-3 py-1 rounded text-xs hover:bg-[#2563eb] hover:text-black transition-colors shrink-0">
            <Plus size={14} className="mr-0 md:mr-1" /> <span className="hidden md:inline">New</span>
          </button>
        </div>
      </div>
      
      <div className="flex-1 flex overflow-hidden relative">
        {false ? (null) : (
          <>
            <main className={`flex-1 relative ${theme === 'dark' ? 'bg-[#000000]' : 'bg-[#f9fafb]'}`}>
              <ViewportGuard><ThreeView /></ViewportGuard>
              {showMixer && <Mixer />}
              <WavefieldPlayer />
              
              <div className="absolute bottom-4 left-4 flex bg-black/50 backdrop-blur-md rounded overflow-hidden">
                <button 
                  onClick={() => setViewMode('2d')} 
                  className={`px-3 py-1.5 text-xs font-bold ${viewMode === '2d' ? 'bg-[#2563eb] text-black' : 'text-white hover:bg-white/10'}`}
                >
                  2D
                </button>
                <button 
                  onClick={() => setViewMode('3d')} 
                  className={`px-3 py-1.5 text-xs font-bold ${viewMode === '3d' ? 'bg-[#2563eb] text-black' : 'text-white hover:bg-white/10'}`}
                >
                  3D
                </button>
              </div>
            </main>
            
            <RightSidebar />
          </>
        )}
      </div>

      {projectManagerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Local projects">
          <div className={`w-full max-w-xl rounded-lg border shadow-2xl ${theme === 'dark' ? 'bg-[#1a1b1e] border-[#2a2c30] text-white' : 'bg-white border-gray-200 text-gray-900'}`}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-current/10">
              <div><h2 className="text-sm font-bold">Local Projects</h2><p className="text-[11px] opacity-60">Stored locally in this browser via IndexedDB.</p></div>
              <button onClick={() => setProjectManagerOpen(false)} className="text-xl leading-none opacity-60 hover:opacity-100" aria-label="Close">×</button>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex gap-2">
                <input value={localProjectName} onChange={e => setLocalProjectName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void createLocalProject(); }} maxLength={100} placeholder="Project name" className={`flex-1 rounded border px-3 py-2 text-sm outline-none ${theme === 'dark' ? 'bg-[#141517] border-[#303238]' : 'bg-gray-50 border-gray-200'}`} />
                <button onClick={() => void createLocalProject()} className="px-3 py-2 rounded bg-[#2563eb] text-black text-xs font-bold">Save Copy</button>
              </div>
              <div className="max-h-72 overflow-auto space-y-2">
                {localProjects.filter(p => p.id !== 'autosave').map(p => (
                  <div key={p.id} className={`flex items-center gap-2 rounded border p-2 ${theme === 'dark' ? 'border-[#2a2c30]' : 'border-gray-200'}`}>
                    <button onClick={() => void loadLocalProject(p.id).then(ok => { if (ok) setProjectManagerOpen(false); })} className="flex-1 text-left min-w-0">
                      <div className="text-xs font-semibold truncate">{p.name}</div><div className="text-[10px] opacity-50">Updated {new Date(p.updatedAt).toLocaleString()}</div>
                    </button>
                    <button onClick={() => { const n = window.prompt('Rename project', p.name); if (n) void renameLocalProject(p.id, n).then(refreshLocalProjects); }} className="text-[10px] px-2 py-1 rounded border opacity-70 hover:opacity-100">Rename</button>
                    <button onClick={() => void duplicateLocalProject(p.id).then(refreshLocalProjects)} className="text-[10px] px-2 py-1 rounded border opacity-70 hover:opacity-100">Duplicate</button>
                    <button onClick={() => { if (window.confirm(`Delete “${p.name}”?`)) void deleteLocalProject(p.id).then(refreshLocalProjects); }} className="text-[10px] px-2 py-1 rounded border border-red-500/40 text-red-400 opacity-80 hover:opacity-100">Delete</button>
                  </div>
                ))}
                {localProjects.filter(p => p.id !== 'autosave').length === 0 && <div className="py-8 text-center text-xs opacity-50">No saved local projects yet.</div>}
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
