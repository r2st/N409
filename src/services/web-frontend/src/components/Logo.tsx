export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--color-ink-900)" />
      <path
        d="M9 22V10l8 8V10"
        stroke="var(--color-brass-400)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="22.5" cy="20.5" r="2.6" fill="var(--color-bond-500)" />
    </svg>
  );
}

export function Wordmark({ light = false }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={30} />
      <span
        className={`font-display text-xl font-semibold tracking-tight ${light ? 'text-paper-50' : 'text-ink-900'}`}
      >
        N409
        <span className="ml-2 align-middle text-[0.62rem] font-sans font-semibold tracking-[0.18em] text-brass-400 uppercase">
          Valuations
        </span>
      </span>
    </span>
  );
}
