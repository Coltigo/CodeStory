import test from 'node:test';
import assert from 'node:assert/strict';
import {localEndpoint,localCatalog,localJSON} from '../src/server/local.js';
import {ApiKeyConnections,ApiKeyAI} from '../src/server/providers.js';
import {analyze} from '../src/parser.js';
const code='def double(x):\n    return x * 2\nprint(double(3))';
function story(){const p=analyze(code,'main.py');return {overview:'Double a number and print the reply.',conceptOrder:p.concepts,flowOrder:p.flow,chapters:p.chunks.map(c=>({id:c.id,title:'Double and display',beginner:'Multiply the number by two.',developer:'Return x * 2 and print the reply.',concept:'Function call',term:'',storyBeginner:'Pip visits his friend and carries a doubled number back.',storyDeveloper:'Pip visits his coworker and carries the reply back.'})),functions:p.symbols.map(s=>({id:s.id,purpose:'Return twice x.',sideEffects:'None visible in this body',caveats:'',storyBeginner:'A friend doubles a package.',storyDeveloper:'A friend doubles a package.'})),limitations:[],narrative:{available:true,reason:'',metaphor:'workshop',premise:'A workshop metaphor, not an observed run.',overview:'Pip carries the reply to the noticeboard.',relationships:[]}};}
function fixture(){const calls=[];let finish='stop',invalid=false,delay=false;return {calls,setFinish:v=>finish=v,setInvalid:v=>invalid=v,setDelay:v=>delay=v,fetcher:async(url,options={})=>{assert.ok(String(url).startsWith('http://127.0.0.1:1234/v1/'));assert.equal(new Headers(options.headers).has('authorization'),false);assert.equal(options.redirect,'error');calls.push({url,body:options.body?JSON.parse(options.body):null});if(String(url).endsWith('/models'))return Response.json({data:[{id:'org/local:7b'},{id:'bad-cloud'},{id:'embedding-model'}]});if(delay)await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true}));return Response.json({choices:[{finish_reason:finish,message:{content:invalid?'invalid':JSON.stringify(story())}}],usage:{prompt_tokens:10,completion_tokens:20}});}};}

test('local endpoints are literal loopback only with no redirects, credentials or arbitrary paths',()=>{
 assert.equal(localEndpoint('http://localhost:1234/v1/'),'http://127.0.0.1:1234/v1');
 for(const value of ['https://api.openai.com/v1','http://192.168.1.2:1234/v1','http://example.test:1234/v1','http://127.0.0.1:80/v1','http://user:pass@127.0.0.1:1234/v1','http://127.0.0.1:1234/admin','http://127.0.0.1:1234/v1?redirect=1'])assert.throws(()=>localEndpoint(value));
});
test('local connection discovers installed models and validates complete explanations with consent and caching',async()=>{
 const f=fixture(),c=new ApiKeyConnections({fetcher:f.fetcher}),ai=new ApiKeyAI(c,{fetcher:f.fetcher});const profile=await c.connectLocal({endpoint:'http://localhost:1234/v1',model:'org/local:7b'});assert.equal(profile.kind,'local');assert.equal(profile.billing,'local');assert.deepEqual((await c.models()).map(m=>m.id),['org/local:7b']);assert.equal(f.calls.length,1);
 const body={code,filename:'main.py',model:'org/local:7b',consent:true};await assert.rejects(()=>ai.explain({...body,consent:false}),/Confirm/);assert.equal(f.calls.length,1);
 const result=await ai.explain(body);assert.equal(result.story.narrative.available,true);assert.deepEqual(result.usage,{input_tokens:10,output_tokens:20});assert.equal(f.calls[1].body.response_format.type,'json_schema');assert.equal(JSON.parse(f.calls[1].body.messages[1].content).source,code);assert.equal(f.calls[1].body.stream,false);assert.equal((await ai.explain(body)).cached,true);assert.equal(f.calls.length,2);c.remove(profile.id);assert.equal(c.active(),null);
});
test('local malformed and incomplete results are rejected and never cached; cancellation releases the adapter',async()=>{
 const f=fixture(),c=new ApiKeyConnections({fetcher:f.fetcher}),ai=new ApiKeyAI(c,{fetcher:f.fetcher});await c.connectLocal({endpoint:'http://127.0.0.1:1234/v1',model:'org/local:7b'});const body={code,filename:'main.py',model:'org/local:7b',consent:true};f.setFinish('length');await assert.rejects(()=>ai.explain(body),/complete explanation/);f.setFinish('stop');f.setInvalid(true);await assert.rejects(()=>ai.explain(body),/unreadable/);assert.equal(ai.cache.size,0);f.setInvalid(false);f.setDelay(true);const controller=new AbortController(),pending=ai.explain(body,controller.signal);await new Promise(r=>setTimeout(r,0));controller.abort();await assert.rejects(()=>pending);assert.equal(ai.busy,false);assert.equal(ai.cache.size,0);
});
test('empty and unavailable local servers show actionable errors',async()=>{
 await assert.rejects(()=>localCatalog(async()=>Response.json({data:[]}),'http://127.0.0.1:1234/v1'),/Download or load/);
 await assert.rejects(()=>localCatalog(async()=>{throw Error('offline');},'http://127.0.0.1:1234/v1'),/Start Ollama or LM Studio/);
});

