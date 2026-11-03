import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {analyze} from '../src/parser.js';
const html=await fs.readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/app.js',import.meta.url))],bundle:true,platform:'browser',format:'iife',write:false,target:'es2022'});
const source=bundle.outputFiles[0].text,code='def double(value):\n    return value * 2\n\nprint(double(4))\n';
const plan={id:'plan-fixture',email:'reader@example.test',label:'Plan fixture',connected:true,planEnabled:true,active:true};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
async function waitFor(fn,label){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)assert.fail('Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,5));}}
function story(request,connection){const parsed=analyze(request.code,request.filename);return {model:request.model,connection,story:{overview:'Literal overview: double a number and print it.',conceptOrder:parsed.concepts,flowOrder:parsed.flow,chapters:parsed.chunks.map(c=>({id:c.id,title:'Double and display',beginner:'Literal beginner: this section defines or uses doubling.',developer:'Literal developer: multiplication produces the result.',concept:'Numeric operation',term:'',storyBeginner:'Workshop beginner: the double worker can return twice the value.',storyDeveloper:'Workshop developer: the double workbench represents multiplication.'})),functions:parsed.symbols.map(s=>({id:s.id,purpose:'Literal function purpose: multiply value by two.',sideEffects:'No side effects in the function.',caveats:'',storyBeginner:'Workshop function beginner.',storyDeveloper:'Workshop function developer.'})),limitations:[],narrative:{available:true,reason:'',metaphor:'workshop',premise:'This workshop is a metaphor, not a runtime trace.',overview:'Workshop overview: double can deliver a numeric result.',relationships:[]}}};}
async function app({withPlan=false,connectError=null}={}){
 const requests=[],errors=[],exports=[],profiles=[];let connection=withPlan?{id:plan.id,kind:'chatgpt_plan',provider:'chatgpt',label:plan.email,ready:true,billing:'plan'}:null;
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM(html,{url:'http://127.0.0.1:4173/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),{window}=dom,document=window.document,$=id=>document.getElementById(id);
 window.scrollTo=()=>{};window.matchMedia=()=>({matches:false});window.HTMLElement.prototype.scrollTo=()=>{};window.HTMLElement.prototype.scrollIntoView=()=>{};
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
 window.Blob=Blob;window.URL.createObjectURL=blob=>{exports.push(blob);return 'blob:fixture';};window.URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=()=>{};
 window.addEventListener('error',event=>{errors.push(event.error||new Error(event.message));event.preventDefault();});
 window.fetch=async(url,options={})=>{
  const path=new URL(url,window.location.href).pathname,body=options.body?JSON.parse(options.body):null;requests.push({path,url:String(url),body,headers:options.headers});
  if(path==='/api/status')return Response.json({csrfToken:'fixture-csrf',active:withPlan?plan:null,accounts:withPlan?[plan]:[],connection,apiConnections:profiles.map(p=>({...p,active:p.id===connection?.id})),busy:false});
  if(path==='/api/models')return Response.json({models:[{id:connection?.provider==='anthropic'?'claude-fixture':connection?.provider==='gemini'?'gemini-fixture':'gpt-fixture',name:'Fixture text model'}]});
  if(path==='/api/connections/api'){
   if(connectError)return Response.json({error:connectError(body.key),code:'api_auth_failed'},{status:401});
   assert.equal(body.billingConsent,true);const profile={id:'api-'+(profiles.length+1),kind:'api_key',provider:body.provider,label:body.label||'My API connection',ready:true,billing:'api',analysisVerified:false};profiles.push(profile);connection=profile;return Response.json({connection});
  }
  if(path==='/api/connections/select'){connection=body.id==='chatgpt'?{id:plan.id,kind:'chatgpt_plan',provider:'chatgpt',label:plan.email,ready:true,billing:'plan'}:profiles.find(p=>p.id===body.id);return Response.json({connection});}
  if(path==='/api/connections/remove'){const index=profiles.findIndex(p=>p.id===body.id);profiles.splice(index,1);if(connection?.id===body.id)connection=null;return Response.json({removed:true});}
  if(path==='/api/analyze'){assert.equal(body.connectionId,connection.id);connection.analysisVerified=true;return Response.json(story(body,connection));}
  throw new Error('Unexpected fixture request: '+path);
 };
 window.eval(source);await settle();await settle();
 const count=path=>requests.filter(r=>r.path===path).length;
 async function upload(){ $('new-code').click();$('code-input').value=code;$('filename').value='double.py';$('analyze-button').click();assert.equal($('input-error').textContent,'');}
 async function connect(provider='openai',key='fixture-secret-only'){
  $('account-button').click();$('api-provider').value=provider;$('api-provider').dispatchEvent(new window.Event('change'));$('api-key').value=key;$('api-label').value='';$('api-billing-confirm').checked=true;
  $('api-connection-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal($('api-key').value,'','The field is cleared as soon as submission starts');
  await waitFor(()=>$('connection-feedback').dataset.tone==='success'||$('connection-feedback').dataset.tone==='error','connection response');
  await settle();
 }
 return {window,document,$,requests,count,exports,upload,connect,close(){window.close();assert.deepEqual(errors,[],'No unexpected UI errors');}};
}
test('connections navigation preserves the reader and ChatGPT sign-in uses its account dialog',async()=>{
 const ui=await app();try{await ui.upload();ui.$('connections-nav').click();assert.equal(ui.$('connections-page').hidden,false);assert.equal(ui.document.querySelector('.workspace').hidden,true);ui.$('plan-connect').click();assert.equal(ui.$('account-dialog').open,true);ui.$('account-dialog').close();ui.$('back-to-reader').click();assert.equal(ui.$('connections-page').hidden,true);assert.equal(ui.$('source-filename').textContent,'double.py');assert.equal(ui.count('/api/analyze'),0);}finally{ui.close();}
});
for(const provider of ['openai','anthropic','gemini'])test(provider+' connection shows its billing notice, keeps the key out of UI/storage, and requires analysis consent',async()=>{
 const ui=await app();try{
  await ui.upload();await ui.connect(provider);assert.equal(ui.$('connection-feedback').dataset.tone,'success');assert.equal(ui.count('/api/analyze'),0);assert.ok(ui.count('/api/models')>0);assert.equal(ui.window.localStorage.length,0);assert.equal(ui.window.sessionStorage.length,0);assert.doesNotMatch(ui.document.body.textContent,/fixture-secret-only/);assert.ok(ui.requests.every(r=>!r.url.includes('fixture-secret-only')));
  ui.$('back-to-reader').click();ui.$('explain-button').click();assert.equal(ui.$('consent-dialog').open,true);assert.match(ui.$('consent-billing-title').textContent,/API connection/);assert.doesNotMatch(ui.$('consent-billing-title').textContent,/ChatGPT plan/);assert.match(ui.$('consent-title').textContent,new RegExp(provider==='anthropic'?'Claude':provider==='gemini'?'Gemini':'OpenAI'));
  ui.$('confirm-analysis').click();await waitFor(()=>ui.$('analysis-kind').textContent==='AI + SOURCE ANALYSIS','API result');ui.$('story-mode').click();ui.$('developer').click();assert.match(ui.$('story').textContent,/Workshop developer/);ui.$('literal-mode').click();assert.match(ui.$('story').textContent,/Literal developer/);ui.$('export-button').click();ui.$('export-markdown').click();assert.match(await ui.exports[0].text(),new RegExp(provider==='anthropic'?'Claude API':provider==='gemini'?'Gemini API':'OpenAI API'));assert.equal(ui.count('/api/analyze'),1);
 }finally{ui.close();}
});
test('API billing confirmation is required and provider errors do not reflect a key',async()=>{
 const ui=await app({connectError:key=>'The provider rejected '+key});try{
  ui.$('account-button').click();ui.$('api-key').value='secret-never-display';ui.$('api-connection-form').dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));assert.equal(ui.count('/api/connections/api'),0);assert.match(ui.$('connection-feedback').textContent,/billing/i);
  await ui.connect('openai','secret-never-display');assert.equal(ui.$('connection-feedback').dataset.tone,'error');assert.doesNotMatch(ui.$('connection-feedback').textContent,/secret-never-display/);assert.match(ui.$('connection-feedback').textContent,/Enter the key again/);assert.equal(ui.$('api-key').value,'');assert.equal(ui.count('/api/analyze'),0);
 }finally{ui.close();}
});
test('switching and removing connections clears stale AI results while retaining the source',async()=>{
 const ui=await app({withPlan:true});try{
  await ui.upload();await ui.connect();ui.$('back-to-reader').click();ui.$('explain-button').click();ui.$('confirm-analysis').click();await waitFor(()=>ui.$('analysis-kind').textContent==='AI + SOURCE ANALYSIS','API result');
  ui.$('account-button').click();ui.$('use-plan').click();await waitFor(()=>ui.$('analysis-kind').textContent==='LOCAL ANALYSIS','connection switch');assert.equal(ui.$('source-filename').textContent,'double.py');assert.match(ui.$('selected-connection').textContent,/ChatGPT plan/);
  ui.document.querySelector('[data-use-api]').click();await waitFor(()=>ui.$('selected-connection').textContent.includes('My API connection'),'API reselection');ui.document.querySelector('[data-remove-api]').click();await waitFor(()=>ui.$('api-connection-list').textContent.includes('No API keys'),'API removal');assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');assert.equal(ui.$('source-filename').textContent,'double.py');assert.equal(ui.count('/api/analyze'),1);
 }finally{ui.close();}
});
test('local AI remains an inactive preview and selecting a runner makes no connection request',async()=>{
 const ui=await app();try{ui.$('account-button').click();const before=ui.requests.length;ui.$('local-runner').value='lmstudio';ui.$('local-runner').dispatchEvent(new ui.window.Event('change'));assert.match(ui.$('local-endpoint').value,/1234/);assert.equal(ui.$('local-model').disabled,true);assert.equal(ui.document.querySelector('.local-preview button').disabled,true);assert.match(ui.document.querySelector('.local-preview').textContent,/COMING SOON/);await settle();assert.equal(ui.requests.length,before);}finally{ui.close();}
});
test('dismissing the analysis notice cancels pending consent',async()=>{
 const ui=await app({withPlan:true});try{await ui.upload();await waitFor(()=>!ui.$('model-select').disabled,'models');ui.$('explain-button').click();ui.$('consent-dialog').close();ui.$('confirm-analysis').click();await settle();assert.equal(ui.count('/api/analyze'),0);}finally{ui.close();}
});
