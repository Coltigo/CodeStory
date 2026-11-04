import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {AccountStore,ChatGPTAuth,AppError,safeEqual} from './auth.js';
import {LocalRuntime,LocalPreferences} from './local-runtime.js';
import {localEndpoint,localCatalog} from './local.js';
import {StoryAI} from './ai.js';
import {inspectProject,projectContext} from '../projects.js';
import {ApiKeyConnections,ApiKeyAI,API_PROVIDERS} from './providers.js';
const ENTRY_DIR=path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT=path.resolve(ENTRY_DIR,path.basename(ENTRY_DIR)==='runtime'?'..':'../..');
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
export async function openBrowser(url){
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'cmd':'xdg-open';
  const args=process.platform==='win32'?['/c','start','',url]:[url];
  return new Promise(resolve=>{const child=spawn(command,args,{stdio:'ignore',windowsHide:true});child.once('error',()=>resolve(false));child.once('exit',code=>resolve(code===0));setTimeout(()=>resolve(false),5000).unref();});
}
async function readJSON(req,maxBytes=550000){const chunks=[];let size=0;for await(const bytes of req){size+=bytes.length;if(size>maxBytes)throw new AppError('The request is too large. Choose a smaller source file.',413,'body_too_large');chunks.push(bytes);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('Expected a JSON request.',400,'invalid_json');}}
export async function createCodeStory({port=4173,root=APP_ROOT,dataDir=path.join(root,'.local'),fetcher=fetch,browserOpener=openBrowser,store:providedStore,localRuntime:providedRuntime}={}){
  const store=providedStore||new AccountStore(dataDir);await store.init();
  const auth=new ChatGPTAuth(store,{fetcher}),ai=new StoryAI(auth,{fetcher}),connections=new ApiKeyConnections({fetcher}),apiAI=new ApiKeyAI(connections,{fetcher});
  const localRuntime=providedRuntime||new LocalRuntime({fetcher}),localPreferences=new LocalPreferences(dataDir);await localPreferences.init();const activeControllers=new Set();let localNotice=localPreferences.notice||'';
  const verifiedPlans=new Set();let changingConnection=false;
  const busy=()=>changingConnection||ai.busy||apiAI.busy;
  const connectionStatus=()=>{
    const apiConnection=connections.active();if(apiConnection)return apiConnection;
    const active=store.publicStatus().active;
    return active?{id:active.id,kind:'chatgpt_plan',provider:'chatgpt',label:active.email,ready:!!(active.connected&&active.planEnabled),billing:'plan',analysisVerified:verifiedPlans.has(active.id)}:null;
  };
  const mutateConnection=async action=>{if(busy())throw new AppError('Wait for the current request to finish, or cancel the analysis before changing connections.',409,'connection_busy');changingConnection=true;try{return await action();}finally{changingConnection=false;}};
  const csrf=randomBytes(32).toString('base64url');let origin;
  const server=http.createServer(async(req,res)=>{
    const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
    res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cache-Control','no-store');
    const json=(status,value)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
      if(req.headers.host!==new URL(origin).host)throw new AppError('Use the CodeStory loopback address shown in the terminal.',403,'invalid_host');
      const url=new URL(req.url,origin);
      // OAuth arrives from OpenAI as a cross-site document navigation. Its redirect
      // to the app retains that classification, while API requests stay protected.
      const documentNavigation=req.method==='GET'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document'&&['/','/auth/callback'].includes(url.pathname);
      if(req.headers['sec-fetch-site']==='cross-site'&&!documentNavigation)throw new AppError('Cross-site requests are not allowed.',403,'cross_site_request');
      if(!['GET','POST'].includes(req.method))throw new AppError('Method not allowed.',405,'method_not_allowed');
      if(req.method==='POST'){
        if(req.headers.origin!==origin||!safeEqual(req.headers['x-codestory-token'],csrf))throw new AppError('Reload CodeStory before making this request.',403,'invalid_local_session');
        if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new AppError('Expected a JSON request.',415,'invalid_content_type');
      }
      if(req.method==='GET'&&url.pathname==='/api/health')return json(200,{app:'CodeStory',version:'1.0.0',local:true});
      if(req.method==='GET'&&url.pathname==='/api/status')return json(200,{csrfToken:csrf,...store.publicStatus(),authResult:auth.lastResult,busy:busy(),connection:connectionStatus(),apiConnections:connections.publicProfiles(),providers:API_PROVIDERS,localPreferences:localPreferences.value,localRuntime:localRuntime.status(),localNotice});
      if(req.method==='POST'&&url.pathname==='/api/local/preferences'){
        const body=await readJSON(req);const preferences=await mutateConnection(()=>localPreferences.save(body));return json(200,{preferences});
      }
      if(req.method==='POST'&&url.pathname==='/api/local/start'){
        const body=await readJSON(req);const runtime=await mutateConnection(()=>localRuntime.start(body));localNotice=runtime.message;return json(200,{runtime});
      }
      if(req.method==='POST'&&url.pathname==='/api/local/stop'){
        const endpoint=localRuntime.status().endpoint;const runtime=await mutateConnection(()=>localRuntime.stop());if(runtime.stopped&&connections.active()?.provider==='local'&&connections.localEndpointIs(endpoint)){const profile=connections.active();connections.remove(profile.id);apiAI.clear();}localNotice=runtime.message;return json(200,{runtime});
      }
      if(req.method==='POST'&&url.pathname==='/api/connections/local/models'){
        const body=await readJSON(req);const discovered=await mutateConnection(()=>localCatalog(fetcher,localEndpoint(body.endpoint)));return json(200,{models:discovered.models});
      }
      if(req.method==='POST'&&url.pathname==='/api/connections/local'){
        const body=await readJSON(req);const connection=await mutateConnection(async()=>{if(body.autoStart===true&&body.runner==='ollama')await localRuntime.start(body);const selected=await connections.connectLocal(body);if(body.runner)await localPreferences.save(body);return selected;});return json(200,{connection});
      }
      if(req.method==='POST'&&url.pathname==='/api/connections/api'){
        const body=await readJSON(req);const connection=await mutateConnection(()=>connections.connect(body));return json(200,{connection});
      }
      if(req.method==='POST'&&url.pathname==='/api/connections/select'){
        const body=await readJSON(req);await mutateConnection(async()=>{if(body.id==='chatgpt'){const active=store.profile();if(!active)throw new AppError('Sign in to ChatGPT before choosing this connection.',401,'sign_in_required');await auth.access(active.id);connections.usePlan();}else connections.select(body.id);});return json(200,{connection:connectionStatus()});
      }
      if(req.method==='POST'&&url.pathname==='/api/connections/remove'){
        const body=await readJSON(req);const result=await mutateConnection(()=>connections.remove(body.id));apiAI.clear();return json(200,result);
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/start'){
        const body=await readJSON(req);
        const authorizationUrl=await mutateConnection(()=>auth.start(origin+'/auth/callback',body.profileId||null,body.enablePlan===true));
        const opened=await browserOpener(authorizationUrl);
        return json(200,{opened,authorizationUrl});
      }
      if(req.method==='GET'&&url.pathname==='/auth/callback'){
        try{await mutateConnection(async()=>{await auth.callback(url.searchParams);connections.usePlan();});res.writeHead(303,{Location:'/?auth=complete'});res.end();}catch(error){auth.lastResult={status:'failed',message:error instanceof AppError?error.message:'Sign-in could not be completed.',at:Date.now()};res.writeHead(303,{Location:'/?auth=failed'});res.end();}return;
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/switch'){
        const body=await readJSON(req);await mutateConnection(async()=>{await auth.switchAccount(body.profileId);connections.usePlan();});ai.clear();return json(200,{ok:true});
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/signout'){
        const body=await readJSON(req);const result=await mutateConnection(()=>auth.signOut(body.profileId||undefined));ai.clear();return json(200,result);
      }
      if(req.method==='GET'&&url.pathname==='/api/models')return json(200,{models:await (connections.active()?connections.models(url.searchParams.get('refresh')==='1'):ai.models(url.searchParams.get('refresh')==='1'))});
      if(req.method==='POST'&&['/api/analyze','/api/projects/analyze-file'].includes(url.pathname)){
        const isProject=url.pathname==='/api/projects/analyze-file';
        let body=await readJSON(req,isProject?2000000:550000);const controller=new AbortController(),connection=connectionStatus();let context=null;
        if(isProject){
          if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError('A project request object is required.',400,'invalid_project');
          if(body.consent!==true)throw new AppError('Review the selected project files and confirm sharing before scanning.',400,'consent_required');
          if(!connection?.ready||body.connectionId!==connection.id)throw new AppError('Choose your AI connection and review the project sharing notice.',409,'connection_changed');
          try{const project=inspectProject(body.files,{importRoot:body.importRoot||''});context=projectContext(project,body.path,body.entryId);context.revision=createHash('sha256').update(JSON.stringify([body.files,project.importRoot,body.entryId])).digest('hex');const file=project.files.find(f=>f.path===body.path);body={code:file.code,filename:file.path.split('/').at(-1),consent:true,connectionId:body.connectionId,model:body.model};}catch(error){throw new AppError(error.message,400,'invalid_project');}
        }
        if(changingConnection)throw new AppError('Wait for the connection check to finish, then try again.',409,'connection_busy');
        if(body.connectionId&&body.connectionId!==connection?.id)throw new AppError('Your AI connection changed. Review the file and connection before analyzing again.',409,'connection_changed');
        if(ai.busy||apiAI.busy)throw new AppError('An analysis is already running. Wait for it or cancel it first.',409,'analysis_busy');
        res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        activeControllers.add(controller);let result;try{result=await (connections.active()?apiAI:ai).explain(body,controller.signal,{project:context});}finally{activeControllers.delete(controller);}if(connection?.kind==='chatgpt_plan')verifiedPlans.add(connection.id);return json(200,{...result,connection:connection?{id:connection.id,kind:connection.kind,provider:connection.provider,label:connection.label,billing:connection.billing}:null});
      }
      if(url.pathname.startsWith('/api/'))throw new AppError('Endpoint not found.',404,'not_found');
      if(req.method!=='GET')throw new AppError('Not found.',404,'not_found');
      const publicPath=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\//,'');
      const file=path.resolve(root,'dist',publicPath),base=path.resolve(root,'dist')+path.sep;
      if(!file.startsWith(base))throw new AppError('Not found.',404,'not_found');
      const extension=path.extname(file);if(!MIME[extension])throw new AppError('Not found.',404,'not_found');
      let data;try{data=await fs.readFile(file);}catch{throw new AppError('Not found.',404,'not_found');}
      res.writeHead(200,{'Content-Type':MIME[extension]});res.end(data);
    }catch(error){
      if(error.name==='AbortError'||res.destroyed)return;
      const known=error instanceof AppError;
      json(known?error.status:500,{error:known?error.message:'CodeStory could not complete this request. Please try again.',code:known?error.code:'internal_error',...(known&&error.requestId?{requestId:error.requestId}:{}),...(known&&error.detail?{detail:error.detail}:{}),...(known&&error.param?{param:error.param}:{})});
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();});});
  if(localPreferences.value.autoStart&&localPreferences.value.model){changingConnection=true;(async()=>{try{await localRuntime.start(localPreferences.value);if(!localRuntime.closed)await connections.connectLocal(localPreferences.value);localNotice=localRuntime.status().message;}catch(error){localNotice=error.message;}finally{changingConnection=false;}})();}
  return {server,auth,ai,store,connections,apiAI,localRuntime,localPreferences,get origin(){return origin;},close:async()=>{for(const controller of activeControllers)controller.abort();await localRuntime.close();return new Promise(resolve=>server.close(resolve));}};
}
async function main(){
  const root=APP_ROOT,port=Number(process.env.CODESTORY_PORT||4173),lockPath=path.join(root,'.local','runtime.lock');
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('CODESTORY_PORT must be a port between 1024 and 65535.');
  await fs.mkdir(path.dirname(lockPath),{recursive:true,mode:0o700});
  let lock;
  try{lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(String(process.pid));}
  catch(e){if(e.code!=='EEXIST')throw e;let pid=Number(await fs.readFile(lockPath,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive){console.log('CodeStory is already running. Open http://127.0.0.1:'+port);return;}await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(String(process.pid));}
  const cleanup=async()=>{await lock?.close().catch(()=>{});await fs.unlink(lockPath).catch(()=>{});};
  try{
    const app=await createCodeStory({port,root});
    console.log('\nCodeStory is ready at '+app.origin+'\nKeep this window open while using CodeStory. Press Control-C to stop.\n');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();await cleanup();process.exit(0);});
    if(process.argv.includes('--open'))await openBrowser(app.origin);
  }catch(e){await cleanup();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.code==='EADDRINUSE'?'Port 4173 is already in use. Close the other app or set CODESTORY_PORT to another port.':e.message);process.exitCode=1;});
