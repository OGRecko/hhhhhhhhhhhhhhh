import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Smartphone, X } from 'lucide-react';
import { useStore } from '../store/useStore';

export function RotateDevicePrompt() {
  const [isPortrait, setIsPortrait] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const { theme } = useStore();

  useEffect(() => {
    const checkOrientation = () => {
      const portrait = window.innerHeight > window.innerWidth;
      const mobile = window.innerWidth < 768 || window.innerHeight < 768;
      
      setIsPortrait(portrait);
      setIsMobile(mobile);
      
      // Auto-reset dismissal if they rotate back to portrait later
      if (!portrait) {
        setDismissed(false);
      }
    };

    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    
    // Some mobile browsers fire orientationchange
    window.addEventListener('orientationchange', checkOrientation);
    
    return () => {
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
  }, []);

  const shouldShow = isPortrait && isMobile && !dismissed;

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center p-6 text-center backdrop-blur-md \${theme === 'dark' ? 'bg-[#0a0a0c]/90 text-white' : 'bg-white/90 text-black'}`}
        >
          <button 
            onClick={() => setDismissed(true)}
            className="absolute top-6 right-6 p-2 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
          >
            <X size={24} />
          </button>

          <motion.div
            animate={{ rotate: [-90, 0, -90] }}
            transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
            className="mb-8"
          >
            <Smartphone size={80} strokeWidth={1} className={theme === 'dark' ? 'text-[#2563eb]' : 'text-[#2563eb]'} />
          </motion.div>
          
          <h2 className="text-3xl font-display font-medium mb-4 tracking-tight">Rotate your device</h2>
          <p className="text-lg mb-8 max-w-sm opacity-70">
            For the best acoustic simulation and layout experience, please use your device in landscape mode.
          </p>
          
          <button 
            onClick={() => setDismissed(true)}
            className="px-6 py-3 rounded-full bg-[#2563eb] text-black font-bold text-sm hover:bg-[#1d4ed8] transition-colors"
          >
            Continue Anyway
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
