/**
 * Which marketability discounts are derived from a volatility.
 *
 * Pure, and deliberately a mirror of the engine's `dlom.py`:
 * `MODEL_DLOM_METHODS` there, `MODEL_DLOM_METHODS` here. The engine is the
 * authority on what actually runs; this exists so the platform's own
 * pre-dispatch checks — the health checks and the QA gate — can ask the same
 * question without each spelling out a list.
 *
 * Both of them used to spell it inline as `method === 'chaffee' || method ===
 * 'finnerty'`, and both were already wrong by two methods: Ghaidarov and
 * Longstaff are equally volatility-derived, so a run selecting one of those
 * with no volatility set got no warning that its discount would come back as
 * zero. A weighted blend (migration 0129) would have slipped past in the same
 * way, and for the worse reason — a blend's model leg contributes silently
 * nothing rather than making the whole discount zero, so the failure is a
 * plausible-looking number rather than an obvious one.
 */

/** Derived from a volatility and a holding period; needs `inputs.volatility`. */
export const MODEL_DLOM_METHODS = ['chaffee', 'finnerty', 'ghaidarov', 'longstaff'] as const;
export type ModelDlomMethod = (typeof MODEL_DLOM_METHODS)[number];

export function isModelDlomMethod(method: unknown): method is ModelDlomMethod {
  return typeof method === 'string' && (MODEL_DLOM_METHODS as readonly string[]).includes(method);
}

/** One weighted leg, as `valuation_params.dlom_methods` stores it. */
interface DlomLegLike {
  method?: unknown;
  weight?: unknown;
}

/**
 * Whether these params ask for a discount that needs a volatility — through
 * either `dlom_method` or any leg of a `dlom_methods` blend.
 *
 * A malformed leg is not this predicate's business: the params route, the
 * engine's pre-flight and the engine itself each reject it with a message about
 * the leg. Here it simply does not select a model.
 */
export function selectsModelDlom(params: { dlom_method?: unknown; dlom_methods?: unknown }): boolean {
  if (isModelDlomMethod(params.dlom_method)) return true;
  const blend = params.dlom_methods;
  if (!Array.isArray(blend)) return false;
  return blend.some(
    (leg: DlomLegLike) => leg !== null && typeof leg === 'object' && isModelDlomMethod(leg.method),
  );
}

/**
 * The model methods a run's discount actually rests on, for a message that names
 * them. Empty when nothing volatility-derived was selected.
 */
export function modelDlomMethodsIn(params: {
  dlom_method?: unknown;
  dlom_methods?: unknown;
}): ModelDlomMethod[] {
  const out: ModelDlomMethod[] = [];
  if (isModelDlomMethod(params.dlom_method)) out.push(params.dlom_method);
  const blend = params.dlom_methods;
  if (Array.isArray(blend)) {
    for (const leg of blend as DlomLegLike[]) {
      if (leg !== null && typeof leg === 'object' && isModelDlomMethod(leg.method)) {
        out.push(leg.method);
      }
    }
  }
  return [...new Set(out)];
}
