import { useRef } from 'react'
import { LossesBars } from '@/features/losses-chart/components/LossesBars'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReduceMotion'
import { useScrollProgress } from '@/hooks/useScrollProgress'
import { fills } from '@/features/losses-chart/utils/barFill'
import {
  changePercent,
  formatLong,
  formatMillions,
  formatRounded,
} from '@/features/losses-chart/utils/formatLoss'
import { FIRST_YEAR, IC3_SOURCE, LOSSES } from '@/features/losses-chart/utils/ic3Losses'
import './losses-chart.css'

const LATEST = LOSSES[LOSSES.length - 1]
const PREVIOUS = LOSSES[LOSSES.length - 2]
const FULL = LOSSES.map(() => 1)

// The scroll hint fades once the chart has started filling.
const HINT_GONE_AT = 0.02

export function LossesChart() {
  const trackRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const reducedMotion = usePrefersReducedMotion()
  const { progress } = useScrollProgress(trackRef, stageRef)

  // With reduced motion there is no track: the chart is simply shown finished.
  const barFills = reducedMotion ? FULL : fills(progress)

  return (
    <section id="stakes" className={`stakes${reducedMotion ? ' stakes--static' : ''}`}>
      <div ref={trackRef} className={reducedMotion ? undefined : 'stakes__track'}>
        <div ref={stageRef} className={reducedMotion ? undefined : 'stakes__stage'}>
          <div className="container">
            <div className="stakes__intro">
              <p className="eyebrow">Why Ari</p>
              {!reducedMotion && (
                <span
                  className={`stakes__hint${progress > HINT_GONE_AT ? ' stakes__hint--gone' : ''}`}
                >
                  Scroll to play ↓
                </span>
              )}
            </div>
            <h2 className="h2 stakes__title">
              {formatRounded(LATEST.usdBillions)}
              <sup className="cite" aria-hidden="true">
                *
              </sup>{' '}
              lost to reported cybercrime in {LATEST.year}.
            </h2>
            <p className="lede stakes__lede">
              Losses reported to the FBI have risen every year since {LOSSES[0].year}, up{' '}
              {changePercent(PREVIOUS.usdBillions, LATEST.usdBillions)}% in {LATEST.year} alone.
              In {FIRST_YEAR.year}, the first year its complaint center reported, the total was{' '}
              {formatMillions(FIRST_YEAR.usdMillions)}.
            </p>

            <figure className="stakes__figure">
              <LossesBars fills={barFills} />

              <table className="sr-only">
                <caption>Reported cybercrime losses by year</caption>
                <thead>
                  <tr>
                    <th scope="col">Year</th>
                    <th scope="col">Reported losses</th>
                  </tr>
                </thead>
                <tbody>
                  {LOSSES.map((loss) => (
                    <tr key={loss.year}>
                      <th scope="row">{loss.year}</th>
                      <td>{formatLong(loss.usdBillions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <figcaption id="ic3-source" className="stakes__source">
                * Source: FBI Internet Crime Complaint Center,{' '}
                <a href={IC3_SOURCE.url} target="_blank" rel="noopener">
                  <em>{IC3_SOURCE.title}</em>
                </a>
                , {IC3_SOURCE.pages}.
              </figcaption>
            </figure>
          </div>
        </div>
      </div>
    </section>
  )
}
