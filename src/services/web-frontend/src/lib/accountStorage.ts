/**
 * Which browser-storage keys belong to the signed-in account, and clearing them
 * when that account signs out.
 *
 * Sign-out cleared exactly one key — `n409.token`, the session marker — because
 * that is the one that decides whether the app thinks a session exists. Every
 * other key the app writes stayed where it was, and two of them are about the
 * client rather than the browser:
 *
 *   * `n409.company_hint` is the company name typed into the registration form,
 *     kept so the first engagement's "Company legal name" field is pre-filled.
 *     It is removed when that engagement is created and otherwise never, so on
 *     a shared machine the next person to reach New valuation is looking at the
 *     previous account's client, already typed into the field.
 *   * `n409.onboarding.draft` holds the wizard's place: the engagement id, the
 *     company legal name and the file names already uploaded. It is
 *     sessionStorage and expires after a day, so it dies with the tab — but a
 *     sign-out and a sign-in are not a new tab, and the wizard reads its draft
 *     on mount without asking who is looking.
 *
 * The other half of the inventory is deliberately kept. A theme, a folded nav
 * section and a cookie-consent choice are facts about this browser, and
 * clearing them at sign-out would be a bug of its own — the next visit would be
 * back to the default theme and the consent banner would ask again, which is
 * the one answer GDPR expects to be remembered.
 *
 * So both lists are written down, and `accountStorage.test.ts` holds every
 * `n409` key literal in the source to membership of exactly one of them: a new
 * key is classified by whoever adds it, at the moment they know which it is.
 */

/**
 * Keys holding something about the signed-in account or its clients. Removed
 * from both storages on sign-out.
 */
export const ACCOUNT_SCOPED_KEYS: readonly string[] = [
  // The session marker itself. `clearToken` also removes it; listing it here
  // makes this function correct on its own rather than by convention.
  'n409.token',
  // A client's company name, typed at registration.
  'n409.company_hint',
  // Engagement id, company legal name, uploaded file names (sessionStorage).
  'n409.onboarding.draft',
  // How far this account got through the checklist, and whether they hid it.
  'n409.getting-started.done',
  'n409.getting-started.dismissed',
  // Which command-palette entries this account used. Ids, not names — but
  // "they were in the partner admin" is still theirs and not the next user's.
  'n409.palette.recent',
];

/**
 * Keys about the browser rather than the account, with the reason each stays.
 * Prefix entries end in `.` and cover every key beneath them.
 */
export const DEVICE_SCOPED_KEYS: ReadonlyArray<{ key: string; why: string }> = [
  { key: 'n409.theme', why: 'A display preference for this browser, not a fact about the account.' },
  {
    key: 'n409.nav.',
    why: 'Which sidebar sections are folded. Per browser; re-expanding them all at sign-out is a regression, not a protection.',
  },
  {
    key: 'n409-cookie-consent',
    why: 'The visitor’s own consent choice. Clearing it would re-ask a question they have already answered — the one thing consent storage exists to avoid.',
  },
];

/**
 * Remove every account-scoped key from both storages.
 *
 * Never throws: Safari in private mode throws on storage access, and a sign-out
 * that fails halfway is worse than one that could not tidy up. Both storages
 * are swept for every key — the two are small enough that asking which one a
 * key lives in is more to keep right than it is worth.
 */
export function clearAccountScopedStorage(): void {
  for (const store of [safeStore(() => localStorage), safeStore(() => sessionStorage)]) {
    if (!store) continue;
    for (const key of ACCOUNT_SCOPED_KEYS) {
      try {
        store.removeItem(key);
      } catch {
        // One unreadable key must not stop the rest from being cleared.
      }
    }
  }
}

function safeStore(get: () => Storage): Storage | null {
  try {
    return get();
  } catch {
    return null;
  }
}
