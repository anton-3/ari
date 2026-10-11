import json,statistics,random,math,datetime
from pathlib import Path
P=Path(__file__).resolve().parent
rows=[json.loads(l) for l in (P/'runs.jsonl').read_text().splitlines()]
def pct(v,p):
 v=sorted(v);i=(len(v)-1)*p;a=int(i);return v[a]+(v[min(a+1,len(v)-1)]-v[a])*(i-a)
def stats(v):return dict(n=len(v),mean=statistics.mean(v),median=statistics.median(v),p95=pct(v,.95),min=min(v),max=max(v),sd=statistics.stdev(v) if len(v)>1 else 0)
def bootstrap(v):
 rng=random.Random(822);m=[statistics.mean(rng.choices(v,k=len(v))) for _ in range(10000)];return [pct(m,.025),pct(m,.975)]
success=[r for r in rows if r.get('status')==200 and r.get('usage') and r.get('events_s')]
for r in success:
 n=r['usage']['completion_tokens'];events=r['events_s'];r['decode_tps']=(n-1)/r['decode_s'] if n>1 and r['decode_s']>0 else None
 r['itl_ms']=r['decode_s']*1000/(n-1) if n>1 else None
 r['event_gaps_ms']=[(b-a)*1000 for a,b in zip(events,events[1:])]
 r['event_count']=len(events);r['events_match_tokens']=len(events)==n
summary=[]
for phase in ['main','length','prefill','transport','transport-default']:
 for s,cap in sorted({(r['size_repetitions'],r['max_tokens']) for r in success if r['phase']==phase}):
  group=[r for r in success if r['phase']==phase and r['size_repetitions']==s and r['max_tokens']==cap]
  item={'phase':phase,'size_repetitions':s,'max_tokens':cap,'prompt_tokens_min':min(r['usage']['prompt_tokens'] for r in group),'prompt_tokens_max':max(r['usage']['prompt_tokens'] for r in group),'n':len(group),'all_one_token_events':all(r['events_match_tokens'] for r in group)}
  for key in ['ttft_ms','headers_ms','total_s','decode_tps','itl_ms']:
   vals=[r[key] for r in group if r.get(key) is not None]
   if vals:item[key]=stats(vals);item[key]['mean_ci95']=bootstrap(vals)
  gaps=[g for r in group for g in r['event_gaps_ms']]
  if gaps:item['individual_itl_ms']=stats(gaps)
  item['completion_tokens']=stats([r['usage']['completion_tokens'] for r in group]);summary.append(item)
result={'utc_start':rows[0]['utc'],'utc_end':max(datetime.datetime.fromisoformat(r['utc'])+datetime.timedelta(seconds=r['total_s']) for r in rows).isoformat(),'total_attempts':len(rows),'successful':len(success),'status_counts':{str(s):sum(r.get('status')==s for r in rows) for s in {r.get('status') for r in rows}},'total_usage_tokens':sum(r['usage']['total_tokens'] for r in success),'summary':summary,'errors':[r for r in rows if r.get('status')!=200 or r.get('error')],'quota_tests':[r for r in rows if r['phase'] in ['burst','recovery'] or r.get('status')==429],'event_mismatches':[{'phase':r['phase'],'trial':r['trial'],'n_tokens':r['usage']['completion_tokens'],'n_events':len(r['events_s'])} for r in success if not r['events_match_tokens']]}
# Per-trial regression controls for slow drift via trial intercepts; ordinary regression pooled too.
main=[r for r in success if r['phase']=='main'];xs=[r['usage']['prompt_tokens'] for r in main];ys=[r['ttft_ms']/1000 for r in main]
if len(main)>2:
 xm=statistics.mean(xs);ym=statistics.mean(ys);slope=sum((x-xm)*(y-ym) for x,y in zip(xs,ys))/sum((x-xm)**2 for x in xs);intercept=ym-slope*xm;res=[y-intercept-slope*x for x,y in zip(xs,ys)];se=math.sqrt(sum(e*e for e in res)/(len(xs)-2)/sum((x-xm)**2 for x in xs))
 result['prefill_regression']={'slope_seconds_per_token':slope,'intercept_seconds':intercept,'slope_normal_ci95':[slope-1.96*se,slope+1.96*se],'effective_incremental_tps':1/slope if slope>0 else None,'r_squared':1-sum(e*e for e in res)/sum((y-ym)**2 for y in ys)}
(P/'summary.json').write_text(json.dumps(result,indent=2))
for s in summary: print(s['phase'],s['prompt_tokens_min'],s['max_tokens'],'n=',s['n'],'TTFT',round(s['ttft_ms']['median'],1),'decode',round(s.get('decode_tps',{}).get('median',0),2),'ITL',round(s.get('itl_ms',{}).get('median',0),2))
print({k:v for k,v in result.items() if k not in ['summary','errors','quota_tests']})

def fit(group,adjust_headers=False):
 x=[r['usage']['prompt_tokens'] for r in group];y=[r['ttft_ms']/1000-(r['headers_ms']/1000 if adjust_headers else 0) for r in group]
 xm=statistics.mean(x);ym=statistics.mean(y);den=sum((z-xm)**2 for z in x)
 if not den:return None
 slope=sum((xx-xm)*(yy-ym) for xx,yy in zip(x,y))/den
 return slope,ym-slope*xm
for phase in ['main','prefill']:
 group=[r for r in success if r['phase']==phase]
 if len({r['size_repetitions'] for r in group})<6:continue
 bins=[[r for r in group if r['size_repetitions']==s] for s in sorted({r['size_repetitions'] for r in group})]
 rng=random.Random(906);fits=[fit([r for b in bins for r in rng.choices(b,k=len(b))])[0] for _ in range(10000)];slope,intercept=fit(group);lo,hi=pct(fits,.025),pct(fits,.975)
 result[phase+'_prefill_fit']={'n':len(group),'slope_ms_per_token':slope*1000,'intercept_s':intercept,'effective_tps':1/slope,'bootstrap_tps_ci95':[1/hi,1/lo] if lo>0 else None,'bootstrap_slope_ci95':[lo,hi],'headers_adjusted_fit':{'effective_tps':1/fit(group,True)[0],'intercept_s':fit(group,True)[1]}}
if main:
 result['main_aggregate']={'decode_tps':sum(r['usage']['completion_tokens']-1 for r in main)/sum(r['decode_s'] for r in main),'itl_ms':sum(r['decode_s'] for r in main)*1000/sum(r['usage']['completion_tokens']-1 for r in main),'min_rate_remaining':min(int(r['rate_headers'].get('x-ratelimit-remaining',100000)) for r in main)}
(P/'summary.json').write_text(json.dumps(result,indent=2))
print({k:v for k,v in result.items() if k.endswith('_fit') or k=='main_aggregate'})

result['quota_tests']=sorted(result['quota_tests']+[rows[i+1] for i,r in enumerate(rows[:-1]) if r.get('status')==429 and rows[i+1]['phase']==r['phase'] and rows[i+1]['trial']==r['trial']],key=lambda r:r['utc'])
result['transport_controls']=[{k:v for k,v in r.items() if k not in ['event_chars','events_s']} for r in success if r['phase'].startswith('transport')]
result['thinking_tokens']=sum(r['usage'].get('completion_tokens_details',{}).get('reasoning_tokens',0) for r in success)
result['finish_counts']={f:sum(r['finish_reason']==f for r in success) for f in {r['finish_reason'] for r in success}}
(P/'summary.json').write_text(json.dumps(result,indent=2))
