import type pg from 'pg';
import { problems } from '@n409/shared';
import type { Queryable } from '../db/pool.js';
import type { ValuationState } from './valuation.js';
import { signedAtByRole, type SignatureRole, type SignedAtByRole } from '../repos/signatures.js';
import { lockPublishGate } from '../repos/publishLock.js';
import { latestSucceededCalculation } from '../repos/calculations.js';
import { latestQaReviewForCalculation } from '../repos/qaReviews.js';
import { findReportByValuation, latestRenderedVersion, versionWrittenAt } from '../repos/reports.js';

/**
 * Publish gating, called by every path that can set the state — the workflow
 * routes, bulk actions, review decisions, and the direct PATCH.
 *
 * 1. Signature (remaining-gaps §3 #3): no valuation enters 'published'
 *    without a Signature (main) on file.
 * 2. QA (IMPROVEMENTS_RESEARCH §4.3): when the valuation has a successful
 *    calculation, its LATEST calculation must carry a non-failing QA review.
 *    A recalculation invalidates the previous review by construction — the
 *    review is keyed to the calculation it examined.
 * 3. The report body that review graded must still be the current one. The
 *    review grades two independent things and only the first of them used to be
 *    identified: `runQa` opens the report and checks it for dead exhibit
 *    references, unexplained approaches, frozen figures and chapters still
 *    carrying the skeleton's instructions — and a `PUT /report` afterwards
 *    replaces that body without touching anything rule 2 reads. So a document
 *    edited after its review published over a review of prose no longer in it.
 * 4. And the body the analyst *signed* must still be the current one, which is
 *    rule 3's argument applied to the stronger of the two attestations (R304,
 *    methodology M3). Rules 2 and 3 both hold that an attestation is about the
 *    artifact it was given against, and a QA review is pinned to both — the
 *    calculation by `qa_reviews.calculation_id`, the prose by
 *    `qa_reviews.report_version`. A signature was pinned to nothing. It is a
 *    single row per role that `upsertSignature` replaces in place, and its
 *    whole state machine was absent/present: once a `main` row existed, rule 1
 *    was satisfied for every body the engagement ever went on to hold.
 *
 *    Which is not a theoretical ordering. `domain/reportSignatures.ts` states
 *    the intended one — "the signature lands later, after QA closes, and may be
 *    replaced … re-signing after a change supersedes the previous row" — so the
 *    product already expects a re-sign after an edit, and simply never asked
 *    for one. Sign, then correct a chapter, then re-run QA (which passes rules
 *    2 and 3, being keyed to the new version), then publish: the deliverable
 *    goes out with a certification page reading "/s/ …, Date signed
 *    2026-08-01" over a body written on the 15th. That page is USPAP SR 10-3's
 *    signed certification and the §409A safe harbour's named qualified
 *    appraiser; an auditor holding the PDF can see the two dates and cannot see
 *    that the platform did not mind.
 *
 *    Asked of `report_versions.created_at` rather than `reports.updated_at`:
 *    the version row is written when a body is, and `updated_at` moves for
 *    bookkeeping the analyst did not sign anything about. The remedy is one
 *    click of the control that already exists, and the message says so — after
 *    rule 3's, because re-signing before the re-review is the wrong order and
 *    the operator would land back here.
 *
 * 5. And the *conclusion* the analyst signed must still be the one the
 *    deliverable states (R372, methodology M3). Rule 4's argument stops where
 *    the prose stops: the figures are render-time markers resolved against the
 *    newest calculation, so re-running the engine restates the concluded value
 *    without writing a report version — the only thing rule 4 can see.
 *
 *    Rules 4 and 5 are asked of **every** signatory on file, not only `main`
 *    (R380, methodology M3) — the certification page prints a dated line per
 *    role. See {@link staleSignatureRefusal}.
 *
 * 6. And the bytes that will be *served* as the deliverable must be of the
 *    body the gate just passed (R448, methodology M3). Rules 2–5 are all asked
 *    of `reports.current_version`, and none of them is what a reader gets.
 *    R327 pinned every outside door of a published engagement — `report.pdf`,
 *    the auditor portal, the evidence bundle, the partner API — to the newest
 *    version carrying stored PDF bytes (`deliverableVersion`), on the reading
 *    that the version somebody rendered is the version that was issued. `POST
 *    /report/render` stores bytes in any state, and "Render PDF" is on the
 *    report tab throughout drafting. So: render v3 to look at it, correct a
 *    chapter (v4), re-run QA against v4, re-sign after v4, publish — rules 2–5
 *    pass, and from that moment every reader is handed v3: a body the QA
 *    review did not grade and the signature does not cover, rendered before
 *    either existed, with the certification page as it stood at the time. The
 *    version history shows v3 with bytes and v4 without, and nothing else
 *    says. Refused with the same remedy as rules 3 and 4 — one click of the
 *    control that exists. An engagement with no stored bytes at all is not
 *    this case: the lazy render on first download issues the current body,
 *    which `reportPostPublishEdit.test.ts` pins.
 *
 * Runs on the pool or on a transaction's client. Both readings matter and they
 * are not the same reading — see {@link assertPublishGateForWrite}.
 */
