import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ButtonLink } from '@/components/ui/ButtonLink'
import { validateEmail } from '@/utils/validateEmail'
import { Field } from '@/features/auth/components/Field'
import { submitAuth } from '@/features/auth/utils/submitAuth'

type Values = { email: string; password: string }
type Errors = Partial<Record<keyof Values, string>>

function validate({ email, password }: Values) {
  const errors: Errors = {}
  if (!validateEmail(email)) errors.email = 'Enter an email like name@domain.com.'
  if (!password) errors.password = 'Enter your password.'
  return errors
}

export function SignInForm() {
  const [values, setValues] = useState<Values>({ email: '', password: '' })
  const [errors, setErrors] = useState<Errors>({})
  const [status, setStatus] = useState<'idle' | 'busy' | 'done'>('idle')
  const formRef = useRef<HTMLFormElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    if (status === 'done') statusRef.current?.focus()
  }, [status])

  function change(field: keyof Values, value: string) {
    const next = { ...values, [field]: value }
    setValues(next)
    if (errors[field]) setErrors({ ...errors, [field]: validate(next)[field] })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (status === 'busy') return

    const found = validate(values)
    setErrors(found)
    const first = Object.keys(found)[0]
    if (first) {
      formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus()
      return
    }

    setStatus('busy')
    await submitAuth('sign-in', values)
    setStatus('done')
  }

  if (status === 'done') {
    return (
      <p ref={statusRef} className="auth-status" role="status" tabIndex={-1}>
        Sign-in isn&apos;t connected yet. Nothing was sent.
      </p>
    )
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={values.email}
        onChange={(value) => change('email', value)}
        error={errors.email}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={values.password}
        onChange={(value) => change('password', value)}
        error={errors.password}
        labelAction={
          <button type="button" className="auth-link">
            Forgot password?
          </button>
        }
      />
      <ButtonLink
        className="auth-block"
        type="submit"
        aria-busy={status === 'busy'}
      >
        {status === 'busy' ? 'Signing in…' : 'Sign in'}
      </ButtonLink>
    </form>
  )
}
