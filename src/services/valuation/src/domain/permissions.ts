import {
  CLIENT_ROLES,
  OPS_ROLES,
  PARTNER_ROLES,
  ROLE_KEYS,
  USER_ADMIN_ROLES,
  type RoleKey,
} from './roles.js';

/**
 * The capability matrix — what each of the eighteen roles is allowed to do,
 * stated once, in a form that can be read.
 *
 * `auth/rbac.ts` already decides this correctly. What it does not do is say so
 * anywhere a person can look: the answer to "what can a `data_supervisor`
 * actually do" was six exported predicates spread across the file, each with
 * its own inlined role set, and the only way to find out was to read all of
 * them. That is fine for a policy the code enforces and nobody has to
 * administer. It is not fine for one where an admin assigns roles from a
 * dropdown of eighteen names, because they are choosing without being told
 * what they are choosing.
 *
 * So this is a description of the existing policy, not a second one. Every
 * entry here is asserted against the rbac predicate it describes
 * (test/unit/permissions.test.ts) — if the two ever disagree, the build fails
 * rather than the matrix quietly becoming a lie. Where a capability has no
 * predicate, the matrix is the definition and rbac has nothing to contradict.
 */

export interface CapabilityDef {
  key: string;
  label: string;
  /** What granting this actually lets someone do, in one sentence. */
  description: string;
  roles: readonly RoleKey[];
}

const OPS = [...OPS_ROLES] as RoleKey[];
const USER_ADMIN = [...USER_ADMIN_ROLES] as RoleKey[];
const PARTNER = [...PARTNER_ROLES] as RoleKey[];
const CLIENT = [...CLIENT_ROLES] as RoleKey[];

export const CAPABILITIES: readonly CapabilityDef[] = [
  {
    key: 'valuations.read.all',
    label: 'See every engagement',
    description: 'Read any engagement on the platform, regardless of who owns it.',
    roles: OPS,
  },
  {
    key: 'valuations.read.partner',
    label: "See the firm's engagements",
    description: "Read every engagement belonging to the user's own partner firm, and no others.",
    roles: PARTNER,
  },
  {
    key: 'valuations.read.own',
    label: 'See own engagements',
    description: 'Read only the engagements the user is themselves the client on.',
    roles: CLIENT,
  },
  {
    key: 'valuations.create',
    label: 'Start an engagement',
    description: 'Open a new engagement. Everyone with any scope at all can do this within it.',
    roles: [...OPS, ...PARTNER, ...CLIENT],
  },
  {
    key: 'working_data.edit',
    label: 'Edit the model',
    description:
      'Change workbook cells, overwrites and report content — the analyst tooling. Clients and ' +
      'partner staff never see the model internals.',
    roles: OPS,
  },
  {
    key: 'report.read.draft',
    label: 'Read an unpublished report',
    description:
      'See the deliverable before it is shared. Outside ops the report appears only once a draft ' +
      'has been issued.',
    roles: OPS,
  },
  {
    key: 'users.manage',
    label: 'Administer users',
    description: 'Create, edit, promote, demote and delete users, and assign roles.',
    roles: USER_ADMIN,
  },
  {
    key: 'partners.manage',
    label: 'Administer partner firms',
    description: 'Create and edit partner firms, their subdomains, commercial terms and API tokens.',
    roles: USER_ADMIN,
  },
  {
    key: 'branding.manage.own',
    label: 'Edit own white-label branding',
    description:
      "Change the firm's own logo, colours and subdomain. `member` is deliberately excluded — it is " +
      'the ordinary seat inside a firm, not its administrator.',
    roles: ['partner'],
  },
  {
    key: 'communications.manage',
    label: 'Edit templates and campaigns',
    description: 'Author email/SMS templates and the automated campaigns that send them.',
    roles: OPS,
  },
  {
    key: 'jobs.read',
    label: 'Watch the job queue',
    description: 'See background work — pipeline runs, AI jobs, outbound mail, webhook deliveries.',
    roles: OPS,
  },
  {
    key: 'inbox.read',
    label: 'Use the shared inbox',
    description: 'Read and reply to engagement threads across every engagement in scope.',
    roles: [...OPS, ...PARTNER],
  },
  {
    key: 'billing.alerts',
    label: 'Hear about money going wrong',
    description:
      'Receive refund, chargeback and failed-renewal alerts. Deliberately the smallest set that ' +
      'can act on one.',
    roles: USER_ADMIN,
  },
  {
    key: 'settings.manage',
    label: 'Change platform settings',
    description: 'Edit system settings, SSO configuration and retention policy.',
    roles: USER_ADMIN,
  },
];

const CAPABILITIES_BY_ROLE: ReadonlyMap<RoleKey, ReadonlySet<string>> = (() => {
  const map = new Map<RoleKey, Set<string>>(ROLE_KEYS.map((r) => [r, new Set<string>()]));
  for (const cap of CAPABILITIES) {
    for (const role of cap.roles) map.get(role)?.add(cap.key);
  }
  return map;
})();

