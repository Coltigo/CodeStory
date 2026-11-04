import {AppError} from './auth.js';
export function localEndpoint(value){
  let url;try{url=new URL(value);}catch{throw new AppError('Enter the local server address ending in /v1.',400,'invalid_local_endpoint');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||Number(url.port)<1024||url.username||url.password||url.search||url.hash||!/^\/v1\/?$/.test(url.pathname))throw new AppError('Use an HTTP loopback address with a port and /v1, such as http://127.0.0.1:11434/v1.',400,'invalid_local_endpoint');
  if(url.hostname==='localhost')url.hostname='127.0.0.1';return url.origin+'/v1';
}
export async function localJSON(fetcher,endpoint,path,{body,signal,timeout=20000}={}){
  const base=localEndpoint(endpoint),combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);let response;
  try{response=await fetcher(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:combined,redirect:'error'});}
  catch{signal?.throwIfAborted();if(combined.aborted)throw new AppError('The local model server did not respond before the timeout.',502,'local_timeout');throw new AppError('Could not reach the local model server. Start Ollama or LM Studio’s server and check its address.',502,'local_network');}
  if(!response.ok){let detail='';const reader=response.body?.getReader();if(reader)try{let count=0;while(count<4096){const part=await Promise.race([reader.read(),new Promise(resolve=>{const timer=setTimeout(()=>resolve({done:true}),1000);timer.unref?.();})]);if(part.done)break;count+=part.value.byteLength;detail+=new TextDecoder().decode(part.value.slice(0,4096));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const kind=/context|token.*limit|too long|context window/i.test(detail)?'local_context_limit':/not found|not loaded|load.*model/i.test(detail)?'local_model_unavailable':'local_request_failed';
    const message=response.status===401?'The local server requires authentication. This connector currently supports servers without API authentication.':kind==='local_context_limit'?'This request exceeds the model’s context or output capacity.':response.status===404||kind==='local_model_unavailable'?'The local model is unavailable or not loaded. Find models again and choose an installed model.':'The local server rejected the structured explanation request. Check that the model supports JSON-schema output.';
    throw new AppError(message,502,response.status===401?'local_auth_required':kind);
  }
  if(Number(response.headers.get('content-length'))>600000){await response.body?.cancel().catch(()=>{});throw new AppError('The local response was too large.',502,'local_response_too_large');}
  const reader=response.body?.getReader();if(!reader)throw new AppError('The local server returned an empty response.',502,'local_invalid_response');
  let text='',size=0;const decoder=new TextDecoder();let abort;
  const canceled=new Promise((_,reject)=>{abort=()=>{reader.cancel().catch(()=>{});reject(new AppError('Local generation stopped or timed out. Your completed guides are still available.',502,'local_timeout'));};combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();});
  try{await Promise.race([(async()=>{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>600000)throw new AppError('The local response was too large.',502,'local_response_too_large');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();})(),canceled]);signal?.throwIfAborted();try{return JSON.parse(text);}catch{throw new AppError('The local model did not return valid JSON. Choose a model with structured-output support.',502,'local_invalid_response');}}
  finally{combined.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function localCatalog(fetcher,endpoint){
  const data=await localJSON(fetcher,endpoint,'/models');if(!Array.isArray(data?.data)||data.data.length>500)throw new AppError('The local server returned an invalid model list.',502,'invalid_models');
  const models=[...new Set(data.data.map(m=>m?.id).filter(id=>typeof id==='string'&&id.length>0&&id.length<=200&&!/[\x00-\x1f\x7f]/.test(id)&&!/(?:cloud|embedding)/i.test(id)))].map(id=>({id,name:id}));
  if(!models.length)throw new AppError('No local text models found. Download or load a model in your runner, then refresh.',400,'no_local_models');return {models,limits:new Map()};
}
