import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
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

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
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
  const set = (t: ThemePref) => {
    try {
      localStorage.setItem('pai-theme', t);
    } catch {
      /* ignore */
    }
    setPref(t);
  };
  return [pref, set];
}
