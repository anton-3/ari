import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

type UseModalOptions = {
  open: boolean
  onClose: () => void
  modalRef: RefObject<HTMLElement | null>
  triggerRef: RefObject<HTMLElement | null>
  focusKey: string
}

export function useModal({ open, onClose, modalRef, triggerRef, focusKey }: UseModalOptions) {
  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      if (!modalRef.current?.contains(event.target as Node)) onClose()
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const modal = modalRef.current
      if (!modal) return
      const items = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return

      const active = document.activeElement
      if (!modal.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose, modalRef])

  // lock page scroll behind the modal
  useEffect(() => {
    if (!open) return
    const { style } = document.body
    const previous = { overflow: style.overflow, paddingRight: style.paddingRight }
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    style.overflow = 'hidden'
    if (scrollbar > 0) style.paddingRight = `${scrollbar}px`
    return () => {
      style.overflow = previous.overflow
      style.paddingRight = previous.paddingRight
    }
  }, [open])

  // focus the first field on open and whenever the mode changes
  useEffect(() => {
    if (!open) return
    modalRef.current?.querySelector<HTMLElement>('input')?.focus()
  }, [open, focusKey, modalRef])

  // return focus to the trigger on close
  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    return () => {
      trigger?.focus()
      // a click on non-focusable page background blurs after this runs
      setTimeout(() => {
        if (document.activeElement === document.body) trigger?.focus()
      }, 0)
    }
  }, [open, triggerRef])
}
