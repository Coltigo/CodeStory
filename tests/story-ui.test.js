import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {analyze} from '../src/parser.js';
import {samples} from '../src/samples.js';
import {languageSupport} from '../src/support.js';

const html=await fs.readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/app.js',import.meta.url))],bundle:true,platform:'browser',format:'iife',target:'es2022',write:false});
const source=bundled.outputFiles[0].text;
const python='def describe_temperature(value):\n    if value > 30:\n        return "hot"\n    else:\n        return "mild"\n\nprint(describe_temperature(20))\n';
const account={id:'story-test',email:'story@example.test',label:'Story test',connected:true,planEnabled:true,active:true};
function result(){
  const parsed=analyze(python,'temperature.py');
  return {model:'fixture-model',cached:false,story:{overview:'Literal AI overview: describe a temperature.',conceptOrder:parsed.concepts,flowOrder:parsed.flow,chapters:parsed.chunks.map(c=>({id:c.id,title:'Read the temperature section',beginner:'Literal beginner: this section defines or uses the temperature check.',developer:'Literal developer: the condition selects a return value if invoked.',storyBeginner:'Narrative beginner: the workshop worker faces the hot-or-mild dilemma (the value > 30 condition).',storyDeveloper:'Narrative developer: the workshop worker conditionally returns the hot or mild label (the source if/else).',concept:'Conditional choice',term:'A condition selects which branch may run.'})),functions:parsed.symbols.map(s=>({id:s.id,purpose:'Literal function purpose: compare the temperature with 30.',sideEffects:'No observable side effects in this function.',caveats:'The argument must support numeric comparison.',storyBeginner:'Narrative function beginner: the describe_temperature worker makes the conditional choice.',storyDeveloper:'Narrative function developer: the describe_temperature worker returns the label selected by value > 30.'})),limitations:['Static source cannot show which branch was observed at runtime.'],narrative:{available:true,reason:'',metaphor:'workshop',premise:'A single workshop metaphor for a static reading, not observed execution.',overview:'Narrative overview: the workshop worker can return a temperature label to its caller.',relationships:[]}}};
}
async function waitFor(predicate,message){const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)assert.fail('Timed out: '+message);await new Promise(resolve=>setTimeout(resolve,5));}}
async function app({connected=false,decline=false,offline=false}={}){
  const errors=[],requests=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM(html,{url:'http://127.0.0.1:4173/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const {window}=dom,document=window.document,$=id=>document.getElementById(id);let exported=null,prints=0;window.print=()=>{window.dispatchEvent(new window.Event('beforeprint'));prints++;assert.equal($('export-dialog').open,false);assert.equal($('story').hidden,false);assert.match(document.title,/temperature.py/);window.dispatchEvent(new window.Event('afterprint'));};
  window.Blob=Blob;window.URL.createObjectURL=blob=>{exported=blob;return 'blob:story-test';};window.URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=()=>{};
  window.scrollTo=()=>{};window.matchMedia=()=>({matches:false});window.HTMLElement.prototype.scrollTo=()=>{};window.HTMLElement.prototype.scrollIntoView=()=>{};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
  window.addEventListener('error',event=>{errors.push(event.error||new Error(event.message));event.preventDefault();});
  window.fetch=async(url,options={})=>{
    const path=new URL(url,window.location.href).pathname;requests.push({path,body:options.body?JSON.parse(options.body):null});
    if(path==='/api/status'&&offline)throw new TypeError('Offline fixture: no local server response');
    if(path==='/api/status')return Response.json({csrfToken:'fixture-token',accounts:connected?[account]:[],active:connected?account:null,busy:false});
    if(path==='/api/models')return Response.json({models:[{id:'fixture-model',name:'Fixture model'}]});
    if(path==='/api/analyze'){const response=result();if(decline){response.story.narrative={available:false,reason:'The core work happens in missing external helpers.',metaphor:'workshop',premise:'',overview:'',relationships:[]};for(const entry of [...response.story.chapters,...response.story.functions]){entry.storyBeginner='';entry.storyDeveloper='';}}return Response.json(response);}
    throw new Error('Unexpected request: '+path);
  };
  window.eval(source);await waitFor(()=>requests.some(r=>r.path==='/api/status'),'initial status');await new Promise(resolve=>setTimeout(resolve,0));
  if(connected)await waitFor(()=>$('model-select').value==='fixture-model','model catalog');
  const count=path=>requests.filter(r=>r.path===path).length;
  async function upload(code=python,filename='temperature.py'){
    $('new-code').click();$('upload-tab').click();const file=new window.File([code],filename,{type:'text/plain'});Object.defineProperty(file,'text',{value:async()=>code});Object.defineProperty($('file-input'),'files',{configurable:true,value:[file]});$('file-input').dispatchEvent(new window.Event('change',{bubbles:true}));
    await waitFor(()=>$('uploaded-name').textContent.includes(filename),'file read');$('analyze-button').click();assert.equal($('input-error').textContent,'');assert.equal($('source-filename').textContent,filename);
  }
  return {$,document,requests,count,upload,printCount:()=>prints,exportedText:async()=>exported?.text(),close(){window.close();assert.deepEqual(errors,[],'No unexpected UI errors');}};
}

test('Story Mode remains available offline and changes independently from reading level',async()=>{
  const ui=await app();
  try{
    await ui.upload();assert.equal(ui.$('literal-mode').getAttribute('aria-pressed'),'true');
    ui.$('story-mode').click();assert.equal(ui.$('story-mode').getAttribute('aria-pressed'),'true');assert.equal(ui.$('beginner').getAttribute('aria-pressed'),'true');
    assert.match(ui.$('story').textContent,/workshop/i);assert.match(ui.$('story-premise').textContent,/metaphor/i);
    ui.$('developer').click();assert.equal(ui.$('story-mode').getAttribute('aria-pressed'),'true');assert.equal(ui.$('developer').getAttribute('aria-pressed'),'true');
    ui.$('literal-mode').click();assert.equal(ui.$('developer').getAttribute('aria-pressed'),'true');assert.equal(ui.$('literal-mode').getAttribute('aria-pressed'),'true');
    ui.$('beginner').click();assert.equal(ui.$('literal-mode').getAttribute('aria-pressed'),'true');assert.ok(ui.document.querySelectorAll('#story .chapter').length>0);
    assert.equal(ui.count('/api/models'),0);assert.equal(ui.count('/api/analyze'),0);assert.equal(ui.$('ai-error').hidden,true);
  }finally{ui.close();}
});

test('one consented AI response supplies both explanation styles and both detail levels',async()=>{
  const ui=await app({connected:true});
  try{
    await ui.upload();ui.$('story-mode').click();assert.equal(ui.count('/api/analyze'),0);
    ui.$('explain-button').click();assert.equal(ui.$('consent-dialog').open,true);assert.equal(ui.count('/api/analyze'),0);ui.$('confirm-analysis').click();
    await waitFor(()=>ui.$('analysis-kind').textContent==='AI + SOURCE ANALYSIS','completed AI story');
    assert.match(ui.$('story').textContent,/Narrative beginner/);assert.match(ui.$('overview-text').textContent,/Narrative overview/);
    assert.ok(ui.document.querySelector('#story details'),'Story chapters retain expandable literal facts');
    ui.$('developer').click();assert.match(ui.$('story').textContent,/Narrative developer/);assert.doesNotMatch(ui.$('story').textContent,/Narrative beginner/);
    ui.document.querySelector('#story button[data-symbol]').click();assert.match(ui.$('inspector').textContent,/Narrative function developer/);assert.match(ui.$('inspector').textContent,/Literal function purpose/);
    ui.$('literal-mode').click();assert.match(ui.$('story').textContent,/Literal developer/);assert.doesNotMatch(ui.$('story').textContent,/Narrative developer/);assert.match(ui.$('overview-text').textContent,/Literal AI overview/);
    ui.$('beginner').click();assert.match(ui.$('story').textContent,/Literal beginner/);ui.$('story-mode').click();assert.match(ui.$('story').textContent,/Narrative beginner/);
    assert.equal(ui.count('/api/analyze'),1);assert.equal(ui.count('/api/models'),1);assert.equal(ui.requests.find(r=>r.path==='/api/analyze').body.consent,true);
  }finally{ui.close();}
});

test('a text-inspected language keeps literal reading and shows a Story Mode notice',async()=>{
  const ui=await app();
  try{
    await ui.upload('puts "hello"\n','hello.rb');assert.equal(ui.$('source-language').textContent,'Ruby');assert.equal(ui.$('language-notice').hidden,false);assert.match(ui.$('language-notice').textContent,/source as text/i);assert.match(ui.$('language-notice').textContent,/not verified/i);
    ui.$('story-mode').click();assert.equal(ui.$('story-unavailable-dialog').open,true);assert.equal(ui.$('literal-mode').getAttribute('aria-pressed'),'true');assert.match(ui.$('story-unavailable-reason').textContent,/verified structure/);ui.$('developer').click();assert.equal(ui.$('language-notice').hidden,false);assert.match(ui.$('language-notice').textContent,/not verified/i);assert.ok(ui.document.querySelectorAll('#story .chapter').length>0);assert.equal(ui.$('ai-error').hidden,true);assert.equal(ui.count('/api/analyze'),0);
  }finally{ui.close();}
});

test('Story Mode exports preserve the metaphor notice, literal facts, and text-inspection limits',async()=>{
  const ui=await app({connected:true});
  try{
    await ui.upload();ui.$('story-mode').click();ui.$('explain-button').click();ui.$('confirm-analysis').click();await waitFor(()=>ui.$('analysis-kind').textContent==='AI + SOURCE ANALYSIS','completed AI story');
    ui.$('export-button').click();ui.$('export-markdown').click();const text=await ui.exportedText();assert.match(text,/Story Mode/);assert.match(text,/single workshop metaphor/);assert.match(text,/not observed execution/);assert.match(text,/Narrative beginner/);assert.match(text,/Literal beginner/);assert.equal(ui.count('/api/analyze'),1);
    await ui.upload('puts "hello"\n','hello.rb');ui.$('export-button').click();ui.$('export-markdown').click();const experimental=await ui.exportedText();assert.match(experimental,/source as text/);assert.match(experimental,/not verified/);assert.match(experimental,/Explanation mode: Literal/);assert.equal(ui.count('/api/analyze'),1);
  }finally{ui.close();}
});


test('languages with syntax parsers remain readable through local modes and maps',async()=>{
  const ui=await app();
  try{
    for(const sample of samples.filter(s=>languageSupport(s.filename).structured)){
      await ui.upload(sample.code,sample.filename);
      assert.doesNotMatch(ui.$('language-notice').textContent,/official|experimental support/i);
      assert.equal(ui.$('source-language').textContent,languageSupport(sample.filename).language);
      ui.$('story-mode').click();ui.$('developer').click();assert.ok(ui.document.querySelectorAll('#story .chapter').length>0);
      ui.$('map-tab').click();assert.ok(ui.$('call-map').textContent.trim());
      if(['HTML','SQL'].includes(languageSupport(sample.filename).language))assert.match(ui.$('map-tab').textContent,/Structure map/);
      ui.$('story-tab').click();ui.$('literal-mode').click();ui.$('beginner').click();
      assert.equal(ui.$('ai-error').hidden,true);assert.equal(ui.document.querySelector('#code script, #code style, #code h1'),null,'Source markup remains inert');
    }
    assert.equal(ui.count('/api/analyze'),0);assert.equal(ui.count('/api/models'),0);
  }finally{ui.close();}
});

test('the example picker can load a chosen language without cycling',async()=>{
  const ui=await app();
  try{
    ui.$('new-code').click();const index=samples.findIndex(s=>s.filename==='page.html');ui.$('example-select').value=String(index);ui.$('load-example').click();
    assert.equal(ui.$('filename').value,'page.html');assert.match(ui.$('input-language').textContent,/^HTML$/);ui.$('analyze-button').click();assert.equal(ui.$('source-language').textContent,'HTML');assert.equal(ui.count('/api/analyze'),0);
  }finally{ui.close();}
});


test('export chooser prints the selected reading surface without another AI request',async()=>{
  const ui=await app();try{await ui.upload();ui.$('story-mode').click();ui.$('map-tab').click();const originalTitle=ui.document.title;ui.$('export-button').click();assert.equal(ui.$('export-dialog').open,true);assert.equal(await ui.exportedText(),undefined);ui.$('export-pdf').click();assert.equal(ui.printCount(),1);assert.equal(ui.$('call-map').hidden,false);assert.equal(ui.document.title,originalTitle);assert.equal(ui.$('story-mode').getAttribute('aria-pressed'),'true');assert.equal(ui.count('/api/analyze'),0);}finally{ui.close();}
});

test('a model can decline Story Mode while its literal explanation remains usable',async()=>{
  const ui=await app({connected:true,decline:true});try{
    await ui.upload();ui.$('story-mode').click();ui.$('explain-button').click();ui.$('confirm-analysis').click();await waitFor(()=>ui.$('analysis-kind').textContent==='AI + SOURCE ANALYSIS','literal AI explanation');
    assert.equal(ui.$('literal-mode').getAttribute('aria-pressed'),'true');assert.equal(ui.$('story-unavailable-dialog').open,true);assert.match(ui.$('story-unavailable-reason').textContent,/missing external helpers/);assert.match(ui.$('story').textContent,/Literal beginner/);assert.equal(ui.$('ai-error').hidden,true);
    ui.$('story-unavailable-dialog').close();ui.$('story-mode').click();assert.equal(ui.$('story-unavailable-dialog').open,true);assert.equal(ui.count('/api/analyze'),1);
  }finally{ui.close();}
});

test('loading an unsuitable file leaves Story Mode with a clear notice',async()=>{
  const ui=await app();try{await ui.upload();ui.$('story-mode').click();await ui.upload('def small():\n    return 1\n'+'# a long file\n'.repeat(351),'large.py');assert.equal(ui.$('literal-mode').getAttribute('aria-pressed'),'true');assert.equal(ui.$('story-unavailable-dialog').open,true);assert.match(ui.$('story-unavailable-reason').textContent,/350 lines/);assert.equal(ui.count('/api/analyze'),0);}finally{ui.close();}
});

test('chapter numbers toggle completion without a sidebar without changing the selected source',async()=>{
  const ui=await app();try{
    await ui.upload();assert.equal(ui.document.querySelector('[data-done],.chapter-footer'),null);
    assert.doesNotMatch(ui.$('story').textContent,/Understood|See the source/);
    const button=ui.document.querySelector('#story [data-complete]'),id=button.dataset.complete;
    assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');assert.equal(button.getAttribute('aria-pressed'),'false');
    const selectedSource=ui.$('source-range').textContent;button.focus();button.click();
    assert.equal(ui.document.activeElement,button,'completion retains keyboard focus');assert.equal(button.textContent,'✓');assert.equal(button.getAttribute('aria-pressed'),'true');assert.match(button.getAttribute('aria-label'),/Mark incomplete/);
    assert.equal(ui.document.querySelector('#chapter-nav'),null);assert.equal(ui.$('source-range').textContent,selectedSource);
    ui.$('developer').click();ui.$('story-mode').click();const after=ui.document.querySelector(`[data-complete="${id}"]`);assert.equal(after.getAttribute('aria-pressed'),'true');assert.equal(after.textContent,'✓');
    after.click();assert.equal(after.getAttribute('aria-pressed'),'false');assert.equal(after.textContent,after.dataset.number);assert.equal(ui.document.querySelector('.sidebar'),null);
    after.click();await ui.upload();assert.ok([...ui.document.querySelectorAll('[data-complete]')].every(b=>b.getAttribute('aria-pressed')==='false'));assert.equal(ui.document.querySelector('#chapter-nav'),null);
    assert.ok(ui.document.querySelector('#story .line-link[data-source]'),'original line links remain available');
  }finally{ui.close();}
});


test('source-derived package contents stay text in the story',async()=>{
  const ui=await app();try{await ui.upload('city = "<script>alert(1)</script>"\n','contents.py');ui.$('story-mode').click();assert.equal(ui.document.querySelector('#story script'),null);assert.match(ui.$('story').textContent,/<script>alert\(1\)<\/script>/);}finally{ui.close();}
});


test('Python begins with useful inspection even when the status request fails, then offers a consented AI step',async()=>{
  const ui=await app({offline:true});try{
    await ui.upload(samples[1].code,samples[1].filename);assert.equal(ui.$('file-inspection').hidden,false);assert.equal(ui.$('story').hidden,true);assert.equal(ui.$('inspection-tab').getAttribute('aria-selected'),'true');assert.match(ui.$('file-inspection').textContent,/File inspection/);assert.match(ui.$('file-inspection').textContent,/temperatures.*readings/s);assert.equal(ui.count('/api/analyze'),0);assert.equal(ui.count('/api/models'),0);
    const value=ui.document.querySelector('#file-inspection [data-inspect-value="average"][data-inspect-scope="s2"]');value.click();assert.equal(ui.$('inspection-name-explorer').hidden,false);assert.match(ui.$('inspection-name-explorer').textContent,/average_temperature\(readings\)/);assert.match(ui.$('inspection-name-explorer').textContent,/format_report\(city, average\)/);ui.document.querySelector('[data-close-name-explorer]').click();assert.equal(ui.$('inspection-name-explorer').hidden,true);assert.equal(ui.document.activeElement,value);
    ui.document.querySelector('#file-inspection [data-inspect-start="12"][data-inspect-end="12"]').click();assert.equal(ui.$('source-range').textContent,'Selected: L12');assert.deepEqual([...ui.document.querySelectorAll('.code-line.focus')].map(line=>line.dataset.line),['12']);
    ui.document.querySelector('[data-inspection-scan]').click();assert.equal(ui.$('connections-page').hidden,false);assert.equal(ui.count('/api/analyze'),0);
  }finally{ui.close();}
});

test('the inspector AI action respects consent, opens the reading guide, and preserves local facts',async()=>{
  const ui=await app({connected:true});try{await ui.upload();assert.equal(ui.$('file-inspection').hidden,false);ui.document.querySelector('[data-inspection-scan]').click();assert.equal(ui.$('consent-dialog').open,true);assert.equal(ui.count('/api/analyze'),0);ui.$('confirm-analysis').click();await waitFor(()=>ui.$('analysis-kind').textContent==='AI + SOURCE ANALYSIS','AI scan result');assert.equal(ui.$('story').hidden,false);assert.equal(ui.$('file-inspection').hidden,true);ui.$('inspection-tab').click();assert.equal(ui.$('file-inspection').hidden,false);assert.match(ui.$('file-inspection').textContent,/value > 30/);assert.doesNotMatch(ui.$('file-inspection').textContent,/Narrative beginner/);ui.document.querySelector('[data-inspection-scan]').click();assert.equal(ui.$('story').hidden,false);assert.equal(ui.count('/api/analyze'),1);}finally{ui.close();}
});

test('inspection facts stay inert and the Python-only tab resets when switching languages',async()=>{
  const ui=await app();try{await ui.upload('value = "<img src=x onerror=alert(1)>"\n','inert.py');assert.equal(ui.document.querySelector('#file-inspection img'),null);assert.match(ui.$('file-inspection').textContent,/<img src=x onerror=alert\(1\)>/);await ui.upload('function hello(){ return 1; }','hello.js');assert.equal(ui.$('inspection-tab').hidden,true);assert.equal(ui.$('file-inspection').hidden,true);assert.equal(ui.$('story').hidden,false);assert.equal(ui.count('/api/analyze'),0);}finally{ui.close();}
});
