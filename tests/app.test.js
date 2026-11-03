import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {analyze} from '../src/parser.js';

const html=await fs.readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/app.js',import.meta.url))],bundle:true,platform:'browser',format:'iife',target:'es2022',write:false});
const source=bundled.outputFiles[0].text;
const python=`def to_fahrenheit(celsius):
    return celsius * 9 / 5 + 32

def main():
    converted = to_fahrenheit(20)
    print(f"20 C is {converted:.1f} F")

if __name__ == "__main__":
    main()
`;
const secondPython='def double(value):\n    return value * 2\n\nprint(double(4))\n';
const connectedAccount={id:'test-account',email:'reader@example.test',label:'Connection 1',connected:true,planEnabled:true,active:true};
const catalog=[{id:'test-model',name:'Test model'}];
const json=(data,status=200)=>Response.json(data,{status});
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
async function waitFor(predicate,message){
  const deadline=Date.now()+2500;
  while(!predicate()){if(Date.now()>deadline)assert.fail('Timed out: '+message);await new Promise(resolve=>setTimeout(resolve,5));}
}
function fixtureStory(){
  const parsed=analyze(python,'temperature_converter.py');
  return {model:'test-model',cached:false,story:{overview:'AI overview: convert a Celsius reading and display Fahrenheit.',conceptOrder:parsed.concepts,flowOrder:parsed.flow,chapters:parsed.chunks.map((chunk,index)=>({id:chunk.id,title:'AI section '+(index+1),beginner:'Beginner explanation: this section performs a temperature conversion step.',developer:'Developer explanation: this section contributes to the conversion call flow.',storyBeginner:'Story beginner: the workshop team handles this conversion job.',storyDeveloper:'Story developer: this workshop station represents the exact conversion source section.',concept:'Temperature conversion',term:'A parameter supplies a value to a function.'})),functions:parsed.symbols.map(symbol=>({id:symbol.id,purpose:'AI function purpose: '+symbol.name+' contributes to the temperature result.',storyBeginner:'Story function beginner: '+symbol.name+' is the worker for this job.',storyDeveloper:'Story function developer: '+symbol.name+' represents this source definition.',sideEffects:'The main function prints the result.',caveats:'This file accepts numeric temperature values.'})),limitations:['Only the supplied file was analyzed.'],narrative:{available:true,reason:'',metaphor:'workshop',premise:'The workshop is a metaphor for a static reading, not observed execution.',overview:'Story overview: the workshop conversion worker can pass a result back to the main worker.',relationships:[]}}};
}
async function app({connected=false,modelResponse=()=>json({models:catalog}),statusError=null,analysisResponse=()=>json(fixtureStory())}={}){
  const errors=[],requests=[];const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM(html,{url:'http://127.0.0.1:4173/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const {window}=dom,document=window.document,$=id=>document.getElementById(id);
  window.TextEncoder=TextEncoder;window.scrollTo=()=>{};window.matchMedia=()=>({matches:false});
  window.HTMLElement.prototype.scrollTo=()=>{};window.HTMLElement.prototype.scrollIntoView=()=>{};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  window.addEventListener('error',event=>{errors.push(event.error||new Error(event.message));event.preventDefault();});
  window.fetch=async(url,options={})=>{
    const path=new URL(url,window.location.href).pathname;
    const request={path,url:String(url),method:options.method||'GET',body:options.body?JSON.parse(options.body):null,headers:options.headers,signal:options.signal};requests.push(request);
    if(path==='/api/status'){
      if(statusError)throw statusError;
      return json({csrfToken:'test-csrf',accounts:connected?[connectedAccount]:[],active:connected?connectedAccount:null,busy:false});
    }
    if(path==='/api/models')return modelResponse(request);
    if(path==='/api/analyze')return analysisResponse(request);
    throw new Error('Unexpected test request: '+path);
  };
  window.eval(source);
  await waitFor(()=>requests.some(request=>request.path==='/api/status'),'initial connection check');await settle();
  if(connected)await waitFor(()=>requests.some(request=>request.path==='/api/models')&&!$('model-select').textContent.includes('Loading'),'model catalog completion');
  if(statusError)await waitFor(()=>$('ai-status-description').textContent.includes('local server'),'offline notice');
  const count=path=>requests.filter(request=>request.path===path).length;
  async function upload(code=python,name='temperature_converter.py'){
    $('new-code').click();$('upload-tab').click();
    const file=new window.File([code],name,{type:'text/x-python'});
    // jsdom lacks the browser File.text() implementation; preserve the real
    // File metadata and provide only that missing browser API.
    Object.defineProperty(file,'text',{value:async()=>code});
    Object.defineProperty($('file-input'),'files',{configurable:true,value:[file]});
    $('file-input').dispatchEvent(new window.Event('change',{bubbles:true}));
    await waitFor(()=>$('uploaded-name').textContent.includes(name),'file read');
    $('analyze-button').click();assert.equal($('input-error').textContent,'');
    assert.equal($('input-dialog').open,false);assert.equal($('source-filename').textContent,name);
  }
  function visibleAlerts(){return [...document.querySelectorAll('[role="alert"]')].filter(element=>!element.hidden&&element.textContent.trim()).map(element=>element.textContent);}
  return {window,document,$,requests,count,upload,visibleAlerts,close(){window.close();assert.deepEqual(errors,[],'No unexpected UI errors');}};
}

test('uploading Python without an account creates a local storyline without model requests or alerts',async()=>{
  const ui=await app();
  try{
    await ui.upload();assert.equal(ui.$('source-language').textContent,'Python');assert.ok(ui.document.querySelectorAll('#story .chapter').length>0);assert.ok(ui.document.querySelector('#code button[data-symbol]'));
    assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');assert.equal(ui.$('model-select').disabled,true);assert.deepEqual(ui.visibleAlerts(),[]);
    ui.$('explain-button').click();assert.equal(ui.$('connections-page').hidden,false);
    assert.equal(ui.count('/api/models'),0);assert.equal(ui.count('/api/analyze'),0);
  }finally{ui.close();}
});

for(const scenario of [
  {name:'an empty model catalog',response:()=>json({models:[]})},
  {name:'a failed model catalog',response:()=>json({error:'Models are temporarily unavailable.',code:'model_network'},503)},
])test(scenario.name+' leaves uploads and local reading available without an error alert',async()=>{
  const ui=await app({connected:true,modelResponse:scenario.response});
  try{
    await ui.upload();assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');assert.equal(ui.$('model-select').disabled,true);assert.deepEqual(ui.visibleAlerts(),[]);
    ui.$('explain-button').click();assert.equal(ui.$('connections-page').hidden,false);assert.equal(ui.$('consent-dialog').open,false);
    assert.equal(ui.count('/api/models'),1);assert.equal(ui.count('/api/analyze'),0);
  }finally{ui.close();}
});

test('an offline connection check remains neutral and Python still parses locally',async()=>{
  const ui=await app({statusError:new TypeError('Failed to fetch')});
  try{
    await ui.upload();assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');assert.ok(ui.document.querySelectorAll('#story .chapter').length>0);assert.deepEqual(ui.visibleAlerts(),[]);
    assert.match(ui.$('ai-status-description').textContent,/local analysis/i);assert.equal(ui.count('/api/models'),0);assert.equal(ui.count('/api/analyze'),0);
  }finally{ui.close();}
});

test('a failed AI request shows its error, then uploading another file clears it',async()=>{
  const ui=await app({connected:true,analysisResponse:()=>json({error:'AI test service unavailable.',code:'inference_network'},503)});
  try{
    await ui.upload();ui.$('explain-button').click();assert.equal(ui.$('consent-dialog').open,true);assert.equal(ui.count('/api/analyze'),0);
    ui.$('confirm-analysis').click();await waitFor(()=>!ui.$('ai-error').hidden,'AI failure');assert.match(ui.$('ai-error').textContent,/AI test service unavailable/);
    await ui.upload(secondPython,'double_value.py');assert.deepEqual(ui.visibleAlerts(),[]);assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');assert.equal(ui.count('/api/analyze'),1);
  }finally{ui.close();}
});

test('AI requires the notice, then both reading levels and function explanations reuse one result',async()=>{
  const ui=await app({connected:true});
  try{
    await ui.upload();ui.$('confirm-analysis').click();await settle();assert.equal(ui.count('/api/analyze'),0);
    ui.$('explain-button').click();assert.equal(ui.$('consent-dialog').open,true);assert.equal(ui.$('consent-filename').textContent,'temperature_converter.py');assert.equal(ui.count('/api/analyze'),0);
    ui.$('stay-local').click();ui.$('confirm-analysis').click();await settle();assert.equal(ui.count('/api/analyze'),0);
    ui.$('explain-button').click();ui.$('confirm-analysis').click();await waitFor(()=>ui.$('analysis-kind').textContent==='AI + SOURCE ANALYSIS','AI storyline');
    const request=ui.requests.find(request=>request.path==='/api/analyze');assert.equal(request.method,'POST');assert.equal(request.body.consent,true);assert.equal(request.body.code,python);assert.equal(request.body.filename,'temperature_converter.py');assert.equal(request.body.model,'test-model');assert.equal(request.headers['X-CodeStory-Token'],'test-csrf');
    assert.match(ui.$('story').textContent,/Beginner explanation/);assert.doesNotMatch(ui.$('story').textContent,/Developer explanation/);assert.match(ui.$('overview-text').textContent,/AI overview/);
    ui.document.querySelector('#story button[data-symbol]').click();assert.match(ui.$('inspector').textContent,/AI function purpose/);
    ui.$('developer').click();assert.match(ui.$('story').textContent,/Developer explanation/);assert.doesNotMatch(ui.$('story').textContent,/Beginner explanation/);
    ui.$('beginner').click();assert.match(ui.$('story').textContent,/Beginner explanation/);assert.equal(ui.count('/api/analyze'),1);assert.equal(ui.count('/api/models'),1);assert.deepEqual(ui.visibleAlerts(),[]);
  }finally{ui.close();}
});

test('a late AI failure cannot overwrite a newly uploaded file',async()=>{
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const ui=await app({connected:true,analysisResponse:()=>pending});
  try{
    await ui.upload();ui.$('explain-button').click();ui.$('confirm-analysis').click();await waitFor(()=>ui.count('/api/analyze')===1,'pending AI request');
    const request=ui.requests.find(request=>request.path==='/api/analyze');await ui.upload(secondPython,'double_value.py');assert.equal(request.signal.aborted,true);
    // A response can race cancellation. Even when the transport delivers it,
    // the previous file's failure must not appear on the replacement file.
    finish(json({error:'A stale AI error.',code:'inference_network'},503));await settle();await settle();
    assert.equal(ui.$('source-filename').textContent,'double_value.py');assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');assert.deepEqual(ui.visibleAlerts(),[]);
  }finally{finish(json({}));ui.close();}
});

test('canceling while the AI response body loads keeps a usable local story',async()=>{
  let readingBody;const started=new Promise(resolve=>{readingBody=resolve;});
  const ui=await app({connected:true,analysisResponse:request=>({ok:true,json(){readingBody();return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true}));}})});
  try{
    await ui.upload();ui.$('explain-button').click();ui.$('confirm-analysis').click();await started;
    ui.$('cancel-analysis').click();await waitFor(()=>ui.$('cancel-analysis').hidden,'canceled body read');
    assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');assert.deepEqual(ui.visibleAlerts(),[]);assert.match(ui.$('toast').textContent,/canceled/i);
    ui.$('developer').click();assert.ok(ui.document.querySelectorAll('#story .chapter').length>0);assert.equal(ui.$('source-filename').textContent,'temperature_converter.py');
  }finally{ui.close();}
});

