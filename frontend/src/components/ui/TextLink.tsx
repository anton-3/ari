import type { ComponentPropsWithoutRef } from 'react'

type AnchorProps = ComponentPropsWithoutRef<'a'> & { href: string }
type ButtonProps = ComponentPropsWithoutRef<'button'> & { href?: undefined }

type TextLinkProps = AnchorProps | ButtonProps

export function TextLink({ className, children, ...props }: TextLinkProps) {
  const classes = ['text-link', className].filter(Boolean).join(' ')
  const content = (
    <>
      {children}
      <svg
        className="text-link__arrow"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M3 9L9 3M4 3h5v5" />
      </svg>
    </>
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
