import type { CallState } from '@/features/how-it-works/types/topology'

type CallPillProps = {
  call: CallState
}

export function CallPill({ call }: CallPillProps) {
  const approved = call === 'approved'

  return (
    <div
      className={`call-pill call-pill--${call}`}
      aria-hidden={call === 'none'}
    >
      <span className="call-pill__avatar">MC</span>
      <span className="call-pill__text">
        <span className="call-pill__title">{approved ? 'Maya Chen approved' : 'Calling Maya Chen'}</span>
        <span className="call-pill__sub">{approved ? 'by voice · 03:14' : 'primary on-call'}</span>
      </span>
    </div>
  )
}
