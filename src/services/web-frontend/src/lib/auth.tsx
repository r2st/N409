import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  api,
  clearToken,
  hasStoredSession,
  setToken,
  storedExpiry,
  tokenExpiry,
  UNAUTHORIZED_EVENT,
} from './api';
import type { ViewMode } from './rbac';
import type { User } from './types';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export type LoginResult = { mfaRequired: false } | { mfaRequired: true; challenge: string };

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /**
   * Admin / normal-user view toggle (admin-role-management feature B). Lives in
   * React state only — never persisted — so it resets on refresh, logout and in
   * new tabs. A temporary preview, not a stored setting.
   */
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  /**
   * Password step. Resolves to `{ mfaRequired: false }` and signs the user in,
   * or `{ mfaRequired: true, challenge }` when the account has 2FA — the caller
   * then collects a code and calls `verifyMfa` with the challenge.
   */
  login: (email: string, password: string) => Promise<LoginResult>;
  /** Second factor: redeem the login challenge with a TOTP or backup code. */
  verifyMfa: (input: {
    challenge: string;
    code?: string;
    backupCode?: string;
    rememberDevice?: boolean;
  }) => Promise<void>;
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
  const [status, setStatus] = useState<AuthStatus>(() => (hasStoredSession() ? 'loading' : 'anonymous'));
  const [viewMode, setViewMode] = useState<ViewMode>('admin');

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setStatus('anonymous');
    // Never carry a "normal view" preview across sign-outs.
    setViewMode('admin');
    // Clear the httpOnly session cookie server-side (audit F-2). Fire-and-forget
    // and outside api() so a 401 can't recurse into another logout.
    void fetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
  }, []);

  // Restore the session from the httpOnly cookie on first load (the marker tells
  // us a session may exist; /auth/me confirms it via the cookie).
  useEffect(() => {
    if (!hasStoredSession()) return;
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

  /*
   * Bumped by every path that puts a new token in hand, so the sign-out timer
   * below is rescheduled around it.
   *
   * The token is module state in `api.ts`, which React cannot observe: the
   * timer effect re-ran on `status`, and replacing a token does not change the
   * status — the user was signed in before and is signed in after. So the two
   * flows that swap a token in place, changing a password and signing out
   * other sessions, left the timer pointed at the *replaced* token's expiry.
   * The server had just minted a full-lifetime successor and the marker in
   * localStorage had already been updated to its expiry, so a reload read the
   * new one correctly while the open tab signed itself out at the old one —
   * and the flow that did it most visibly is the one where a user deliberately
   * ends their other sessions and gets their own ended minutes later.
   */
  const [tokenEpoch, setTokenEpoch] = useState(0);

  /**
   * The single place a token is stored. `setToken` alone is not enough — see
   * `tokenEpoch`.
   */
  const storeToken = useCallback((token: string) => {
    setToken(token);
    setTokenEpoch((n) => n + 1);
  }, []);

  // The API issues fixed-lifetime JWTs (no refresh endpoint yet), so schedule
  // a clean sign-out at expiry instead of letting requests start failing.
  useEffect(() => {
    if (status !== 'authenticated') return;
    // In-memory token has the exact exp; after a reload only the marker remains.
    const exp = tokenExpiry() ?? storedExpiry();
    if (!exp) return;
    const ms = exp - Date.now();
    if (ms <= 0) {
      logout();
      return;
    }
    const timer = window.setTimeout(logout, ms);
    return () => window.clearTimeout(timer);
  }, [status, tokenEpoch, logout]);

  const adopt = useCallback(
    async (token: string, known?: User) => {
      storeToken(token);
      const me = known ?? (await api<{ user: User }>('/auth/me')).user;
      setUser(me);
      setStatus('authenticated');
    },
    [storeToken],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const res = await api<{ user: User; token: string } | { mfa_required: true; challenge: string }>(
        '/auth/login',
        { method: 'POST', body: { email, password } },
      );
      if (!('token' in res)) {
        return { mfaRequired: true, challenge: res.challenge };
      }
      await adopt(res.token, res.user);
      return { mfaRequired: false };
    },
    [adopt],
  );

  const verifyMfa = useCallback(
    async (input: { challenge: string; code?: string; backupCode?: string; rememberDevice?: boolean }) => {
      const res = await api<{ user: User; token: string }>('/auth/mfa/verify', {
        method: 'POST',
        body: {
          challenge: input.challenge,
          code: input.code,
          backup_code: input.backupCode,
          remember_device: input.rememberDevice,
        },
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

  const replaceToken = useCallback((token: string) => storeToken(token), [storeToken]);

  const value = useMemo(
    () => ({
      status,
      user,
      viewMode,
      setViewMode,
      login,
      verifyMfa,
      register,
      adoptToken,
      setUser,
      replaceToken,
      logout,
    }),
    [status, user, viewMode, login, verifyMfa, register, adoptToken, replaceToken, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
