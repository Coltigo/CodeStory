import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze,orderedChunks,describeChunk} from '../src/parser.js';
import {samples} from '../src/samples.js';
for(const sample of samples)test(sample.filename+' preserves source and covers each section in both orders',()=>{
  const m=analyze(sample.code,sample.filename);assert.equal(m.code,sample.code);
  for(const mode of ['beginner','developer']){const ordered=orderedChunks(m,mode);assert.equal(ordered.length,m.chunks.length);assert.equal(new Set(ordered.map(c=>c.id)).size,m.chunks.length);}
  for(const c of m.chunks){assert.ok(c.start<c.end);assert.ok(c.startLine<=c.endLine);assert.ok(m.code.slice(c.start,c.end).trim());}
});
test('developer order follows the invocation through its helpers',()=>{const m=analyze(samples[0].code,samples[0].filename),titles=orderedChunks(m,'developer').map(c=>describeChunk(c,m,'developer').title);assert.deepEqual(titles.slice(0,5),['Run checkout','Checkout','Calculate Subtotal','Apply Discount','Format Receipt']);});
test('tracks arrows, recursion and direct calls without looping',()=>{const m=analyze('const double = n => n * 2;\nfunction main(n){ if(n) return main(n-1); return double(n); }\nmain(2);','test.js');const main=m.symbols.find(s=>s.name==='main');assert.equal(main.dependencies.length,2);assert.equal(m.flow.length,3);assert.deepEqual(m.symbols[0].returns,['n * 2']);});
test('a parameter shadow does not connect to a global function',()=>{const m=analyze('function helper(){}\nfunction run(helper){ return helper(); }\nrun(()=>1);','test.js');assert.deepEqual(m.symbols[1].dependencies,[]);assert.equal(m.highlights.filter(h=>m.code.slice(h.start,h.end)==='helper').length,1);});
test('TypeScript generic syntax is parsed without JSX ambiguity',()=>{const m=analyze('const identity = <T>(value: T): T => value;\nconsole.log(identity(1));','test.ts');assert.equal(m.symbols[0].name,'identity');});
test('runtime TypeScript enums are not presented as erased types',()=>{const m=analyze('enum Status { Ready, Done }','test.ts');assert.notEqual(m.chunks[0].kind,'type');});
test('Python supports decorators, async functions, annotations, and nested defaults',()=>{const code='@cache\nasync def main(x: dict[str, int], y=(1, 2), *, z="a,b"):\n    return await helper(x)\n\ndef helper(x):\n    return x\n\nmain({})\n';const m=analyze(code,'test.py');assert.equal(m.symbols.length,2);assert.equal(m.symbols[0].async,true);assert.deepEqual(m.symbols[0].params,['x: dict[str, int]','y=(1, 2)','*','z="a,b"']);assert.deepEqual(m.symbols[0].dependencies,['s1']);assert.equal(m.chunks[0].startLine,1);assert.ok(m.symbols[0].returns[0].includes('await helper'));});
test('Python function body bindings shadow a top-level name',()=>{const m=analyze('def helper():\n    pass\ndef main(helper):\n    return helper()\n','test.py');assert.deepEqual(m.symbols[1].dependencies,[]);});
test('Python docstring is documentation, not an entry point',()=>{const m=analyze('"""Description."""\ndef f():\n    return 1\nf()\n','test.py');assert.equal(m.chunks[0].kind,'documentation');assert.equal(m.flow[0],'c2');});
test('accepts experimental text and rejects oversized, empty, and malformed input with useful errors',()=>{assert.equal(analyze('x','test.rb').support.official,false);assert.throws(()=>analyze(' '.repeat(80000)+'x'),/80,000/);assert.throws(()=>analyze(''),/Add some code/);assert.throws(()=>analyze('function x( {','bad.js'),/line/);assert.throws(()=>analyze('def f(:\n    return 1\n','bad.py'),/line/);});

test('JavaScript directives remain visible as their own sections',()=>{const m=analyze('\"use strict\";\nfunction main(){ return 1; }\nmain();','strict.js');assert.equal(m.chunks[0].kind,'directive');assert.equal(m.chunks[0].startLine,1);assert.equal(m.flow.length,3);});
