import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionInfo } from '@shared/api';
import { get, onUnauthorized } from './api';

interface SessionContextValue {
  session: SessionInfo | null;
  refresh: () => Promise<SessionInfo | null>;
}

const SessionContext = createContext<SessionContextValue>({ session: null, refresh: async () => null });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const refresh = useCallback(async () => {
    try {
      const s = await get<SessionInfo>('/api/session');
      setSession(s);
      return s;
    } catch {
      const fallback: SessionInfo = { authenticated: false, setupRequired: false, needsUser: false, version: '', features: { rag: false } };
      setSession(fallback);
      return fallback;
    }
  }, []);
  useEffect(() => {
    void refresh();
    return onUnauthorized(() => {
      setSession((s) => (s ? { ...s, authenticated: false, user: undefined } : s));
    });
  }, [refresh]);
  return <SessionContext.Provider value={{ session, refresh }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

// ------------------------------------------------------------------ theme

export type ThemePref = 'light' | 'dark' | 'system';

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

type ThemeContextValue = [ThemePref, (t: ThemePref) => void];

const ThemeContext = createContext<ThemeContextValue>(['system', () => undefined]);

export const ACCENTS = [
  { id: 'iris', label: 'Iris', swatch: '#5b3ff3' },
  { id: 'ocean', label: 'Ocean', swatch: '#1d5fe0' },
  { id: 'emerald', label: 'Emerald', swatch: '#04805a' },
  { id: 'amber', label: 'Amber', swatch: '#c2570c' },
  { id: 'rose', label: 'Rose', swatch: '#d1204f' },
] as const;
export type Accent = (typeof ACCENTS)[number]['id'];

const AccentContext = createContext<[Accent, (a: Accent) => void]>(['iris', () => undefined]);

function applyAccent(accent: Accent) {
  if (accent === 'iris') delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = accent;
}

/** One theme state for the whole app; keeps "system" in sync with the OS. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      return (localStorage.getItem('pai-theme') as ThemePref) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    apply(pref);
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  const set = useCallback((t: ThemePref) => {
    try {
      localStorage.setItem('pai-theme', t);
    } catch {
      /* ignore */
    }
    setPref(t);
  }, []);
  const value = useMemo<ThemeContextValue>(() => [pref, set], [pref, set]);

  const [accent, setAccentState] = useState<Accent>(() => {
    try {
      const saved = localStorage.getItem('pai-accent');
      return ACCENTS.some((a) => a.id === saved) ? (saved as Accent) : 'iris';
    } catch {
      return 'iris';
    }
  });
  useEffect(() => applyAccent(accent), [accent]);
  const setAccent = useCallback((a: Accent) => {
    try {
      localStorage.setItem('pai-accent', a);
    } catch {
      /* ignore */
    }
    setAccentState(a);
  }, []);
  const accentValue = useMemo<[Accent, (a: Accent) => void]>(() => [accent, setAccent], [accent, setAccent]);

  return (
    <ThemeContext.Provider value={value}>
      <AccentContext.Provider value={accentValue}>{children}</AccentContext.Provider>
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
/** Accent colour of the interface (kept in this browser). */
export const useAccent = () => useContext(AccentContext);

// ------------------------------------------------------------------ sign-out

/** Remove data of the signed-in user kept in this browser (Ask conversations and filters). */
export function clearUserData(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) if (key?.startsWith('pai-ask-')) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
