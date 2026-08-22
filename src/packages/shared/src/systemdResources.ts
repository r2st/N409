/**
 * The memory ceilings a unit declares, and the rules a unit in this estate has
 * to satisfy before it is installed.
 *
 * ## The gap this closes
 *
 * Until round 99 not one unit in `infra/systemd/` or `infra/backup/` set a
 * `MemoryMax`. Every N409 process could grow until the *host* ran out, at which
 * point the kernel's global OOM killer picks a victim by heuristic — and the
 * heuristic's favourite target is the largest RSS on the box, which is not
 * necessarily the process that misbehaved. On 204.168.241.124 the largest RSS
 * belongs to an unrelated product, and the second largest is PostgreSQL: the
 * two processes a leak in the report service would be most likely to kill.
 *
 * That was survivable while every N409 process was small and flat. Round 98
 * ended it. `renderReportPdf` moved off the API's event loop onto the report
 * unit, and in doing so removed the bound nobody had designed: pdfkit is
 * synchronous, so in-process renders were strictly serial and the working set
 * was one render's worth no matter how many clients asked. Delegating makes
 * them concurrent — up to `MAX_DELEGATED_IN_FLIGHT + MAX_DELEGATED_QUEUED` of
 * them — and the report unit's measured cost is about 10MB of retained working
 * set per render in flight. The service's memory is now a function of load,
 * on a 3.8GB host with swap already touched.
 *
 * ## What is being asserted, and why it is three directives rather than one
 *
 * `MemoryMax` alone is not a bound on a unit's footprint. In cgroup v2 it caps
 * pages resident in RAM; anonymous pages pushed to swap are accounted
 * separately by `memory.swap.max`, which defaults to unlimited. A leaking
 * process under an unswapped `MemoryMax` therefore stays under its limit
 * indefinitely while filling the host's 2GB of swap and thrashing every other
 * tenant — the exact host-wide harm the limit was set to prevent, with the
 * limit reporting compliance the whole time. So `MemorySwapMax` is required
 * too, and the real ceiling of a unit is the sum of the two.
 *
 * `MemoryHigh` is required for the opposite reason: without it the only thing
 * that ever happens is the kill. `MemoryHigh` is the throttle — over it the
 * kernel reclaims aggressively and the cgroup slows down, which is a signal
 * (visible as `MemoryHigh` pressure and as latency) some distance before the
 * process dies. A unit with `MemoryMax` and no `MemoryHigh` has one behaviour,
 * SIGKILL, and no warning before it.
 *
 * It is deliberately *not* required that a swap allowance be zero. Zero is the
 * tempting answer for a latency-sensitive service — a swapped Node heap is an
 * outage that reports as healthy — but combined with `MemoryHigh` it converts
 * the throttle into a stall: over `MemoryHigh`, with no swap to reclaim
 * anonymous pages into, a heap-heavy process can only be squeezed by evicting
 * file pages, so it grinds instead of degrading and systemd sees a unit that is
 * still `active`. A small non-zero allowance gives reclaim somewhere to go and
 * keeps the ceiling a number you can add up.
 */

/** The memory directives of a `[Service]`, in bytes. `null` = not set. */
export interface UnitMemory {
  /** `Type=` — `oneshot` units do not run alongside the always-on estate. */
  type: string | null;
  /** `MemoryAccounting=`, lowercased, as written. */
  accounting: string | null;
  high: MemorySize | null;
  max: MemorySize | null;
  swapMax: MemorySize | null;
}

/** A parsed size. `infinity` and unparseable values are distinguishable. */
export interface MemorySize {
  /** The text as written in the unit, for messages. */
  raw: string;
  /** Bytes, or `null` when the value is `infinity` or could not be read. */
  bytes: number | null;
  kind: 'bytes' | 'infinity' | 'percent' | 'unparseable';
}

/** systemd's size suffixes. K is 1024, not 1000 — see systemd.syntax(7). */
const SUFFIXES: Record<string, number> = {
  '': 1,
  B: 1,
  K: 1024,
  KB: 1024,
  M: 1024 ** 2,
  MB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1024 ** 3,
  T: 1024 ** 4,
  TB: 1024 ** 4,
};

/**
 * Read a systemd memory size.
 *
 * A percentage is legal systemd and is reported as its own kind rather than
 * resolved: {@link memoryLimitFaults} refuses it, because the estate ceiling is
 * a sum and a percentage makes that sum a property of whichever host the units
 * land on rather than of the units.
 */
