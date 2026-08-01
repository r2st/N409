import { brandLogo, useBranding } from '../lib/branding';

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--color-chrome-900)" />
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

/**
 * The platform mark, or the tenant's logo where one is set. `light` means the
 * mark sits on dark chrome — the ground the dark logo variant exists for.
 */
export function BrandMark({ size = 30, light = false }: { size?: number; light?: boolean }) {
  const branding = useBranding();
  const logo = brandLogo(branding, light ? 'dark' : 'light');
  if (!logo) return <LogoMark size={size} />;
  return (
    <img
      src={logo}
      alt=""
      aria-hidden="true"
      // Firms supply whatever they have — square marks and wide lockups alike —
      // so height is fixed and width is left to the asset, up to a sane cap.
      style={{ height: size, maxWidth: size * 4 }}
      className="object-contain"
    />
  );
}

export function Wordmark({ light = false }: { light?: boolean }) {
  const branding = useBranding();
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark size={30} light={light} />
      <span
        className={`font-display text-xl font-semibold tracking-tight ${light ? 'text-chrome-fg' : 'text-ink-900'}`}
      >
        {branding.name}
        {branding.tagline && (
          <span className="ml-2 align-middle text-[0.62rem] font-sans font-semibold tracking-[0.18em] text-brass-400 uppercase">
            {branding.tagline}
          </span>
        )}
      </span>
    </span>
  );
}
