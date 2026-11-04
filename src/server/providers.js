import {createHash,randomUUID} from 'node:crypto';
import {localEndpoint,localCatalog,localJSON} from './local.js';
import {analyze} from '../parser.js';
import {AppError} from './auth.js';
import {INSTRUCTIONS,STORY_SCHEMA,STORY_VERSION,sourceContext,validateStory,readResponseStream} from './ai.js';

export const API_PROVIDERS=Object.freeze([
  Object.freeze({id:'openai',label:'OpenAI API',billing:'OpenAI API project credits and limits; ChatGPT subscription allowance does not apply.',billingUrl:'https://platform.openai.com/settings/organization/billing/overview',modelsUrl:'https://platform.openai.com/docs/api-reference/models/list'}),
  Object.freeze({id:'anthropic',label:'Anthropic API',billing:'Anthropic Console API credits and limits apply; a Claude chat plan alone does not grant API access.',billingUrl:'https://platform.claude.com/settings/billing',modelsUrl:'https://platform.claude.com/docs/en/api/models/list'}),
  Object.freeze({id:'gemini',label:'Gemini API',billing:'Your Google API project quota and billing apply; a Google AI consumer plan is not this API allowance.',billingUrl:'https://ai.google.dev/gemini-api/docs/billing',modelsUrl:'https://ai.google.dev/api/models'})
]);
const bases={openai:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta'};
const state=new WeakMap();
const MAX_BYTES=600000,MAX_PAGES=5,MAX_MODELS=500;
const safeModel=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id);
const textModel=id=>!/(?:embedding|whisper|(?:^|[-_:])tts(?:$|[-_:])|dall-e|imagen|image|sora|veo|moderation|transcrib|audio|realtime)/i.test(id);
const providerName=id=>API_PROVIDERS.find(p=>p.id===id)?.label||'The AI provider';
const abortCheck=signal=>signal?.throwIfAborted();
function requestId(response,key){
  const value=response.headers.get('x-request-id')||response.headers.get('request-id');
  return value&&/^(?:req[_-]|request[_-]|[0-9a-f]{8}-)[A-Za-z0-9._:-]{1,100}$/i.test(value)&&!value.includes(key)?value:null;
}
function providerError(provider,status,id=null){
  const name=providerName(provider);
  if(status===401)return new AppError(`${name} did not accept this API key. Check the key and reconnect.`,401,'api_auth_failed',id);
  if(status===403)return new AppError(`${name} did not allow this request. Check the API project's permissions and model access.`,403,'api_forbidden',id);
  if(status===404)return new AppError(`${name} could not find this model or endpoint. Refresh the model list and choose another model.`,404,'api_model_unavailable',id);
  if(status===429)return new AppError(`${name} reached an API rate or quota limit. Review the provider's API usage and billing, then try again.`,429,'api_rate_limit',id);
  if(status>=500||status===408)return new AppError(`${name} is temporarily unavailable. Try again later; the local guide is still available.`,502,'api_unavailable',id);
  return new AppError(`${name} could not accept this request. Choose a model that supports structured JSON output, or review the API connection.`,400,'api_request_rejected',id);
}
function headers(provider,key){
  if(provider==='anthropic')return {'x-api-key':key,'anthropic-version':'2023-06-01','Content-Type':'application/json'};
  if(provider==='gemini')return {'x-goog-api-key':key,'Content-Type':'application/json'};
  return {Authorization:'Bearer '+key,'Content-Type':'application/json'};
}
async function readChunk(reader,signal){
  abortCheck(signal);
  if(!signal)return reader.read();
  let onAbort;
  const canceled=new Promise((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([reader.read(),canceled]);}
  finally{signal.removeEventListener('abort',onAbort);}
}
async function bodyText(response,signal){
  const contentLength=Number(response.headers.get('content-length'));
  if(contentLength>MAX_BYTES){await response.body?.cancel().catch(()=>{});throw new AppError('The AI service returned too much data. Try a smaller file.',502,'response_too_large');}
  if(!response.body)throw new AppError('The AI service returned an empty response.',502,'empty_response');
  const reader=response.body.getReader(),decoder=new TextDecoder();let total=0,text='';
  try{
    while(true){const {done,value}=await readChunk(reader,signal);abortCheck(signal);if(done)break;total+=value.byteLength;if(total>MAX_BYTES)throw new AppError('The AI service returned too much data. Try a smaller file.',502,'response_too_large');text+=decoder.decode(value,{stream:true});}
    return text+decoder.decode();
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}
async function request(fetcher,provider,key,url,{method='GET',body,signal,timeout=20000}={}){
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
  abortCheck(signal);let response;
  try{response=await fetcher(url,{method,headers:headers(provider,key),...(body===undefined?{}:{body:JSON.stringify(body)}),signal:combined,redirect:'error'});}
  catch{abortCheck(signal);throw new AppError(`${providerName(provider)} could not be reached. Check the connection and try again.`,502,'api_network');}
  abortCheck(signal);
  const id=requestId(response,key);
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw providerError(provider,response.status,id);}
  let text;
  try{text=await bodyText(response,combined);}
  catch(error){abortCheck(signal);if(error instanceof AppError)throw error;throw new AppError('The AI connection ended before completion. Nothing incomplete was saved; try again.',502,'interrupted_response',id);}
  return {text,id,headers:response.headers};
}
function parseJSON(text){try{return JSON.parse(text);}catch{throw new AppError('The AI service returned an unreadable response. Try again; the local guide is still available.',502,'invalid_provider_response');}}
function current(connections,snapshot){
  const data=state.get(connections);
  if(data.activeId!==snapshot.id||data.revision!==snapshot.revision||!data.profiles.has(snapshot.id))throw new AppError('The AI connection changed while this request was running. Try again with the selected connection.',409,'connection_changed');
}
function capture(connections){
  const data=state.get(connections),profile=data.profiles.get(data.activeId);
  if(!profile)throw new AppError('Connect and select an API provider before using AI explanations.',401,'api_connection_required');
  return {...profile,revision:data.revision};
}
function publicProfile(profile,activeId){return {id:profile.id,kind:profile.provider==='local'?'local':'api_key',provider:profile.provider,label:profile.label,ready:true,billing:profile.provider==='local'?'local':'api',preferredModel:profile.model||null,analysisVerified:profile.analysisVerified,active:profile.id===activeId};}
async function catalog(fetcher,provider,key){
  const items=new Map(),limits=new Map(),seen=new Set();let next=null;
  for(let page=0;page<MAX_PAGES;page++){
    const url=new URL(bases[provider]+'/models');
    if(provider==='gemini'){url.searchParams.set('pageSize','100');if(next)url.searchParams.set('pageToken',next);}
    if(provider==='anthropic'){url.searchParams.set('limit','100');if(next)url.searchParams.set('after_id',next);}
    if(provider==='openai'&&next){url.searchParams.set('limit','100');url.searchParams.set('after',next);}
    const response=await request(fetcher,provider,key,url.toString());
    const data=parseJSON(response.text),models=provider==='gemini'?data?.models:data?.data;
    if(!Array.isArray(models))throw new AppError('The AI provider returned an unexpected model catalog.',502,'invalid_models');
    for(const item of models){
      if(!item||typeof item!=='object')continue;
      if(provider==='gemini'&&(!Array.isArray(item.supportedGenerationMethods)||!item.supportedGenerationMethods.includes('generateContent')))continue;
      const id=provider==='gemini'&&typeof item.name==='string'?item.name.replace(/^models\//,''):item.id;
      if(!safeModel(id)||!textModel(id)||id.includes(key))continue;
      const name=provider==='anthropic'?item.display_name:provider==='gemini'?item.displayName:null;
      items.set(id,{id,name:typeof name==='string'&&name.trim()&&name.length<=160&&!name.includes(key)?name:id});
      const limit=item.max_output_tokens??item.max_tokens;
      if(Number.isSafeInteger(limit)&&limit>0)limits.set(id,Math.min(limit,16384));
      if(items.size>MAX_MODELS)throw new AppError('The AI model catalog is too large for this version. Use a connection with a smaller catalog.',502,'catalog_too_large');
    }
    next=provider==='gemini'?data.nextPageToken:data.has_more?data.last_id:null;
    if(!next){if(!items.size)throw new AppError('No text-generation models are available to this API connection. Check the provider project and model permissions.',403,'no_models');return {models:[...items.values()],limits};}
    if(typeof next!=='string'||next.length>2000||next.includes(key)||seen.has(next))throw new AppError('The AI provider returned an invalid model catalog page.',502,'invalid_models');
    seen.add(next);
  }
  throw new AppError('The AI model catalog has too many pages for this version. Use a connection with a smaller catalog.',502,'catalog_too_large');
}

export class ApiKeyConnections {
  constructor({fetcher=fetch}={}){this.fetcher=fetcher;state.set(this,{profiles:new Map(),activeId:null,revision:0});}
  async connect({provider,label,key,billingConsent}={}){
    if(billingConsent!==true)throw new AppError('Confirm the provider API credits, quota, and billing notice before connecting.',400,'api_billing_consent_required');
    if(typeof provider!=='string'||!Object.hasOwn(bases,provider))throw new AppError('Choose OpenAI, Anthropic, or Gemini.',400,'invalid_provider');
    if(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key)||!key.trim()||/[^\x21-\x7e]/.test(key.trim()))throw new AppError('Enter a valid API key without spaces or line breaks.',400,'invalid_api_key');
    key=key.trim();label=typeof label==='string'&&label.trim()?label.trim():providerName(provider)+' connection';
    if(label.length>60||/[\x00-\x1f\x7f]/.test(label)||label.includes(key))throw new AppError('Use a short connection name that does not contain the API key.',400,'invalid_connection_label');
    const discovered=await catalog(this.fetcher,provider,key);
    const data=state.get(this),profile={id:randomUUID(),provider,label,key,analysisVerified:false,catalog:discovered,modelsAt:Date.now()};
    data.profiles.set(profile.id,profile);data.activeId=profile.id;data.revision++;
    return publicProfile(profile,data.activeId);
  }
  async connectLocal({endpoint,model,label}={}){
    endpoint=localEndpoint(endpoint);const discovered=await localCatalog(this.fetcher,endpoint);
    if(!discovered.models.some(m=>m.id===model))throw new AppError('Choose a model from this local server.',400,'invalid_model');
    label=typeof label==='string'&&label.trim()?label.trim():'Local AI';if(label.length>60||/[\x00-\x1f\x7f]/.test(label))throw new AppError('Use a short local connection name.');
    const data=state.get(this),profile={id:randomUUID(),provider:'local',key:'',endpoint,model,label,analysisVerified:false,catalog:discovered,modelsAt:Date.now()};data.profiles.set(profile.id,profile);data.activeId=profile.id;data.revision++;return publicProfile(profile,data.activeId);
  }
  localEndpointIs(endpoint){const data=state.get(this);return data.profiles.get(data.activeId)?.endpoint===endpoint;}
  publicProfiles(){const data=state.get(this);return [...data.profiles.values()].map(p=>publicProfile(p,data.activeId));}
  active(){const data=state.get(this),profile=data.profiles.get(data.activeId);return profile?publicProfile(profile,data.activeId):null;}
  select(id){const data=state.get(this),profile=data.profiles.get(id);if(!profile)throw new AppError('That API connection was not found. Connect it again.',404,'api_connection_not_found');data.activeId=id;data.revision++;return publicProfile(profile,id);}
  usePlan(){const data=state.get(this);data.activeId=null;data.revision++;return null;}
  remove(id){const data=state.get(this);if(!data.profiles.has(id))throw new AppError('That API connection was not found.',404,'api_connection_not_found');data.profiles.delete(id);if(data.activeId===id)data.activeId=null;data.revision++;return {removed:true};}
  async models(refresh=false){
    const snapshot=capture(this),data=state.get(this);
    if(!refresh&&Date.now()-snapshot.modelsAt<120000)return snapshot.catalog.models.map(m=>({...m}));
    const discovered=snapshot.provider==='local'?await localCatalog(this.fetcher,snapshot.endpoint):await catalog(this.fetcher,snapshot.provider,snapshot.key);current(this,snapshot);
    Object.assign(data.profiles.get(snapshot.id),{catalog:discovered,modelsAt:Date.now()});
    return discovered.models.map(m=>({...m}));
  }
}

function usage(data,provider){
  const source=provider==='gemini'?data.usageMetadata:data.usage;
  if(!source||typeof source!=='object')return null;
  const mapping=provider==='gemini'?{input_tokens:'promptTokenCount',output_tokens:'candidatesTokenCount',total_tokens:'totalTokenCount'}:{input_tokens:'input_tokens',output_tokens:'output_tokens',total_tokens:'total_tokens'};
  return Object.fromEntries(Object.entries(mapping).filter(([,key])=>Number.isSafeInteger(source[key])&&source[key]>=0).map(([key,sourceKey])=>[key,source[sourceKey]]));
}
async function generate(fetcher,snapshot,model,context,signal){
  const {provider,key}=snapshot,input=JSON.stringify(context);let body,url=bases[provider],response;
  if(provider==='local'){
    const data=await localJSON(fetcher,snapshot.endpoint,'/chat/completions',{signal,timeout:600000,body:{model,messages:[{role:'system',content:INSTRUCTIONS},{role:'user',content:input}],stream:false,max_tokens:16384,response_format:{type:'json_schema',json_schema:{name:'code_story',strict:true,schema:STORY_SCHEMA}}}});
    const choice=data?.choices?.[0];if(choice?.finish_reason!=='stop'||typeof choice.message?.content!=='string'||!choice.message.content.trim())throw new AppError('The local model did not finish a complete explanation. Try a smaller file or a model with a larger context/output limit.',502,'local_incomplete_response');
    return {text:choice.message.content,usage:data.usage?{input_tokens:data.usage.prompt_tokens,output_tokens:data.usage.completion_tokens}:null};
  }
  if(provider==='openai'){
    url+='/responses';body={model,instructions:INSTRUCTIONS,input:[{role:'user',content:input}],store:false,stream:true,text:{format:{type:'json_schema',name:'code_story',strict:true,schema:STORY_SCHEMA}}};
  }else if(provider==='anthropic'){
    url+='/messages';body={model,max_tokens:snapshot.catalog.limits.get(model)||16384,system:INSTRUCTIONS,messages:[{role:'user',content:input}],output_config:{format:{type:'json_schema',schema:STORY_SCHEMA}}};
  }else{
    url+='/models/'+encodeURIComponent(model)+':generateContent';body={systemInstruction:{parts:[{text:INSTRUCTIONS}]},contents:[{role:'user',parts:[{text:input}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:STORY_SCHEMA}};
  }
  response=await request(fetcher,provider,key,url,{method:'POST',body,signal,timeout:240000});abortCheck(signal);
  if(provider==='openai'){
    let result;
    try{result=await readResponseStream(new Response(response.text,{headers:response.headers}));}
    catch(error){
      const allowed=['empty_stream','invalid_stream','model_refusal','incomplete_response','response_too_large','interrupted_stream'];
      if(allowed.includes(error.code))throw new AppError(error.message,502,error.code,response.id);
      throw providerError(provider,error.status||502,response.id);
    }
    if(result.text.length>MAX_BYTES)throw new AppError('The AI explanation was too large. Try a smaller file.',502,'response_too_large');
    return {text:result.text,usage:usage({usage:result.usage},provider)};
  }
  const data=parseJSON(response.text);
  if(provider==='anthropic'){
    if(data?.stop_reason==='refusal'||Array.isArray(data?.content)&&data.content.some(c=>c?.type==='refusal'))throw new AppError('This model declined to explain the file. The local guide is still available.',422,'model_refusal',response.id);
    if(data?.stop_reason!=='end_turn')throw new AppError('The model did not finish a complete explanation. Try a smaller file or another model.',502,'incomplete_response',response.id);
    const text=Array.isArray(data.content)?data.content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join(''):'';
    if(!text)throw new AppError('The model returned no explanation text. Try another model.',502,'empty_response',response.id);
    return {text,usage:usage(data,provider)};
  }
  const candidate=Array.isArray(data?.candidates)?data.candidates[0]:null;
  if(data?.promptFeedback?.blockReason||['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII'].includes(candidate?.finishReason))throw new AppError('This model declined to explain the file. The local guide is still available.',422,'model_refusal',response.id);
  if(candidate?.finishReason!=='STOP')throw new AppError('The model did not finish a complete explanation. Try a smaller file or another model.',502,'incomplete_response',response.id);
  const text=Array.isArray(candidate.content?.parts)?candidate.content.parts.filter(p=>p?.thought!==true&&typeof p.text==='string').map(p=>p.text).join(''):'';
  if(!text)throw new AppError('The model returned no explanation text. Try another model.',502,'empty_response',response.id);
  return {text,usage:usage(data,provider)};
}
export class ApiKeyAI {
  constructor(connections,{fetcher=fetch}={}){this.connections=connections;this.fetcher=fetcher;this.cache=new Map();this.busy=false;}
  clear(){this.cache.clear();}
  async explain({code,filename,model,consent}={},signal,{project=null}={}){
    if(consent!==true)throw new AppError('Confirm that this code may be sent to the selected AI provider before analysis.',400,'consent_required');
    if(typeof code!=='string'||typeof filename!=='string'||filename.length>100)throw new AppError('A valid source file is required.',400,'invalid_source');
    let parsed;try{parsed=analyze(code,filename);}catch(error){throw new AppError(error.message,400,'parse_error');}
    if(parsed.chunks.length>100||parsed.symbols.length>80)throw new AppError('AI analysis supports up to 100 sections and 80 functions per file. Split this file into smaller files.',400,'too_many_sections');
    if(this.busy)throw new AppError('An AI analysis is already running. Wait for it or cancel it before starting another.',409,'analysis_busy');
    const snapshot=capture(this.connections);this.busy=true;
    try{
      abortCheck(signal);const models=await this.connections.models();abortCheck(signal);current(this.connections,snapshot);
      if(!models.some(item=>item.id===model))throw new AppError('Choose a model from the selected API connection’s catalog.',400,'invalid_model');
      const cacheKey=createHash('sha256').update(JSON.stringify([snapshot.id,code,filename,model,STORY_VERSION,...(project?[project]:[])])).digest('hex');
      if(this.cache.has(cacheKey))return {...this.cache.get(cacheKey),cached:true};
      const result=await generate(this.fetcher,snapshot,model,{...sourceContext(parsed),...(project?{project}:{})},signal);abortCheck(signal);current(this.connections,snapshot);
      if(snapshot.key&&result.text.includes(snapshot.key))throw new AppError('The AI service returned an unsafe response. Nothing was saved; try another model.',502,'invalid_provider_response');
      const story=parseJSON(result.text);validateStory(story,parsed);
      const completed={story,model,provider:snapshot.provider,usage:result.usage,cached:false,createdAt:new Date().toISOString()};
      state.get(this.connections).profiles.get(snapshot.id).analysisVerified=true;
      this.cache.set(cacheKey,completed);if(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);
      return completed;
    }finally{this.busy=false;}
  }
}
