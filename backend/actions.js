// Ari's non-Linode tools: security actions (demo-safe stubs) + live telemetry hooks.
// The telemetry tools talk to the telemetry service so Ari can read live traffic on a
// call and post findings that show up on the dashboard in real time.
const TELEMETRY_URL = process.env.TELEMETRY_URL || "http://localhost:8090";
import { demoJobs, narrate } from './demo-jobs.js';

async function tget(path) {
  const res = await fetch(`${TELEMETRY_URL}${path}`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`telemetry ${res.status}`);
  return res.json();
}
async function tpost(path, body, timeoutMs = 15000) {
  const res = await fetch(`${TELEMETRY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `telemetry ${res.status}`);
  return res.json();
}

export const tools = [
  {
    type: "function",
    function: {
      name: "deploy_agents",
      description:
        "Dispatch a swarm of helper agents to scan the team's own repo and infrastructure for security issues. Use when asked to kick off a scan, look into things, or add more agents. They show up moving on the live graph.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "How many agents to deploy (1-20)." },
          type: {
            type: "string",
            description: "Optional kind of agent: scanner, log-watcher, verifier, or remediator. Omit to mix.",
          },
          focus: {
            type: "string",
            description: "Optional area to focus on, e.g. 'payments service', 'auth', or a file name.",
          },
        },
        required: ["count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_agents",
      description: "Check what the deployed agents are doing right now (how many are working, and any findings).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_agents",
      description: "Stand down the deployed agents and wind the swarm back to idle.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_live_metrics",
      description: "Check the current live traffic and health of the infrastructure (requests/sec, error rate, latency, active users).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "report_vulnerability",
      description: "Log a security finding so it appears on the team's live dashboard. Use when you've identified a concrete vulnerability.",
      parameters: {
        type: "object",
        properties: {
          severity: { type: "string", description: "critical | high | medium | low" },
          title: { type: "string", description: "Short description, e.g. 'SQL injection in /api/transactions'" },
          endpoint: { type: "string", description: "Affected endpoint or component, if known" },
        },
        required: ["severity", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rollback_commit",
      description: "Roll back a commit: reverts it on a new branch and opens a real GitHub pull request (never pushes to main), then texts the link. Confirm with the person first.",
      parameters: {
        type: "object",
        properties: {
          sha: { type: "string", description: "The commit SHA to revert" },
          project: { type: "string", description: "Project/repo name, if known" },
        },
        required: ["sha"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rotate_secret",
      description: "Rotate a leaked credential on the live bank: generates a new value, deploys it to every app node with a rolling restart. Supported: the Stripe secret key, the session signing secret (rotating it signs everyone out). Confirm first.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Which secret/key, e.g. 'Stripe live key'" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "block_ips",
      description:
        "Ban the latest retained incident's source IP addresses at the load balancer. After approval, call with empty arguments {}; the incident is resolved internally. Returns the background operation state.",
      parameters: {
        type: "object",
        properties: {
          ips: {
            type: "array",
            items: { type: "string" },
            description: "IP addresses to ban. Omit to ban the current attackers from the live incident.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_incident",
      description:
        "Read the current live incident on the fleet (e.g. a denial-of-service attack): whether one is active, the request rate, and the attacking source IP addresses.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "scale_web_app",
      description:
        "Activate the prepared web-03 node on Akamai Cloud to serve MyFiat. Returns promptly while health checks and joining the reverse proxy continue in the background. Use for requests to spin up another web node.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "How many app nodes to add (default 1)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_rate_limit_pr",
      description:
        "Implement new rate limiting in the reverse-proxy (load balancer) nginx config, in a NEW git branch, open a pull request, and text the caller the PR link. Call this once when asked to add rate limiting as a PR.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "Optional short note for the PR description." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_ports",
      description: "Close exposed ports on a fleet node (by label) or the whole fleet: blocks public access with the firewall while keeping the private network between servers open, then verifies from outside. Will not close SSH (22) or the load balancer's web ports. Confirm first.",
      parameters: {
        type: "object",
        properties: {
          ports: { type: "array", items: { type: "integer" }, description: "Port numbers to close, e.g. [22, 5432]" },
          label: { type: "string", description: "Instance label, or omit for the whole fleet" },
        },
        required: ["ports"],
      },
    },
  },
];

export async function runTool(name, args = {}, context = {}) {
  try {
    if (name === "deploy_agents") {
      const count = Math.max(1, Math.min(20, parseInt(args.count, 10) || 1));
      const data = await tpost("/api/agents/deploy", {
        count,
        type: args.type || undefined,
        focus: args.focus || undefined,
      });
      const n = data.agents?.length ?? count;
      const where = args.focus ? ` on ${args.focus}` : "";
      return `Deployed ${n} ${args.type || ""} agent${n > 1 ? "s" : ""}${where}. They're fanning out across the graph now; I'll flag anything they confirm.`;
    }
    if (name === "list_agents") {
      const data = await tget("/api/agents");
      const agents = data.agents || [];
      if (!agents.length) return "No agents are deployed right now.";
      const working = agents.filter((a) => a.status === "working" || a.status === "dispatched").length;
      const done = agents.filter((a) => a.status === "done").length;
      const findings = (data.events || []).filter((e) => e.finding || e.type === "finding").length;
      return `${agents.length} agents out: ${working} still working, ${done} wrapped up${findings ? `, ${findings} finding${findings > 1 ? "s" : ""} so far` : ", nothing confirmed yet"}.`;
    }
    if (name === "recall_agents") {
      await tpost("/api/agents/recall", {});
      return "Recalling the swarm now. They're standing down to idle.";
    }
    if (name === "get_live_metrics") {
      const m = await tget("/api/metrics");
      if (m.stale) return 'Request measurements are currently unavailable or stale.';
      return `Live right now: ${Math.round(m.requestsPerMinute)} requests per minute, ${m.requestsLast180s} requests in the last three minutes, ${(m.errorRate * 100).toFixed(1)} percent server errors. Traffic pattern looks ${m.mode === "surge" ? "abnormal, like an attack" : "normal"}.`;
    }
    if (name === "report_vulnerability") {
      await tpost("/api/vulns", {
        severity: args.severity,
        title: args.title,
        endpoint: args.endpoint || "",
        status: "open",
      });
      return `Logged a ${args.severity} finding to the dashboard: ${args.title}.`;
    }
    if (name === "rollback_commit") {
      const { rollbackCommit } = await import("./rollback.js");
      const r = await rollbackCommit({ sha: args.sha, reason: args.reason || "" });
      if (!r.ok) return `I couldn't roll that back: ${r.error}.`;
      return `I opened pull request ${r.number} reverting ${r.sha}, "${r.subject}", on branch ${r.branch}. Merge it to roll back. I've texted you the link.`;
    }
    if (name === "rotate_secret") {
      const r = await tpost("/api/fleet/rotate-secret", { name: args.name }, 180000);
      const nodes = r.results.map((x) => x.label).join(", ");
      if (!r.ok) return `Rotation of the ${r.secret} stopped partway (${r.results.filter((x) => x.ok).length} of ${r.results.length} nodes); the rest still use the old value.`;
      return `Rotated the ${r.secret}. The new value ends in ${r.fingerprint.slice(-4)} and is live on ${nodes} after a rolling restart. ${r.note}`;
    }
    if (name === "get_incident") {
      const inc = await tget("/api/fleet/incident");
      if (!inc.active) return "No active incident on the fleet right now. Traffic looks normal.";
      const ips = (inc.attackerIps || []).map((a) => a.ip);
      return `Active incident on ${inc.label || "the load balancer"}: about ${Math.round(inc.reqPerSec)} requests a second, baseline is ${Math.round(inc.baselineRps || 0)}. Looks like a denial-of-service flood from ${ips.length} source${ips.length === 1 ? "" : "s"}: ${ips.join(", ")}.`;
    }
    if (name === "block_ips") {
      const inc = context.incidentId ? { id: context.incidentId } : await tget('/api/fleet/incident');
      if (!inc.id) return 'There is no retained incident to ban.';
      const job = demoJobs.start(`block:${inc.id}`, async () => {
        await narrate('Approval received. Applying the incident IP blocklist at the reverse proxy.');
        return tpost('/api/fleet/block-ips', { ips: args.ips, incidentId: inc.id });
      });
      return job.status === 'running' ? 'Applying the incident IP bans now. I will confirm completion on the dashboard.' : JSON.stringify(job);
    }
    if (name === "scale_web_app") {
      if (args.count != null && Number(args.count) !== 1) return 'The prepared demo supports activating one additional web node.';
      const r = await tpost('/api/fleet/activate-web', { incidentId: context.incidentId });
      return `web-03 activation ${r.operation.status} on Akamai Cloud. The prepared node is being checked and will join the reverse proxy as soon as it is ready.`;
    }
    if (name === "open_rate_limit_pr") {
      const { openRateLimitPr } = await import("./rate-limit-pr.js");
      const key = context.incidentId || context.callSid || 'manual';
      const job = demoJobs.start(`pr:${key}`, () => openRateLimitPr({ note: args.note || '', to: context.recipient }));
      return job.status === 'running' ? 'I am creating the rate-limiting branch and pull request now. I will text the link when it is ready; this continues after we hang up.' : JSON.stringify(job);
    }
    if (name === "block_ips_LEGACY_UNUSED") {
      const ips = (args.ips || []).join(", ");
      return `Blocked ${ips} at the edge firewall. That traffic is being dropped now.`;
    }
    if (name === "close_ports") {
      const r = await tpost("/api/fleet/close-ports", { ports: args.ports, label: args.label }, 120000);
      const lines = r.results.map((x) => `${x.label}: ${x.closed.length ? `closed ${x.closed.join(", ")}` : "nothing closed"}`
        + `${x.refused.length ? ` (kept ${x.refused.join(", ")} open, closing them would cut off SSH or the website)` : ""}`
        + `${x.stillOpen.length ? `; ${x.stillOpen.join(", ")} still reachable` : ""}${x.error ? `; failed: ${x.error}` : ""}`);
      return `${r.ok ? "Done, verified from outside." : "Partly done."} ${lines.join(". ")}. The private network between the servers still works.`;
    }
    return `Unknown tool: ${name}`;
  } catch (err) {
    if (name === "get_live_metrics" || name === "report_vulnerability") {
      return `I couldn't reach the monitoring service just now (${err.message}).`;
    }
    return `That action failed: ${err.message}`;
  }
}
