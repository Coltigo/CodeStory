import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {analyze} from '../src/parser.js';
import {INSTRUCTIONS,STORY_SCHEMA,STORY_VERSION,StoryAI,sourceContext,validateStory} from '../src/server/ai.js';

const code='function double(value) { return value * 2; }\nfunction report(value) { return double(value); }\nconsole.log(report(4));';
const parsed=analyze(code,'delivery.js');
function completeStory(model=parsed){
  return {overview:'Double a value and print it.',conceptOrder:model.concepts,flowOrder:model.flow,chapters:model.chunks.map(c=>({id:c.id,title:'Read this section',beginner:'This section defines or invokes the shown code.',developer:'The source section determines its behavior.',concept:'Code section',term:'A section groups related source statements.',storyBeginner:'This workshop station takes the job shown by the source.',storyDeveloper:'The workshop station represents this exact source section, with no observed execution.'})),functions:model.symbols.map(s=>({id:s.id,purpose:'Perform the shown operation.',sideEffects:'None observed.',caveats:'Only static source is available.',storyBeginner:`The ${s.name} worker performs its named job.`,storyDeveloper:`The ${s.name} workshop worker represents the source definition.`})),limitations:['This is a static reading, not observed execution.'],narrative:{available:true,reason:'',metaphor:'workshop',premise:'This workshop is a metaphor for a static reading, not observed execution.',overview:'The report worker can ask the double worker to prepare a result.',relationships:sourceContext(model).knownRelationships}};
}
const event=data=>'data: '+JSON.stringify(data)+'\n\n';
const stream=story=>new Response(event({type:'response.output_text.delta',delta:JSON.stringify(story)})+event({type:'response.completed',response:{id:'story-test',usage:{input_tokens:80,output_tokens:120}}}));

test('Story Mode is required alongside literal explanations at both experience levels',()=>{
  assert.ok(STORY_SCHEMA.required.includes('narrative'));
  assert.deepEqual(STORY_SCHEMA.properties.narrative.properties.metaphor.enum,['workshop']);
  for(const section of ['chapters','functions'])for(const field of ['storyBeginner','storyDeveloper'])assert.ok(STORY_SCHEMA.properties[section].items.required.includes(field));
  const story=completeStory();assert.equal(validateStory(story,parsed),story);
  const missing=structuredClone(story);delete missing.chapters[0].storyBeginner;
  assert.throws(()=>validateStory(missing,parsed),e=>e.code==='invalid_story');
  const empty=structuredClone(story);empty.functions[0].storyDeveloper='  ';
  assert.throws(()=>validateStory(empty,parsed),e=>e.code==='invalid_story');
  assert.throws(()=>validateStory({...story,narrative:{...story.narrative,metaphor:'spaceship'}},parsed),e=>e.code==='invalid_story');
});

test('narrative relationships accept only unique direct edges in the supplied source graph',()=>{
  const context=sourceContext(parsed),story=completeStory();
  assert.ok(context.knownRelationships.some(r=>r.fromId===parsed.symbols[1].id&&r.toId===parsed.symbols[0].id));
  assert.ok(context.knownRelationships.some(r=>r.fromId===parsed.chunks.at(-1).id&&r.toId===parsed.symbols[1].id));
  for(const relationships of [
    [{fromId:'invented',toId:parsed.symbols[0].id}],
    [{fromId:parsed.symbols[0].id,toId:parsed.symbols[1].id}],
    [context.knownRelationships[0],context.knownRelationships[0]],
    [{fromId:parsed.chunks[0].id,toId:parsed.symbols[0].id}]
  ])assert.throws(()=>validateStory({...story,narrative:{...story.narrative,relationships}},parsed),e=>e.code==='invalid_story_relationships');
  assert.equal(validateStory({...story,narrative:{...story.narrative,relationships:[]}},parsed).narrative.relationships.length,0);
});

