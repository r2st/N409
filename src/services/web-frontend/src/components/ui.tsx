import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import type { StateTone } from '../lib/format';
import { STATE_LABELS, STATE_TONES, KIND_LABELS } from '../lib/format';
import type { ValuationKind, ValuationState } from '../lib/types';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-bond-600 text-white hover:bg-bond-700 active:bg-bond-800 shadow-card disabled:bg-ink-300',
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
  return (
    <label className="block">
      <span className="mb-1.5 block text-[0.8rem] font-semibold text-ink-700">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
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

export function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-ink-200 border-t-bond-600" />
    </div>
  );
}
