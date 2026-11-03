import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/parser.js';
import {INSTRUCTIONS,STORY_SCHEMA} from '../src/server/ai.js';
import {API_PROVIDERS,ApiKeyConnections,ApiKeyAI} from '../src/server/providers.js';

const code='def double(value):\n    return value * 2\n\nprint(double(3))\n',filename='double.py';
const parsed=analyze(code,filename);
// All credentials and provider responses in this file are invented fixtures.
const providers=[
  {id:'openai',model:'gpt-fixture',key:'unit-test-openai-key-never-real',origin:'https://api.openai.com',path:'/v1/responses'},
  {id:'anthropic',model:'claude-fixture',key:'unit-test-anthropic-key-never-real',origin:'https://api.anthropic.com',path:'/v1/messages'},
  {id:'gemini',model:'gemini-fixture',key:'unit-test-gemini-key-never-real',origin:'https://generativelanguage.googleapis.com',path:'/v1beta/models/gemini-fixture:generateContent'}
];
function story(){return {overview:'Define double and print double(3), whose predicted value is 6.',conceptOrder:parsed.concepts,flowOrder:parsed.flow,
  chapters:parsed.chunks.map(c=>({id:c.id,title:'Read the doubling operation',beginner:'double returns its input multiplied by 2; the call supplies 3.',developer:'double returns value * 2; the top-level print receives the returned value.',concept:'Numeric transformation',term:'',storyBeginner:'The double worker doubles a package: its code returns value * 2.',storyDeveloper:'The double workbench represents the exact multiplication body.'})),
  functions:parsed.symbols.map(s=>({id:s.id,purpose:'Return value multiplied by 2.',sideEffects:'None visible in this body.',caveats:'',storyBeginner:'The double worker returns a package containing value * 2.',storyDeveloper:'The worker returns the product to its caller.'})),limitations:[],narrative:{available:true,reason:'',metaphor:'workshop',premise:'A workshop metaphor for static source, not observed execution.',overview:'The print operation can receive the product from double.',relationships:[]}};}
function catalog(provider,{models,more}={}){
  if(provider.id==='gemini')return Response.json({models:models||[{name:'models/'+provider.model,displayName:'Fixture model',supportedGenerationMethods:['generateContent']}],...more});
  return Response.json({data:models||[{id:provider.model,display_name:'Fixture model',max_output_tokens:4096}],...more});
}
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
function inference(provider,value=story()){
  const text=JSON.stringify(value);
  if(provider.id==='openai')return new Response(event({type:'response.output_text.delta',delta:text})+event({type:'response.completed',response:{id:'req_fixture',usage:{input_tokens:10,output_tokens:20,total_tokens:30}}}));
  if(provider.id==='anthropic')return Response.json({content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:20}});
  return Response.json({candidates:[{content:{parts:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:20,totalTokenCount:30}});
}
const connect=(connections,provider,label='Test connection')=>connections.connect({provider:provider.id,key:provider.key,label,billingConsent:true});
const explain=(ai,provider,extra={})=>ai.explain({code,filename,model:provider.model,consent:true,...extra});
async function setup(provider,handler){
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url:String(url),options});if(options.method==='GET')return catalog(provider);return handler?handler(url,options):inference(provider);};
  const connections=new ApiKeyConnections({fetcher});await connect(connections,provider);
  return {connections,ai:new ApiKeyAI(connections,{fetcher}),calls};
}

test('API provider metadata distinguishes API credits and quotas from consumer chat plans',()=>{
  assert.deepEqual(API_PROVIDERS.map(p=>p.id),['openai','anthropic','gemini']);
  for(const provider of API_PROVIDERS){assert.ok(provider.label);assert.ok(provider.billing);assert.equal(new URL(provider.billingUrl).protocol,'https:');assert.equal(new URL(provider.modelsUrl).protocol,'https:');}
  assert.match(API_PROVIDERS[0].billing,/ChatGPT subscription allowance does not apply/);
  assert.match(API_PROVIDERS[1].billing,/Claude chat plan alone/);
  assert.match(API_PROVIDERS[2].billing,/project quota/);
});