export async function assertPublishGate(
  db: Queryable,
  valuationId: string,
  to: ValuationState,
): Promise<void> {
  if (to !== 'published') return;
  const signedAt = await signedAtByRole(db, valuationId);
  if (signedAt.main === null) {
    throw problems.conflict('A main signature is required before publishing — sign the valuation first');
  }

  /*
   * Loaded once for rules 3 and 4, and before the QA block rather than inside
   * it: the calculation check below has nothing to say about an engagement that
   * never ran one, and such an engagement still has a signed body somebody can
   * have edited.
   */
  const report = await findReportByValuation(db, valuationId);

  const calculation = await latestSucceededCalculation(db, valuationId);
  // Nothing calculated — nothing for QA to judge, so rules 2 and 3 do not
  // apply. Rule 4 still does, which is why this is a skip and not a return.
  if (calculation) {
    const review = await latestQaReviewForCalculation(db, calculation.id);
    if (!review) {
      throw problems.conflict('Quality gate: run a QA review of the latest calculation before publishing');
    }
    if (review.status === 'fail') {
      throw problems.conflict(
        'Quality gate: the latest QA review failed — resolve the failing checks and re-run QA before publishing',
      );
    }

    /*
     * Rule 3. Only when there is a report: an engagement with none has no body
     * to have graded, which is the same reading `runQa` files as a null.
     *
     * A null `report_version` beside a report that exists is a review filed
     * before the column did, and is read as "does not say" rather than as "did
     * not change". Refused, because the column answers a compliance question
     * and an unknown is not a yes — the remediation is one QA re-run and the
     * message names it.
     *
     * `>` rather than `!==`: a revert moves `current_version` forwards too (it
     * writes the restored content as a *new* version), so there is no direction
     * in which the pointer goes back, and an inequality that could fire on a
     * lower number would only be describing a state that cannot arise.
     */
    if (report && (review.report_version === null || report.current_version > review.report_version)) {
      throw problems.conflict(
        'Quality gate: the report body has been edited since the last QA review — re-run QA before publishing',
      );
    }
  }

  /*
   * Rule 5. The conclusion the analyst signed must still be the conclusion the
   * deliverable states (R372, methodology M3).
   *
   * Rule 4 is the same argument about the prose, and it stops exactly where the
   * prose stops. The figures are not in the body: `{{figures}}`, `{{exhibits}}`
   * and `{{signatures}}` are markers the stored chapters keep, and the render
   * resolves them — `routes/reports.ts` loads `latestCalculationForKind` on the
   * way to the PDF and builds the summary page, the exhibit schedules and the
   * concluded FMV out of whatever run is newest at that instant. So the equity
   * value and the per-share figure on a signed report are late-bound in a way
   * the chapters are not, and re-running the engine restates them without
   * writing a report version, which is the only thing rule 4 can see.
   *
   * Which leaves the ordinary correction sequence open: sign, notice a wrong
   * input, recompute, re-run QA — rules 2 and 3 both pass, being keyed to the
   * new run and to a body nobody touched — then publish. The certification page
   * prints "/s/ …, Date signed" against a concluded value the signer never saw,
   * and it is the value that matters most: USPAP SR 10-3 certifies the analyses
   * and the opinion, not the paragraphs around them, and the §409A safe
   * harbour turns on an appraiser having concluded *this* number.
   *
   * The newest succeeded run of any shape, which is the row rule 2 already
   * grades, rather than the report's own `latestCalculationForKind`. On a 409A
   * engagement they are the same row. On a specialty one an off-kind run does
   * not move the deliverable's figures, so this refuses a publish the
   * deliverable would have survived — the conservative direction, and the one
   * rule 2 already takes about the same row.
   *
   * Before rule 4's `if (!report) return`, because an engagement with no report
   * body still has a conclusion: `routes/auditorPortal.ts` and the partner API
   * both serve `equity_value` / `fmv_per_share` off that same latest run to
   * readers outside the firm.
   */
  if (calculation) {
    const stale = staleSince(signedAt, calculation.created_at);
    if (stale.length > 0) {
      throw staleSignatureRefusal(stale, 'The valuation has been recalculated', 'an earlier conclusion');
    }
  }

  /*
   * Rule 4, and last on purpose.
   *
   * An analyst who edits a signed, reviewed body has two things to redo, and
   * they have an order: re-run QA over the new prose, then sign what QA
   * cleared. A gate that named the signature first would send them to sign a
   * body no reviewer had read, and they would be back here a moment later.
   *
   * A version row with no `created_at` is not reachable — the column is NOT
   * NULL with a default — so a null here means the pointer names a version that
   * is not there, which is a broken report rather than an unsigned edit, and is
   * left to the routes that read the body to fail on.
   */
  if (!report) return;
  const writtenAt = await versionWrittenAt(db, report.id, report.current_version);
  if (writtenAt === null) return;
  const stale = staleSince(signedAt, writtenAt);
  if (stale.length > 0) {
    throw staleSignatureRefusal(stale, 'The report body has been edited', 'an earlier draft');
  }

  // Rule 6. Same shape as rule 3: `<` rather than `!==`, because a version
  // newer than the current pointer cannot exist.
  const rendered = await latestRenderedVersion(db, report.id);
  if (rendered !== null && rendered < report.current_version) {
    throw problems.conflict(
      `The report body has been edited since it was last rendered — v${rendered} is the version ` +
        `readers would be handed, and v${report.current_version} is the one this gate has checked. ` +
        `Render the current version before publishing.`,
    );
  }
}

