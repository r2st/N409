import { brandLogo, useBranding } from '../lib/branding';

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <line x1="16" y1="6" x2="16" y2="2" stroke="var(--color-bond-400)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="1.5" r="1.5" fill="var(--color-bond-400)" />
      <rect x="5" y="6" width="22" height="17" rx="5" fill="var(--color-bond-400)" />
      <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="var(--color-ink-950)" />
      <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="var(--color-ink-950)" />
      <circle cx="11.5" cy="12.5" r="1" fill="var(--color-bond-200)" />
      <circle cx="21.5" cy="12.5" r="1" fill="var(--color-bond-200)" />
      <path d="M12 19Q16 22 20 19" stroke="var(--color-ink-950)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <rect x="1" y="10" width="4" height="5" rx="2" fill="var(--color-bond-500)" />
      <rect x="27" y="10" width="4" height="5" rx="2" fill="var(--color-bond-500)" />
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
  const isPlatform = !branding.white_label;
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark size={30} light={light} />
      <span
        className={`font-display text-xl font-semibold tracking-tight ${light ? 'text-chrome-fg' : 'text-ink-900'}`}
      >
        {isPlatform ? (
          <>
            DoAide{' '}
            <em className="font-display italic text-bond-500">
              409A
            </em>
          </>
        ) : (
          branding.name
        )}
      </span>
      {branding.tagline && (
        <span className={`text-[0.62rem] font-sans font-semibold tracking-[0.18em] uppercase ${light ? 'text-chrome-fg/50' : 'text-ink-400'}`}>
          {branding.tagline}
        </span>
      )}
    </span>
  );
}