test('connecting requires billing consent, an allowlisted provider, and a clean key before any request',async()=>{
  let calls=0;const connections=new ApiKeyConnections({fetcher:async()=>{calls++;throw new Error('Unexpected request');}}),valid={provider:'openai',key:'fixture-only-key',label:'Private connection',billingConsent:true};
  for(const [change,expected] of [
    [{billingConsent:false},'api_billing_consent_required'],[{provider:'http://other.example'},'invalid_provider'],[{provider:'__proto__'},'invalid_provider'],
    [{key:''},'invalid_api_key'],[{key:'   '},'invalid_api_key'],[{key:'fixture\nkey'},'invalid_api_key'],[{key:'fixture\tkey'},'invalid_api_key'],[{key:'x'.repeat(4097)},'invalid_api_key'],
    [{label:'fixture-only-key'},'invalid_connection_label'],[{label:'x'.repeat(61)},'invalid_connection_label']
  ])await assert.rejects(()=>connections.connect({...valid,...change}),error=>error.code===expected);
  assert.equal(calls,0);assert.deepEqual(connections.publicProfiles(),[]);assert.equal(connections.active(),null);
});

test('an optional blank or whitespace connection name receives the provider default',async()=>{
  const provider=providers[0],connections=new ApiKeyConnections({fetcher:async()=>catalog(provider)});
  for(const label of ['', '   ',undefined]){
    const profile=await connections.connect({provider:provider.id,key:provider.key,label,billingConsent:true});
    assert.equal(profile.label,'OpenAI API connection');
  }
});

for(const provider of providers)test(`${provider.id}: a model-list check connects without inference, and one completed analysis verifies all presentation modes`,async()=>{
  const {connections,ai,calls}=await setup(provider);
  assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/models')||calls[0].url.includes('/models?'));
  const profile=connections.active();assert.equal(profile.kind,'api_key');assert.equal(profile.billing,'api');assert.equal(profile.ready,true);assert.equal(profile.analysisVerified,false);
  assert.deepEqual(await connections.models(),[{id:provider.model,name:provider.id==='openai'?provider.model:'Fixture model'}]);assert.equal(calls.length,1);
  const result=await explain(ai,provider);assert.equal(result.cached,false);assert.equal(result.provider,provider.id);assert.equal(result.usage.input_tokens,10);assert.equal(connections.active().analysisVerified,true);
  const inferenceCall=calls[1],url=new URL(inferenceCall.url),body=JSON.parse(inferenceCall.options.body);
  assert.equal(url.origin,provider.origin);assert.equal(url.pathname,provider.path);assert.equal(inferenceCall.options.redirect,'error');
  assert.equal(inferenceCall.url.includes(provider.key),false);assert.equal(inferenceCall.options.body.includes(provider.key),false);
  if(provider.id==='openai'){
    assert.equal(inferenceCall.options.headers.Authorization,'Bearer '+provider.key);assert.equal(body.store,false);assert.equal(body.stream,true);
    assert.equal(body.instructions,INSTRUCTIONS);assert.deepEqual(body.text.format.schema,STORY_SCHEMA);assert.equal(body.max_output_tokens,undefined);
    assert.equal(JSON.parse(body.input[0].content).source,code);
  }else if(provider.id==='anthropic'){
    assert.equal(inferenceCall.options.headers['x-api-key'],provider.key);assert.equal(inferenceCall.options.headers['anthropic-version'],'2023-06-01');
    assert.equal(body.system,INSTRUCTIONS);assert.equal(body.max_tokens,4096);assert.deepEqual(body.output_config.format.schema,STORY_SCHEMA);assert.equal(JSON.parse(body.messages[0].content).source,code);
  }else{
    assert.equal(inferenceCall.options.headers['x-goog-api-key'],provider.key);assert.equal(url.searchParams.has('key'),false);
    assert.equal(body.systemInstruction.parts[0].text,INSTRUCTIONS);assert.equal(body.generationConfig.responseMimeType,'application/json');assert.deepEqual(body.generationConfig.responseJsonSchema,STORY_SCHEMA);assert.equal(body.generationConfig.responseFormat,undefined);
    assert.equal(JSON.parse(body.contents[0].parts[0].text).source,code);
  }
  assert.equal((await explain(ai,provider)).cached,true);assert.equal(calls.length,2);
  const exposed=JSON.stringify([connections,connections.active(),connections.publicProfiles(),result]);assert.equal(exposed.includes(provider.key),false);
});

test('inference rejects absent consent, unknown models, large sources, and excessive sections without a provider call',async()=>{
  const provider=providers[0],{connections,ai,calls}=await setup(provider);
  await assert.rejects(()=>explain(ai,provider,{consent:false}),error=>error.code==='consent_required');
  await assert.rejects(()=>explain(ai,provider,{model:'../../untrusted'}),error=>error.code==='invalid_model');
  await assert.rejects(()=>explain(ai,provider,{code:'x'.repeat(80001)}),error=>error.code==='parse_error');
  await assert.rejects(()=>explain(ai,provider,{code:Array.from({length:101},(_,i)=>`value_${i} = ${i}`).join('\n')}),error=>error.code==='too_many_sections');
  await assert.rejects(()=>explain(ai,provider,{code:Array.from({length:81},(_,i)=>`def function_${i}():\n    return ${i}\n`).join('\n')}),error=>error.code==='too_many_sections');
  assert.equal(calls.length,1);assert.equal(connections.active().analysisVerified,false);assert.equal(ai.busy,false);
});

