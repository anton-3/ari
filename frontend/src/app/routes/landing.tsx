import { Header } from '@/components/layouts/Header'
import { AuthTrigger } from '@/features/auth/components/AuthTrigger'
import { Hero } from '@/features/hero/components/Hero'
import { HowItWorks } from '@/features/how-it-works/components/HowItWorks'

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
              <AuthTrigger mode="sign-in" variant="ghost">
                Sign In
              </AuthTrigger>
              <AuthTrigger mode="sign-up" variant="accent">
                Sign up
              </AuthTrigger>
            </>
          }
        />
        <main>
          <Hero
            secondaryAction={
              <AuthTrigger mode="sign-up" variant="text">
                Sign up
              </AuthTrigger>
            }
          />
          <HowItWorks />
        </main>
      </div>
    </>
  )
}
