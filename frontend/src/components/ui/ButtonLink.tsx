import type { ComponentPropsWithoutRef } from 'react'

type Variant = 'accent' | 'ghost'

type AnchorProps = ComponentPropsWithoutRef<'a'> & { href: string }
type ButtonProps = ComponentPropsWithoutRef<'button'> & { href?: undefined }

type ButtonLinkProps = (AnchorProps | ButtonProps) & { variant?: Variant }

export function ButtonLink({ variant = 'accent', className, ...props }: ButtonLinkProps) {
  const classes = ['btn', `btn--${variant}`, className].filter(Boolean).join(' ')

  if (props.href !== undefined) {
    return <a className={classes} {...props} />
  }
  return <button type="button" className={classes} {...props} />
}
