import { ButtonLink } from '@/components/ui/ButtonLink'
import { site } from '@/config/site'

export function Header() {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <a className="brand" href="/" aria-label={`${site.name} home`}>
          <img src="/favicon.svg" width={28} height={28} alt="" />
          <span>{site.name}</span>
        </a>
        <ButtonLink variant="ghost" arrow href="/dashboard.html">Open Dashboard</ButtonLink>
      </div>
    </header>
  )
}
