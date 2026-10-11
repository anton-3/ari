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
      description:
        "Ban source IP addresses at the load balancer during an incident (e.g. a denial-of-service flood). If you omit ips, the current attacking IPs from the live incident are banned.",
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
        "Add another node to serve the web app (MyFiat), e.g. to absorb a traffic surge. It boots on our cloud and joins the load balancer automatically.",
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
    if (name === "get_incident") {
      const inc = await tget("/api/fleet/incident");
      if (!inc.active) return "No active incident on the fleet right now. Traffic looks normal.";
      const ips = (inc.attackerIps || []).map((a) => a.ip);
      return `Active incident on ${inc.label || "the load balancer"}: about ${Math.round(inc.reqPerSec)} requests a second, baseline is ${Math.round(inc.baselineRps || 0)}. Looks like a denial-of-service flood from ${ips.length} source${ips.length === 1 ? "" : "s"}: ${ips.join(", ")}.`;
    }
    if (name === "block_ips") {
      let ips = Array.isArray(args.ips) ? args.ips.filter(Boolean) : [];
      if (!ips.length) {
        const inc = await tget("/api/fleet/incident").catch(() => ({}));
        ips = (inc.attackerIps || []).map((a) => a.ip);
      }
      if (!ips.length) return "No IPs to ban — I couldn't find any attacking addresses in the current incident.";
      const data = await tpost("/api/fleet/block-ips", { ips });
      const blocked = data.blocked || ips;
      return `Banned ${blocked.join(", ")} at the load balancer. That traffic is being dropped now, and the request rate should settle.`;
    }
    if (name === "scale_web_app") {
      const count = Math.max(1, Math.min(5, parseInt(args.count, 10) || 1));
      const made = [];
      for (let i = 0; i < count; i++) {
        const r = await tpost("/api/fleet/nodes", { role: "app" });
        if (r.node) made.push(r.node.label || r.node.id);
      }
      if (!made.length) return "I couldn't add a node right now — the fleet may be at capacity.";
      return `Spinning up ${made.length} more app node${made.length > 1 ? "s" : ""} on the cloud (${made.join(", ")}). ${made.length > 1 ? "They're" : "It's"} booting and will join the load balancer automatically in a few minutes.`;
    }
    if (name === "open_rate_limit_pr") {
      const { openRateLimitPr } = await import("./rate-limit-pr.js");
      const r = await openRateLimitPr({ note: args.note || "" });
      if (!r.ok) return `I couldn't open the PR: ${r.error}. I'll flag it and we can do it manually.`;
      return `Done — I pushed the rate-limiting change to branch ${r.branch} and opened the pull request. I've texted you the link${r.url ? "" : " (PR created)"}.`;
    }
    if (name === "block_ips_LEGACY_UNUSED") {
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
