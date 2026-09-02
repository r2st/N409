import { problems, type ApiProblem } from '@n409/shared';

/**
 * "Xero is not connected", and the two situations it was the whole answer to.
 *
 * Five handlers across the three connector families — accounting, HRIS and cap
 * table — guard their pull, import and schedule routes with the same line:
 *
 *     if (!connection || connection.status === 'revoked')
 *       throw problems.unprocessable(`${LABELS[provider]} is not connected`);
 *
 * Four words, no remedy, and — in the handler directly above one of them — a
 * sentence explaining that an importer has not shipped yet and what will happen
 * when it does. That gap inside a single handler is the finding rather than the
 * wording itself (R350, methodology M19): the terse one is the refusal an
 * analyst actually hits, because it is what a *stale tab* gets.
 *
 * The predicate is two situations, and telling them apart is the point:
 *
 *   - `!connection` — nothing was ever connected here. The remedy is to
 *     connect it, and the only thing missing from the old message is where.
 *   - `revoked` — it *was* connected and somebody disconnected it. `revoked` is
 *     terminal and is written by nothing except an explicit disconnect (see
 *     `revokeConnection`, whose `status <> 'revoked'` guard every other writer
 *     on the row now carries). So this is a lost race with a colleague, or with
 *     the reader's own earlier click, and "is not connected" describes it in a
 *     way that invites them to go looking for a connect button on a card that
 *     is telling them the same four words. Naming the disconnect is what says
 *     the state is deliberate and that reconnecting means a fresh authorisation
 *     rather than a retry.
 *
 * `where` is per-family because the three panels are on three different tabs,
 * and "connect it" without a destination is the half of the message R262 kept
 * finding missing: before shipping a remedy, find the control it names.
 */
export function notConnected(
  providerLabel: string,
  panel: { tab: string; panel: string },
  status: string | undefined,
): ApiProblem {
  const where = connectorPanelPath(panel);
  return problems.unprocessable(
    status === 'revoked'
      ? `${providerLabel} was disconnected from this engagement, so there is no authorisation left ` +
          `to use. Connect it again under ${where} — a disconnect clears the stored credentials, so ` +
          'this is a fresh authorisation rather than a retry.'
      : `${providerLabel} is not connected to this engagement, so there is nothing to read from. ` +
          `Connect it under ${where} first.`,
    { connection_status: status ?? 'absent' },
  );
}

/**
 * Where each family's connect control lives, named as the reader sees it.
 *
 * `tab` is the word on the tab in `ValuationWorkspace`; `panel` is the heading
 * over the connect control on it. Both are quoted exactly, because of what the
 * reader does with the phrase they were handed: they search the page for it.
 * All three entries used to be paraphrases — the tab is "Cap Table" and this
 * said "Cap table"; the headings are "Live sync", "HRIS / payroll sync" and
 * "Accounting integrations" against a remedy that said "Sync", "HRIS sync" and
 * "Accounting". A near miss fails that search as completely as a wrong name
 * does, and what the reader concludes is that the control is not there.
 *
 * `test/unit/remedyControlLabels.test.ts` holds each half to the frontend's
 * source, so a tab rename or a heading rewrite fails there rather than quietly
 * turning these back into paraphrases.
 */
export const CONNECTOR_PANELS = {
  accounting: { tab: 'Documents', panel: 'Accounting integrations' },
  hris: { tab: 'Grants', panel: 'HRIS / payroll sync' },
  capTable: { tab: 'Cap Table', panel: 'Live sync' },
} as const;

/** The remedy phrase — `Documents → Accounting integrations`. */
export function connectorPanelPath(panel: { tab: string; panel: string }): string {
  return `${panel.tab} → ${panel.panel}`;
}