test('connection profiles, bearer keys, and explanation caches are isolated by connection and by manager',async()=>{
  const provider=providers[0],requests=[];let count=0;
  const fetcher=async(url,options)=>{if(options.method==='GET')return catalog(provider);requests.push(options.headers.Authorization);count++;return inference(provider);};
  const connections=new ApiKeyConnections({fetcher}),ai=new ApiKeyAI(connections,{fetcher});
  const first=await connect(connections,provider,'First');await explain(ai,provider);
  const second=await connect(connections,{...provider,key:'second-fixture-key'},'Second');await explain(ai,provider);
  connections.select(first.id);assert.equal((await explain(ai,provider)).cached,true);assert.equal(count,2);assert.deepEqual(requests,['Bearer '+provider.key,'Bearer second-fixture-key']);
  assert.equal(connections.publicProfiles().length,2);connections.remove(first.id);assert.equal(connections.active(),null);
  connections.select(second.id);connections.usePlan();assert.equal(connections.active(),null);assert.equal(connections.publicProfiles().length,1);
  const other=new ApiKeyConnections({fetcher}),otherAI=new ApiKeyAI(other,{fetcher});assert.deepEqual(other.publicProfiles(),[]);
  await assert.rejects(()=>explain(otherAI,provider),error=>error.code==='api_connection_required');
  assert.throws(()=>other.select(second.id),error=>error.code==='api_connection_not_found');
});

test('provider errors never echo raw upstream details or credentials and never trigger fallback',async()=>{
  for(const provider of providers)for(const [status,code] of [[401,'api_auth_failed'],[403,'api_forbidden'],[429,'api_rate_limit'],[500,'api_unavailable'],[400,'api_request_rejected']]){
    let attempts=0;const fetcher=async()=>{attempts++;return Response.json({error:{message:provider.key,code:provider.key}},{status,headers:{'x-request-id':'req_'+provider.key}});};
    const connections=new ApiKeyConnections({fetcher});
    await assert.rejects(()=>connect(connections,provider),error=>{assert.equal(error.code,code);assert.equal(JSON.stringify(error).includes(provider.key),false);assert.equal(error.message.includes(provider.key),false);assert.equal(error.requestId,null);assert.equal(error.detail,undefined);return true;});
    assert.equal(attempts,1);assert.deepEqual(connections.publicProfiles(),[]);
  }
  const provider=providers[0],{ai,calls}=await setup(provider,()=>Response.json({error:{message:'fixture secret'}},{status:429,headers:{'x-request-id':'req_sanitized-123'}}));
  await assert.rejects(()=>explain(ai,provider),error=>error.code==='api_rate_limit'&&error.requestId==='req_sanitized-123');
  assert.equal(calls.length,2);assert.equal(ai.cache.size,0);
});

test('network errors are safe fixed messages rather than thrown fetcher details',async()=>{
  const provider=providers[0],connections=new ApiKeyConnections({fetcher:async()=>{throw new Error('Request contains '+provider.key);}});
  await assert.rejects(()=>connect(connections,provider),error=>error.code==='api_network'&&!error.message.includes(provider.key));
});

test('catalogs filter obvious nontext and unsafe model IDs and follow provider-specific pagination',async()=>{
  for(const provider of providers){
    const urls=[];
    const fetcher=async(url)=>{
      urls.push(new URL(url));
      if(provider.id==='gemini')return catalog(provider,{models:urls.length===1?[
        {name:'models/text-embedding-fixture',supportedGenerationMethods:['embedContent']},
        {name:'models/gemini-image-fixture',supportedGenerationMethods:['generateContent']},
        {name:'models/'+provider.model,supportedGenerationMethods:['generateContent']}
      ]:[{name:'models/second-fixture',supportedGenerationMethods:['generateContent']}],more:urls.length===1?{nextPageToken:'page-two'}:{}});
      return catalog(provider,{models:urls.length===1?[{id:provider.model},{id:'text-embedding-fixture'},{id:'https://elsewhere.example'},{id:provider.key},{id:'audio-fixture'}]:[{id:'second-fixture'}],more:urls.length===1?{has_more:true,last_id:'page-two'}:{has_more:false}});
    };
    const connections=new ApiKeyConnections({fetcher});await connect(connections,provider);
    assert.deepEqual((await connections.models()).map(m=>m.id),[provider.model,'second-fixture']);assert.equal(urls.length,2);
    assert.equal(urls[1].searchParams.get(provider.id==='gemini'?'pageToken':provider.id==='anthropic'?'after_id':'after'),'page-two');
    assert.ok(urls.every(url=>url.origin===provider.origin&&!url.toString().includes(provider.key)));
  }
});

