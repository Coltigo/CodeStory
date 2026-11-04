import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import demo from '../src/demo/weather-project.json' with {type:'json'};
import {inspectProject,projectId,projectContext} from '../src/projects.js';
import {buildProjectStory} from '../src/project-story.js';
import {projectHandoff} from '../src/project-handoffs.js';
import {renderProjectStory} from '../src/project-story-view.js';
const file=(path,code)=>({path,code});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const options={esc,link:(path,start,end,label)=>`<button data-project-source="${esc(path)}" data-project-start="${start}" data-project-end="${end}">${esc(label||path)}</button>`,chip:id=>`<button data-project-symbol="${esc(id)}">${esc(id)}</button>`};
const demoResults=()=>new Map(Object.entries(demo.guides).map(([path,result])=>[path,{result}]));
function guides(project){return new Map(project.files.filter(f=>f.model).map(f=>[f.path,{result:{story:{overview:'Literal guide',narrative:{available:true,overview:'A little workshop.',premise:'A source metaphor.'},chapters:f.model.chunks.map(c=>({id:c.id,title:'The job card',beginner:'Literal beginner.',developer:'Literal developer.',storyBeginner:'Pip opens this job card and follows the written work.',storyDeveloper:'Pip reads the details on this job card.'})),functions:f.model.symbols.map(s=>({id:s.id,purpose:'Literal purpose of '+s.name,storyBeginner:'Pip visits friend '+s.name+' and reads the whole job card.',storyDeveloper:'Pip studies coworker '+s.name+' and the written details.'}))}}}]))}

test('project tour uses full scenes and follows helper replies back through the source callers',()=>{
 const p=inspectProject(demo.files),book=buildProjectStory(p,demoResults(),projectId('main.py'));
 assert.deepEqual(book.events.filter(e=>e.type==='scene').map(e=>e.node.id),['main.py#module','main.py#s0','report.py#s0','units.py#s0']);
 const average=book.events.find(e=>e.type==='scene'&&e.node.path==='units.py');assert.ok(average.sections[0].text.length>demo.guides['units.py'].story.narrative.overview.length*5);assert.equal(average.sections[0].text.split('\n\n').length,3);
 const returns=book.events.filter(e=>e.type==='return');assert.deepEqual(returns.map(e=>e.to.id),['report.py#s0','main.py#s0','main.py#module']);assert.equal(returns[0].handoff.resultName,'temperature');assert.equal(returns[1].handoff.passedToCall,'print');assert.equal(book.cut,false);
});

test('source handoffs preserve actual argument names and local parameter labels across files',()=>{
 const p=inspectProject(demo.files),main=p.links.find(e=>e.crossFile&&e.from.path==='main.py'),average=p.links.find(e=>e.crossFile&&e.from.path==='report.py');assert.deepEqual(projectHandoff(p,main).arguments.map(a=>[a.expression,a.parameter]),[['"Harbor Town"','city'],['readings','readings']]);assert.deepEqual(projectHandoff(p,average).arguments.map(a=>[a.expression,a.parameter]),[['readings','values']]);
});

test('same-line calls and shared helpers have distinct packages and one reusable scene',()=>{
 const p=inspectProject([file('main.py','def helper(value):\n    return value\nfirst = helper(1); second = helper(2)\n')]);const book=buildProjectStory(p,guides(p),projectId('main.py'));const handoffs=book.events.filter(e=>e.type==='handoff');assert.deepEqual(handoffs.map(e=>e.handoff.arguments[0].expression),['1','2']);assert.deepEqual(handoffs.map(e=>e.handoff.resultName),['first','second']);assert.equal(book.events.filter(e=>e.type==='scene'&&e.node.localId==='s0').length,1);assert.ok(book.events.some(e=>e.type==='revisit'&&!e.cycle));
});

test('recursion terminates and is labeled as a source cycle rather than a repeated runtime trace',()=>{
 const p=inspectProject([file('a.py','from b import second\ndef first():\n    return second()'),file('b.py','from a import first\ndef second():\n    return first()')]),book=buildProjectStory(p,guides(p),projectId('a.py','s0'));assert.equal(book.sceneCount,2);assert.equal(book.events.filter(e=>e.type==='revisit'&&e.cycle).length,1);assert.ok(book.events.length<10);
});

test('parameter guesses are suppressed for unpacking, conflicting arguments and receiver methods',()=>{
 for(const call of ['helper(*items)','helper(1, value=2)','helper(1, 2)']){const p=inspectProject([file('a.py','def helper(value):\n    return value\n'+call)]),edge=p.links[0];assert.ok(projectHandoff(p,edge).arguments.every(a=>a.parameter===null),call);}
 const p=inspectProject([file('a.py','class Worker:\n    def helper(self, value):\n        return value\n    def run(self):\n        return self.helper(3)')]);assert.ok(projectHandoff(p,p.links[0]).arguments.every(a=>a.parameter===null));
});

