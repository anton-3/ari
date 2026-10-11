import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReduceMotion'
import ErrorBoundary from '../../graph/ErrorBoundary'
import IsoView, { C, PROTO_COLOR } from '../../graph/IsoView'
import type { IsoSel } from '../../graph/IsoView'
import {
  chainOf,
  errFrac,
  factsOf,
  issuesUnder,
  itemsOf,
  routeOf,
  treeFor,
} from '../../graph/codetree'
import { SEV_RANK, fmtMem, fmtRate } from '../../graph/helpers'
import { useFleet } from '../../graph/useFleet'
import type { FleetApi } from '../../graph/useFleet'
import type {
  Agent,
  Codemap,
  Fleet,
  FleetIssue,
  FleetLink,
  FleetNode,
} from '../../graph/types'
import type { Metrics } from '../types'

const INSETS = { top: 48, right: 20, bottom: 20, left: 20 }
// Room the camera leaves for the detail popup while something is selected.
const DETAIL_INSET = 344
// Map tags and tooltips, enlarged to match the dashboard's type scale.
const MAP_UI_SCALE = 1.7
// Not drawn for now: the controller and its control links.
const HIDDEN_ROLES = new Set(['controller'])
const SYNTHETIC_ROLES = new Set(['controller', 'internet'])
const LEGEND: [string, string][] = [
  ['http', PROTO_COLOR.http],
  ['postgres', PROTO_COLOR.postgres],
  ['redis', PROTO_COLOR.redis],
  ['warning', C.amber],
  ['critical', C.red],
]

function canReboot(node: FleetNode | undefined): node is FleetNode {
  return (
    !!node &&
    node.deletable &&
    !SYNTHETIC_ROLES.has(node.role) &&
    node.status === 'running' &&
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
  return <FleetCard fl={real} agents={agents} metrics={metrics} simulated={false} />
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
  const [rebootError, setRebootError] = useState<string | null>(null)

  const feed = fl?.fleet ?? null
  const fleet = useMemo<Fleet | null>(() => {
    if (!feed) return null
    const hidden = new Set(
      feed.nodes.filter((node) => HIDDEN_ROLES.has(node.role)).map((n) => n.id),
    )
    if (!hidden.size) return feed
    return {
      ...feed,
      nodes: feed.nodes.filter((node) => !hidden.has(node.id)),
      links: feed.links.filter(
        (link) => !hidden.has(link.source) && !hidden.has(link.target),
      ),
    }
  }, [feed])
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
  const selectedLink =
    selected?.kind === 'link'
      ? links.find((link) => link.id === selected.id)
      : undefined

  // Esc steps out one level; destructive keyboard shortcuts are disabled.
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, selectedNode, codemap])

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
        <h2 id="infrastructure-title">infrastructure</h2>
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
              rightInset={selected ? DETAIL_INSET : 0}
              insets={INSETS}
              showControl={false}
              uiScale={MAP_UI_SCALE}
              compactTags
              selected={selected}
              focus={null}
              onSelect={setPicked}
              onDropRole={(role, x, y) => fl.addNode(role, { x, y })}
            />
          </ErrorBoundary>
        ) : (
          <div className="panel-empty">waiting for fleet telemetry…</div>
        )}
        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            path={selected?.kind === 'node' ? (selected.path ?? []) : []}
            codemap={codemap}
            onClose={() => setPicked(null)}
            onReboot={
              canReboot(selectedNode)
                ? () => {
                    setPicked(null)
                    setRebootError(null)
                    void fl?.rebootNode(selectedNode.id).then((ok) => {
                      if (!ok) setRebootError(`Could not reboot ${selectedNode.label}. Select the server to retry.`)
                    })
                  }
                : undefined
            }
          />
        )}
        {selectedLink && (
          <LinkDetail
            link={selectedLink}
            nodes={nodes}
            onClose={() => setPicked(null)}
          />
        )}
      </div>
      <footer className="infrastructure-footer">
        <span>
          {fleet
            ? `${servers.length} server${servers.length === 1 ? '' : 's'} · ${running} running · ${issues} issue${issues === 1 ? '' : 's'} · ${fmtRate(throughput)}`
            : 'connecting to telemetry'}
        </span>
        {fleet && simulated && (
          <span>simulated fleet · no real servers</span>
        )}
        {rebootError && <span role="alert">{rebootError}</span>}
      </footer>
    </section>
  )
}

const severityClass = (severity: string) =>
  (SEV_RANK[severity] ?? 0) >= 3 ? 'is-critical' : 'is-warning'

