import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import type { StateTone } from '../lib/format';
import { STATE_LABELS, STATE_TONES, KIND_LABELS } from '../lib/format';
import type { ValuationKind, ValuationState } from '../lib/types';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-bond-600 text-white hover:bg-bond-700 active:bg-bond-800 shadow-card disabled:bg-ink-300',
  secondary:
    'border border-ink-200 bg-white text-ink-800 hover:border-ink-400 hover:bg-paper-50 disabled:text-ink-300',
  ghost: 'text-ink-600 hover:bg-paper-200 hover:text-ink-900',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${buttonStyles[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  // Wire aria so screen readers announce validation errors (audit F-3 P2). The
  // control gets an id + aria-invalid + aria-describedby pointing at the error
  // (or hint) node, injected into the single child so call sites don't change.
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  let control: ReactNode = children;
  if (isValidElement(children)) {
    const child = children as ReactElement<Record<string, unknown>>;
    const props = child.props;
    const existingDescribedBy = props['aria-describedby'] as string | undefined;
    control = cloneElement(child, {
      id: (props.id as string | undefined) ?? fieldId,
      'aria-invalid': error ? true : props['aria-invalid'],
      'aria-describedby': [existingDescribedBy, describedBy].filter(Boolean).join(' ') || undefined,
    });
  }

  return (
    <label className="block">
      <span className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">{label}</span>
      {control}
      {hint && !error && (
        <span id={hintId} className="mt-1 block text-xs text-ink-400">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} className="mt-1 block text-xs font-medium text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 focus:border-bond-600 focus:ring-2 focus:ring-bond-600/20 focus:outline-none';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />;
}

const toneStyles: Record<StateTone, string> = {
  neutral: 'bg-paper-200 text-ink-600 ring-ink-200',
  progress: 'bg-sky-50 text-sky-800 ring-sky-200',
  attention: 'bg-amber-50 text-amber-800 ring-amber-200',
  success: 'bg-bond-50 text-bond-700 ring-bond-200',
  muted: 'bg-paper-200 text-ink-400 ring-ink-200 line-through decoration-ink-300',
};

export function StateBadge({ state }: { state: ValuationState }) {
  const tone = STATE_TONES[state] ?? 'neutral';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${toneStyles[tone]}`}
    >
      {STATE_LABELS[state] ?? state}
    </span>
  );
}

export function KindBadge({ kind }: { kind: ValuationKind }) {
  return (
    <span className="inline-flex items-center rounded border border-ink-200 bg-white px-2 py-0.5 font-mono text-[0.7rem] font-semibold tracking-wide text-ink-700 uppercase">
      {KIND_LABELS[kind] ?? kind}
    </span>
  );
}

export function StatCard({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-paper-300 bg-white p-5 shadow-card">
      <div className="overline text-ink-400">{label}</div>
      <div
        className={`tnum mt-2 font-display text-3xl font-semibold ${accent ? 'text-bond-600' : 'text-ink-900'}`}
      >
        {value}
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-800"
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-paper-50 px-6 py-14 text-center">
      <p className="font-display text-lg text-ink-700">{title}</p>
      {children && <div className="mt-3 text-sm text-ink-400">{children}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  // role=status + an sr-only label so non-sighted users hear the load (F-3 P3).
  return (
    <div role="status" aria-live="polite" className="flex justify-center py-16">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-ink-200 border-t-bond-600" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus-trap for overlays (audit F-3 P2). While `active`, keeps Tab/Shift+Tab
 * cycling inside the referenced element, moves focus in on activate and restores
 * it to the trigger on deactivate, and calls `onEscape` on the Esc key. Attach
 * the returned ref to the dialog container.
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  onEscape: () => void,
): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const container = ref.current;

    const focusable = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    (focusable()[0] ?? container)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        container?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreFocusRef.current?.focus?.();
    };
  }, [active, onEscape]);

  return ref;
}

/**
 * Accessible modal dialog (audit F-3 P2): `role="dialog"` + `aria-modal`, a focus
 * trap (Tab/Shift+Tab cycle within), `Esc` to close, focus moved in on open and
 * restored to the trigger on close, and a backdrop click to dismiss.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  labelledBy,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  labelledBy?: string;
  className?: string;
}) {
  const dialogRef = useFocusTrap<HTMLDivElement>(open, onClose);
  const titleId = useId();

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
        tabIndex={-1}
        className={`max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-paper-300 bg-white shadow-lift focus:outline-none ${className}`}
      >
        {title && (
          <h2
            id={titleId}
            className="border-b border-paper-200 px-5 py-4 font-display text-lg font-semibold text-ink-900"
          >
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