test('deferred work and definition-time factory calls retain their timing in the story',()=>{
 const p=inspectProject([file('a.py','def decorator_factory(value):\n    return value\n@decorator_factory(2)\ndef wrapped():\n    return 1\nasync def later(value):\n    return value\njob = later(3)\n')]);const decorator=p.links.find(e=>e.callName==='decorator_factory'),later=p.links.find(e=>e.callName==='later');assert.equal(decorator.definitionTime,true);assert.equal(projectHandoff(p,later).timing,'async');const dom=new JSDOM(renderProjectStory(p,guides(p),projectId('a.py'),'beginner',options));try{assert.match(dom.window.document.body.textContent,/waiting work|ticket for work/);assert.match(dom.window.document.body.textContent,/before that newly defined body is called/);}finally{dom.window.close();}
});

test('unlinked source files and functions are separated from the verified tour',()=>{
 const p=inspectProject([file('main.js','import {work} from "./tools.js";\nwork();'),file('tools.js','export function work(){return 1;}')]),book=buildProjectStory(p,guides(p),projectId('main.js'));assert.equal(book.events.filter(e=>e.type==='handoff').length,0);assert.equal(book.context.length,1);assert.equal(book.context[0].node.path,'tools.js');assert.equal(book.context[0].context,true);assert.ok(book.context[0].sections[0].text.includes('Pip'));assert.ok(book.unvisited.some(n=>n.path==='tools.js'));
});

test('missing or declined guides remain explicit instead of becoming invented scenes',()=>{
 const p=inspectProject(demo.files),results=demoResults();results.delete('units.py');const book=buildProjectStory(p,results,projectId('main.py'));const missing=book.events.find(e=>e.type==='scene'&&e.node.path==='units.py');assert.equal(missing.available,false);assert.match(missing.reason,/Scan this file/);assert.equal(missing.sections.length,0);
 const declined=structuredClone(demo.guides['report.py']);declined.story.narrative.available=false;declined.story.narrative.reason='The required behavior is missing.';results.set('report.py',{result:declined});assert.match(buildProjectStory(p,results,projectId('main.py')).events.find(e=>e.type==='scene'&&e.node.path==='report.py').reason,/behavior is missing/);
});

test('story context previews are bounded while the original selected source remains available',()=>{
 const huge='x'.repeat(2000),p=inspectProject([file('a.py','def helper(value):\n    return value\nresult = helper("'+huge+'")')]),ctx=projectContext(p,'a.py',projectId('a.py'));assert.ok(ctx.storyHandoffs[0].arguments[0].expression.length<=240);assert.ok(ctx.storyHandoffs[0].source.length<=240);assert.equal(p.files[0].code.includes(huge),true);assert.equal(ctx.storyHandoffs[0].previewLimits.completeSourceSuppliedSeparately,true);
});

test('rendered story keeps source data inert and uses scene navigation, reply links and full demo prose',()=>{
 const p=inspectProject(demo.files),html=renderProjectStory(p,demoResults(),projectId('main.py'),'beginner',{...options,demo:demo.projectStory}),dom=new JSDOM(html);try{const doc=dom.window.document;assert.equal(doc.querySelectorAll('.project-story-scene').length,4);assert.equal(doc.querySelectorAll('.story-reply').length,3);assert.match(doc.body.textContent,/part of the job/);assert.match(doc.body.textContent,/a list and gives the bundle/);assert.match(doc.body.textContent,/reply on as an input to print/);assert.match(doc.body.textContent,/20\.0 C, mild/);assert.ok(doc.querySelector('[data-project-stay-story]'));assert.ok(doc.querySelector('[data-project-story-jump]'));assert.ok(doc.querySelector('.story-cast'));}finally{dom.window.close();}
 const source=inspectProject([file('a.py','def helper(value):\n    return value\nhelper("<img src=x onerror=alert(1)>")')]);const malicious=guides(source);malicious.get('a.py').result.story.functions[0].storyBeginner='<script>alert(1)</script>';malicious.get('a.py').result.story.functions[0].storyDeveloper='<script>alert(1)</script>';const unsafe=new JSDOM(renderProjectStory(source,malicious,projectId('a.py'),'developer',options));try{assert.equal(unsafe.window.document.querySelector('script,img'),null);assert.match(unsafe.window.document.body.textContent,/<script>alert\(1\)<\/script>/);}finally{unsafe.window.close();}
});
