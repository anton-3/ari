import type { ComponentPropsWithoutRef } from 'react'

type Variant = 'accent' | 'ghost'

type AnchorProps = ComponentPropsWithoutRef<'a'> & { href: string }
type ButtonProps = ComponentPropsWithoutRef<'button'> & { href?: undefined }

// `arrow` adds the hover treatment: a fill that grows from the centre while the
// arrow swaps sides. Each variant styles it differently (see base.css).
// `turn` is the quieter one: an underline draws in under the label and the
// arrow turns to point down.
type ButtonLinkProps = (AnchorProps | ButtonProps) & { variant?: Variant; arrow?: boolean; turn?: boolean }

const ARROW_PATH =
  'M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z'

function Arrow({ side }: { side: 'in' | 'out' | 'turn' }) {
  return (
    <svg className={`btn__arrow btn__arrow--${side}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ARROW_PATH} />
    </svg>
  )
}

export function ButtonLink({ variant = 'accent', arrow = false, turn = false, className, children, ...props }: ButtonLinkProps) {
  const classes = ['btn', `btn--${variant}`, arrow && 'btn--arrow', turn && 'btn--turn', className].filter(Boolean).join(' ')

  const content = arrow ? (
    <>
      <span className="btn__fill" aria-hidden="true" />
      <Arrow side="in" />
      <span className="btn__label">{children}</span>
      <Arrow side="out" />
    </>
  ) : turn ? (
    <>
      <span className="btn__text">{children}</span>
      <Arrow side="turn" />
    </>
  ) : (
    children
  )

  if (props.href !== undefined) {
    return (
      <a className={classes} {...props}>
        {content}
      </a>
    )
  }
  return (
    <button type="button" className={classes} {...props}>
      {content}
    </button>
  )
}
