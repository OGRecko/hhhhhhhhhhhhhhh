import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Logo } from './Logo';
import { Activity, Cpu, Box, Headphones, ShieldCheck, Zap, Server, ChevronRight, Check, Download } from 'lucide-react';


import { motion } from 'motion/react';

import { DownloadExeButton } from './DownloadExeButton';
export default function LandingPage() {
  const navigate = useNavigate();
  
  
  
  const handleGetStarted = () => {
    navigate('/app');
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)] text-[#ededed] font-sans">
      {/* Navigation */}
      <nav className="w-full px-8 py-6 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-base)] sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Logo className="w-5 h-5 text-white" />
          <span className="font-display font-medium text-lg tracking-tight text-white">Cavity Audio</span>
        </div>
        <div className="flex items-center gap-4">
          <DownloadExeButton compact className="hidden sm:flex items-center gap-1.5 text-xs font-semibold text-emerald-400 border border-emerald-500/40 px-3 py-1.5 rounded-full bg-emerald-500/10 hover:bg-emerald-500/20 transition-all shadow-sm" />
          <button 
            onClick={handleGetStarted}
            className="bg-white text-black px-5 py-2 rounded-full text-sm font-medium hover:bg-neutral-200 transition-colors shadow-sm"
          >
            Open App
          </button>
        </div>
      </nav>

      {/* Hero Section */}
            <section className="px-6 pt-24 pb-32 max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
        <div>
          <motion.h1 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="font-display text-5xl md:text-6xl font-medium tracking-tight mb-8 leading-[1.1] max-w-4xl text-white"
          >
            Deterministic Acoustic Simulation Engine
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-lg md:text-xl max-w-xl mb-12 leading-relaxed text-gray-400"
          >
            A deterministic acoustic simulation engine with 3D room modeling, source-backed speaker data when available, and explicitly labeled modeled acoustic results.
          </motion.p>
          
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex flex-wrap gap-4"
          >
            <button 
              onClick={handleGetStarted}
              className="px-8 py-3.5 rounded bg-white text-black font-medium text-sm transition-colors hover:bg-gray-200 flex items-center gap-2"
            >
              Launch Simulator <ChevronRight size={16} />
            </button>
            <DownloadExeButton className="px-6 py-3.5 rounded border border-emerald-500/50 bg-emerald-500/10 text-emerald-300 font-medium text-sm transition-colors hover:bg-emerald-500/20 flex items-center gap-2" />
          </motion.div>
        </div>

        {/* Professional Graphic CSS/SVG */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.4, duration: 0.8, ease: "easeOut" }}
          className="relative w-full aspect-square md:aspect-[4/3] rounded border border-[#2a2c30] bg-[#141517] overflow-hidden flex items-center justify-center p-8"
        >
          {/* Background grid */}
          <div className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(#2a2c30 1px, transparent 1px), linear-gradient(90deg, #2a2c30 1px, transparent 1px)', backgroundSize: '40px 40px', opacity: 0.3 }} />
          
          <div className="relative w-full h-full border border-[#2a2c30] bg-[#0d0e0f] rounded shadow-2xl flex flex-col">
            {/* Fake App Header */}
            <div className="h-8 border-b border-[#2a2c30] flex items-center px-4 justify-between bg-[#1a1b1e]">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-[#3a3d42]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#3a3d42]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[#3a3d42]" />
              </div>
              <div className="text-[9px] font-bold text-gray-500 tracking-widest uppercase">FDTD Solver active</div>
            </div>
            {/* Fake App Body */}
            <div className="flex-1 p-6 relative overflow-hidden flex items-center justify-center">
               <div className="absolute top-4 left-4 flex flex-col gap-2">
                 {[4000, 2000, 1000, 500, 250, 125].map(freq => (
                   <div key={freq} className="flex items-center gap-2">
                     <span className="text-[8px] text-gray-500 w-8">{freq}Hz</span>
                     <div className="h-1 bg-[#2a2c30] w-24 rounded-full overflow-hidden">
                       <motion.div 
                         initial={{ width: 0 }}
                         animate={{ width: `${[72, 54, 68, 43, 61, 49][[4000, 2000, 1000, 500, 250, 125].indexOf(freq)]}%` }}
                         transition={{ duration: 1.5, delay: 0.5 }}
                         className="h-full bg-[#2563eb]" 
                       />
                     </div>
                   </div>
                 ))}
               </div>
               
               {/* 3D Wireframe Room Representation */}
               <svg viewBox="0 0 200 200" className="w-48 h-48 mt-8 ml-16 opacity-80" stroke="#4fa8d9" strokeWidth="1" fill="none">
                 <motion.polygon 
                   initial={{ strokeDasharray: 800, strokeDashoffset: 800 }}
                   animate={{ strokeDashoffset: 0 }}
                   transition={{ duration: 2, ease: "easeInOut" }}
                   points="50,150 150,150 170,100 70,100" 
                   stroke="#3a3d42" 
                   fill="rgba(58,61,66,0.1)" 
                 />
                 <motion.polygon points="50,150 50,70 70,20 70,100" stroke="#3a3d42" fill="rgba(58,61,66,0.15)" />
                 <motion.polygon points="50,70 150,70 170,20 70,20" stroke="#3a3d42" fill="rgba(58,61,66,0.05)" />
                 <motion.polygon points="150,150 150,70 170,20 170,100" stroke="#3a3d42" fill="rgba(58,61,66,0.2)" />
                 {/* Source / Receiver */}
                 <circle cx="90" cy="120" r="3" fill="#2563eb" />
                 <circle cx="140" cy="90" r="2" fill="#6b7280" />
                 
                 {/* Concentric sound waves */}
                 <motion.circle 
                   cx="90" cy="120" r="10" 
                   stroke="#2563eb" 
                   strokeWidth="0.5"
                   initial={{ opacity: 1, scale: 0.1 }}
                   animate={{ opacity: 0, scale: 5 }}
                   transition={{ repeat: Infinity, duration: 2 }}
                   style={{ transformOrigin: "90px 120px" }}
                 />
                 <motion.circle 
                   cx="90" cy="120" r="10" 
                   stroke="#2563eb" 
                   strokeWidth="0.5"
                   initial={{ opacity: 1, scale: 0.1 }}
                   animate={{ opacity: 0, scale: 5 }}
                   transition={{ repeat: Infinity, duration: 2, delay: 0.6 }}
                   style={{ transformOrigin: "90px 120px" }}
                 />
               </svg>
            </div>
          </div>
        </motion.div>
      </section>

      {/* Analytics / Specs Section */}
      <section className="py-32 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <div className="max-w-5xl mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="font-display text-3xl font-medium mb-6 text-white tracking-tight">Precision Data Yields Precision Decisions.</h2>
              <p className="text-gray-400 leading-relaxed mb-8 text-lg">
                Cavity Audio uses a dedicated FDTD (Finite-Difference Time-Domain) solver with explicit computational and numerical limits. Results are reported with the available data provenance rather than presented as laboratory measurements.
              </p>
              
              <ul className="space-y-4">
                {[
                  'Supported modulation-transfer analysis for STI workflows',
                  'Source-backed speaker specifications applied when available',
                  'Explicit computational verification bounds'
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-3 text-gray-300">
                    <Check size={20} className="text-white shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            
            <div className="bg-[var(--color-bg-base)] border border-[var(--color-border)] rounded p-8">
              <div className="flex items-center gap-3 mb-6 pb-6 border-b border-[var(--color-border)]">
                <Activity size={24} className="text-white" />
                <span className="font-display font-medium text-xl text-white">Solver Output</span>
              </div>
              <div className="space-y-4 font-mono text-sm text-gray-400">
                <div className="flex justify-between"><span>Grid Elements</span><span className="text-white">50,000,000 max</span></div>
                <div className="flex justify-between"><span>Spatial Step (dx)</span><span className="text-white">solver-selected</span></div>
                <div className="flex justify-between"><span>Time Step (dt)</span><span className="text-white">CFL-stable</span></div>
                <div className="flex justify-between"><span>Bandwidth (f_max)</span><span className="text-white">500 Hz</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-32 border-t border-[var(--color-border)] bg-[var(--color-bg-base)]">
        <div className="max-w-5xl mx-auto px-6">
          <div className="mb-16">
            <h2 className="font-display text-3xl font-medium mb-4 text-white tracking-tight">Strict Acoustic Modeling</h2>
            <p className="text-gray-400 text-lg max-w-2xl">Build room layouts and review supported acoustic results with explicit limits and provenance.</p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-6">
            <FeatureCard 
              icon={<Box size={24} className="text-white" />}
              title="Database Transducers"
              description="Configure PA arrays and monitors using retained speaker specifications and clearly labeled modeled/reference data."
            />
            <FeatureCard 
              icon={<ShieldCheck size={24} className="text-white" />}
              title="Provenance Reporting"
              description="Export labeled PDF reports with the simulation parameters, modeled acoustic results, and data-provenance notes."
            />
            <FeatureCard 
              icon={<Zap size={24} className="text-white" />}
              title="Real-Time Analysis"
              description="Calculate supported acoustic metrics and label unavailable metrics rather than fabricating them."
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 border-t border-[var(--color-border)] bg-[var(--color-bg-base)]">
        <div className="max-w-5xl mx-auto px-6 flex flex-col items-start gap-4">
          <div className="flex items-center gap-2 text-white">
            <Logo className="w-5 h-5 text-white" />
            <span className="font-display font-medium text-lg tracking-tight">Cavity Audio</span>
          </div>
          <p className="text-sm text-gray-500 max-w-xl">
            Designed for acoustic engineering workflows. Results are software models and estimates based on the supplied inputs and retained speaker data; unavailable measurements are not fabricated. Software is provided "as is", without warranty of any kind.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-gray-600 mt-4">
            <span>&copy; {new Date().getFullYear()} Cavity Audio Systems. All rights reserved.</span>
            <a href="/privacy.html" className="hover:text-gray-400 focus:outline-none focus:ring-2 focus:ring-white/40 rounded" aria-label="Privacy Policy">Privacy</a>
            <a href="/terms.html" className="hover:text-gray-400 focus:outline-none focus:ring-2 focus:ring-white/40 rounded" aria-label="Terms of Use">Terms</a>
            <a href="/third-party-notices.html" className="hover:text-gray-400 focus:outline-none focus:ring-2 focus:ring-white/40 rounded" aria-label="Third-party notices">Third-party notices</a>
            <a href="/LICENSE.txt" className="hover:text-gray-400 focus:outline-none focus:ring-2 focus:ring-white/40 rounded" aria-label="Software license">License</a>
          </div>
        </div>
      </footer>

      
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode, title: string, description: string }) {
  return (
    <div className="p-8 rounded bg-[var(--color-bg-surface)] border border-[var(--color-border)]">
      <div className="mb-6">
        {icon}
      </div>
      <h3 className="font-display text-xl font-medium mb-3 text-white tracking-tight">{title}</h3>
      <p className="text-gray-400 leading-relaxed">
        {description}
      </p>
    </div>
  );
}

function PricingFeature({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-3 text-gray-300">
      <Check size={20} className="text-white shrink-0" />
      <span>{text}</span>
    </li>
  );
}