export function parseMemorySize(raw: string): MemorySize {
  const text = raw.trim();
  if (text.toLowerCase() === 'infinity') return { raw: text, bytes: null, kind: 'infinity' };
  if (/^\d+(\.\d+)?%$/.test(text)) return { raw: text, bytes: null, kind: 'percent' };
  const match = /^(\d+)\s*([A-Za-z]*)$/.exec(text);
  if (!match) return { raw: text, bytes: null, kind: 'unparseable' };
  const suffix = (match[2] ?? '').toUpperCase();
  const factor = SUFFIXES[suffix];
  if (factor === undefined) return { raw: text, bytes: null, kind: 'unparseable' };
  return { raw: text, bytes: Number(match[1]) * factor, kind: 'bytes' };
}

/** Human-readable bytes, in the units the unit files are written in. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${bytes}B`;
}

/**
 * Pull the memory directives out of a unit file.
 *
 * Last assignment wins, and an empty assignment resets to unset — systemd's
 * rule for a directive that a drop-in wants to clear. Only `[Service]` is read;
 * these directives mean nothing anywhere else, and a `MemoryMax=` under
 * `[Unit]` is a typo that should read as absent rather than as a limit.
 */
export function parseUnitMemory(text: string): UnitMemory {
  const out: UnitMemory = { type: null, accounting: null, high: null, max: null, swapMax: null };
  let section = '';
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1] ?? '';
      continue;
    }
    if (section !== 'Service') continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    switch (key) {
      case 'Type':
        out.type = value === '' ? null : value.toLowerCase();
        break;
      case 'MemoryAccounting':
        out.accounting = value === '' ? null : value.toLowerCase();
        break;
      case 'MemoryHigh':
        out.high = value === '' ? null : parseMemorySize(value);
        break;
      case 'MemoryMax':
        out.max = value === '' ? null : parseMemorySize(value);
        break;
      case 'MemorySwapMax':
        out.swapMax = value === '' ? null : parseMemorySize(value);
        break;
      default:
        break;
    }
  }
  return out;
}

/** systemd's spellings of "off". Anything else enables accounting. */
const FALSEY = new Set(['no', 'false', '0', 'off']);

/**
 * The rules every `.service` this estate installs has to satisfy.
 *
 * Returned as messages rather than thrown, because the caller collects them
 * across the whole install set and a deploy should report all of them at once.
 */
export function memoryLimitFaults(resources: UnitMemory): string[] {
  const faults: string[] = [];

  if (resources.accounting !== null && FALSEY.has(resources.accounting)) {
    faults.push(
      `MemoryAccounting=${resources.accounting} switches off the accounting every limit below depends ` +
        'on — the directives stay in the file and stop being enforced. Remove the line or set it to yes.',
    );
  }

  const required: [keyof UnitMemory & ('high' | 'max' | 'swapMax'), string, string][] = [
    [
      'max',
      'MemoryMax',
      "without it a leak in this unit is answered by the kernel's global OOM killer, which picks its " +
        'victim by size rather than by blame — on this host that is PostgreSQL or an unrelated product',
    ],
    [
      'high',
      'MemoryHigh',
      'without it the unit has exactly one memory behaviour, SIGKILL at MemoryMax, and no throttling ' +
        'or pressure signal before it',
    ],
    [
      'swapMax',
      'MemorySwapMax',
      'MemoryMax bounds resident pages only, so without this a leak settles into swap, stays under its ' +
        'limit for ever and thrashes the host it was supposed to be isolated from',
    ],
  ];

  for (const [field, name, why] of required) {
    const size = resources[field];
    if (size === null) {
      faults.push(`${name} is not set — ${why}.`);
      continue;
    }
    if (size.kind === 'infinity') {
      faults.push(`${name}=infinity is the default written out; it bounds nothing — ${why}.`);
      continue;
    }
    if (size.kind === 'percent') {
      faults.push(
        `${name}=${size.raw} is a percentage of whatever host the unit lands on. The estate's ceiling is ` +
          "checked as a sum against the host's RAM, which a percentage makes circular. State an absolute size.",
      );
      continue;
    }
    if (size.kind === 'unparseable' || size.bytes === null) {
      faults.push(`${name}=${size.raw} is not a size systemd will read.`);
    }
  }

  const high = resources.high?.bytes ?? null;
  const max = resources.max?.bytes ?? null;
  const swap = resources.swapMax?.bytes ?? null;
  if (high !== null && max !== null && high >= max) {
    faults.push(
      `MemoryHigh=${resources.high!.raw} is not below MemoryMax=${resources.max!.raw} — a throttle at or ` +
        'above the kill threshold never engages, so the unit is back to having one behaviour.',
    );
  }

  // The estate writes MemorySwapMax at a quarter of MemoryMax: enough for
  // reclaim under MemoryHigh to have somewhere to put cold anonymous pages, and
  // not enough for the unit to spend its life paged out. The check is at a
  // half rather than at the quarter so that a considered exception does not
  // need to argue with this file, while the shape that has no defence — a swap
  // allowance in the region of the RAM ceiling, which lets a service run
  // mostly out of swap and report as healthy the whole time — is refused.
  if (swap !== null && max !== null && swap > max / 2) {
    faults.push(
      `MemorySwapMax=${resources.swapMax!.raw} is more than half of MemoryMax=${resources.max!.raw}. ` +
        'Swap on that scale means the unit can run largely paged out, which is an outage that reports as ' +
        'healthy — every probe answers, slowly. The estate writes a quarter.',
    );
  }

  return faults;
}

