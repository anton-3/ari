import type { ReactNode } from 'react'
import { site } from '@/config/site'

type HeaderProps = {
  actions: ReactNode
}

export function Header({ actions }: HeaderProps) {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <a className="brand" href="/">
          {site.name}
        </a>
        <nav className="site-header__nav" aria-label="Primary">
          <div className="site-header__actions">{actions}</div>
        </nav>
      </div>
    </header>
  )
}
