import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/parser.js';
import {sourceContext} from '../src/server/ai.js';
import {inspectionContext,INSPECTION_VERSION} from '../src/python-inspection.js';
import {samples} from '../src/samples.js';
const inspect=code=>analyze(code,'inspection.py');

test('Python inspection follows source-backed weather handoffs and keeps original source',()=>{
  const sample=samples.find(s=>s.filename==='weather.py'),model=analyze(sample.code,sample.filename),i=model.inspection;
  assert.equal(i.version,INSPECTION_VERSION);assert.equal(i.executed,false);assert.equal(model.code,sample.code);
  assert.equal(i.summary.functions,3);assert.equal(i.summary.assignments,4);assert.equal(i.summary.handoffs,3);
  const call=i.handoffs.find(c=>c.name==='describe_weather');assert.equal(call.resultName,'report');assert.deepEqual(call.arguments.map(a=>[a.expression,a.parameter]),[['city','city'],['temperatures','readings']]);
  for(const key of ['assignments','returns','decisions','handoffs','unresolvedCalls'])for(const f of i[key]){assert.ok(f.startLine<=f.endLine);assert.equal(f.startLine,model.code.slice(0,f.start).split('\n').length);assert.ok(model.chunks.some(c=>c.id===f.chunkId&&c.start<=f.start&&c.end>=f.end));}
});

test('choices retain both paths, missing else, loop headers and update operators',()=>{
  const model=inspect('def totals(values):\n    total = 0\n    for value in values:\n        if value > 0:\n            total += value\n        else:\n            continue\n    else:\n        print("done")\n    while total > 50:\n        total -= 1\n    if total > 10:\n        return total\n    elif total == 0:\n        return None\n    else:\n        return -1\n');
  const i=model.inspection;assert.deepEqual(i.loops.map(l=>[l.kind,l.hasElse]),[['for',true],['while',false]]);assert.equal(i.loops[0].target,'value');assert.equal(i.loops[0].iterable,'values');assert.equal(i.loops[1].condition,'total > 50');
  assert.deepEqual(i.decisions[1].paths.map(p=>[p.kind,p.condition]),[['if','total > 10'],['elif','total == 0'],['else',null]]);assert.equal(i.decisions[1].paths[2].statements[0].source,'return -1');assert.equal(i.assignments.find(a=>a.operator==='+=').expression,'value');assert.ok(i.assignments.find(a=>a.operator==='-=').controlContext.some(c=>c.kind==='while'));
});

test('scope labels keep nested function returns and references separate',()=>{
  const model=inspect('value = 10\ndef outer(value):\n    result = value + 1\n    def inner(value):\n        result = value * 2\n        return result\n    return result\n');
  const outer=model.symbols.find(s=>s.name==='outer'),inner=model.symbols.find(s=>s.name==='inner');
  assert.deepEqual(model.inspection.returns.map(r=>r.scopeId),[inner.id,outer.id]);assert.equal(model.inspection.assignments.filter(a=>a.scopeId===outer.id).length,1);assert.equal(model.inspection.assignments.filter(a=>a.scopeId===inner.id).length,1);
});

test('imports preserve alias and conditional scope without importing a package',()=>{
  const model=inspect('import made_up_module as custom, math\nfrom pathlib import Path as FilePath\nfrom . import helpers\ndef read():\n    if custom:\n        from .data import load as loader\n    return 1\n'),i=model.inspection;
  assert.deepEqual(i.imports[0].bindings,[{imported:'made_up_module',local:'custom'},{imported:'math',local:'math'}]);assert.equal(i.imports[1].module,'pathlib');assert.equal(i.imports[1].bindings[0].local,'FilePath');assert.equal(i.imports[2].module,'.');assert.equal(i.imports[3].scopeId,model.symbols[0].id);assert.ok(i.imports[3].controlContext.length);
});

test('shadowed functions and dynamic call targets remain unresolved',()=>{
  const model=inspect('def helper(value):\n    return value\ndef run(helper, value):\n    return helper(value)\n\n(get_factory())(3)\n');
  assert.equal(model.inspection.handoffs.length,0);assert.ok(model.inspection.unresolvedCalls.some(c=>c.name==='helper'));assert.ok(model.inspection.unresolvedCalls.some(c=>c.name==='(get_factory())'));
});

test('keyword and unpacked arguments are not assigned invented positional parameters',()=>{
  const model=inspect('def work(first, second=2):\n    return first + second\nwork(1, second=3)\nwork(*values)\n'),calls=model.inspection.handoffs;
  assert.deepEqual(calls[0].arguments.map(a=>a.parameter),['first','second']);assert.equal(calls[1].arguments[0].unpacked,true);assert.equal(calls[1].arguments[0].parameter,null);
});

