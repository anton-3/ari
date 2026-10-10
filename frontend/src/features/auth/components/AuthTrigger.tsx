import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ButtonLink } from '@/components/ui/ButtonLink'
import { TextLink } from '@/components/ui/TextLink'
import { AuthModal } from '@/features/auth/components/AuthModal'
import { useModal } from '@/features/auth/hooks/useModal'
import type { AuthMode } from '@/features/auth/utils/submitAuth'

type AuthTriggerProps = {
  mode: AuthMode
  variant: 'accent' | 'ghost' | 'text'
  children: ReactNode
}

export function AuthTrigger({ mode: initialMode, variant, children }: AuthTriggerProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(initialMode)
  const modalId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  function close() {
    setOpen(false)
    setMode(initialMode)
  }

  useModal({ open, onClose: close, modalRef, triggerRef, focusKey: mode })

  const triggerProps = {
    ref: triggerRef,
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': open,
    'aria-controls': modalId,
    onClick: () => (open ? close() : setOpen(true)),
  }

  return (
    <>
      {variant === 'text' ? (
        <TextLink {...triggerProps}>{children}</TextLink>
      ) : (
        <ButtonLink variant={variant} {...triggerProps}>
          {children}
        </ButtonLink>
      )}
      {open && (
        <AuthModal
          id={modalId}
          mode={mode}
          onModeChange={setMode}
          onClose={close}
          modalRef={modalRef}
        />
      )}
    </>
  )
}
