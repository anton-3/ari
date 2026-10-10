import { ButtonLink } from '@/components/ui/ButtonLink'
import { site } from '@/config/site'
import './simulate.css'

export function Simulate() {
  return (
    <section id={site.sections.demo} className="demo">
      <div className="container demo__inner">
        <h2 className="display display--md">See Ari in action.</h2>
        <ButtonLink className="demo__cta">Simulate</ButtonLink>
      </div>
    </section>
  )
}
