import { useId } from 'react'
import type { ReactNode } from 'react'

type FieldProps = {
  label: string
  name: string
  type: 'text' | 'email' | 'password'
  autoComplete: string
  value: string
  onChange: (value: string) => void
  error?: string
  hint?: string
  labelAction?: ReactNode
}

export function Field({
  label,
  name,
  type,
  autoComplete,
  value,
  onChange,
  error,
  hint,
  labelAction,
}: FieldProps) {
  const id = useId()
  const messageId = `${id}-message`
  const message = error ?? hint

  return (
    <div className="auth-field">
      <div className="auth-field__row">
        <label htmlFor={id}>{label}</label>
        {labelAction}
      </div>
      <input
        id={id}
        className="auth-input"
        name={name}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
      />
      {message && (
        <p
          id={messageId}
          className={error ? 'auth-field__error' : 'auth-field__hint'}
          role={error ? 'alert' : undefined}
        >
          {message}
        </p>
      )}
    </div>
  )
}
