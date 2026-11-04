import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectProject,projectFlow,projectContext,projectId,validateProjectFiles,excludedProjectPath} from '../src/projects.js';
const file=(path,code)=>({path,code});
const simple=()=>[file('main.py','from helpers import double as twice\ndef run(value):\n    return twice(value)\nif __name__ == "__main__":\n    print(run(3))\n'),file('helpers.py','def double(value):\n    return value * 2\n')];

test('project direct imported aliases carry exact file-qualified caller and definition identities',()=>{
 const p=inspectProject(simple()),edge=p.links.find(e=>e.crossFile);assert.equal(edge.from.id,projectId('main.py','s0'));assert.equal(edge.to.id,projectId('helpers.py','s0'));assert.equal(edge.line,3);assert.equal(edge.importLine,1);assert.equal(p.nodes.filter(n=>n.localId==='s0').length,2);
 const flow=projectFlow(p,projectId('main.py'));assert.deepEqual(flow.nodes.map(n=>n.name),['main.py','run','double']);assert.equal(flow.cycle,false);
 const context=projectContext(p,'main.py',projectId('main.py'));assert.equal(context.relatedSource[0].path,'helpers.py');assert.equal(context.relatedSource[0].source,simple()[1].code);assert.match(context.instructions,/untrusted data/);
});

test('relative imports, module aliases and from-package module imports resolve without dropping package paths',()=>{
 const p=inspectProject([file('pkg/__init__.py','# package\n'),file('pkg/main.py','from . import tools as helper\nfrom .tools import double as twice\nimport pkg.tools as other\nhelper.double(2)\ntwice(3)\nother.double(4)\n'),file('pkg/tools.py','def double(value):\n    return value * 2\n')]);assert.equal(p.links.filter(e=>e.crossFile).length,3);assert.ok(p.links.every(e=>e.to.path==='pkg/tools.py'));
 const nested=inspectProject([file('pkg/sub/main.py','from ..tools import double\ndouble(4)\n'),file('pkg/tools.py','def double(x):\n    return x * 2')]);assert.equal(nested.links.length,1);
});

test('src import root is explicit and ambiguous module candidates stay unresolved',()=>{
 const files=[file('src/main.py','from helpers import work\nwork()'),file('src/helpers.py','def work():\n    return 1')];assert.equal(inspectProject(files).links.length,0);assert.equal(inspectProject(files,{importRoot:'src'}).links.length,1);
 const p=inspectProject([file('main.py','from helpers import work\nwork()'),file('helpers.py','def work():\n    return 1'),file('helpers/__init__.py','def work():\n    return 2')]);assert.equal(p.links.length,0);assert.equal(p.unknownCalls.length,1);
});

test('same basenames and function names in different packages never collide',()=>{
 const p=inspectProject([file('main.py','from a.tools import work as a\nfrom b.tools import work as b\na()\nb()'),file('a/tools.py','def work():\n    return "A"'),file('b/tools.py','def work():\n    return "B"')]);assert.deepEqual(p.links.map(e=>e.to.path),['a/tools.py','b/tools.py']);assert.equal(new Set(p.nodes.map(n=>n.id)).size,p.nodes.length);
});

test('parameters, local assignments, comprehension names and wildcard imports block invented imported calls',()=>{
 const cases=['from helpers import double\ndef run(double):\n    return double(1)','from helpers import double\ndef run():\n    double = other\n    return double(1)','from helpers import double\nvalues = [double(1) for double in workers]','from helpers import double\nfrom unknown import *\ndouble(1)','if enabled:\n    from helpers import double\ndouble(1)','import helpers\nhelpers.double = other\nhelpers.double(1)'];
 for(const code of cases){const p=inspectProject([file('main.py',code),simple()[1]]);assert.equal(p.links.filter(e=>e.crossFile).length,0,code);}
});