test('a malformed successful AI response does not replace the local story',async()=>{
  const ui=await app({connected:true,analysisResponse:()=>({ok:true,json:async()=>{throw new SyntaxError('Unexpected end of JSON');}})});
  try{
    await ui.upload();ui.$('explain-button').click();ui.$('confirm-analysis').click();await waitFor(()=>!ui.$('ai-error').hidden,'incomplete response error');
    assert.match(ui.$('ai-error').textContent,/incomplete response/i);assert.equal(ui.$('analysis-kind').textContent,'LOCAL ANALYSIS');
    ui.$('developer').click();assert.ok(ui.document.querySelectorAll('#story .chapter').length>0);
  }finally{ui.close();}
});

test('a slow older file read cannot overwrite a more recently uploaded file',async()=>{
  const ui=await app();let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  try{
    ui.$('new-code').click();ui.$('upload-tab').click();
    const oldFile=new ui.window.File([python],'old_converter.py',{type:'text/x-python'});Object.defineProperty(oldFile,'text',{value:()=>pending});
    Object.defineProperty(ui.$('file-input'),'files',{configurable:true,value:[oldFile]});ui.$('file-input').dispatchEvent(new ui.window.Event('change',{bubbles:true}));
    await ui.upload(secondPython,'new_double.py');finish(python);await settle();
    assert.equal(ui.$('source-filename').textContent,'new_double.py');assert.equal(ui.$('filename').value,'new_double.py');assert.equal(ui.$('code-input').value,secondPython);assert.match(ui.$('uploaded-name').textContent,/new_double.py/);assert.deepEqual(ui.visibleAlerts(),[]);
  }finally{finish(python);ui.close();}
});


