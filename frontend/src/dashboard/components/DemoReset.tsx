import { useEffect, useRef, useState } from 'react'
import { TELEMETRY_BASE_URL } from '../config'
import type { FeedSource } from '../types'

type ResetState = {
  status: 'idle' | 'running' | 'done' | 'failed'
  error?: string
  startedAt?: number
  completedAt?: number
  steps: { id: string; label: string; status: 'pending' | 'running' | 'done' | 'failed'; detail?: string }[]
}
const LABELS: Record<FeedSource, string> = {
  live: 'live', polling: 'polling', mock: 'demo data', connecting: 'connecting', offline: 'offline · last snapshot',
}
const endpoint = `${TELEMETRY_BASE_URL}/api/demo/reset-run`
export function DemoReset({ source }: { source: FeedSource }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ResetState>({ status: 'idle', steps: [] })
  const [sending, setSending] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const posting = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef(0)
  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (posting.current) {
        timer = setTimeout(poll, 1000)
        return
      }
      const sequence = ++request.current
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
        if (!response.ok) throw new Error('Reset service is unavailable. Checking again…')
        const next = await response.json() as ResetState
        if (!stopped && sequence === request.current) {
          setState(next); setPollError('')
          if (next.status === 'running') setShowResult(true)
        }
      } catch (e) {
        if (!stopped && open && sequence === request.current) setPollError(e instanceof Error ? e.message : 'Cannot check reset progress')
      } finally {
        if (!stopped) timer = setTimeout(poll, 1000)
      }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [open])
  async function confirm() {
    posting.current = true
    setSending(true); setShowResult(false); setState({ status: 'idle', steps: [] }); setError(''); ++request.current
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) })
      const next = await response.json()
      if (!response.ok) throw new Error(next.error || 'Reset could not start')
      ++request.current; setState(next); setShowResult(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'Reset could not start') }
    finally { posting.current = false; setSending(false) }
  }
  const running = sending || state.status === 'running'
  const showProgress = showResult || state.status === 'running' || state.status === 'failed'
  return <>
    <button className="feed-status reset-trigger" title="Reset to pre-demo state" onClick={() => { setError(''); setPollError(''); setShowResult(state.status === 'running' || state.status === 'failed'); setOpen(true) }}>
      <i className={`status-square ${source}`} />{LABELS[source]}
      {state.status === 'running' && <span className="reset-spinner" aria-label="Reset running" />}
    </button>
    <dialog ref={dialog} className="dashboard-dialog reset-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="reset-heading">
      <div className="dialog-heading"><h2 id="reset-heading">Reset to pre-demo state</h2></div>
      <p className="dialog-note">Stop the attack, remove IP bans, hide web-03 on warm standby, close the latest demo PR and delete its branch, then prepare and verify the next take.</p>
      <p className="dialog-note">Attack requests are scrubbed from the three-minute window, so the reset finishes in seconds.</p>
      {showProgress && state.steps.length > 0 && <ol className="reset-steps" aria-label="Reset progress">
        {state.steps.map(step => <li key={step.id} data-status={step.status}>
          <span className={step.status === 'running' ? 'reset-spinner' : 'reset-step-icon'} aria-label={step.status}>{step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : step.status === 'pending' ? '○' : ''}</span>
          <div>{step.label}{step.detail && <small>{step.detail}</small>}</div>
        </li>)}
      </ol>}
      <div aria-live="polite" role="status">
        {showProgress && state.status === 'done' && <p className="reset-success">Reset completed{state.completedAt ? ` at ${new Date(state.completedAt).toLocaleTimeString()}` : ''}. Pre-demo state verified.</p>}
        {state.status === 'failed' && <p className="reset-error">{state.error} Cleanup is paused; confirm to retry safely.</p>}
        {error && <p className="reset-error" role="alert">{error}</p>}
        {pollError && <p className="reset-error">{pollError}</p>}
        {running && <p className="dialog-note">Reset continues even if you close this window or refresh the dashboard.</p>}
      </div>
      <div className="reset-buttons">
        <button onClick={() => setOpen(false)}>{running || (showProgress && state.status === 'done') ? 'Close' : 'Cancel'}</button>
        <button className="reset-confirm" onClick={() => void confirm()} disabled={running}>{sending ? 'Starting…' : state.status === 'running' ? 'Resetting…' : showProgress && state.status === 'done' ? 'Reset again' : state.status === 'failed' ? 'Confirm retry' : 'Confirm'}</button>
      </div>
    </dialog>
  </>
}