test('replaced exports and re-exports are not treated as verified source function definitions',()=>{
 for(const code of ['def double(x):\n    return x\ndouble = other','from actual import double','from missing import *\ndef double(x):\n    return x','if enabled:\n    def double(x):\n        return x']){const p=inspectProject([simple()[0],file('helpers.py',code)]);assert.equal(p.links.filter(e=>e.crossFile).length,0,code);}
});

test('missing external modules and unreadable Python stay visible without breaking the project',()=>{
 const p=inspectProject([file('main.py','from missing import work\nwork()'),file('broken.py','def :\n nope')]);assert.equal(p.files.length,2);assert.ok(p.files[1].error);assert.equal(p.links.length,0);assert.equal(p.imports[0].targetPath,null);assert.match(p.unknownCalls[0].reason,/missing/);assert.throws(()=>projectContext(p,'broken.py',projectId('main.py')),/inspector/);
});

test('cycles terminate and include every reachable helper once',()=>{
 const p=inspectProject([file('a.py','from b import second\ndef first():\n    return second()'),file('b.py','from a import first\ndef second():\n    return first()')]);const flow=projectFlow(p,projectId('a.py','s0'));assert.equal(flow.cycle,true);assert.equal(flow.nodes.length,2);assert.equal(flow.edges.length,2);assert.throws(()=>projectFlow(p,'invented#s0'),/entry/);
});

test('project input limits count UTF-8 bytes and reject paths, dependencies, secrets and duplicates',()=>{
 for(const path of ['../main.py','/main.py','a//b.py','a\\b.py','C:/main.py','a/./main.py','a/../b.py'])assert.throws(()=>validateProjectFiles([file(path,'print(1)')]));
 for(const path of ['.git/hook.py','.venv/lib.py','secrets.py','app/.env.py','node_modules/x.py','build/out.py','photo.png'])assert.ok(excludedProjectPath(path));
 assert.throws(()=>validateProjectFiles([file('a.py','x'),file('a.py','y')]),/Duplicate/);assert.throws(()=>validateProjectFiles(Array.from({length:21},(_,i)=>file(i+'.py','x'))),/20/);assert.throws(()=>validateProjectFiles([file('a.py','é'.repeat(40001))]),/80 KB/);assert.throws(()=>validateProjectFiles(['a','b','c','d'].map(p=>file(p+'.py','#'.repeat(70000)))),/240 KB/);
});

test('empty package markers are retained without parser errors and dotted filenames cannot impersonate packages',()=>{
 const empty=inspectProject([file('pkg/__init__.py',''),file('main.py','print(1)')]);assert.equal(empty.files[0].empty,true);assert.equal(empty.files[0].error,null);
 const p=inspectProject([file('main.py','from a.b import work\nwork()'),file('a.b.py','def work():\n    return 1')]);assert.equal(p.links.length,0);
});

test('package attributes and unloaded module members do not masquerade as direct submodule imports',()=>{
 for(const main of ['import pkg\npkg.tools.work()','from pkg import tools\ntools.work()']){const p=inspectProject([file('main.py',main),file('pkg/__init__.py','tools = replacement\n'),file('pkg/tools.py','def work():\n    return 1')]);assert.equal(p.links.length,0,main);}
 const p=inspectProject([file('main.py','from tools import Worker\nWorker.work()'),file('tools.py','class Worker:\n    pass'),file('tools/Worker.py','def work():\n    return 1')]);assert.equal(p.links.length,0);
});

test('bundled small projects have readable source and two verified cross-file handoffs',async()=>{
 const fs=await import('node:fs/promises');for(const name of ['weather-workshop','password-quality']){const dir=new URL('../examples/projects/'+name+'/',import.meta.url),names=(await fs.readdir(dir)).filter(n=>n.endsWith('.py'));const files=await Promise.all(names.map(async path=>({path,code:await fs.readFile(new URL(path,dir),'utf8')})));const p=inspectProject(files);assert.ok(p.files.every(f=>f.model),name);assert.equal(p.links.filter(e=>e.crossFile).length,2,name);assert.ok(projectFlow(p,projectId('main.py')).nodes.length>=4);}
});

