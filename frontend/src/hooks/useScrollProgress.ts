import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'

// Time constant of the easing, in ms: progress closes ~63% of the gap to the scroll
// position in this long, so a wheel notch glides instead of jumping.
const EASE_MS = 110

// Close enough to the scroll position to stop animating (well under a pixel of track).
const SETTLED = 0.0002

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
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0
    let last = 0
    let current = 0
    let started = false
    // Sticky offset and scroll range only change with layout, so they are measured on
    // resize rather than on every frame.
    let layout: { stickyTop: number; range: number } | null = null

    function update(now: number) {
      frame = 0
      const track = trackRef.current
      const stage = stageRef.current
      if (!track || !stage) return
      if (!layout) {
        const { stickyTop, range } = measure(track, stage)
        layout = { stickyTop, range }
      }
      const { stickyTop, range } = layout
      const raw = range > 0 ? (stickyTop - track.getBoundingClientRect().top) / range : 0
      const target = Math.min(Math.max(raw, 0), 1)

      // Ease towards the scroll position, independent of frame rate. The first frame
      // and reduced motion go straight there.
      const dt = last ? now - last : 0
      last = now
      const gap = target - current
      if (!started || reduced.matches || Math.abs(gap) < SETTLED) {
        current = target
        last = 0
      } else {
        current += gap * (1 - Math.exp(-dt / EASE_MS))
        schedule()
      }
      started = true
      setProgress(current)
    }

    // Throttled to one read per animation frame.
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update)
    }

    function remeasure() {
      layout = null
      schedule()
    }

    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', remeasure)
    const observer = new ResizeObserver(remeasure)
    if (trackRef.current) observer.observe(trackRef.current)
    if (stageRef.current) observer.observe(stageRef.current)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', remeasure)
      observer.disconnect()
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
