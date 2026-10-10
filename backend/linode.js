// Tools that let Ari inspect and control Linode compute instances over the phone.
// Shutdown/boot/provision are reversible or cleanable; delete is intentionally NOT
// exposed to the live call (cleanup is a separate CLI: `npm run cleanup-nodes`).
import { randomBytes as _rand } from "node:crypto";
const randomBytes = (n) => _rand(n).toString("base64url").slice(0, n);
const TOKEN = process.env.LINODE_API_TOKEN;

async function api(path, method = "GET", body) {
  const res = await fetch(`https://api.linode.com/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errors?.[0]?.reason || `Linode API ${res.status}`);
  return data;
}

async function findByLabel(label) {
  const { data } = await api("/linode/instances");
  const want = (label || "").toLowerCase();
  // Exact label match first, then a loose contains-match so "payments" finds "ari-demo-payments-api".
  return (
    data.find((i) => i.label.toLowerCase() === want) ||
    data.find((i) => i.label.toLowerCase().includes(want)) ||
    null
  );
}

// OpenAI-style tool definitions advertised to the model.
export const tools = [
  {
    type: "function",
    function: {
      name: "list_instances",
      description: "List all compute instances with their label, status, region, and public IP.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "provision_instances",
      description:
        "Spin up one or more NEW compute instances, e.g. to absorb a traffic surge or scale out. Uses sensible defaults; only set size or region if the person actually specifies them. Returns the new instances and their IPs.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "integer", description: "How many new instances to create (1-10)." },
          role: {
            type: "string",
            description: "Optional short role name used in the labels, e.g. 'web' or 'edge'. Defaults to 'node'.",
          },
          size: {
            type: "string",
            description:
              "Optional. ONLY set this if the person specifies a size/plan. Accepts 'small', 'medium', 'large', or a raw Linode plan id like 'g6-standard-2'. Leave unset for the default.",
          },
          region: {
            type: "string",
            description:
              "Optional. ONLY set this if the person specifies a location. A Linode region id like 'us-ord', 'us-east', 'eu-west'. Leave unset for the default.",
          },
        },
        required: ["count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shutdown_instance",
      description: "Power off a compute instance, identified by its label or part of it. Reversible with boot_instance.",
      parameters: {
        type: "object",
        properties: { label: { type: "string", description: "The instance label, e.g. 'payments-api'" } },
        required: ["label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "boot_instance",
      description: "Power a compute instance back on, identified by its label or part of it.",
      parameters: {
        type: "object",
        properties: { label: { type: "string", description: "The instance label" } },
        required: ["label"],
      },
    },
  },
];

// Execute a tool call. Returns a short string the model reads back to the caller.
export async function runTool(name, args) {
  try {
    if (name === "list_instances") {
      const { data } = await api("/linode/instances");
      if (!data.length) return "There are no compute instances right now.";
      return data
        .map((i) => `${i.label}: ${i.status}, ${i.region}, ${i.ipv4?.[0] || "no ip"}`)
        .join("; ");
    }

    if (name === "provision_instances") {
      const count = Math.max(1, Math.min(10, parseInt(args.count, 10) || 1));
      const role = (args.role || "node").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "node";
      const region = args.region?.trim() || process.env.LINODE_REGION || "us-ord";
      // Friendly size words -> Linode plan ids; a raw plan id passes through. Default: nanode.
      const sizeMap = { small: "g6-nanode-1", medium: "g6-standard-2", large: "g6-standard-4" };
      const sizeArg = args.size?.trim().toLowerCase();
      const type = sizeArg ? sizeMap[sizeArg] || args.size.trim() : process.env.LINODE_TYPE || "g6-nanode-1";
      const stamp = Date.now().toString(36).slice(-4);
      const created = [];
      let capped = false;
      for (let n = 1; n <= count; n++) {
        try {
          const inst = await api("/linode/instances", "POST", {
            label: `ari-${role}-${stamp}-${n}`,
            region,
            type,
            image: "linode/ubuntu24.04",
            root_pass: `Ari-${randomBytes(18)}!`,
            booted: true,
            tags: ["ari-demo", "ari-provisioned"],
          });
          created.push(inst);
        } catch (err) {
          // Partial success matters: report how many came up rather than discarding them.
          if (/limit/i.test(err.message)) capped = true;
          break;
        }
      }
      if (!created.length) {
        return capped
          ? "I couldn't start any — the account is already at its service limit. We'd need Linode to raise the cap first."
          : "I couldn't start any new instances just now.";
      }
      const ips = created.map((i) => `${i.label} (${i.ipv4?.[0] || "ip pending"})`).join(", ");
      const base = `Spun up ${created.length} new ${type} instance${created.length > 1 ? "s" : ""} in ${region}: ${ips}. They're booting now.`;
      return capped
        ? `${base} That's as many as the account's service limit allows right now; I can add more once Linode raises the cap.`
        : base;
    }

    if (name === "shutdown_instance" || name === "boot_instance") {
      const inst = await findByLabel(args.label);
      if (!inst) return `No instance matching "${args.label}". Use list_instances to see what's running.`;
      const action = name === "shutdown_instance" ? "shutdown" : "boot";
      await api(`/linode/instances/${inst.id}/${action}`, "POST");
      const verb = action === "shutdown" ? "powering off" : "booting up";
      return `Done: ${verb} ${inst.label} (was ${inst.status}).`;
    }

    return `Unknown tool: ${name}`;
  } catch (err) {
    return `That action failed: ${err.message}`;
  }
}
