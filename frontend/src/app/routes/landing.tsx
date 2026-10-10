import { Header } from '@/components/layouts/Header'
import { ButtonLink } from '@/components/ui/ButtonLink'

export function Landing() {
  return (
    <>
      <div className="gridlines container" aria-hidden="true">
        <div className="gridlines__cols">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="page">
        <Header
          actions={
            <>
              <ButtonLink variant="accent">Sign In</ButtonLink>
              <ButtonLink variant="ghost">Sign up</ButtonLink>
            </>
          }
        />
      </div>
    </>
  )
}