test('AI context includes selected import data modules even when no cross-file function is called',()=>{
 const p=inspectProject([file('main.py','from config import FACTOR\nvalue = 5 * FACTOR'),file('config.py','FACTOR = 0.62')]);const context=projectContext(p,'main.py',projectId('main.py'));assert.equal(context.relatedSource[0].path,'config.py');assert.equal(context.knownImports[0].targetPath,'config.py');assert.equal(context.knownConnections.length,0);
});

test('mixed-language projects preserve source, local calls and language-specific inspection context',()=>{
 const sources=[
  file('main.js','function double(value){return value * 2;}\nconsole.log(double(3));'),
  file('typed.cts','function add(value:number):number {return value + 1;}\nadd(3);'),
  file('page.html','<h1>Hello</h1><script src="./main.js"></script>'),
  file('App.java','class App { static int doubleValue(int value) { return value * 2; } public static void main(String[] args) { System.out.println(doubleValue(3)); } }'),
  file('App.cs','class App { static int Double(int value) { return value * 2; } static void Main() { System.Console.WriteLine(Double(3)); } }'),
  file('query.sql','SELECT name FROM people WHERE active = true;'),
  file('script.py','def double(value):\n    return value * 2\nprint(double(3))'),
  file('main.go','package main\nfunc main() { println("hello") }'),
  file('mystery.custom','an unfamiliar source language\nnext instruction'),
  file('Dockerfile','FROM node:24\nWORKDIR /app\n'),
  file('style.css','body { color: purple; }')
 ];
 const p=inspectProject(sources);assert.ok(p.files.every(f=>f.model),JSON.stringify(p.files.filter(f=>f.error).map(f=>[f.path,f.error])));assert.equal(p.files.find(f=>f.path==='typed.cts').model.language,'TypeScript');assert.equal(p.files.find(f=>f.path==='main.go').model.language,'Go');assert.ok(p.links.some(e=>e.path==='main.js'&&e.to.localId==='s0'));assert.ok(p.links.every(e=>!e.crossFile));assert.ok(p.imports.some(i=>i.path==='page.html'&&i.targetPath==='main.js'));
 const context=projectContext(p,'main.go',projectId('main.go'));assert.equal(context.scope,'selected-source-project');assert.equal(context.relatedSource.length,sources.length-1);assert.equal(context.manifest.find(f=>f.path==='main.go').inspection,'text');assert.equal(context.manifest.find(f=>f.path==='main.js').inspection,'syntax');
});

test('project file selection accepts uncommon and extensionless text but rejects binary contents and binary file types',()=>{
 for(const path of ['main.rb','program.rs','file.js','Makefile','file.unusual','style.svg','settings.json'])assert.equal(excludedProjectPath(path),'');
 for(const path of ['app.exe','font.woff2','archive.zip','document.pdf','photo.png'])assert.ok(excludedProjectPath(path));
 assert.throws(()=>validateProjectFiles([file('program.custom','\u0000\u0001data')]),/plain-text source/);
 const p=inspectProject([file('directives.cs','#define DEBUG\nclass App {}')]);assert.notEqual(p.files[0].empty,true,'C# directives must not be mistaken for Python comments');
});

test('JavaScript import context remains separate from verified callable bindings',()=>{
 const p=inspectProject([file('main.js','import {work} from "./helpers.js";\nwork();'),file('helpers.js','export function work(){return 1;}'),file('other.py','def work():\n    return 2')]);assert.equal(p.links.length,0);assert.equal(p.imports[0].targetPath,'helpers.js');assert.equal(p.unknownCalls[0].callName,'work');assert.ok(projectContext(p,'main.js',projectId('main.js')).relatedSource.some(f=>f.path==='helpers.js'));
});
