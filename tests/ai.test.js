import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/parser.js';
import {StoryAI,readResponseStream,validateStory,upstreamError} from '../src/server/ai.js';
const code='function greet(name){ return "Hi " + name; }\nconsole.log(greet("Alex"));';
const parsed=analyze(code,'hello.js');
const story={overview:'Greet a person and print the result.',conceptOrder:parsed.concepts,flowOrder:parsed.flow,chapters:parsed.chunks.map(c=>({id:c.id,title:'Explain the section',beginner:'A literal explanation.',developer:'Technical explanation.',concept:'Function call',term:'A call runs a function.',storyBeginner:'In the workshop, this section gives the greeting worker a job.',storyDeveloper:'The workshop job corresponds to the section shown.'})),functions:parsed.symbols.map(s=>({id:s.id,purpose:'Build a greeting.',sideEffects:'None observed.',caveats:'Assumes a string input.',storyBeginner:'The greet worker packages a greeting.',storyDeveloper:'The greet worker returns the built string to its caller.'})),limitations:[],narrative:{available:true,reason:'',metaphor:'workshop',premise:'A workshop metaphor for a static reading, not observed execution.',overview:'The greet worker builds a greeting for the print operation.',relationships:[]}};
const event=data=>'data: '+JSON.stringify(data)+'\n\n';
const stream=events=>new Response(events.map(event).join(''),{headers:{'Content-Type':'text/event-stream'}});
test('only treats a stream with response.completed as successful',async()=>{const response=stream([{type:'response.output_text.delta',delta:'hello'},{type:'response.completed',response:{id:'test-response',usage:{input_tokens:10,output_tokens:2}}}]);assert.equal((await readResponseStream(response)).text,'hello');await assert.rejects(()=>readResponseStream(stream([{type:'response.output_text.delta',delta:'partial'}])),e=>e.code==='interrupted_stream');});
test('detects post-start usage limits, incomplete results, and refusal',async()=>{await assert.rejects(()=>readResponseStream(stream([{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])),e=>e.code==='subscription_sharing_usage_limit_exceeded');await assert.rejects(()=>readResponseStream(stream([{type:'response.incomplete'}])),e=>e.code==='incomplete_response');await assert.rejects(()=>readResponseStream(stream([{type:'response.refusal.delta',delta:'No'}])),e=>e.code==='model_refusal');});
test('reports a broken SSE transport as an interrupted response',async()=>{
  const broken=new Response(new ReadableStream({start(controller){controller.error(new TypeError('terminated'));}}));
  await assert.rejects(()=>readResponseStream(broken),e=>e.code==='interrupted_stream'&&e.status===502);
});
test('refuses invented, omitted, or duplicated source references',()=>{assert.equal(validateStory(story,parsed),story);assert.throws(()=>validateStory({...story,flowOrder:['invented']},parsed));assert.throws(()=>validateStory({...story,chapters:[]},parsed));assert.throws(()=>validateStory({...story,conceptOrder:[parsed.concepts[0],parsed.concepts[0]]},parsed));});
test('uses only plan OAuth, gets account-specific models, requires consent, and caches both detail levels and presentation modes',async()=>{
  let inferenceCalls=0,body;
  const auth={store:{data:{activeId:'account1'}},access:async()=> 'oauth-test-token'};
  const ai=new StoryAI(auth,{fetcher:async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer oauth-test-token');
    if(url.endsWith('/models'))return Response.json({models:[{slug:'test-model',display_name:'Test Model',visibility:'list'},{slug:'hidden',display_name:'Hidden',visibility:'hidden'}]});
    inferenceCalls++;body=JSON.parse(options.body);
    return stream([{type:'response.output_text.delta',delta:JSON.stringify(story)},{type:'response.completed',response:{id:'test-completed',usage:{input_tokens:20,output_tokens:100}}}]);
  }});
  await assert.rejects(()=>ai.explain({code,filename:'hello.js',model:'test-model',consent:false}),e=>e.code==='consent_required');
  const result=await ai.explain({code,filename:'hello.js',model:'test-model',consent:true});assert.equal(result.cached,false);assert.equal(result.story.chapters[0].beginner,'A literal explanation.');assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.max_output_tokens,undefined);assert.equal(body.tools,undefined);assert.equal(body.text.format.type,'json_schema');assert.equal(body.input[0].role,'user');
  const cached=await ai.explain({code,filename:'hello.js',model:'test-model',consent:true});assert.equal(cached.cached,true);assert.equal(inferenceCalls,1);
});
test('canceling during model discovery prevents inference and keeps account changes blocked until cleanup',async()=>{
  let releaseModels,modelsStarted;
  const started=new Promise(resolve=>{modelsStarted=resolve;});
  const pendingModels=new Promise(resolve=>{releaseModels=resolve;});let inferenceCalls=0;
  const auth={store:{data:{activeId:'account1'}},access:async()=> 'fake-oauth'};
  const ai=new StoryAI(auth,{fetcher:async url=>{if(url.endsWith('/models')){modelsStarted();return pendingModels;}inferenceCalls++;throw new Error('Inference must not start');}});
  const controller=new AbortController();
  const pending=ai.explain({code,filename:'hello.js',model:'test-model',consent:true},controller.signal);
  await started;assert.equal(ai.busy,true);
  await assert.rejects(()=>ai.explain({code,filename:'hello.js',model:'test-model',consent:true}),e=>e.code==='analysis_busy');
  const rejected=assert.rejects(()=>pending,e=>e.name==='AbortError');controller.abort();
  releaseModels(Response.json({models:[{slug:'test-model',display_name:'Test Model',visibility:'list'}]}));await rejected;
  assert.equal(inferenceCalls,0);assert.equal(ai.busy,false);assert.equal(ai.cache.size,0);
});
test('canceling a running response never caches a partial story',async()=>{
  let inferenceStarted;const started=new Promise(resolve=>{inferenceStarted=resolve;});
  const auth={store:{data:{activeId:'account1'}},access:async()=> 'fake-oauth'};
  const ai=new StoryAI(auth,{fetcher:async(url,options)=>{
    if(url.endsWith('/models'))return Response.json({models:[{slug:'test-model',display_name:'Test Model',visibility:'list'}]});
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(event({type:'response.output_text.delta',delta:'{"overview":'})));options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});inferenceStarted();}}));
  }});
  const controller=new AbortController();const pending=ai.explain({code,filename:'hello.js',model:'test-model',consent:true},controller.signal);
  await started;const rejected=assert.rejects(()=>pending,e=>e.name==='AbortError');controller.abort();await rejected;
  assert.equal(ai.busy,false);assert.equal(ai.cache.size,0);
});
test('model catalogs, bearer credentials, and cached stories remain separate for each account',async()=>{
  const auth={store:{data:{activeId:'account1'}},access:async id=>'fake-'+id};let inferenceCalls=0;const modelRequests=[];
  const ai=new StoryAI(auth,{fetcher:async(url,options)=>{
    if(url.endsWith('/models')){modelRequests.push(options.headers.Authorization);return Response.json({models:[{slug:'test-model',display_name:'Test Model',visibility:'list'}]});}
    inferenceCalls++;assert.equal(options.headers.Authorization,'Bearer fake-'+auth.store.data.activeId);
    return stream([{type:'response.output_text.delta',delta:JSON.stringify(story)},{type:'response.completed',response:{id:'fake-complete'}}]);
  }});
  const request={code,filename:'hello.js',model:'test-model',consent:true};
  assert.equal((await ai.explain(request)).cached,false);auth.store.data.activeId='account2';assert.equal((await ai.explain(request)).cached,false);
  auth.store.data.activeId='account1';assert.equal((await ai.explain(request)).cached,true);
  assert.equal(inferenceCalls,2);assert.deepEqual(modelRequests,['Bearer fake-account1','Bearer fake-account2']);
});
test('keeps direct-admission diagnostic details and structured request parameters',()=>{
  const admission=upstreamError(503,{detail:'Direct routing is temporarily unavailable.'},'fake-request-id');assert.equal(admission.status,503);assert.equal(admission.requestId,'fake-request-id');assert.equal(admission.detail,'Direct routing is temporarily unavailable.');
  const unsupported=upstreamError(400,{error:{code:'subscription_sharing_unsupported_capability',param:'model',message:'Unsupported model.'}},'fake-request-id');assert.equal(unsupported.code,'subscription_sharing_unsupported_capability');assert.equal(unsupported.param,'model');assert.match(unsupported.message,/another available model/);
});
