import type { ReactNode } from 'react'
import { ButtonLink } from '@/components/ui/ButtonLink'
import { site } from '@/config/site'
import { scrollToSection } from '@/utils/scrollToSection'
import './hero.css'

type HeroProps = {
  secondaryAction: ReactNode
}

export function Hero({ secondaryAction }: HeroProps) {
  return (
    <section className="hero">
      <div className="container hero__inner">
        <h1 className="display">
          The security engineer that never{' '}
          <span className="hero__accent">
            sleeps
            <svg
              className="hero__sweep"
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
          .
        </h1>
        {/* <p className="lede">
          Ari watches your code, cloud, and runtime around the clock, proves what it finds, and
          calls you when an attack needs a human yes.
        </p> */}
        <p className="lede">
          Ari does blank.
        </p>
        <div className="hero__actions">
          <ButtonLink onClick={() => scrollToSection(site.sections.howPanel, 'center')}>See how it works</ButtonLink>
          {secondaryAction}
        </div>
      </div>
    </section>
  )
}
