import { Underlined } from '@/components/ui/Underlined'
import { ButtonLink } from '@/components/ui/ButtonLink'
import { site } from '@/config/site'
import './simulate.css'

export function Simulate() {
  return (
    <section id={site.sections.demo} className="demo">
      <div className="container demo__inner">
        <h2 className="display display--md">See Ari in <Underlined>action</Underlined>.</h2>
        <ButtonLink className="demo__cta" arrow href="/dashboard.html">Open Dashboard</ButtonLink>
      </div>
    </section>
  )
}