/**
 * Whether any of the principal's roles carries the capability.
 *
 * `ignored` short-circuits to false whatever else the user holds. It is the
 * one role that subtracts: a user who has been ignored keeps their other role
 * rows (so restoring them is one delete, not a re-grant), and a union that
 * ignored that would hand a suspended admin their console back.
 */
export function hasCapability(principal: { roles: readonly RoleKey[] }, capability: string): boolean {
  if (principal.roles.includes('ignored')) return false;
  return principal.roles.some((role) => CAPABILITIES_BY_ROLE.get(role)?.has(capability) ?? false);
}

/** Every capability a role carries — what the admin UI shows next to its name. */
export function capabilitiesForRole(role: RoleKey): string[] {
  return [...(CAPABILITIES_BY_ROLE.get(role) ?? [])].sort();
}

/** The union across a principal's roles, for `GET /me/capabilities`. */
export function capabilitiesFor(principal: { roles: readonly RoleKey[] }): string[] {
  if (principal.roles.includes('ignored')) return [];
  const out = new Set<string>();
  for (const role of principal.roles) {
    for (const cap of CAPABILITIES_BY_ROLE.get(role) ?? []) out.add(cap);
  }
  return [...out].sort();
}

export type RoleScope = 'ops' | 'partner' | 'client' | 'none';

export function scopeOfRole(role: RoleKey): RoleScope {
  if (role === 'ignored') return 'none';
  if (OPS_ROLES.has(role)) return 'ops';
  if (PARTNER_ROLES.has(role)) return 'partner';
  if (CLIENT_ROLES.has(role)) return 'client';
  // `auditor` — read-only external access, granted per engagement through the
  // auditor portal rather than by valuation scope.
  return 'none';
}

export interface RoleDef {
  key: RoleKey;
  label: string;
  description: string;
  scope: RoleScope;
  capabilities: string[];
}

/**
 * Human-readable descriptions for the eighteen roles. These are what the
 * assignment dropdown shows; without them an admin picks between
 * `data_supervisor` and `support_supervisor` on the strength of the word
 * "supervisor".
 */
const ROLE_DESCRIPTIONS: Record<RoleKey, { label: string; description: string }> = {
  valuation_user: {
    label: 'Valuation user',
    description: 'The client. Sees their own engagements and the reports issued on them.',
  },
  admin: { label: 'Admin', description: 'Full operational and administrative access.' },
  god: {
    label: 'God',
    description: 'Admin plus the operations kept off the console — reserved for platform engineers.',
  },
  supervisor: {
    label: 'Supervisor',
    description: 'Runs the ops floor: every engagement, plus user and partner administration.',
  },
  support: {
    label: 'Support',
    description: 'Answers client questions. Reads every engagement and works the shared inbox.',
  },
  support_supervisor: {
    label: 'Support supervisor',
    description: 'Support, plus ownership of the support queue itself.',
  },
  reviewer: {
    label: 'Reviewer',
    description: 'Reviews finished work and signs it off. Full analyst tooling on every engagement.',
  },
  main_reviewer: {
    label: 'Main reviewer',
    description: 'The reviewer of record — the signature on the opinion.',
  },
  contributing_reviewer: {
    label: 'Contributing reviewer',
    description: 'Reviews alongside the main reviewer without being the signatory.',
  },
  data: {
    label: 'Data',
    description: 'Prepares the inputs: documents, cap table, financials, comparables.',
  },
  data_supervisor: { label: 'Data supervisor', description: 'Runs the data team and its queue.' },
  partner: {
    label: 'Partner',
    description:
      "A partner firm's administrator. Sees the firm's engagements and edits its white-label branding.",
  },
  member: {
    label: 'Member',
    description: "An ordinary seat inside a partner firm — the firm's engagements, no admin.",
  },
  investor: {
    label: 'Investor',
    description: 'Read-only access to the engagements they are a party to.',
  },
  auto: {
    label: 'Auto',
    description: 'The automation identity. Actions taken by the pipeline are attributed to it.',
  },
  spa: {
    label: 'SPA',
    description: 'Single-purpose service account for an integration.',
  },
  ignored: {
    label: 'Ignored',
    description: 'Suspended. Overrides every other role the user holds and grants nothing.',
  },
  auditor: {
    label: 'Auditor',
    description:
      'External auditor. Sees only what an auditor-portal grant opens, and only for as long as it lasts.',
  },
};

export const ROLE_DEFS: readonly RoleDef[] = ROLE_KEYS.map((key) => ({
  key,
  label: ROLE_DESCRIPTIONS[key].label,
  description: ROLE_DESCRIPTIONS[key].description,
  scope: scopeOfRole(key),
  capabilities: capabilitiesForRole(key),
}));
