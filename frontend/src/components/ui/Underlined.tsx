import { useEffect, useRef, useState, type ReactNode } from 'react'

// An accent-coloured phrase with the hero's hand-drawn sweep under it. The sweep
// draws in from the left the first time the phrase is fully on screen.
// `lead` is accent-coloured text placed before the phrase that the sweep skips.
export function Underlined({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [drawn, setDrawn] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    // Wait until the phrase has cleared the bottom edge so the draw is seen.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setDrawn(true)
        observer.disconnect()
      },
      { threshold: 1, rootMargin: '0px 0px -12% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <span className={`underlined${drawn ? ' underlined--drawn' : ''}`}>
      {lead}
      <span ref={ref} className="underlined__text">
        {children}
        <svg
          className="underlined__sweep"
          viewBox="0 0 120 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2 9C30 3 70 2 110 6" vectorEffect="non-scaling-stroke" />
          <circle cx="114" cy="6.5" r="3" fill="currentColor" stroke="none" />
        </svg>
      </span>
    </span>
  )
}
