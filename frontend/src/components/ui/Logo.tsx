type LogoProps = {
  size?: number
  className?: string
}

// Radar sweep: two range rings, a sweep wedge, the sweep arm and a contact.
export function Logo({ size = 26, className }: LogoProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="7.5" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <path d="M16 16 L16 2 A14 14 0 0 1 28.12 9 Z" fill="currentColor" opacity="0.35" />
      <path d="M16 16 L16 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="21.5" cy="10.5" r="1.8" fill="currentColor" />
    </svg>
  )
}
