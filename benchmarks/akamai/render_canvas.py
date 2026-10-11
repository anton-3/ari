from pathlib import Path
import json,sys
P=Path(__file__).resolve().parent
data=json.loads((P/'summary.json').read_text());data['smoke']=json.loads((P/'smoke.json').read_text())
code='''import { Stack, Row, Grid, H1, H2, Text, Stat, Table, LineChart, Divider, useState, useHostTheme } from "cursor/canvas";
const report: any = __DATA__;
const f = (x: number, digits=1) => x.toLocaleString(undefined,{maximumFractionDigits:digits,minimumFractionDigits:digits});
export default function AkamaiBenchmark() {
 const theme=useHostTheme();
 const [phase,setPhase]=useState("main");
 const groups=report.summary.filter((r:any)=>r.phase===phase);
 const main=report.summary.filter((r:any)=>r.phase==="main");
 const fit=report.main_prefill_fit;
 return <Stack gap={18} style={{padding:24,color:theme.text.primary,maxWidth:1200,margin:"0 auto"}}>
 <H1>Akamai text inference benchmark</H1>
 <Text tone="secondary">Source: measured POST /v1/chat/completions requests · {report.utc_start} to {report.utc_end} (UTC). Alias hackathon-chat; reported model {report.smoke.response.model}.</Text>
 <Text weight="semibold">Estimated prefill ~2.3k tokens/s; typical sustained decode ~13–16 tokens/s. Streaming arrives in bursts.</Text>
 <Row gap={36} wrap>
 <Stat value={f(fit.effective_tps,0)+" tokens/s"} label="Estimated incremental prefill"/>
 <Stat value={f(report.main_aggregate.decode_tps)+" tokens/s"} label="Measured aggregate decode"/>
 <Stat value={f(report.main_aggregate.itl_ms)+" ms"} label="Mean inter-token latency"/>
 </Row>
 <Text>Prefill estimate: inverse slope of TTFT versus actual input tokens. Main-sweep 95% bootstrap interval: {fit.bootstrap_tps_ci95.map((v:number)=>f(v,0)).join("–")} tokens/s. Independent one-output-token sweep: {f(report.prefill_prefill_fit.effective_tps,0)} tokens/s ({report.prefill_prefill_fit.bootstrap_tps_ci95.map((v:number)=>f(v,0)).join("–")} interval). These are client-observed estimates; the API provides no GPU prefill timer.</Text>
 <Grid columns="repeat(auto-fit,minmax(320px,1fr))" gap={24}>
 <Stack gap={8}><H2>Time to first content token</H2><Text size="small" tone="secondary">Y: latency (seconds) · X: input length (tokens)</Text>
 <LineChart categories={main.map((r:any)=>f(r.prompt_tokens_min,0))} series={[{name:"Median TTFT (s)",data:main.map((r:any)=>r.ttft_ms.median/1000),tone:"info"},{name:"Mean TTFT (s)",data:main.map((r:any)=>r.ttft_ms.mean/1000),tone:"neutral"}]} valueSuffix=" s" height={240}/>
 <Text size="small" tone="secondary">Source: 48 sequential trials, 8 per length, 256 output tokens. Input lengths are categories, not a linear numeric axis.</Text></Stack>
 <Stack gap={8}><H2>Decode throughput by input length</H2><Text size="small" tone="secondary">Y: decode throughput (tokens/s) · X: input length (tokens)</Text>
 <LineChart categories={main.map((r:any)=>f(r.prompt_tokens_min,0))} series={[{name:"Median decode (tokens/s)",data:main.map((r:any)=>r.decode_tps.median),tone:"info"}]} valueSuffix=" tokens/s" height={240}/>
 <Text size="small" tone="secondary">Source: same 48 trials; (completion tokens − 1)/(last-token time − first-token time).</Text></Stack>
 </Grid>
 <Divider/>
 <H2>Measurements and variation</H2>
 <label>Experiment: <select value={phase} onChange={e=>setPhase(e.target.value)} style={{background:theme.bg.elevated,color:theme.text.primary,borderColor:theme.stroke.primary,padding:6}}><option value="main">Prompt-size sweep · 256 output tokens</option><option value="prefill">Prefill check · 1 output token</option><option value="transport">Compression-disabled controls</option><option value="transport-default">Default-encoding control</option><option value="length">Output-length sweep · ~1,880 input tokens</option></select></label>
 <Table headers={["Input tokens","Output cap","Trials","TTFT median (s)","TTFT mean 95% CI (s)","TTFT range (s)","Decode median (tokens/s)","Trial-average ITL median (ms)","Individual ITL p50 (ms)","Individual ITL p95 (ms)"]} rows={groups.map((r:any)=>[`${r.prompt_tokens_min}–${r.prompt_tokens_max}`,r.max_tokens,r.n,f(r.ttft_ms.median/1000,2),r.ttft_ms.mean_ci95.map((v:number)=>f(v/1000,2)).join("–"),`${f(r.ttft_ms.min/1000,2)}–${f(r.ttft_ms.max/1000,2)}`,r.decode_tps?f(r.decode_tps.median,2):"Not applicable",r.itl_ms?f(r.itl_ms.median,2):"Not applicable",r.individual_itl_ms?f(r.individual_itl_ms.median,2):"Not applicable",r.individual_itl_ms?f(r.individual_itl_ms.p95,2):"Not applicable"])} />
 <Text size="small" tone="secondary">CI: 10,000 within-size bootstrap resamples of the mean. Individual ITL p95 pools observed adjacent-token gaps; gaps are correlated. A one-token output has no decode interval. Small trial counts support typical behavior, not precise production latency tails.</Text>
 <H2>Per-minute quota behavior</H2>
 <Text>Live headers report a 100,000-token/minute team quota. Workshop materials additionally list 60 requests/minute across endpoints. Input and output both consume the token allowance. The sequential one-token sweep also hit a 429: a ~28,763-token request was accepted with 3,223 tokens remaining, followed by rejection of a small request. This is consistent with checking balance before a request, then charging actual usage, allowing an overshoot. The 429 returned request-bucket headers (limit 60, 49 remaining), so its headers alone do not identify the exhausted token bucket. The live observations are below. Serial main-sweep requests encountered no 429s, with the lowest observed pre-request balance {f(report.main_aggregate.min_rate_remaining,0)} tokens.</Text>
 <Text>At 28,800 input + 256 output tokens, three calls consume about 87,000 tokens and four about 116,000 tokens. Thus even modest concurrency can exhaust the allowance. A ~1,880-input/256-output chat uses ~2,136 tokens: roughly 46 such calls fit in 100,000 tokens, below the documented 60-request limit. These are arithmetic budgets, not measured maximum serving rates.</Text>
 <Table headers={["UTC request start","Trial","HTTP","Prompt tokens","Output tokens","Quota remaining header","Reset delay (s)","Result"]} rows={report.quota_tests.map((r:any)=>[r.utc.slice(11,23),`${r.phase} ${r.trial}`,r.status,r.usage?.prompt_tokens??"—",r.usage?.completion_tokens??"—",r.rate_headers["x-ratelimit-remaining"]??"—",r.rate_headers["x-ratelimit-reset"]??"—",r.error||(r.status===429?"Rate-limited":r.finish_reason??"—")])} />
 <Text>Burst tests use four simultaneous ~28,800-token prompts with one output token, followed by probes if needed, in two separate minute windows. After each burst we wait 65 seconds and test recovery. All 429 attempts, burst and recovery timings are excluded from the latency estimates. Four concurrent large prompts were admitted from a fresh budget and used about 115,000 tokens; the follow-up probe was rejected despite over 50 requests still remaining. Admission headers therefore do not reserve the full cost of in-flight work. The quota is shared with other users of the same team key; counters may include their traffic.</Text>
 <H2>Method and scope</H2>
 <Text>{report.total_attempts} recorded benchmark attempts; {report.successful} successful with usage and content; {f(report.total_usage_tokens,0)} actual input + output tokens. Smoke test returned “Connection successful.” Only the text generation endpoint was called.</Text>
 <Text>Python requests with persistent connections for sequential tests; streaming SSE parsed immediately with chunk_size=1 and monotonic timestamps. Unique identifier near the beginning of every prompt limits prefix-cache reuse; the remaining context is controlled repeated prose. Six input lengths, randomized order, eight trials each; independent randomized one-token sweep, five trials per input length; randomized output caps 32/128/512/1024, three trials each at fixed context. Temperature 0; thinking disabled and reasoning token usage checked. Warmups excluded. Three 256-token compression-disabled controls plus one default-encoding control check stream delivery. Total reported reasoning tokens: {report.thinking_tokens}.</Text>
 <Text>TTFT runs from request start to first nonempty content event, including connection, transfer, gateway, queue, prefill, first-token generation and delivery. Decode uses server-reported completion-token counts. All content-event counts were checked against token counts; mismatch count: {report.event_mismatches.length}. Mean ITL is decode duration/(completion tokens − 1). Aggregate decode is total token intervals divided by total decode time. SSE delivery can bunch or delay tokens; observed ITL is client-visible delivery latency. Many individual gaps are below 1 ms while others exceed 3 seconds, so individual-gap p50 is not a GPU decode time. Compression-disabled and default-encoding controls both returned uncompressed chunked text/event-stream and retained the bursty delivery.</Text>
 <Text>Prefill regression fits TTFT = intercept + slope × input tokens. Header-adjusted main-sweep fit: {f(fit.headers_adjusted_fit.effective_tps,0)} tokens/s, used only as sensitivity analysis because headers do not establish the exact start of GPU prefill. Retain all successful outliers. Shared load, network and batching make the estimate specific to this run. Context repetition is controlled but does not cover every content distribution. No concurrency capacity, GPU topology, or maximum-output-limit claim is inferred.</Text>
 <Text tone="secondary" size="small">Evidence: benchmarks/akamai/runs.jsonl (all SSE timestamps, usage, quota headers); summary.json (statistics and confidence intervals); benchmark.py and analyze.py (reproducible method). Credentials are loaded from .env in memory and never written to artifacts.</Text>
 </Stack>;
}
'''
code=code.replace('__DATA__',json.dumps(data,separators=(',',':')))
Path(sys.argv[1]).write_text(code)
