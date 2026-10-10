import { useId } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { SignInForm } from '@/features/auth/components/SignInForm'
import { SignUpForm } from '@/features/auth/components/SignUpForm'
import type { AuthMode } from '@/features/auth/utils/submitAuth'
import './auth.css'

type AuthModalProps = {
  id: string
  mode: AuthMode
  onModeChange: (mode: AuthMode) => void
  onClose: () => void
  modalRef: RefObject<HTMLDivElement | null>
}

export function AuthModal({ id, mode, onModeChange, onClose, modalRef }: AuthModalProps) {
  const headingId = useId()
  const signingIn = mode === 'sign-in'

  return createPortal(
    <div className="auth-backdrop">
      <div
        ref={modalRef}
        id={id}
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <button type="button" className="auth-modal__close" aria-label="Close" onClick={onClose}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2 2l10 10M12 2L2 12" />
          </svg>
        </button>
        <h2 id={headingId} className="auth-modal__title">
          {signingIn ? 'Sign in to Ari' : 'Create your Ari account'}
        </h2>
        {signingIn ? <SignInForm key="sign-in" /> : <SignUpForm key="sign-up" />}
        <p className="auth-switch">
          {signingIn ? 'New to Ari? ' : 'Already have an account? '}
          <button
            type="button"
            className="auth-link"
            onClick={() => onModeChange(signingIn ? 'sign-up' : 'sign-in')}
          >
            {signingIn ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>,
    document.body,
  )
}
