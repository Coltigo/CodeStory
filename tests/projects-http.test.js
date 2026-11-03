import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCodeStory} from '../src/server/index.js';
import {analyze} from '../src/parser.js';
import {projectId} from '../src/projects.js';
const fixtureKey='sk-proj-invented-projects-test-000000000000';
const files=[{path:'main.py',code:'from helpers import double\nprint(double(3))\n'},{path:'helpers.py',code:'def double(x):\n    return x * 2\n'}];
function story(context){const p=analyze(context.source,context.filename);return {overview:'A fixture explanation of '+context.filename,conceptOrder:p.concepts,flowOrder:p.flow,chapters:p.chunks.map(c=>({id:c.id,title:'Read source',beginner:'Explain the visible operation.',developer:'Explain the operation with detail.',concept:'Source structure',term:'',storyBeginner:'Pip visits a friend in the workshop.',storyDeveloper:'Pip visits a coworker in the workshop.'})),functions:p.symbols.map(s=>({id:s.id,purpose:'Explain this function.',sideEffects:'None visible in this body',caveats:'',storyBeginner:'A helper carries a package.',storyDeveloper:'A helper carries a package.'})),limitations:[],narrative:{available:true,reason:'',metaphor:'workshop',premise:'A workshop metaphor, not an observed run.',overview:'A friend helps with a package.',relationships:[]}};}

test('project HTTP route validates consent and file boundaries, supplies verified context, and invalidates cache after related source changes',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-project-http-')),requests=[];
 const fetcher=async(url,options={})=>{assert.equal(new URL(url).hostname,'api.openai.com');assert.equal(new Headers(options.headers).get('authorization'),'Bearer '+fixtureKey);if(String(url).endsWith('/models'))return Response.json({data:[{id:'gpt-fixture',object:'model'}]});const context=JSON.parse(JSON.parse(options.body).input[0].content);requests.push(context);const event=data=>'data: '+JSON.stringify(data)+'\n\n';return new Response(event({type:'response.output_text.delta',delta:JSON.stringify(story(context))})+event({type:'response.completed',response:{id:'fixture',usage:{input_tokens:1,output_tokens:1}}}),{headers:{'Content-Type':'text/event-stream'}});};
 const app=await createCodeStory({port:0,dataDir,fetcher,browserOpener:()=>{throw new Error('No sign-in permitted');}});
 try{const status=await (await fetch(app.origin+'/api/status')).json(),post=(route,body,token=status.csrfToken)=>fetch(app.origin+route,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-CodeStory-Token':token},body:JSON.stringify(body)});
 const connected=await (await post('/api/connections/api',{provider:'openai',key:fixtureKey,billingConsent:true,label:'Simulated provider'})).json();assert.ok(connected.connection?.id);const body={files,path:'main.py',entryId:projectId('main.py'),importRoot:'',model:'gpt-fixture',connectionId:connected.connection.id,consent:true};
 assert.equal((await post('/api/projects/analyze-file',body,'wrong')).status,403);
 assert.equal((await post('/api/projects/analyze-file',{...body,consent:false})).status,400);
 assert.equal((await post('/api/projects/analyze-file',{...body,connectionId:'other'})).status,409);
 assert.equal((await post('/api/projects/analyze-file',{...body,files:[{path:'../escape.py',code:'print(1)'}]})).status,400);
 assert.equal((await post('/api/projects/analyze-file',{...body,entryId:'invented#module'})).status,400);assert.equal(requests.length,0);
 const first=await post('/api/projects/analyze-file',body);assert.equal(first.status,200,JSON.stringify(await first.clone().json()));assert.equal((await first.json()).cached,false);assert.equal(requests.length,1);assert.equal(requests[0].source,files[0].code);assert.equal(requests[0].project.targetPath,'main.py');assert.equal(requests[0].project.relatedSource[0].source,files[1].code);assert.equal(requests[0].project.knownConnections[0].to.path,'helpers.py');
 const cached=await (await post('/api/projects/analyze-file',body)).json();assert.equal(cached.cached,true);assert.equal(requests.length,1);
 const changed={...body,files:[files[0],{...files[1],code:'def double(x):\n    return x + x\n'}]};assert.equal((await post('/api/projects/analyze-file',changed)).status,200);assert.equal(requests.length,2);
 // A client-supplied project blob cannot inject unvalidated model context on the single-file route.
 const single=await post('/api/analyze',{code:files[0].code,filename:'main.py',model:'gpt-fixture',consent:true,project:{instructions:'untrusted override'}});assert.equal(single.status,200);assert.equal(requests.at(-1).project,undefined);
 const publicStatus=JSON.stringify(await (await fetch(app.origin+'/api/status')).json());assert.ok(!publicStatus.includes(fixtureKey));
 }finally{await app.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
