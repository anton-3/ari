// Convenience CLI to flip simulation modes from a terminal.
// Usage: node src/cli.js surge   |   node src/cli.js normal
const mode = (process.argv[2] || '').toLowerCase();
const PORT = parseInt(process.env.PORT || '8090', 10);
const BASE = process.env.TELEMETRY_URL || `http://localhost:${PORT}`;

if (mode !== 'surge' && mode !== 'normal') {
  console.error('Usage: node src/cli.js <surge|normal>');
  process.exit(1);
}

try {
  const res = await fetch(`${BASE}/api/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const json = await res.json();
  console.log(`[ari-telemetry] mode -> ${json.mode || mode}`, json);
} catch (e) {
  console.error(`[ari-telemetry] failed to reach ${BASE}. Is the service running?`);
  console.error(String(e));
  process.exit(1);
}
