import { useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { ARI_PHONE } from '../config'

export function AriContact() {
  const dialog = useRef<HTMLDialogElement>(null)
  const phoneLink = `tel:${ARI_PHONE}`
  const phoneLabel = ARI_PHONE.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3')

  return (
    <div className="ari-contact">
      <span>text or call</span>
      <button
        type="button"
        className="ari-qr-trigger"
        aria-label={`Enlarge QR code to call Ari at ${phoneLabel}`}
        aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}
      >
        <QRCodeSVG value={phoneLink} size={80} level="M" marginSize={4} aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        className="dashboard-dialog ari-qr-dialog"
        aria-labelledby="ari-qr-title"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)
            event.currentTarget.close()
        }}
      >
        <div className="dialog-heading">
          <h2 id="ari-qr-title">Text or call Ari</h2>
          <button type="button" className="dialog-close" aria-label="Close QR code" onClick={() => dialog.current?.close()}>×</button>
        </div>
        <p>Scan with your phone to call Ari.</p>
        <a className="ari-qr-large" href={phoneLink} aria-label={`Call Ari at ${phoneLabel}`}>
          <QRCodeSVG value={phoneLink} size={320} level="M" marginSize={4} title={`Call Ari at ${phoneLabel}`} />
        </a>
        <a className="ari-qr-phone" href={phoneLink}>{phoneLabel}</a>
      </dialog>
    </div>
  )
}
