// Delete all instances Ari provisioned during demos (tagged "ari-provisioned").
// The permanent target app (ari-demo-payments-api) is NOT tagged this way, so it's left alone.
const TOKEN = process.env.LINODE_API_TOKEN;
const res = await fetch("https://api.linode.com/v4/linode/instances?page_size=100", {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const { data } = await res.json();
const targets = data.filter((i) => (i.tags || []).includes("ari-provisioned"));
if (!targets.length) {
  console.log("No provisioned demo nodes to clean up.");
  process.exit(0);
}
for (const i of targets) {
  const d = await fetch(`https://api.linode.com/v4/linode/instances/${i.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  console.log(`${d.ok ? "deleted" : "FAILED"}: ${i.label}`);
}
