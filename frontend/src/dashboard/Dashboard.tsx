import './dashboard.css'
import { useTelemetry } from './useTelemetry'
import { TopBar } from './components/TopBar'
import { StatTiles } from './components/StatTiles'
import { TrafficPanel } from './components/TrafficPanel'
import { TopologyPanel } from './components/TopologyPanel'
import { VulnsPanel } from './components/VulnsPanel'
import { LogStream } from './components/LogStream'

export default function Dashboard() {
  const { metrics, logs, topology, vulns, source } = useTelemetry()

  return (
    <div className="ari">
      <TopBar source={source} />
      <main className="ari__main">
        <StatTiles metrics={metrics} />
        <TrafficPanel metrics={metrics} />
        <TopologyPanel topology={topology} />
        <VulnsPanel vulns={vulns} />
        <LogStream logs={logs} />
      </main>
    </div>
  )
}
