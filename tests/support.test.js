import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/parser.js';
import {languageSupport,STRUCTURED_LANGUAGES} from '../src/support.js';
import {samples} from '../src/samples.js';
import {describeStoryChunk,storyFunction,storyReadiness} from '../src/narrative.js';

for(const language of STRUCTURED_LANGUAGES)test(language+' has a source-linked syntax reading guide',()=>{
  const sample=samples.find(s=>languageSupport(s.filename).language===language)||(language==='TypeScript'?{filename:'example.ts',code:'function double(value:number):number {return value * 2;}\ndouble(4);'}:null);
  assert.ok(sample,'Missing sample: '+language);
  const model=analyze(sample.code,sample.filename);assert.equal(model.support.structured,true);assert.equal(model.language,language);assert.ok(model.chunks.length>1);
  assert.equal(new Set(model.flow).size,model.chunks.length);assert.equal(new Set(model.concepts).size,model.chunks.length);
  for(const chunk of model.chunks){assert.ok(chunk.start<chunk.end);assert.ok(chunk.startLine<=chunk.endLine);assert.ok(model.code.slice(chunk.start,chunk.end).trim());}
});
test('TypeScript uses its grammar without a support-tier label',()=>{
  const m=analyze('const identity = <T>(value:T):T => value;\nidentity(1);','generic.ts');assert.equal(m.language,'TypeScript');assert.equal(m.symbols[0].name,'identity');assert.equal(m.support.structured,true);assert.equal(m.warnings.length,0);assert.equal(Object.hasOwn(m.support,'official'),false);
});
test('unknown extensions preserve source and line references without invented functions or semantic claims',()=>{
  const code='some niche language\n  unknown syntax\n\nmore source\n';
  const m=analyze(code,'example.niche');assert.equal(m.code,code);assert.equal(m.support.structured,false);assert.equal(m.symbols.length,0);assert.equal(m.highlights.length,0);assert.match(m.warnings.join(' '),/source as text/);assert.match(m.analysisNotes.join(' '),/not been verified/);
  for(const c of m.chunks)assert.equal(c.startLine,code.slice(0,c.start).split('\n').length);
});
test('binary-looking uploads are rejected instead of receiving an unverified explanation',()=>{
  assert.throws(()=>analyze('\u0000\u0001\u0002PNG','picture.png'),/plain-text source/);
});
test('local Story Mode uses only verified teammates and names actual branch conditions',()=>{
  const m=analyze('function helper(x){return x;}\nfunction decide(value){if(value>0)return helper(value);return 0;}\ndecide(2);','story.js');
  const s=m.symbols.find(s=>s.name==='decide');const story=storyFunction(s,m,'beginner');assert.match(story,/helper/);assert.match(story,/value is greater than 0/);assert.match(story,/does not say which path/);
  const c=m.chunks.find(c=>c.symbolIds.includes(s.id));assert.ok(describeStoryChunk(c,m,'beginner',{body:'Literal facts'}).literal);
});
test('JavaScript catch/class/block bindings do not create false workshop collaborations',()=>{
  const variants=['function helper(){}\nfunction run(){try{}catch(helper){helper();}}','function helper(){}\nfunction run(){class helper{}; helper();}','function helper(){}\n{const helper=()=>2;helper();}'];
  for(const code of variants){const m=analyze(code,'shadow.js');assert.ok(m.symbols.every(s=>s.dependencies.length===0));assert.equal(m.highlights.filter(h=>code.slice(h.start,h.end)==='helper').length,1);}
});

test('Python Story Mode distinguishes deferred coroutine and generator work',()=>{
  const generator=analyze('def readings():\n    value = yield 1\n    return value\n','generator.py');
  assert.equal(generator.symbols[0].generator,true);assert.match(storyFunction(generator.symbols[0],generator),/work waits until someone asks for items/);assert.match(storyFunction(generator.symbols[0],generator),/return ends this series/i);
  const coroutine=analyze('async def read_value():\n    return 1\n','coroutine.py');
  assert.match(storyFunction(coroutine.symbols[0],coroutine),/ticket for work that waits/);assert.match(storyFunction(coroutine.symbols[0],coroutine),/awaits or schedules/);
  const asyncGenerator=analyze('async def readings():\n    yield 1\n','async_generator.py');assert.match(storyFunction(asyncGenerator.symbols[0],asyncGenerator),/async request for each next item/);
});
test('Python grammar limitations have an honest, useful error',()=>{
  assert.throws(()=>analyze('with context() as (first, second):\n    pass\n','context.py'),/parser.*grammar/);
});


test('story availability depends on understood structure and file complexity',()=>{
  for(const sample of samples.filter(s=>languageSupport(s.filename).structured))assert.equal(storyReadiness(analyze(sample.code,sample.filename)).available,true,sample.filename);
  assert.equal(storyReadiness(analyze('puts "hello"','test.rb')).available,false);
  assert.equal(storyReadiness(analyze('def double(n):\n    return n * 2\n','simple.py')).available,true);
  assert.equal(storyReadiness(analyze(Array.from({length:25},(_,i)=>`value${i} = ${i}`).join('\n'),'many.py')).available,false);
});


test('a simple Python choice becomes two concrete paths in the story',()=>{
  const model=analyze('def check(value):\n    if value > 30:\n        return "hot"\n    else:\n        return "mild"\n','choice.py'),story=storyFunction(model.symbols[0],model);
  assert.match(story,/If value is greater than 30/);assert.match(story,/writes “hot”/);assert.match(story,/Otherwise.*writes “mild”/);assert.doesNotMatch(story,/value > 30/);
});