test('catalog page loops, page overflow, malformed responses, and oversized bodies cannot create a connection',async()=>{
  const provider=providers[0];
  for(const mode of ['loop','overflow','null','huge']){
    let calls=0;const connections=new ApiKeyConnections({fetcher:async()=>{calls++;
      if(mode==='null')return Response.json(null);
      if(mode==='huge')return new Response('x'.repeat(600001));
      return catalog(provider,{more:{has_more:true,last_id:mode==='loop'?'same-page':'page-'+calls}});
    }});
    await assert.rejects(()=>connect(connections,provider),error=>['invalid_models','catalog_too_large','response_too_large'].includes(error.code));
    assert.ok(calls<=5);assert.equal(connections.active(),null);
  }
});

test('refusals, truncation, missing completion, and schema mismatches never become verified or cached',async()=>{
  const incomplete=[
    [providers[0],()=>new Response(event({type:'response.output_text.delta',delta:JSON.stringify(story())})),'interrupted_stream'],
    [providers[0],()=>new Response(event({type:'response.incomplete'})),'incomplete_response'],
    [providers[0],()=>new Response(event({type:'response.refusal.delta',delta:'fixture refusal'})),'model_refusal'],
    [providers[1],()=>Response.json({stop_reason:'max_tokens',content:[{type:'text',text:JSON.stringify(story())}]}),'incomplete_response'],
    [providers[1],()=>Response.json({stop_reason:'refusal',content:[]}),'model_refusal'],
    [providers[2],()=>Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(story())}]}}]}),'incomplete_response'],
    [providers[2],()=>Response.json({promptFeedback:{blockReason:'SAFETY'}}),'model_refusal'],
    [providers[2],()=>Response.json({candidates:[{finishReason:'SAFETY'}]}),'model_refusal'],
    [providers[2],()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}]}),'invalid_story_references']
  ];
  for(const [provider,response,expected] of incomplete){
    const {connections,ai}=await setup(provider,response);
    await assert.rejects(()=>explain(ai,provider),error=>error.code===expected);
    assert.equal(ai.cache.size,0);assert.equal(connections.active().analysisVerified,false);assert.equal(ai.busy,false);
  }
});

test('canceling a response that ignores fetch cancellation still ends the read without caching',async()=>{
  const provider=providers[1];let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const {connections,ai}=await setup(provider,()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"content":'));started();}})));
  const controller=new AbortController(),pending=ai.explain({code,filename,model:provider.model,consent:true},controller.signal);
  await ready;assert.equal(ai.busy,true);
  await assert.rejects(()=>explain(ai,provider),error=>error.code==='analysis_busy');
  const rejected=assert.rejects(()=>pending,error=>error.name==='AbortError');controller.abort();await rejected;
  assert.equal(ai.busy,false);assert.equal(ai.cache.size,0);assert.equal(connections.active().analysisVerified,false);
});

test('connection changes, including switching away and back, invalidate in-flight results',async()=>{
  const provider=providers[0];let release,started;
  const ready=new Promise(resolve=>{started=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const {connections,ai}=await setup(provider,async()=>{started();await waiting;return inference(provider);});
  const first=connections.active();const pending=explain(ai,provider);await ready;
  connections.usePlan();connections.select(first.id);
  const rejected=assert.rejects(()=>pending,error=>error.code==='connection_changed');release();await rejected;
  assert.equal(ai.cache.size,0);assert.equal(connections.active().analysisVerified,false);assert.equal(ai.busy,false);
});

test('unsafe credential echoes and oversized inference responses are discarded',async()=>{
  const provider=providers[1];
  for(const mode of ['secret','huge']){
    const {connections,ai}=await setup(provider,()=>{if(mode==='huge')return new Response('x'.repeat(600001));const value=story();value.overview=provider.key;return inference(provider,value);});
    await assert.rejects(()=>explain(ai,provider),error=>error.code===(mode==='huge'?'response_too_large':'invalid_provider_response')&&!error.message.includes(provider.key));
    assert.equal(ai.cache.size,0);assert.equal(connections.active().analysisVerified,false);
  }
});
