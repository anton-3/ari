"""Client-observed SSE benchmark. Secrets loaded locally and never recorded."""
import requests,time,json,random,uuid,datetime,argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=Path(__file__).resolve().parent
cfg={k:v.strip().strip('\"\'') for l in (ROOT/'.env').read_text().splitlines() if '=' in l and not l.lstrip().startswith('#') for k,v in [l.split('=',1)]}
session=requests.Session()
session.headers['Authorization']='Bearer '+cfg['OPENAI_API_KEY']
session.headers['Accept-Encoding']='identity'
url=cfg['OPENAI_BASE_URL'].rstrip('/')+'/chat/completions'
def run(size,cap,phase,trial):
 # Unique first tokens defeat cross-request prefix caching; fixed rest controls content.
 prompt=f'Unique benchmark identifier: {uuid.uuid4()}.\n'
 prompt+='Read the following context before answering.\n'+('The river flows past the quiet town and the old stone bridge.\n'*size)
 prompt+='\nWrite a very long detailed essay about rivers, bridges, ecology, and town life. Keep writing until the output limit. Do not mention this benchmark.'
 payload={'model':cfg.get('CHAT_MODEL','hackathon-chat'),'messages':[{'role':'user','content':prompt}], 'max_tokens':cap,'temperature':0,'stream':True,'stream_options':{'include_usage':True},'chat_template_kwargs':{'enable_thinking':False}}
 start=time.perf_counter(); times=[]; usage=None; finish=None; content=[]; chunks=[]
 row={'phase':phase,'size_repetitions':size,'max_tokens':cap,'trial':trial,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'prompt_chars':len(prompt)}
 try:
  transport=session
  if phase=='burst':
   transport=requests.Session();transport.headers.update(session.headers)
  r=transport.post(url,json=payload,stream=True,timeout=(20,180))
  row['headers_ms']=(time.perf_counter()-start)*1000;row['status']=r.status_code
  row['response_transport']={k:v for k,v in r.headers.items() if k.lower() in ['content-encoding','content-type','transfer-encoding','server','via','x-accel-buffering']}
  row['rate_headers']={k:v for k,v in r.headers.items() if 'ratelimit' in k.lower() or 'retry' in k.lower()}
  if r.status_code!=200:
   row['error']=r.text[:1500]
  else:
   for line in r.iter_lines(chunk_size=1):
    if not line.startswith(b'data:'):continue
    raw=line[5:].strip()
    if raw==b'[DONE]':break
    obj=json.loads(raw)
    if obj.get('usage'):usage=obj['usage']
    for choice in obj.get('choices',[]):
     d=choice.get('delta',{});txt=d.get('content') or d.get('reasoning_content') or ''
     if txt:
      now=time.perf_counter();times.append(now-start);content.append(txt);chunks.append(len(txt))
     if choice.get('finish_reason'):finish=choice['finish_reason']
   row.update(usage=usage,finish_reason=finish,events_s=times,event_chars=chunks,output_chars=len(''.join(content)),output_excerpt=''.join(content)[:100])
   if times:row.update(ttft_ms=times[0]*1000,decode_s=times[-1]-times[0])
  r.close()
 except Exception as e:row['error']=type(e).__name__ # never log request/credentials
 row['total_s']=time.perf_counter()-start
 with (OUT/'runs.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
 print(json.dumps({k:v for k,v in row.items() if k not in ['events_s','event_chars','rate_headers']}),flush=True)
 return row

def retry(size,cap,phase,trial):
 for attempt in range(10):
  row=run(size,cap,phase,trial)
  if row.get('status')!=429:return row
  print('Rate limited; waiting 65 seconds before retry.',flush=True);time.sleep(65)
 raise RuntimeError('Repeated rate limit')
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('phase',choices=['inspect','main','burst','length','prefill','transport','transport-default']);a=parser.parse_args()
 if a.phase=='inspect':run(8,128,'inspect',0)
 if a.phase=='main':
  retry(8,128,'warmup',0)
  rng=random.Random(713); jobs=[(s,t) for s in [1,32,128,512,1024,2048] for t in range(8)];rng.shuffle(jobs)
  for s,t in jobs:retry(s,256,'main',t)
 if a.phase=='transport-default':
  session.headers['Accept-Encoding']='gzip, deflate, br'
  retry(128,256,'transport-default',0)
 if a.phase=='transport':
  for t in range(3):retry(128,256,'transport',t)
 if a.phase=='prefill':
  jobs=[(s,t) for s in [1,32,128,512,1024,2048] for t in range(5)];random.Random(812).shuffle(jobs)
  for s,t in jobs:retry(s,1,'prefill',t)
 if a.phase=='length':
  jobs=[(cap,t) for cap in [32,128,512,1024] for t in range(3)];random.Random(318).shuffle(jobs)
  for cap,t in jobs:retry(128,cap,'length',t)
 if a.phase=='burst':
  from concurrent.futures import ThreadPoolExecutor
  for round_id in range(2):
   delay=60-time.time()%60+2
   print(f'Aligning quota burst to next minute; waiting {delay:.1f} seconds.',flush=True);time.sleep(delay)
   with ThreadPoolExecutor(max_workers=4) as pool:
    results=list(pool.map(lambda t:run(2048,1,'burst',round_id*10+t),range(4)))
   if not any(r.get('status')==429 for r in results):
    for t in range(4,7):
     r=run(2048,1,'burst',round_id*10+t)
     if r.get('status')==429:break
   print('Waiting 65 seconds then checking recovery.',flush=True);time.sleep(65)
   run(1,1,'recovery',round_id)