/** The signatories whose attestation predates `at`. `main` first, as the page prints them. */
function staleSince(signedAt: SignedAtByRole, at: Date): SignatureRole[] {
  const roles: SignatureRole[] = ['main', 'second'];
  return roles.filter((role) => {
    const when = signedAt[role];
    return when !== null && at.getTime() > when.getTime();
  });
}

/**
 * The refusal for rules 4 and 5, naming whose signature has gone stale.
 *
 * BOTH SIGNATORIES ARE ON THE PAGE, AND ONLY ONE WAS ON THE GATE (round 380,
 * methodology M3). R304 and R372 established the rule these two checks apply —
 * an attestation is about the artifact it was given against — and both read
 * `main` alone, because `mainSignedAt` was the only reader this module had.
 *
 * `valuation_signatures` holds a row per role and the deliverable prints every
 * one of them: `domain/reportSignatures.ts` builds the certification table with
 * a "Date signed" column and labels the second row **Concurring reviewer**,
 * whose own comment says the label exists so an auditor does not read two
 * signatures as two independent appraisals. It is a firm quality-control
 * attestation on a USPAP SR 10-3 certification page, under a date.
 *
 * So the sequence rule 4 was written to stop was still open one row over: both
 * sign, the analyst corrects a chapter, re-runs QA (rules 2 and 3 pass, being
 * keyed to the new version) and re-signs — which satisfies rule 4 as it stood —
 * and publishes. The concurring reviewer's line goes out dated before the body
 * it certifies, and nothing in the product minded.
 *
 * The second signature is optional (rule 1 asks only for `main`), so it is
 * held to currency rather than to existence, and the remedy has the two arms
 * that follows from: have them re-sign, or remove the row. Both are controls
 * that already exist on the Signatures panel, named here as that panel labels
 * them.
 */
function staleSignatureRefusal(stale: readonly SignatureRole[], change: string, certifies: string): Error {
  if (stale.length === 1 && stale[0] === 'second') {
    return problems.conflict(
      `${change} since the second signature was given — that signature on file certifies ${certifies}, ` +
        'and it is printed on the report’s certification page under the date it was given. Have the ' +
        'second signatory re-sign, or remove their signature on the Signatures panel, before publishing.',
    );
  }
  if (stale.length > 1) {
    return problems.conflict(
      `${change} since it was signed — both signatures on file certify ${certifies}. Re-sign the ` +
        'valuation, and have the second signatory re-sign or remove their signature on the ' +
        'Signatures panel, before publishing.',
    );
  }
  return problems.conflict(
    `${change} since it was signed — the signature on file certifies ${certifies}. ` +
      'Re-sign the valuation before publishing.',
  );
}

/**
 * The gate as a precondition of the write, rather than as a question asked
 * beforehand.
 *
 * `assertPublishGate` on the pool decides nothing durable: it reads on one
 * connection and the caller writes `state` on another, so every row the gate
 * consulted is free to change in between. It did. A `DELETE
 * /valuations/:id/signatures/main` concurrent with a publish left the
 * engagement `published` with no main signature on file — the gate had seen the
 * signature, and the route deleting it refuses only once the valuation is
 * already published, which the publisher had not yet made true. Reproduced on
 * five runs in six; see test/integration/publishGateRace.test.ts.
 *
 * Passed as `patchValuation`'s `preCommit`, this runs on the client that is
 * about to issue the UPDATE, under a lock the signature and QA writers also
 * take. So the reading the state change is justified by is a reading nothing
 * can invalidate before that state change commits.
 *
 * The pool-side call stays, and is not redundant: it fails an unsignable
 * publish before a transaction and a lock are taken, and it is the call that
 * produces the 409 an operator sees in the ordinary, uncontended case.
 */
export function assertPublishGateForWrite(
  valuationId: string,
  to: ValuationState,
): (client: pg.PoolClient) => Promise<void> {
  return async (client) => {
    if (to !== 'published') return;
    await lockPublishGate(client, valuationId);
    await assertPublishGate(client, valuationId, to);
  };
}
