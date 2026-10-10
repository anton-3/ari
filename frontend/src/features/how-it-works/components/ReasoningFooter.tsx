import { Logo } from '@/components/ui/Logo'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReduceMotion'
import { TYPING_SHARE } from '@/features/how-it-works/utils/topologyData'

type ReasoningFooterProps = {
  thought: string
  summary: string
  // 0 to 1 through the current step; drives how much of the thought has typed.
  progress?: number
}

export function ReasoningFooter({ thought, summary, progress = 1 }: ReasoningFooterProps) {
  const reducedMotion = usePrefersReducedMotion()
  const share = reducedMotion ? 1 : Math.min(Math.max(progress, 0) / TYPING_SHARE, 1)
  const typed = thought.slice(0, Math.ceil(thought.length * share))

  return (
    <div className="reasoning">
      <Logo className="reasoning__logo" size={22} />
      <div className="reasoning__text">
        {/* The typed text is decorative; screen readers get the whole thought at once. */}
        <span className="sr-only" aria-live="polite">
          {thought}. {summary}
        </span>
        <p className="reasoning__thought" aria-hidden="true">
          {typed}
          <span className="reasoning__caret" />
        </p>
        <p className="reasoning__summary" aria-hidden="true">
          {summary}
        </p>
      </div>
    </div>
  )
}