test('unresolved or ambiguous calls cannot create narrative collaboration edges',()=>{
  const model={...parsed,symbols:parsed.symbols.map(s=>({...s,dependencies:[]})),chunks:parsed.chunks.map(c=>({...c,calls:[...c.calls]}))};
  const last=model.chunks.at(-1);last.calls=[{name:'double',direct:true,resolved:false},{name:'double',direct:true,resolved:true},{name:'unknown',direct:true}];
  assert.deepEqual(sourceContext(model).knownRelationships,[]);
  const duplicate={...model.symbols[0],id:'s_duplicate'};model.symbols.push(duplicate);last.calls=[{name:'double',direct:true}];
  assert.deepEqual(sourceContext(model).knownRelationships,[]);
  last.calls=[{name:'double',direct:false,resolved:true,targetId:duplicate.id}];
  assert.deepEqual(sourceContext(model).knownRelationships,[{fromId:last.id,toId:duplicate.id}]);
});

test('source context carries language guarantees and declarative metadata without inferring function calls',()=>{
  const model={code:'SELECT name FROM people;',filename:'people.sql',language:'SQL',support:{structured:true,level:'syntax',label:'Syntax inspection'},warnings:['The SQL dialect is unknown.'],analysisNotes:['Query clauses describe data relationships.'],chunks:[{id:'c0',startLine:1,endLine:1,kind:'query',names:['people'],symbolIds:[],calls:[],operation:'SELECT',tables:['people'],clauses:['SELECT','FROM']}],symbols:[]};
  const context=sourceContext(model);
  assert.deepEqual(context.support,model.support);assert.deepEqual(context.warnings,model.warnings);assert.deepEqual(context.analysisNotes,model.analysisNotes);
  assert.equal(context.chunks[0].operation,'SELECT');assert.deepEqual(context.chunks[0].tables,['people']);assert.deepEqual(context.knownRelationships,[]);
  model.support={structured:false,level:'text',label:'Text inspection'};assert.equal(sourceContext(model).support.structured,false);
});

test('Python definition-time default calls belong to the chapter rather than the uncalled function body',()=>{
  const model=analyze('def supply():\n    return 4\n\ndef run(value=supply()):\n    return value\n','defaults.py');
  const supplier=model.symbols.find(s=>s.name==='supply'),run=model.symbols.find(s=>s.name==='run');
  const relationships=sourceContext(model).knownRelationships;
  assert.ok(relationships.some(r=>r.fromId===run.chunkId&&r.toId===supplier.id));
  assert.ok(!relationships.some(r=>r.fromId===run.id&&r.toId===supplier.id));
  assert.equal(sourceContext(model).functions.find(s=>s.id===run.id).knownCalls.length,0);
});

test('Python decorator application is a definition-time chapter relationship',()=>{
  const model=analyze('def decorate(function):\n    return function\n\n@decorate\ndef task():\n    return 3\n','decorated.py');
  const decorator=model.symbols.find(s=>s.name==='decorate'),task=model.symbols.find(s=>s.name==='task');
  const context=sourceContext(model);
  assert.ok(context.knownRelationships.some(r=>r.fromId===task.chunkId&&r.toId===decorator.id));
  assert.ok(!context.knownRelationships.some(r=>r.fromId===task.id&&r.toId===decorator.id));
  assert.deepEqual(context.functions.find(s=>s.id===task.id).decorators.map(value=>value.trim()),['@decorate']);
});

test('JavaScript block, catch, and class shadowing cannot invent narrative handoffs to a top-level namesake',()=>{
  for(const source of [
    'function helper() { return 1; }\n{ const helper = () => 2; console.log(helper()); }',
    'function helper() { return 1; }\nfunction run() { try {} catch (helper) { helper(); } }',
    'function helper() { return 1; }\nfunction run() { class helper {} return helper(); }'
  ])assert.deepEqual(sourceContext(analyze(source,'shadowing.js')).knownRelationships,[]);
});

