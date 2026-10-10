import { Header } from '@/components/layouts/Header'
import { ButtonLink } from '@/components/ui/ButtonLink'
import { TextLink } from '@/components/ui/TextLink'
import { Hero } from '@/features/hero/components/Hero'

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
              <ButtonLink variant="ghost">Sign In</ButtonLink>
              <ButtonLink variant="accent">Sign up</ButtonLink>
            </>
          }
        />
        <main>
          <Hero secondaryAction={<TextLink>Sign up</TextLink>} />
        </main>
      </div>
    </>
  )
}
