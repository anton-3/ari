import { PHASES } from '@/features/how-it-works/utils/topologyData'

type PhaseListProps = {
  active: number
  // 0 to 1 through the active phase; fills the bar under the active row.
  phaseProgress: number
  onSelect: (index: number) => void
}

export function PhaseList({ active, phaseProgress, onSelect }: PhaseListProps) {
  return (
    <div className="phases">
      <ol className="phases__list" aria-label="How Ari works, in five phases">
        {PHASES.map((phase, index) => {
          const state = index < active ? 'past' : index === active ? 'active' : 'ahead'

          return (
            <li key={phase.name}>
              <button
                type="button"
                className={`phase phase--${state}`}
                aria-current={state === 'active' ? 'step' : undefined}
                onClick={() => onSelect(index)}
              >
                <span className="phase__head">
                  <span className="phase__num">{phase.number}</span>
                  <span className="phase__name">{phase.name}</span>
                </span>
                <span className="phase__copy" aria-hidden={state !== 'active'}>
                  <span className="phase__copytext">{phase.copy}</span>
                </span>
                <span
                  className="phase__bar"
                  style={{ transform: `scaleX(${state === 'active' ? phaseProgress : 0})` }}
                />
              </button>
            </li>
          )
        })}
      </ol>
      <p className="phases__mobilecopy">{PHASES[active].copy}</p>
    </div>
  )
}
