import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installProjects} from '../src/projects-view.js';
import {analyze} from '../src/parser.js';
import {installTabKeys} from '../src/tabs.js';
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Timed out waiting for project UI');}
function guide(code,path){const p=analyze(code,path.split('/').at(-1));return {model:'mock',story:{overview:'AI guide for '+path,conceptOrder:p.concepts,flowOrder:p.flow,chapters:p.chunks.map(c=>({id:c.id,title:'Explain '+path,beginner:'Literal beginner '+path,developer:'Literal developer '+path,storyBeginner:'Pip visits his friend in '+path,storyDeveloper:'Pip meets the coworker in '+path})),limitations:[],narrative:{available:true,reason:'',overview:'Pip visits the room '+path}}};}
function setup({fail='',delay=false}={}){
 const dom=new JSDOM('<main id="projects-page"></main>',{url:'http://127.0.0.1:4173',pretendToBeVisual:true}),{document}=dom.window,$=id=>document.getElementById(id),calls=[];let busy=false,connected=true,opens=0,failNext=fail;
 dom.window.HTMLElement.prototype.scrollIntoView=function(){};dom.window.matchMedia=()=>({matches:true});dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 const api=async(path,{body,signal})=>{calls.push({path,body});if(delay)await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')));});if(failNext===body.path){failNext='';throw new Error('Simulated file failure');}const f=body.files.find(f=>f.path===body.path);return guide(f.code,f.path);};
 const ui=installProjects({document,api,getConnection:()=>connected?{id:'fixture',label:'Fixture plan',ready:true,kind:'chatgpt_plan'}:null,getModels:()=>connected?[{id:'mock',name:'Mock model'}]:[],getBusy:()=>busy,setBusy:value=>{busy=value;},openConnections:()=>opens++});installTabKeys(document);
 async function example(){$('project-example').click();await until(()=>$('project-entry').options.length>0);}
 return {ui,$,calls,dom,example,connected(value){connected=value;ui.refreshConnection();},opens:()=>opens,async start(){$('project-scan').click();assert.equal($('project-consent').open,true);$('project-confirm').click();},close:()=>dom.window.close()};
}

test('project inspection is local, previews exclusions and selects exact source from a cross-file link',async()=>{
 const t=setup();try{await t.example();assert.equal(t.calls.length,0);assert.equal(t.$('project-workbench').hidden,false);assert.match(t.$('project-reading').textContent,/cross-file calls linked/);t.dom.window.document.querySelector('[data-project-tab="map"]').click();const ref=t.dom.window.document.querySelector('[data-project-source="units.py"][data-project-start="1"]');assert.ok(ref);ref.click();assert.equal(t.$('project-source-title').textContent,'units.py');assert.match(t.$('project-source-code').textContent,/def average/);assert.equal(t.$('project-back').hidden,false);t.$('project-back').click();assert.equal(t.$('project-source-title').textContent,'main.py');assert.equal(t.calls.length,0);}finally{t.close();}
});

test('project AI consent names selected files and model, preserves successful guides on partial failure and retries only missing guides',async()=>{
 const t=setup({fail:'report.py'});try{await t.example();t.$('project-scan').click();assert.equal(t.calls.length,0);assert.match(t.$('project-sharing').textContent,/3 AI requests/);assert.match(t.$('project-sharing').textContent,/main.py.*report.py.*units.py/s);t.$('project-confirm').click();await until(()=>t.$('project-progress').textContent.includes('2 completed'));assert.equal(t.calls.length,3);assert.match(t.$('project-reading').textContent,/AI guide for main.py/);assert.match(t.$('project-notice').textContent,/needing attention/);await t.start();await until(()=>t.calls.length===4&&t.$('project-progress').textContent.includes('3 completed'));assert.equal(t.calls[3].body.path,'report.py');assert.ok(t.calls.every(c=>c.path==='/api/projects/analyze-file'&&c.body.consent===true&&c.body.connectionId==='fixture'));t.$('project-story').click();assert.match(t.$('project-reading').textContent,/coworker/);const count=t.calls.length;t.$('project-developer').click();assert.equal(t.calls.length,count);}finally{t.close();}
});

test('cancel stops the project queue without sending another file',async()=>{
 const t=setup({delay:true});try{await t.example();await t.start();await until(()=>t.calls.length===1);t.$('project-cancel').click();await until(()=>t.$('project-notice').textContent.includes('canceled'));assert.equal(t.calls.length,1);assert.equal(t.$('project-folder').disabled,false);assert.equal(t.$('project-cancel').hidden,true);}finally{t.close();}
});

test('disconnected project remains inspectable and offers connection setup without an error or inference',async()=>{
 const t=setup();try{await t.example();t.connected(false);t.$('project-scan').click();assert.equal(t.opens(),1);assert.equal(t.calls.length,0);assert.equal(t.$('project-consent').open,false);t.$('project-story').click();assert.match(t.$('project-reading').textContent,/Scan this file with AI/);assert.equal(t.$('project-literal').getAttribute('aria-pressed'),'false');}finally{t.close();}
});

test('file review excludes sensitive and generated files and keeps uploaded HTML inert',async()=>{
 const t=setup();try{const files=[['root/main.py','print("<img src=x onerror=alert(1)>")'],['root/.venv/hidden.py','x=1'],['root/secrets.py','secret=1'],['root/note.txt','hello']].map(([path,code])=>({name:path.split('/').at(-1),webkitRelativePath:path,size:code.length,text:async()=>code}));Object.defineProperty(t.$('project-folder-input'),'files',{value:files});t.$('project-folder-input').dispatchEvent(new t.dom.window.Event('change'));await until(()=>t.$('project-excluded-count').textContent.includes('3 skipped'));assert.equal(t.dom.window.document.querySelectorAll('[data-project-include]').length,1);t.dom.window.document.querySelector('[data-project-open]').click();assert.equal(t.$('project-source-code').querySelector('img'),null);assert.match(t.$('project-source-code').textContent,/<img src=x/);assert.equal(t.calls.length,0);}finally{t.close();}
});

test('project tab arrow keys activate one panel and keep a single tab stop',async()=>{
 const t=setup();try{await t.example();const first=t.$('project-overview-tab');first.focus();first.dispatchEvent(new t.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(t.dom.window.document.activeElement,t.$('project-file-tab'));assert.equal(t.$('project-file-tab').getAttribute('aria-selected'),'true');assert.equal(t.$('project-overview-tab').tabIndex,-1);t.$('project-file-tab').dispatchEvent(new t.dom.window.KeyboardEvent('keydown',{key:'End',bubbles:true}));assert.equal(t.$('project-reading').getAttribute('aria-labelledby'),'project-map-tab');}finally{t.close();}
});

test('project completion and colored source functions keep independent reading progress across modes',async()=>{
 const t=setup();try{await t.example();t.$('project-file-tab').click();const button=t.dom.window.document.querySelector('[data-project-complete]');button.focus();button.click();assert.equal(button.textContent,'✓');assert.equal(t.dom.window.document.activeElement,button);assert.equal(button.getAttribute('aria-pressed'),'true');t.$('project-developer').click();assert.equal(t.dom.window.document.querySelector(`[data-project-complete="${button.dataset.projectComplete}"]`).getAttribute('aria-pressed'),'true');const imported=t.dom.window.document.querySelector('[data-project-symbol="report.py#s0"]');assert.ok(imported);imported.click();assert.equal(t.$('project-source-title').textContent,'report.py');assert.ok(t.$('project-source-code').querySelector('.code-function'));assert.equal(t.calls.length,0);}finally{t.close();}
});
