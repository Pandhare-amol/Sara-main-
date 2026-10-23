import {StrictMode, lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ApiKeyGate} from './components/ApiKeyGate.tsx';
import {CrashGuard} from './components/CrashGuard.tsx';
import {isNativeApp} from './lib/serverConfig';
import './index.css';

// The phone shell is split out of the desktop bundle: desktop users never
// download it, and the phone does not download the desktop studio.
const MobileApp = lazy(() => import('./mobile/MobileApp.tsx'));

// The desktop companion window loads the same bundle with ?mode=companion and
// renders only the character, without the app shell or key gate.
const CompanionApp = lazy(() => import('./companion/CompanionApp.tsx'));

const params = new URLSearchParams(location.search);
const isCompanion = params.get('mode') === 'companion';

const UI_STORAGE = 'sara.ui.v1';

function prefersMobileShell(): boolean {
  // Native app: always the phone shell.
  if (isNativeApp()) return true;
  const forced = params.get('ui');
  if (forced === 'mobile' || forced === 'desktop') {
    try {
      window.localStorage.setItem(UI_STORAGE, forced);
    } catch {
      /* ignore */
    }
    return forced === 'mobile';
  }
  try {
    const saved = window.localStorage.getItem(UI_STORAGE);
    if (saved === 'mobile' || saved === 'desktop') return saved === 'mobile';
  } catch {
    /* ignore */
  }
  // Narrow screens or touch-first devices get the focused shell.
  const narrow = window.matchMedia?.('(max-width: 860px)')?.matches ?? false;
  const touch = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  return narrow && touch;
}

const useMobileShell = prefersMobileShell();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashGuard>
      {isCompanion ? (
        <Suspense fallback={null}>
          <CompanionApp />
        </Suspense>
      ) : useMobileShell ? (
        <ApiKeyGate>
          <Suspense
            fallback={
              <div className="flex h-[100dvh] items-center justify-center bg-[#03040a] text-[11px] uppercase tracking-[0.3em] text-white/30">
                Sara
              </div>
            }
          >
            <MobileApp />
          </Suspense>
        </ApiKeyGate>
      ) : (
        <ApiKeyGate>
          <App />
        </ApiKeyGate>
      )}
    </CrashGuard>
  </StrictMode>,
);