test('HTTP local discovery, selection, single-file and project scans preserve local-only consent and session boundaries',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{createCodeStory}=await import('../src/server/index.js');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-local-http-')),f=fixture(),app=await createCodeStory({port:0,dataDir:dir,fetcher:f.fetcher,browserOpener:()=>{throw Error('No sign-in');}});
 try{const status=await (await fetch(app.origin+'/api/status')).json();const post=(route,body,token=status.csrfToken)=>fetch(app.origin+route,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-CodeStory-Token':token},body:JSON.stringify(body)});
 assert.equal((await post('/api/connections/local/models',{endpoint:'http://example.test:1234/v1'})).status,400);assert.equal(f.calls.length,0);assert.equal((await post('/api/connections/local/models',{endpoint:'http://127.0.0.1:1234/v1'},'wrong')).status,403);
 const found=await (await post('/api/connections/local/models',{endpoint:'http://127.0.0.1:1234/v1'})).json();assert.equal(found.models[0].id,'org/local:7b');assert.ok(f.calls.every(c=>!c.body));const connected=await (await post('/api/connections/local',{endpoint:'http://127.0.0.1:1234/v1',model:'org/local:7b'})).json();assert.equal(connected.connection.kind,'local');
 const body={code,filename:'main.py',model:'org/local:7b',connectionId:connected.connection.id,consent:true};const before=f.calls.length;assert.equal((await post('/api/analyze',{...body,consent:false})).status,400);assert.equal(f.calls.length,before);const result=await (await post('/api/analyze',body)).json();assert.equal(result.connection.kind,'local');assert.equal(result.story.overview,story().overview);
 const project=await post('/api/projects/analyze-file',{files:[{path:'main.py',code}],path:'main.py',entryId:'main.py#module',model:body.model,connectionId:body.connectionId,consent:true});assert.equal(project.status,200,JSON.stringify(await project.clone().json()));assert.ok(JSON.parse(f.calls.at(-1).body.messages[1].content).project);
 const updated=await (await fetch(app.origin+'/api/status')).json();assert.equal(updated.active,null);assert.equal(updated.connection.analysisVerified,true);assert.deepEqual(updated.accounts,[]);assert.equal((await post('/api/connections/remove',{id:body.connectionId})).status,200);assert.equal((await (await fetch(app.origin+'/api/status')).json()).connection,null);
 }finally{await app.close();await fs.rm(dir,{recursive:true,force:true});}
});


test('local transport bounds response size and cancels a stalled response body',async()=>{
 await assert.rejects(()=>localJSON(async()=>new Response('{}',{headers:{'content-length':'600001'}}),'http://127.0.0.1:1234/v1','/models'),/too large/);
 let canceled=false;const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){canceled=true;}}),controller=new AbortController();const pending=localJSON(async()=>new Response(stream),'http://127.0.0.1:1234/v1','/models',{signal:controller.signal});await new Promise(r=>setTimeout(r,0));controller.abort();await assert.rejects(()=>pending);assert.equal(canceled,true);
});
