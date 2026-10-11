import { useRef } from 'react'
import { site } from '@/config/site'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReduceMotion'
import { PhaseList } from '@/features/how-it-works/components/PhaseList'
import { ReasoningFooter } from '@/features/how-it-works/components/ReasoningFooter'
import { TopologyMap } from '@/features/how-it-works/components/TopologyMap'
import { useScrollProgress } from '@/hooks/useScrollProgress'
import { sceneFor } from '@/features/how-it-works/utils/scenes'
import { PHASES, STEPS_PER_PHASE } from '@/features/how-it-works/utils/topologyData'
import './how-it-works.css'

const TOTAL_STEPS = PHASES.length * STEPS_PER_PHASE

// Clicking a phase lands slightly into its first step so the phase reads as started.
const PHASE_ENTRY = 0.15

// The scroll hint fades once the story has started moving (about a dozen pixels).
const HINT_GONE_AT = 0.002

export function HowItWorks() {
  const trackRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const reducedMotion = usePrefersReducedMotion()
  const { progress, scrollToProgress } = useScrollProgress(trackRef, stageRef)

  // Story position 0 to 15: the whole part picks phase and step, the fraction drives typing.
  // Held just below 15 so the last step stays on screen at the end.
  const position = Math.min(progress * TOTAL_STEPS, TOTAL_STEPS - 0.001)
  const phase = Math.floor(position / STEPS_PER_PHASE)
  const inPhase = position - phase * STEPS_PER_PHASE
  const step = Math.floor(inPhase)
  const scene = sceneFor(phase, step)

  function jumpTo(index: number) {
    scrollToProgress(
      (index * STEPS_PER_PHASE + PHASE_ENTRY) / TOTAL_STEPS,
      reducedMotion ? 'auto' : 'smooth',
    )
  }

  return (
    <section id={site.sections.how} className="how">
      <div ref={trackRef} className="how__track">
        <div ref={stageRef} className="how__stage">
          <div className="container">
            <div className="how__intro">
              <p className="eyebrow">How it works</p>
              <span className={`how__hint${progress > HINT_GONE_AT ? ' how__hint--gone' : ''}`}>
                Scroll to play ↓
              </span>
            </div>
            <h2 className="h2 how__title">Watch it reason about your network.</h2>
            <div className="how__grid">
              <PhaseList
                active={phase}
                phaseProgress={inPhase / STEPS_PER_PHASE}
                onSelect={jumpTo}
              />
              <div id={site.sections.howPanel} className="how__panel">
                <div className="how__panelhead">
                  <span className="how__label">Ari / Live infrastructure</span>
                  <span className={`how__chip how__chip--${scene.status.tone}`} aria-live="polite">
                    <span className="how__dot" aria-hidden="true" />
                    {scene.status.label}
                  </span>
                </div>
                <TopologyMap scene={scene} />
                <ReasoningFooter
                  thought={scene.thought}
                  summary={scene.summary}
                  progress={inPhase - step}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
