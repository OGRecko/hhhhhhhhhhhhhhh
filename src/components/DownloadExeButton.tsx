import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

interface ReleaseInfo { available: boolean; version?: string; file?: string; size?: number; url?: string }
type State = { status: 'loading' } | { status: 'ready'; info: ReleaseInfo } | { status: 'unavailable' };

/** Green "Download EXE" button. Only enabled when the server confirms a built Windows EXE exists. */
export function DownloadExeButton({ className, compact = false }: { className: string; compact?: boolean }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/release/windows', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((info: ReleaseInfo) => { if (!cancelled) setState(info.available && info.url && info.file ? { status: 'ready', info } : { status: 'unavailable' }); })
      .catch(() => { if (!cancelled) setState({ status: 'unavailable' }); });
    return () => { cancelled = true; };
  }, []);

  const label = compact ? 'Download EXE' : 'Download Windows EXE';
  if (state.status === 'ready') {
    const mb = state.info.size ? ` · ${(state.info.size / 1048576).toFixed(0)} MB` : '';
    return (
      <a href={state.info.url} download={state.info.file} className={className}
         title={`Download ${state.info.file} (Windows installer, v${state.info.version}${mb})`}>
        <Download size={compact ? 13 : 16} /><span>{label}</span>
      </a>
    );
  }
  return (
    <span aria-disabled="true" className={`${className} opacity-50 cursor-not-allowed pointer-events-none`}
          title={state.status === 'loading' ? 'Checking for Windows build…' : 'Windows EXE has not been built yet (run npm run release:windows)'}>
      {state.status === 'loading' ? <Loader2 size={compact ? 13 : 16} className="animate-spin" /> : <Download size={compact ? 13 : 16} />}
      <span>{state.status === 'loading' ? 'Checking…' : 'EXE not built'}</span>
    </span>
  );
}