test('method argument labels stay unknown rather than binding a value to self',()=>{
  const model=inspect('class Worker:\n    def helper(self, value):\n        return value\n    def run(self, value):\n        return self.helper(value)\n');
  const call=model.inspection.handoffs.find(c=>c.name==='self.helper');assert.ok(call);assert.equal(call.arguments[0].parameter,null);
});

test('decorators, default expressions and awaited calls retain timing context',()=>{
  const model=inspect('def decorate(function):\n    return function\ndef supply():\n    return 2\n@decorate\ndef task(value=supply()):\n    return value\nasync def fetch():\n    return 1\nasync def run():\n    result = await fetch()\n    return result\n');
  const i=model.inspection,decorator=i.handoffs.find(c=>c.definitionTime),supply=i.handoffs.find(c=>c.name==='supply'),fetch=i.handoffs.find(c=>c.name==='fetch');
  assert.equal(decorator.definitionName,'task');assert.equal(decorator.scopeId,'module');assert.equal(supply.definitionHeader,true);assert.equal(supply.scopeId,'module');assert.equal(fetch.awaited,true);assert.equal(fetch.resultName,'result');assert.equal(fetch.timing,'deferred-async');
});

test('yield-from and bare return are represented without inventing an ordinary returned item',()=>{
  const model=inspect('def values(items):\n    yield from items\n    return\n');assert.equal(model.inspection.returns[0].delegated,true);assert.equal(model.inspection.returns[0].expression,'items');assert.equal(model.inspection.returns[1].expression,null);
});

test('AI receives bounded inspection facts alongside the unchanged original source',()=>{
  const code=Array.from({length:45},(_,n)=>`value${n} = ${n}`).join('\n'),model=inspect(code),context=sourceContext(model);
  assert.equal(context.source,code);assert.equal(context.localInspection.executed,false);assert.equal(context.localInspection.assignments.length,30);assert.equal(context.localInspection.omittedCounts.assignments,15);assert.equal(context.localInspection.summary.assignments,45);assert.equal(inspectionContext(undefined),undefined);
  assert.equal(sourceContext(analyze('const x = 1;','test.js')).localInspection,undefined);
});

test('match cases and short-circuit calls retain their syntax context without inventing a selected path',()=>{
  const model=inspect('def helper():\n    return 1\nmatch value:\n    case 1:\n        helper()\n    case _:\n        print(0)\nvalue and helper()\n'),i=model.inspection;
  assert.deepEqual(i.decisions[0].paths.map(p=>[p.kind,p.condition]),[['case','1'],['case','_']]);assert.ok(i.handoffs[0].controlContext.some(c=>c.kind==='match'));assert.ok(i.handoffs[1].controlContext.some(c=>c.kind==='BinaryExpression'));
});

test('AI fact previews bound long text and nested argument lists without shortening the original source',()=>{
  const code='def helper('+Array.from({length:16},(_,i)=>'arg'+i).join(', ')+'):\n    return 1\nvalue = "'+'x'.repeat(300)+'"\nhelper('+Array.from({length:16},(_,i)=>i).join(', ')+')\n',model=inspect(code),context=sourceContext(model);
  assert.equal(context.source,code);assert.equal(context.localInspection.handoffs[0].arguments.length,12);assert.equal(context.localInspection.assignments[0].expression.length,238);assert.equal(context.localInspection.previewLimits.textTruncated,true);assert.equal(context.localInspection.previewLimits.nestedListTruncated,true);assert.equal(model.inspection.handoffs[0].arguments.length,16);
});

test('chained assignments retain chained equal signs in facts and variable exploration',async()=>{
 const {renderInspection,renderNameExplorer}=await import('../src/inspection-view.js');const {JSDOM}=await import('jsdom');const model=inspect('first = second = 7\n'),options={esc:String,chip:()=>'',link:()=>''};
 const dom=new JSDOM('<div>'+renderInspection(model,options)+renderNameExplorer(model,'first','module',options)+'</div>');try{assert.match(dom.window.document.body.textContent,/first = second = 7/);assert.doesNotMatch(dom.window.document.body.textContent,/first , second/);}finally{dom.window.close();}
});

test('duplicate, excess or unknown arguments do not claim a successful parameter handoff',()=>{
 const model=inspect('def work(first, second=2):\n    return first + second\nwork(1, first=3)\nwork(1, 2, 3)\nwork(unknown=1)\n');assert.equal(model.inspection.handoffs.length,3);for(const call of model.inspection.handoffs){assert.ok(call.arguments.every(a=>a.parameter===null));assert.ok(call.arguments.every(a=>a.bindingIssue));}
});
