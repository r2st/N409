import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Cookie-consent state (409.ai §25 / GDPR). Persisted to localStorage so the
 * banner only appears on first visit, and read by the analytics loader so
 * tracking scripts run only after an explicit "accept".
 */
export type ConsentValue = 'granted' | 'denied';
export type ConsentState = ConsentValue | null;

export const CONSENT_STORAGE_KEY = 'n409-cookie-consent';

/** Read the stored decision. Returns null when unset or storage is unavailable. */
export function readStoredConsent(storage: Storage | undefined = safeStorage()): ConsentState {
  try {
    const raw = storage?.getItem(CONSENT_STORAGE_KEY);
    return raw === 'granted' || raw === 'denied' ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredConsent(value: ConsentValue, storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.setItem(CONSENT_STORAGE_KEY, value);
  } catch {
    /* storage disabled (private mode / SSR) — consent stays in-memory only */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export interface ConsentContextValue {
  consent: ConsentState;
  /** True until the visitor has made a choice (banner should show). */
  needsChoice: boolean;
  accept: () => void;
  decline: () => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

export function ConsentProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [consent, setConsent] = useState<ConsentState>(() => readStoredConsent());

  const accept = useCallback(() => {
    writeStoredConsent('granted');
    setConsent('granted');
  }, []);

  const decline = useCallback(() => {
    writeStoredConsent('denied');
    setConsent('denied');
  }, []);

  const value = useMemo<ConsentContextValue>(
    () => ({ consent, needsChoice: consent === null, accept, decline }),
    [consent, accept, decline],
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

export function useConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error('useConsent must be used within a ConsentProvider');
  return ctx;
}
