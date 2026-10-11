import { useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReduceMotion'
import ErrorBoundary from '../../graph/ErrorBoundary'
import IsoView, { C, PROTO_COLOR } from '../../graph/IsoView'
import type { IsoSel } from '../../graph/IsoView'
import { itemsOf, treeFor } from '../../graph/codetree'
import { fmtRate } from '../../graph/helpers'
import { forgetPos } from '../../graph/positions'
import { useFleet } from '../../graph/useFleet'
import type { FleetApi } from '../../graph/useFleet'
import type { Agent, FleetNode } from '../../graph/types'
import type { Metrics } from '../types'

// The simulator only takes over once the real feed has had this long to answer.
const SIM_GRACE_MS = 4000
const INSETS = { top: 20, right: 20, bottom: 20, left: 20 }
const SYNTHETIC_ROLES = new Set(['controller', 'internet'])
const LEGEND: [string, string][] = [
  ['http', PROTO_COLOR.http],
  ['postgres', PROTO_COLOR.postgres],
  ['redis', PROTO_COLOR.redis],
  ['warning', C.amber],
  ['critical', C.red],
]

function canDelete(node: FleetNode | undefined): node is FleetNode {
  return (
    !!node &&
    node.deletable &&
    !SYNTHETIC_ROLES.has(node.role) &&
    node.status !== 'deleting' &&
    !node.id.startsWith('pending-')
  )
}

interface MapProps {
  metrics: Metrics | null
  agents: Agent[]
}

export function InfrastructureMap({ metrics, agents }: MapProps) {
  const surge = metrics?.mode === 'surge'
  const real = useFleet(false, surge)
  const hasReal = (real.fleet?.nodes.length ?? 0) > 0
  const [waited, setWaited] = useState(false)

  useEffect(() => {
    if (hasReal) return
    const timer = window.setTimeout(() => setWaited(true), SIM_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [hasReal])

  if (hasReal)
    return (
      <FleetCard fl={real} agents={agents} metrics={metrics} simulated={false} />
    )
  if (waited) return <SimulatedFleet metrics={metrics} surge={surge} />
  return <FleetCard fl={null} agents={[]} metrics={metrics} simulated={false} />
}

// Mounted only while there is no real fleet; the real feed keeps probing above.
function SimulatedFleet({
  metrics,
  surge,
}: {
  metrics: Metrics | null
  surge: boolean
}) {
  const fl = useFleet(true, surge)
  return <FleetCard fl={fl} agents={fl.simAgents} metrics={metrics} simulated />
}

function FleetCard({
  fl,
  agents,
  metrics,
  simulated,
}: MapProps & { fl: FleetApi | null; simulated: boolean }) {
  const reducedMotion = usePrefersReducedMotion()
  const section = useRef<HTMLElement>(null)
  const hovered = useRef(false)
  const [picked, setPicked] = useState<IsoSel | null>(null)
  const [confirm, setConfirm] = useState<FleetNode | null>(null)
  const [typed, setTyped] = useState('')

  const fleet = fl?.fleet ?? null
  const codemap = fl?.codemap ?? null
  const nodes = fleet?.nodes ?? []
  const links = fleet?.links ?? []
  // A selection whose node or link has gone is simply no longer shown.
  const selected =
    picked &&
    (picked.kind === 'node'
      ? nodes.some((node) => node.id === picked.id)
      : links.some((link) => link.id === picked.id))
      ? picked
      : null
  const selectedNode =
    selected?.kind === 'node'
      ? nodes.find((node) => node.id === selected.id)
      : undefined

  // Delete/Backspace asks to destroy the selected server; Esc steps out one level.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      if (document.querySelector('dialog[open]')) return
      if (!hovered.current && !section.current?.contains(document.activeElement))
        return
      if (event.key === 'Escape') {
        if (selected?.kind !== 'node') return setPicked(null)
        const items = itemsOf(
          treeFor(codemap, selectedNode?.role ?? ''),
          selected.path ?? [],
        )
        if (!items.length) return setPicked(null)
        // a selected leaf closes the level it sits on; an open item closes itself
        const drop = items[items.length - 1].children.length ? 1 : 2
        setPicked({
          kind: 'node',
          id: selected.id,
          path: items
            .slice(0, Math.max(0, items.length - drop))
            .map((item) => item.key),
        })
      } else if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        canDelete(selectedNode)
      ) {
        event.preventDefault()
        setTyped('')
        setConfirm(selectedNode)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, selectedNode, codemap])

  async function destroy() {
    if (!fl || !confirm || typed !== confirm.label) return
    const node = confirm
    setConfirm(null)
    if (await fl.deleteNode(node.id, typed)) {
      forgetPos(node.label)
      setPicked(null)
    }
  }

  const servers = nodes.filter((node) => !SYNTHETIC_ROLES.has(node.role))
  const running = servers.filter((node) => node.status === 'running').length
  const issues = servers.reduce(
    (sum, node) => sum + (node.issues?.length ?? 0),
    0,
  )
  const throughput = links.reduce(
    (sum, link) => sum + Math.max(0, link.bytesPerSec),
    0,
  )
  const addable = fl?.roles.filter((role) => role.addable) ?? []

  return (
    <section
      ref={section}
      className="dash-panel infrastructure"
      id="infrastructure"
      aria-labelledby="infrastructure-title"
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
    >
      <div className="panel-heading">
        <div className="fleet-heading">
          <h2 id="infrastructure-title">infrastructure</h2>
          {fl && fleet && addable.length > 0 && (
            <div className="fleet-add" aria-label="Add a server">
              {addable.map((role) => (
                <button
                  key={role.role}
                  type="button"
                  draggable
                  title={`${role.description} — click to add, or drag onto the map`}
                  onClick={() => fl.addNode(role.role)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/ari-role', role.role)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  + {role.label.toLowerCase()}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="health-legend">
          {LEGEND.map(([label, color]) => (
            <span key={label}>
              <i style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="infrastructure-canvas">
        {fl && fleet ? (
          <ErrorBoundary>
            <IsoView
              fleet={fleet}
              agents={agents}
              metrics={metrics}
              codemap={codemap}
              live={!simulated}
              reduced={reducedMotion}
              rightInset={0}
              insets={INSETS}
              showControl={false}
              selected={selected}
              focus={null}
              onSelect={setPicked}
              onDropRole={(role, x, y) => fl.addNode(role, { x, y })}
            />
          </ErrorBoundary>
        ) : (
          <div className="panel-empty">waiting for fleet telemetry…</div>
        )}
      </div>
      <footer className="infrastructure-footer">
        <span>
          {fleet
            ? `${servers.length} server${servers.length === 1 ? '' : 's'} · ${running} running · ${issues} issue${issues === 1 ? '' : 's'} · ${fmtRate(throughput)}`
            : 'connecting to telemetry'}
        </span>
        <span>
          {!fleet
            ? ''
            : simulated
              ? 'simulated fleet · no real servers'
              : 'live fleet'}
        </span>
      </footer>
      {confirm && (
        <dialog
          ref={(element) => {
            if (!element || element.open) return
            element.showModal()
            element.querySelector('input')?.focus()
          }}
          className="dashboard-dialog"
          onClose={() => setConfirm(null)}
          aria-labelledby="destroy-title"
        >
          <div className="dialog-heading">
            <h2 id="destroy-title">destroy server</h2>
            <button
              className="dialog-close"
              onClick={() => setConfirm(null)}
              aria-label="Close dialog"
            >
              ×
            </button>
          </div>
          <p className="dialog-note">
            {simulated
              ? `This removes ${confirm.label} from the simulated fleet. No real server is touched.`
              : `This permanently deletes the Linode server ${confirm.label} (${confirm.publicIp}, ${confirm.region}, ${confirm.type}). Its disk and everything on it is destroyed. This cannot be undone.`}
          </p>
          <input
            className="finding-search mono"
            aria-label={`Type ${confirm.label} to confirm`}
            placeholder={`type ${confirm.label} to confirm`}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void destroy()
            }}
          />
          <div className="fleet-destroy-actions">
            <button className="text-button" onClick={() => setConfirm(null)}>
              cancel
            </button>
            <button
              className="fleet-destroy"
              disabled={typed !== confirm.label}
              onClick={() => void destroy()}
            >
              destroy {confirm.label}
            </button>
          </div>
        </dialog>
      )}
    </section>
  )
}