test('the narrative prompt maintains one metaphor, keeps literal facts separate, and preserves conditional semantics',()=>{
  for(const requirement of ['ONE consistent metaphor','workshop team','must remain LITERAL','not observed execution','actual source condition','Do not switch metaphors','knownRelationships','HTML describes document structure','SQL describes statements','each file’s language and inspection metadata','Text-inspected files use provisional sections','untrusted DATA'])assert.ok(INSTRUCTIONS.includes(requirement),requirement);
});

test('one consented inference caches all four presentations and ignores legacy literal-only cache entries',async()=>{
  const auth={store:{data:{activeId:'account1'}},access:async()=> 'fake-plan-oauth'};
  let inferenceCalls=0,requestBody;
  const ai=new StoryAI(auth,{fetcher:async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer fake-plan-oauth');
    if(url.endsWith('/models'))return Response.json({models:[{slug:'test-model',display_name:'Test Model',visibility:'list'}]});
    inferenceCalls++;requestBody=JSON.parse(options.body);return stream(completeStory());
  }});
  const legacyKey=createHash('sha256').update(JSON.stringify(['account1',code,'delivery.js','test-model','story-v1'])).digest('hex');
  ai.cache.set(legacyKey,{story:{overview:'Legacy explanation'},model:'test-model'});
  const request={code,filename:'delivery.js',model:'test-model',consent:true};
  const result=await ai.explain(request),cached=await ai.explain(request);
  assert.equal(inferenceCalls,1);assert.equal(result.cached,false);assert.equal(cached.cached,true);assert.equal(cached.story.narrative.metaphor,'workshop');
  for(const field of ['beginner','developer','storyBeginner','storyDeveloper'])assert.equal(typeof cached.story.chapters[0][field],'string');
  assert.equal(requestBody.text.format.schema.properties.narrative.properties.metaphor.enum[0],'workshop');
  assert.deepEqual(JSON.parse(requestBody.input[0].content).knownRelationships,sourceContext(parsed).knownRelationships);
  const currentKey=createHash('sha256').update(JSON.stringify(['account1',code,'delivery.js','test-model',STORY_VERSION])).digest('hex');assert.ok(ai.cache.has(currentKey));
  assert.equal(requestBody.store,false);assert.equal(requestBody.stream,true);assert.equal(requestBody.tools,undefined);
});


test('declining a simple story preserves complete literal analysis, but requires an explanation',()=>{
  const story=completeStory();story.narrative={available:false,reason:'The essential steps are hidden in an external library.',metaphor:'workshop',premise:'',overview:'',relationships:[]};for(const entry of [...story.chapters,...story.functions]){entry.storyBeginner='';entry.storyDeveloper='';}
  assert.equal(validateStory(story,parsed),story);assert.ok(story.chapters.every(c=>c.beginner&&c.developer));
  assert.throws(()=>validateStory({...story,narrative:{...story.narrative,reason:''}},parsed),e=>e.code==='invalid_story');
  const missing=structuredClone(story);missing.chapters[0].beginner='';assert.throws(()=>validateStory(missing,parsed),e=>e.code==='invalid_story');
});

test('local parsing limits override an AI claim that a story is available',()=>{
  const model=analyze('SELECT * FROM people;','records.sql');model.chunks[0].partial=true;
  const story=completeStory(model);validateStory(story,model);assert.equal(story.narrative.available,false);assert.match(story.narrative.reason,/fully understood/);assert.equal(story.chapters[0].storyBeginner,'');assert.ok(story.chapters[0].beginner);
});

test('AI may tell a source-grounded story for a text-inspected language without inventing local call edges',()=>{
 const model=analyze('package main\nfunc main() { println("hello") }','main.go');assert.equal(sourceContext(model).storyReadiness.available,true);const story=completeStory(model);validateStory(story,model);assert.equal(story.narrative.available,true);assert.deepEqual(story.narrative.relationships,[]);assert.equal(model.symbols.length,0);
});
