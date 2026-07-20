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

export interface Column<T> {
  /** Stable key; also used as the React key for the cell. */
  key: string;
  header: ReactNode;
  /** Cell renderer; defaults to `String(row[key])`. */
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Extra classes on the <td>/<th> (e.g. column width, hide-on-mobile). */
  className?: string;
}

const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/**
 * Shared semantic table primitive (audit F-4 P3): each list page re-implemented
 * its own `<table>`. One accessible table (scoped `<th>`, optional caption, an
 * empty-state row) that scrolls horizontally inside its own container so the
 * page body never scrolls sideways on mobile.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty = 'Nothing to show.',
  onRowClick,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  caption?: string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-paper-300 text-left">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`px-3 py-2.5 text-xs font-semibold tracking-wide text-ink-500 uppercase ${alignClass[col.align ?? 'left']} ${col.className ?? ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-ink-400">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`border-b border-paper-200 last:border-0 ${
                  onRowClick ? 'cursor-pointer hover:bg-paper-50' : ''
                }`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-2.5 text-ink-800 ${alignClass[col.align ?? 'left']} ${col.className ?? ''}`}
                  >
                    {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Total number of pages for `total` items at `pageSize` (min 1). */
export function pageCountOf(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Shared pagination control (audit F-4 P3). 1-indexed; disables Prev/Next at the
 * ends and renders as a labelled <nav> so it's reachable by assistive tech.
 */
export function Pagination({
  page,
  pageCount,
  onPage,
  className = '',
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  const clamped = Math.min(Math.max(page, 1), pageCount);
  return (
    <nav aria-label="Pagination" className={`flex items-center justify-between gap-4 text-sm ${className}`}>
      <Button
        variant="secondary"
        onClick={() => onPage(clamped - 1)}
        disabled={clamped <= 1}
        aria-label="Previous page"
      >
        Previous
      </Button>
      <span aria-live="polite" className="text-ink-500">
        Page {clamped} of {pageCount}
      </span>
      <Button
        variant="secondary"
        onClick={() => onPage(clamped + 1)}
        disabled={clamped >= pageCount}
        aria-label="Next page"
      >
        Next
      </Button>
    </nav>
  );
}

const toastTone = {
  success: 'border-bond-200 bg-bond-50 text-bond-800',
  error: 'border-red-200 bg-red-50 text-red-800',
  info: 'border-ink-200 bg-white text-ink-800',
} as const;

/**
 * Lightweight controlled toast (audit F-4 P3). Announces via `role=status`
 * (errors as `alert`) and auto-dismisses after `duration` ms; the parent owns
 * visibility so it stays trivially testable without a global provider.
 */
export function Toast({
  message,
  tone = 'info',
  onDismiss,
  duration = 4000,
}: {
  message: ReactNode;
  tone?: keyof typeof toastTone;
  onDismiss?: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (!onDismiss || duration <= 0) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [onDismiss, duration, message]);

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-lift ${toastTone[tone]}`}
    >
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="rounded p-0.5 text-current/60 hover:text-current"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l14 14M19 5L5 19" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