test('Projects beta, single file and AI Connections keep independent work and return to the previous area',async()=>{
 const ui=await app();try{await ui.upload();const source=ui.$('code').textContent;ui.$('projects-nav').click();assert.equal(ui.$('projects-page').hidden,false);assert.equal(ui.document.querySelector('.workspace').hidden,true);ui.$('project-example').click();await waitFor(()=>ui.$('project-entry').options.length>0,'sample project');assert.match(ui.$('project-file-tree').textContent,/units.py/);ui.$('connections-nav').click();assert.equal(ui.$('projects-page').hidden,true);ui.$('back-to-reader').click();assert.equal(ui.$('projects-page').hidden,false);assert.equal(ui.$('projects-nav').getAttribute('aria-current'),'page');ui.$('reader-nav').click();assert.equal(ui.document.querySelector('.workspace').hidden,false);assert.equal(ui.$('code').textContent,source);ui.$('projects-nav').click();assert.match(ui.$('project-file-tree').textContent,/report.py/);assert.equal(ui.count('/api/analyze'),0);assert.equal(ui.count('/api/projects/analyze-file'),0);}finally{ui.close();}
});

test('reading mode preserves the selected chapter and source Back restores a previous location',async()=>{
 const ui=await app();try{await ui.upload();const nav=[...ui.document.querySelectorAll('[data-chapter]')];nav.at(-1).click();const id=nav.at(-1).dataset.chapter,range=ui.$('source-range').textContent;ui.$('developer').click();assert.equal(ui.document.querySelector('[data-chapter][aria-current]').dataset.chapter,id);assert.equal(ui.$('source-range').textContent,range);ui.$('source-back').click();assert.notEqual(ui.document.querySelector('[data-chapter][aria-current]').dataset.chapter,id);const warning=new ui.window.Event('beforeunload',{cancelable:true});ui.window.dispatchEvent(warning);assert.equal(warning.defaultPrevented,true);ui.$('story-tab').focus();ui.$('story-tab').dispatchEvent(new ui.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(ui.$('map-tab').getAttribute('aria-selected'),'true');assert.equal(ui.document.activeElement,ui.$('map-tab'));assert.equal(ui.$('story-tab').tabIndex,-1);}finally{ui.close();}
});