/** One unit's declared ceiling, for the estate sum. */
export interface UnitCeiling {
  unit: string;
  resources: UnitMemory;
}

export interface EstateCeiling {
  /** Units that run continuously — everything that is not `Type=oneshot`. */
  alwaysOnBytes: number;
  /** The largest single oneshot; they are scheduled hours apart and never overlap. */
  largestOneshotBytes: number;
  /** What the estate can be holding at one moment: RAM ceiling plus swap ceiling. */
  totalBytes: number;
}

/**
 * Add the declared ceilings up into the number that matters: the most memory
 * this estate can be holding at any one instant.
 *
 * Always-on units are summed. The oneshots are not summed with each other —
 * `n409-backup.timer` fires at 02:00 and `n409-backup-verify.timer` at 04:00 on
 * Sundays, so at most one is running — but the largest of them *is* added,
 * because both fire while the services are up.
 *
 * Swap counts. A unit sitting at `MemoryMax` with its `MemorySwapMax` full is
 * occupying both, and the point of the sum is to be the number an operator can
 * compare against the box.
 */
export function estateCeiling(units: UnitCeiling[]): EstateCeiling {
  let alwaysOn = 0;
  let largestOneshot = 0;
  for (const { resources } of units) {
    const ceiling = (resources.max?.bytes ?? 0) + (resources.swapMax?.bytes ?? 0);
    if (resources.type === 'oneshot') largestOneshot = Math.max(largestOneshot, ceiling);
    else alwaysOn += ceiling;
  }
  return {
    alwaysOnBytes: alwaysOn,
    largestOneshotBytes: largestOneshot,
    totalBytes: alwaysOn + largestOneshot,
  };
}

/**
 * How much of the host the estate's ceilings must leave for everything else.
 *
 * This is a sanity bound, not a capacity model, and the difference is worth
 * being explicit about: a `MemoryMax` is a ceiling rather than a reservation,
 * so an estate whose ceilings sum to more than the box has is not necessarily
 * over-committed — N409's five services hold about 365MB between them against
 * the 1.6GB they are now allowed. What this catches is the two ways the numbers
 * stop meaning anything: somebody raising a limit to a value that could never
 * be honoured, and the estate being moved onto a smaller host than the one the
 * limits were sized for. Both are silent otherwise, and both end as the
 * host-wide OOM this file exists to prevent.
 *
 * 1GiB, because 204.168.241.124 is not a single-tenant box: PostgreSQL, Caddy,
 * the kernel and two unrelated products live there too.
 */
export const MIN_HOST_HEADROOM_BYTES = 1024 ** 3;

/**
 * Fault the estate when its declared ceilings do not fit the host they are
 * about to be installed on.
 *
 * `hostTotalBytes` comes from `os.totalmem()` at the call site rather than from
 * here, so the check is against the machine the deploy is running on — which,
 * for the deploy, is the machine the units will boot on.
 */
export function estateCeilingFaults(ceiling: EstateCeiling, hostTotalBytes: number): string[] {
  const headroom = hostTotalBytes - ceiling.totalBytes;
  if (headroom >= MIN_HOST_HEADROOM_BYTES) return [];
  return [
    `the units in this estate declare ceilings summing to ${formatBytes(ceiling.totalBytes)} ` +
      `(${formatBytes(ceiling.alwaysOnBytes)} always-on, plus ${formatBytes(ceiling.largestOneshotBytes)} for ` +
      `the largest scheduled job) on a host with ${formatBytes(hostTotalBytes)} of RAM. That leaves ` +
      `${formatBytes(Math.max(0, headroom))} for PostgreSQL, Caddy, the kernel and every other tenant, ` +
      `against a required ${formatBytes(MIN_HOST_HEADROOM_BYTES)}. Either the limits have been raised past ` +
      'what this box can honour, or the estate has been moved onto a smaller one.',
  ];
}
