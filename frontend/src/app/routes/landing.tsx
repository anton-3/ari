import { Header } from '@/components/layouts/Header'
import { Simulate } from '@/features/simulate/components/Simulate'
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
        <Header />
        <main>
          <Hero />
          <HowItWorks />
          <Simulate />
        </main>
      </div>
    </>
  )
}
