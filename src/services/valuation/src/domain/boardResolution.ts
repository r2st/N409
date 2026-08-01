/**
 * Board resolution generation + approval status (feature 5). Pure functions —
 * no I/O — so the document rendering and the "is the board done?" rule are unit
 * testable in isolation.
 */

export type BoardResolutionStatus = 'pending' | 'approved' | 'rejected';
export type BoardSignoffStatus = 'pending' | 'signed' | 'rejected';

/** Event types for the audit spine — kept local (not in domain/valuation.ts) to avoid merge churn. */
export const BOARD_EVENT_TYPES = {
  resolutionGenerated: 'board_resolution_generated',
  memberAdded: 'board_member_added',
  memberRemoved: 'board_member_removed',
  resolutionSent: 'board_resolution_sent',
  signoffRecorded: 'board_signoff_recorded',
  resolutionApproved: 'board_resolution_approved',
  resolutionRejected: 'board_resolution_rejected',
} as const;

export interface ResolutionInput {
  companyName: string;
  valuationKind: string;
  valuationDate: string; // ISO date
  fmvConclusion: number;
  currency: string;
  methodologySummary: string;
  appraiserQualifications: string;
  /** ULID / reference number shown for auditor traceability. */
  reference: string;
}

/** Minimal HTML escaper — resolution text is analyst-authored but rendered to a browser. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatMoney(amount: number, currency: string): string {
  // Per-share FMV can carry cents; keep up to 4 dp but trim trailing zeros.
  const fixed = amount.toFixed(4).replace(/\.?0+$/, '');
  return `${currency} ${fixed}`;
}

function formatDate(iso: string): string {
  // Render in a locale-stable long form without depending on Date.now().
  const [y, m, d] = iso.slice(0, 10).split('-');
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const monthName = months[Number(m) - 1] ?? m;
  return `${monthName} ${Number(d)}, ${y}`;
}

/**
 * Render the board resolution body. Kind-agnostic wording that names the 409A
 * safe-harbor adoption explicitly so the document doubles as the audit artifact.
 */
export function renderBoardResolution(input: ResolutionInput): string {
  const fmv = formatMoney(input.fmvConclusion, input.currency);
  const date = formatDate(input.valuationDate);
  const company = escapeHtml(input.companyName);
  return [
    `<h1>Resolution of the Board of Directors of ${company}</h1>`,
    `<p>Adopting the Fair Market Value of the Common Stock</p>`,
    `<p><strong>Valuation reference:</strong> ${escapeHtml(input.reference)}</p>`,
    `<p><strong>Valuation date:</strong> ${escapeHtml(date)}</p>`,
    `<p><strong>Report type:</strong> ${escapeHtml(input.valuationKind.toUpperCase())}</p>`,
    `<p>WHEREAS, the Board of Directors (the “Board”) of ${company} (the “Company”) has ` +
      `determined that it is in the best interests of the Company to establish the fair market ` +
      `value of the Company’s common stock for purposes of granting equity awards in compliance ` +
      `with Section 409A of the Internal Revenue Code;</p>`,
    `<p>WHEREAS, the Board engaged an independent appraiser to prepare a valuation of the ` +
      `Company’s common stock as of ${escapeHtml(date)};</p>`,
    `<h2>Methodology</h2>`,
    `<p>${escapeHtml(input.methodologySummary)}</p>`,
    `<h2>Appraiser qualifications</h2>`,
    `<p>${escapeHtml(input.appraiserQualifications)}</p>`,
    `<h2>Resolution</h2>`,
    `<p>NOW, THEREFORE, BE IT RESOLVED, that the Board hereby adopts and approves a fair market ` +
      `value of <strong>${escapeHtml(fmv)} per share</strong> of the Company’s common stock as of ` +
      `${escapeHtml(date)}, and determines that this valuation was made reasonably and in good ` +
      `faith so as to establish the presumption of reasonableness under Treasury Regulation ` +
      `§1.409A-1(b)(5)(iv)(B);</p>`,
    `<p>RESOLVED FURTHER, that the officers of the Company are authorized to grant equity awards ` +
      `with an exercise price no less than the fair market value adopted herein until such time as ` +
      `this determination is no longer valid.</p>`,
  ].join('\n');
}

/**
 * Aggregate status from the member sign-offs. Any rejection rejects the whole
 * resolution; approval requires at least one member and every member signed.
 */
export function resolutionStatusFrom(signoffs: Array<{ status: BoardSignoffStatus }>): BoardResolutionStatus {
  if (signoffs.some((s) => s.status === 'rejected')) return 'rejected';
  if (signoffs.length > 0 && signoffs.every((s) => s.status === 'signed')) return 'approved';
  return 'pending';
}

export const DEFAULT_APPRAISER_QUALIFICATIONS =
  'The valuation was prepared by a qualified independent appraiser with significant experience ' +
  'valuing the securities of privately held companies, in accordance with the AICPA Practice Aid ' +
  '“Valuation of Privately-Held-Company Equity Securities Issued as Compensation.”';