function DetailShell({
  title,
  sub,
  label,
  onClose,
  children,
}: {
  title: string
  sub: string
  label: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <aside className="fleet-detail" aria-label={label}>
      <header>
        <div>
          <strong title={title}>{title}</strong>
          <span title={sub}>{sub}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>
      {children}
    </aside>
  )
}

function Issues({ issues }: { issues: FleetIssue[] }) {
  if (!issues.length) return null
  const sorted = issues
    .slice()
    .sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0))
  return (
    <ul className="fleet-detail-issues">
      {sorted.slice(0, 3).map((issue) => (
        <li key={issue.id} title={issue.detail}>
          <i className={severityClass(issue.severity)} />
          {issue.title}
        </li>
      ))}
      {sorted.length > 3 && <li className="more">+{sorted.length - 3} more</li>}
    </ul>
  )
}

function NodeDetail({
  node,
  path,
  codemap,
  onClose,
  onReboot,
}: {
  node: FleetNode
  path: string[]
  codemap: Codemap | null
  onClose: () => void
  onReboot?: () => void
}) {
  const tree = treeFor(codemap, node.role)
  const items = itemsOf(tree, path)
  const item = items[items.length - 1]

  // A file or symbol is open: describe that, with the server as context.
  if (item && tree) {
    const symbol = item.sym
    const route = routeOf(tree, item)
    const facts = factsOf(item)
    return (
      <DetailShell
        title={item.label}
        sub={`${item.kind} · ${node.label}`}
        label={facts ? 'Selected item' : 'Selected code'}
        onClose={onClose}
      >
        <dl>
          {facts ? (
            <>
              {(facts.info ?? []).map(([key, value]) => (
                <Fragment key={key}>
                  <dt>{key}</dt>
                  <dd title={value}>{value}</dd>
                </Fragment>
              ))}
              {item.children.length > 0 && (
                <>
                  <dt>inside</dt>
                  <dd>{item.children.length}</dd>
                </>
              )}
            </>
          ) : item.kind === 'file' ? (
            <>
              <dt>path</dt>
              <dd>{item.key}</dd>
              <dt>lines</dt>
              <dd>{item.fileInfo?.loc ?? '—'}</dd>
            </>
          ) : (
            symbol && (
              <>
                <dt>where</dt>
                <dd>
                  {item.file.split('/').pop()}:{symbol.line}–{symbol.endLine}
                </dd>
              </>
            )
          )}
          {route && (
            <>
              <dt>req/s</dt>
              <dd>{route.rps.toFixed(route.rps >= 10 ? 0 : 2)}</dd>
              <dt>errors</dt>
              <dd>{(errFrac(route.errorRate) * 100).toFixed(2)}%</dd>
            </>
          )}
        </dl>
        <Issues issues={issuesUnder(tree, node.issues ?? [], chainOf(item))} />
      </DetailShell>
    )
  }

  return (
    <DetailShell
      title={node.label}
      sub={`${node.role} · ${node.status}`}
      label="Selected server"
      onClose={onClose}
    >
      <dl>
        {tree?.role.title && (
          <>
            <dt>runs</dt>
            <dd title={tree.role.title}>{tree.role.title}</dd>
          </>
        )}
        <dt>private</dt>
        <dd>{node.privateIp}</dd>
        <dt>public</dt>
        <dd>{node.publicIp}</dd>
        {node.status === 'running' && (
          <>
            <dt>cpu</dt>
            <dd>{Math.round(node.cpu * 100)}%</dd>
            <dt>memory</dt>
            <dd>{fmtMem(node.memUsed, node.memTotal)}</dd>
          </>
        )}
      </dl>
      <Issues issues={node.issues ?? []} />
      {onReboot && (
        <button type="button" className="fleet-detail-reboot" onClick={onReboot}>
          reboot server
        </button>
      )}
    </DetailShell>
  )
}

function LinkDetail({
  link,
  nodes,
  onClose,
}: {
  link: FleetLink
  nodes: FleetNode[]
  onClose: () => void
}) {
  const name = (id: string) => nodes.find((node) => node.id === id)?.label ?? id
  return (
    <DetailShell
      title={`${link.protocol} :${link.port}`}
      sub={`${name(link.source)} → ${name(link.target)}`}
      label="Selected connection"
      onClose={onClose}
    >
      <dl>
        <dt>connections</dt>
        <dd>{link.conns}</dd>
        <dt>forward</dt>
        <dd>{fmtRate(link.bytesPerSec)}</dd>
        <dt>reverse</dt>
        <dd>{fmtRate(link.bytesPerSecReverse)}</dd>
      </dl>
    </DetailShell>
  )
}
