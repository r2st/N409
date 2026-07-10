import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, clearToken, getToken, setToken, tokenExpiry, UNAUTHORIZED_EVENT } from './api';
import type { User } from './types';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    email: string;
    password: string;
    first_name?: string;
    last_name?: string;
  }) => Promise<void>;
  /** Complete a Google OIDC redirect: store the issued token, load the user. */
  adoptToken: (token: string) => Promise<void>;
  /** Push an updated user into context after a profile edit. */
  setUser: (user: User) => void;
  /**
   * Swap in a replacement token without re-fetching the user. Changing your
   * password or signing out other sessions invalidates the token in hand; the
   * API hands back its successor so this tab stays signed in.
   */
  replaceToken: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? 'loading' : 'anonymous'));

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setStatus('anonymous');
  }, []);

  // Restore the session from a stored token on first load.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api<{ user: User }>('/auth/me')
      .then(({ user: me }) => {
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        logout();
      });
    return () => {
      cancelled = true;
    };
  }, [logout]);

  // Any 401 anywhere in the app signs the user out.
  useEffect(() => {
    window.addEventListener(UNAUTHORIZED_EVENT, logout);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, logout);
  }, [logout]);

  // The API issues fixed-lifetime JWTs (no refresh endpoint yet), so schedule
  // a clean sign-out at expiry instead of letting requests start failing.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const exp = tokenExpiry();
    if (!exp) return;
    const ms = exp - Date.now();
    if (ms <= 0) {
      logout();
      return;
    }
    const timer = window.setTimeout(logout, ms);
    return () => window.clearTimeout(timer);
  }, [status, logout]);

  const adopt = useCallback(async (token: string, known?: User) => {
    setToken(token);
    const me = known ?? (await api<{ user: User }>('/auth/me')).user;
    setUser(me);
    setStatus('authenticated');
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<{ user: User; token: string }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      await adopt(res.token, res.user);
    },
    [adopt],
  );

  const register = useCallback(
    async (input: { email: string; password: string; first_name?: string; last_name?: string }) => {
      const res = await api<{ user: User; token: string }>('/auth/register', {
        method: 'POST',
        body: input,
      });
      await adopt(res.token, res.user);
    },
    [adopt],
  );

  const adoptToken = useCallback(async (token: string) => adopt(token), [adopt]);

  const replaceToken = useCallback((token: string) => setToken(token), []);

  const value = useMemo(
    () => ({ status, user, login, register, adoptToken, setUser, replaceToken, logout }),
    [status, user, login, register, adoptToken, replaceToken, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
