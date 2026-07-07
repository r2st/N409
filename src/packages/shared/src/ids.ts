import { ulid } from 'ulid';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** ULID primary keys, matching the current platform's `01K…` id scheme. */
export function newUlid(): string {
  return ulid();
}

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}
