import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'

// Scroll position through a tall track, 0 to 1:
// (stage's sticky top - track top) / (track height - stage height)
function measure(track: HTMLElement, stage: HTMLElement) {
  const stickyTop = parseFloat(getComputedStyle(stage).top) || 0
  const range = track.offsetHeight - stage.offsetHeight
  return { stickyTop, range, trackTop: track.getBoundingClientRect().top }
}

export function useScrollProgress(
  trackRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let frame = 0

    function update() {
      frame = 0
      const track = trackRef.current
      const stage = stageRef.current
      if (!track || !stage) return
      const { stickyTop, range, trackTop } = measure(track, stage)
      const next = range > 0 ? (stickyTop - trackTop) / range : 0
      setProgress(Math.min(Math.max(next, 0), 1))
    }

    // Throttled to one read per animation frame.
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update)
    }

    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(frame)
    }
  }, [trackRef, stageRef])

  // Scrolls the page so the track is at the given progress (0 to 1).
  const scrollToProgress = useCallback(
    (target: number, behavior: ScrollBehavior) => {
      const track = trackRef.current
      const stage = stageRef.current
      if (!track || !stage) return
      const { stickyTop, range, trackTop } = measure(track, stage)
      window.scrollTo({ top: window.scrollY + trackTop - stickyTop + target * range, behavior })
    },
    [trackRef, stageRef],
  )

  return { progress, scrollToProgress }
}
