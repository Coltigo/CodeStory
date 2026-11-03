import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/parser.js';
import {samples} from '../src/samples.js';
import {storyWorkflow} from '../src/story-facts.js';
import {storyFunction,describeStoryChunk} from '../src/narrative.js';

test('the weather story connects coworkers, argument labels, intermediate replies and message formatting',()=>{
  const model=analyze(samples[1].code,samples[1].filename),coordinator=model.symbols.find(s=>s.name==='describe_weather');
  const workflow=storyWorkflow(coordinator,model);
  assert.deepEqual(workflow.map(s=>[s.target.name,s.args,s.binding,s.returns]),[['average_temperature',['readings'],'average',false],['format_report',['city','average'],null,true]]);
  const story=storyFunction(coordinator,model);assert.match(story,/coworker of describe_weather/);assert.ok(story.indexOf('average_temperature')<story.indexOf('format_report'));assert.match(story,/package labeled average/);assert.ok(story.split(/(?<=[.!?])\s+/).length>=10);assert.ok(story.includes('\n\n'));
  const request=model.chunks.find(c=>c.names.includes('report'));const scene=describeStoryChunk(request,model,'beginner',{}).body;
  assert.match(scene,/his friend describe_weather/);assert.match(scene,/“temperatures” package gets the local label readings/);assert.match(scene,/labels it report/);
  const formatting=storyFunction(model.symbols.find(s=>s.name==='format_report'),model);assert.match(formatting,/spaces are named city and average/);assert.match(formatting,/one digit after the decimal point/);assert.doesNotMatch(formatting,/message on the noticeboard/);
});

test('a sequential story never invents handoffs through a branch, nested call, shadowed name or deferred helper',()=>{
  for(const code of [
    'def helper(value):\n    return value\ndef run(value):\n    if value:\n        return helper(value)\n    return 0\n',
    'def helper(value):\n    return value\ndef run(value):\n    return helper(helper(value))\n',
    'def helper(value):\n    return value\ndef run(helper, value):\n    return helper(value)\n',
    'async def helper(value):\n    return value\ndef run(value):\n    return helper(value)\n',
    'def helper(value):\n    yield value\ndef run(value):\n    return helper(value)\n',
    'def helper(value):\n    return value\ndef run(value):\n    return helper(value=value)\n'
  ]){
    const model=analyze(code,'limits.py');assert.deepEqual(storyWorkflow(model.symbols.find(s=>s.name==='run'),model),[],code);
  }
});

test('source strings remain data in local story facts',()=>{
  const model=analyze('city = "<script>alert(1)</script>"\n','unsafe.py'),scene=describeStoryChunk(model.chunks[0],model,'beginner',{});
  assert.match(scene.body,/<script>alert\(1\)<\/script>/);assert.ok(scene.literal);assert.equal(model.code,'city = "<script>alert(1)</script>"\n');
});

test('story comparison rewrites preserve quoted operators, escaped quotes and long string data',()=>{
 for(const literal of ['"a>b"',"'a<=b'",'"a\\\" > b"','"'+('x>'.repeat(100))+'"']){const model=analyze('def choose(label):\n    if label == '+literal+':\n        return "yes"\n    else:\n        return "no"\n','compare.py');const story=storyFunction(model.symbols[0],model);assert.ok(!story.includes('a is greater than b'));assert.ok(!story.includes('a is at most b'));assert.match(story,/label equals/);if(literal.length<100)assert.ok(story.includes(literal),story);}
});

test('local averaging stories require unshadowed builtin call evidence',()=>{
 const builtin=analyze('def average(values):\n    return sum(values) / len(values)\n','mean.py');assert.match(storyFunction(builtin.symbols[0],builtin),/adds up/);
 for(const prefix of ['def sum(values):\n    return 999\n','from helpers import sum\n']){const model=analyze(prefix+'def average(values):\n    return sum(values) / len(values)\n','mean.py');const story=storyFunction(model.symbols.find(s=>s.name==='average'),model);assert.doesNotMatch(story,/adds up the numbers/);assert.match(story,/sum\(values\)/);}
 const repeated=analyze('def repeat(text):\n    return text * 2\n','repeat.py');assert.doesNotMatch(storyFunction(repeated.symbols[0],repeated),/multiplies text/);
});
