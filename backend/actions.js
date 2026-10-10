// Ari's non-Linode tools: security actions (demo-safe stubs) + live telemetry hooks.
// The telemetry tools talk to the telemetry service so Ari can read live traffic on a
// call and post findings that show up on the dashboard in real time.
const TELEMETRY_URL = process.env.TELEMETRY_URL || "http://localhost:8090";

async function tget(path) {
  const res = await fetch(`${TELEMETRY_URL}${path}`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`telemetry ${res.status}`);
  return res.json();
}
async function tpost(path, body) {
  const res = await fetch(`${TELEMETRY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`telemetry ${res.status}`);
  return res.json();
}

export const tools = [
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
      description: "Roll back a specific git commit on a project to undo a bad or insecure change. Confirm with the person first.",
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
      description: "Rotate and revoke a leaked credential or API key that was exposed.",
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
      description: "Block one or more source IP addresses at the edge firewall, e.g. during a brute-force or scan.",
      parameters: {
        type: "object",
        properties: { ips: { type: "array", items: { type: "string" }, description: "IP addresses to block" } },
        required: ["ips"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_ports",
      description: "Close exposed network ports on an instance or the whole fleet to tighten the firewall.",
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

export async function runTool(name, args) {
  try {
    if (name === "get_live_metrics") {
      const m = await tget("/api/metrics");
      return `Live right now: ${Math.round(m.rps)} requests a second, ${(m.errorRate * 100).toFixed(1)} percent errors, ${Math.round(m.latencyMs)} millisecond latency, ${m.activeUsers} active users. Traffic pattern looks ${m.mode === "surge" ? "abnormal, like an attack" : "normal"}.`;
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
      return `Rolling back commit ${args.sha}${args.project ? ` on ${args.project}` : ""} now. The bad change is reverted and the service is redeploying the previous good build.`;
    }
    if (name === "rotate_secret") {
      return `Rotated ${args.name} and revoked the exposed key. New secret is in the vault; I've queued a history purge so the old one can't be recovered from the repo.`;
    }
    if (name === "block_ips") {
      const ips = (args.ips || []).join(", ");
      return `Blocked ${ips} at the edge firewall. That traffic is being dropped now.`;
    }
    if (name === "close_ports") {
      const ports = (args.ports || []).join(", ");
      return `Closed port${(args.ports || []).length > 1 ? "s" : ""} ${ports} on ${args.label || "the whole fleet"}. Those are no longer reachable from outside.`;
    }
    return `Unknown tool: ${name}`;
  } catch (err) {
    if (name === "get_live_metrics" || name === "report_vulnerability") {
      return `I couldn't reach the monitoring service just now (${err.message}).`;
    }
    return `That action failed: ${err.message}`;
  }
}
