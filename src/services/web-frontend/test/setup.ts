import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { clearToken } from '../src/lib/api';

/**
 * Testing Library's own wait budget, which `testTimeout` in the Vite config
 * does not cover: every `findBy*` and `waitFor` gives up after 1s by default,
 * whatever the test timeout says.
 *
 * That was enough for a bare run and not for `--coverage`, which puts twelve
 * v8-instrumented workers on twelve cores. A `findBy` that waits on a lazily
 * imported route plus a settled fetch would occasionally cross 1s under that
 * load, and a *different* test failed on each run — the same shape of problem
 * the `testTimeout` bump already documents, one layer down. A suite whose
 * red/green depends on machine load is not measuring the code.
 *
 * Raising it costs nothing on a passing wait — the poll returns as soon as the
 * assertion holds — and only lets a genuinely failing one take longer to say so.
 */
configure({ asyncUtilTimeout: 5000 });

// Node 26 defines an experimental globalThis.localStorage that is inert
// (undefined) without --localstorage-file and shadows jsdom's implementation.
// Replace it with a real in-memory Storage for tests.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  // Reset the in-memory session token (module state) between tests.
  clearToken();
});
