// Tools that let Ari inspect and control Linode compute instances over the phone.
// Shutdown/boot are reversible; delete is intentionally NOT exposed to the live call.
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
