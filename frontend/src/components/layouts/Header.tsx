import { ButtonLink } from '@/components/ui/ButtonLink'
import { site } from '@/config/site'

export function Header() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <a className="brand" href="/">
          {site.name}
        </a>
        <ButtonLink variant="ghost" arrow href="/dashboard.html">Open Dashboard</ButtonLink>
      </div>
    </header>
  )
}
