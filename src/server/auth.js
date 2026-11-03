import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify,customFetch} from 'jose';
export const ISSUER='https://auth.openai.com';
export const RESOURCE='https://api.openai.com/v1';
export const PLAN_SCOPE='chatgpt.tokens.use.direct';
const SCOPE='openid profile email offline_access resource.invoke '+PLAN_SCOPE;
export class AppError extends Error {
  constructor(message,status=400,code='app_error',requestId=null){super(message);this.status=status;this.code=code;this.requestId=requestId;}
}
const safeEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const random=()=>randomBytes(32).toString('base64url');
const hasPlan=p=>!!p?.access_token&&p.scopes?.includes(PLAN_SCOPE);
export class AccountStore {
  constructor(directory){this.directory=directory;this.file=path.join(directory,'accounts.json');this.saving=Promise.resolve();this.data={version:1,hostId:'urn:uuid:'+randomUUID(),activeId:null,profiles:[]};}
  async init(){
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const stat=await fs.lstat(this.directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('The account directory must be a real directory.');
    await fs.chmod(this.directory,0o700);
    try{const s=await fs.lstat(this.file);if(s.isSymbolicLink()||!s.isFile())throw new Error('Invalid account file.');await fs.chmod(this.file,0o600);const data=JSON.parse(await fs.readFile(this.file,'utf8'));if(data.version!==1||!Array.isArray(data.profiles)||!/^urn:uuid:/.test(data.hostId))throw new Error('Invalid account file.');this.data=data;}
    catch(e){if(e.code!=='ENOENT')throw e;await this.save();}
  }
  save(){
    const write=async()=>{const temp=this.file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(this.data),{mode:0o600,flag:'wx'});await fs.rename(temp,this.file);await fs.chmod(this.file,0o600);};
    // Save current state in order, so an older write cannot finish after signout
    // and restore the credentials that signout just removed.
    const pending=this.saving.then(write,write);this.saving=pending;return pending;
  }
  profile(id=this.data.activeId){return this.data.profiles.find(p=>p.id===id);}
  publicProfile(p){return {id:p.id,email:p.email||'ChatGPT account',label:p.label,connected:!!p.access_token,planEnabled:hasPlan(p),active:p.id===this.data.activeId};}
  publicStatus(){return {accounts:this.data.profiles.map(p=>this.publicProfile(p)),active:this.profile()?this.publicProfile(this.profile()):null};}
}
export class ChatGPTAuth {
  constructor(store,{fetcher=fetch,now=()=>Date.now()}={}){this.store=store;this.fetcher=fetcher;this.now=now;this.pending=new Map();this.refreshes=new Map();this.sessionVersions=new Map();this.signingOut=new Set();this.lastResult=null;}
  sessionVersion(id){return this.sessionVersions.get(id)||0;}
  invalidateSession(id){this.sessionVersions.set(id,this.sessionVersion(id)+1);}
  async discovery(){
    if(this.configuration)return this.configuration;
    let response;try{response=await this.fetcher(ISSUER+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(15000)});}catch{throw new AppError('Could not reach ChatGPT sign-in. Check your internet connection.',502,'auth_network');}
    if(!response.ok)throw new AppError('ChatGPT sign-in discovery is unavailable.',502,'auth_unavailable');
    const config=await response.json();
    if(config.issuer!==ISSUER)throw new AppError('Unexpected sign-in issuer.',502,'invalid_issuer');
    for(const key of ['authorization_endpoint','token_endpoint','jwks_uri','revocation_endpoint']){if(new URL(config[key]).origin!==ISSUER)throw new AppError('Unexpected sign-in endpoint.',502,'invalid_endpoint');}
    this.configuration=config;this.jwks=createRemoteJWKSet(new URL(config.jwks_uri),{[customFetch]:this.fetcher});return config;
  }
  async start(redirectUri,profileId=null,enablePlan=false){
    const config=await this.discovery();
    const profile=profileId?this.store.profile(profileId):null;
    if(profileId&&!profile)throw new AppError('That saved account was not found.');
    for(const [key,attempt]of this.pending)if(attempt.expiresAt<this.now())this.pending.delete(key);
    if(this.pending.size>=8)throw new AppError('Too many sign-in attempts are open. Finish one or try again in ten minutes.',429,'auth_busy');
    const state=random(),nonce=random(),verifier=random();
    const retainedClient=profile?.client_id||(!profileId?this.store.data.recoveryClientId:null);
    const attempt={state,nonce,verifier,redirectUri,profileId,sessionVersion:profile?this.sessionVersion(profile.id):null,clientId:retainedClient,expiresAt:this.now()+600000};this.pending.set(state,attempt);
    const url=new URL(config.authorization_endpoint);
    const params={client_id:retainedClient||'dynamic_agent_client',ext_agent_host_id:this.store.data.hostId,response_type:'code',redirect_uri:redirectUri,scope:SCOPE,resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
    if(!retainedClient)params.agent_name_hint='CodeStory';
    else if(profile?.email)params.login_hint=profile.email;
    if(enablePlan&&profile)params.prompt='consent';
    for(const [key,value]of Object.entries(params))url.searchParams.set(key,value);
    this.lastResult={status:'pending',at:this.now()};return url.toString();
  }
  async exchange(body){
    const config=await this.discovery();let response;
    try{response=await this.fetcher(config.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),signal:AbortSignal.timeout(20000)});}catch{throw new AppError('Could not complete ChatGPT sign-in. Try again when your connection is stable.',502,'auth_network');}
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const code=typeof data.error==='string'?data.error:data.error?.code||'token_exchange_failed';
      const message=code==='invalid_grant'?'This sign-in expired or was revoked. Sign in to ChatGPT again.':response.status===429?'ChatGPT sign-in is rate limited. Wait and try again.':response.status>=500?'ChatGPT sign-in is temporarily unavailable. Your saved connection has been kept; try again later.':'ChatGPT could not authorize this connection. Please sign in again.';
      throw new AppError(message,response.status,code,response.headers.get('x-request-id'));
    }
    if(!data.access_token||!/^bearer$/i.test(data.token_type||''))throw new AppError('ChatGPT returned an incomplete sign-in response.',502,'invalid_token_response');
    return data;
  }
  async validateIdToken(token,clientId,nonce,subject){
    if(!token)throw new AppError('ChatGPT did not return an identity token.',401,'missing_id_token');
    await this.discovery();let payload;
    try{({payload}=await jwtVerify(token,this.jwks,{issuer:ISSUER,audience:clientId,algorithms:['RS256'],requiredClaims:['exp','sub'],clockTolerance:30}));}
    catch{throw new AppError('ChatGPT identity verification failed. Please start sign-in again.',401,'invalid_identity');}
    if(typeof payload.sub!=='string'||!payload.sub)throw new AppError('The signed-in identity is incomplete.',401,'invalid_identity');
    if(nonce&&!safeEqual(payload.nonce,nonce))throw new AppError('The sign-in response did not match this attempt.',401,'invalid_nonce');
    if(subject&&payload.sub!==subject)throw new AppError('A different account was selected. Use “Add account” to connect it separately.',401,'account_mismatch');
    return payload;
  }
  async callback(params){
    const state=params.get('state'),attempt=state?this.pending.get(state):null;
    if(!attempt||attempt.expiresAt<this.now()){if(state)this.pending.delete(state);throw new AppError('This sign-in attempt expired or did not match CodeStory. Start again.',400,'invalid_state');}
    this.pending.delete(state);
    try{
      if(params.has('error'))throw new AppError(params.get('error')==='access_denied'?'Sign-in was canceled. You can continue with local analysis.':'ChatGPT sign-in could not be completed.',400,'access_denied');
      const supplied=params.get('client_id');
      if(attempt.clientId&&supplied&&supplied!==attempt.clientId)throw new AppError('The returned account registration did not match.',400,'client_mismatch');
      const clientId=attempt.clientId||supplied;
      if(!clientId||clientId==='dynamic_agent_client'||clientId.length>300)throw new AppError('ChatGPT did not return a valid account registration.',400,'missing_client');
      if(!params.get('code'))throw new AppError('The sign-in response did not contain a code.',400,'missing_code');
      if(!attempt.profileId){this.store.data.recoveryClientId=clientId;await this.store.save();}
      const data=await this.exchange({grant_type:'authorization_code',client_id:clientId,code:params.get('code'),code_verifier:attempt.verifier,redirect_uri:attempt.redirectUri,resource:RESOURCE});
      const old=attempt.profileId?this.store.profile(attempt.profileId):null;
      const identity=await this.validateIdToken(data.id_token,clientId,attempt.nonce,old?.subject);
      if(old&&(this.signingOut.has(old.id)||attempt.sessionVersion!==this.sessionVersion(old.id)))throw new AppError('This connection changed while you were signing in. Start sign-in again.',409,'session_changed');
      let profile=this.store.data.profiles.find(p=>p.client_id===clientId&&p.subject===identity.sub);
      if(!profile){profile={id:randomUUID(),label:'Connection '+(this.store.data.profiles.length+1),client_id:clientId,subject:identity.sub,issuer:ISSUER};this.store.data.profiles.push(profile);}
      this.invalidateSession(profile.id);
      Object.assign(profile,{email:typeof identity.email==='string'?identity.email:null,...this.tokenFields(data,[])});
      if(this.store.data.recoveryClientId===clientId)delete this.store.data.recoveryClientId;
      this.store.data.activeId=profile.id;await this.store.save();
      this.lastResult={status:hasPlan(profile)?'connected':'permission_needed',message:hasPlan(profile)?'Your ChatGPT plan is connected.':'Signed in, but ChatGPT plan usage was not authorized.',at:this.now()};
      return this.lastResult;
    }catch(error){this.lastResult={status:'failed',message:error instanceof AppError?error.message:'Sign-in could not be completed.',at:this.now()};throw error;}
  }
  tokenFields(data,previousScopes){
    const seconds=Number(data.expires_in);if(!Number.isFinite(seconds)||seconds<=0)throw new AppError('The connection did not include a valid token expiry.',502,'invalid_expiry');
    return {access_token:data.access_token,refresh_token:data.refresh_token,id_token:data.id_token,token_type:'Bearer',scopes:typeof data.scope==='string'?data.scope.split(/\s+/).filter(Boolean):previousScopes,expires_at:this.now()+seconds*1000,saved_at:new Date(this.now()).toISOString()};
  }
  async access(profileId=this.store.data.activeId){
    const p=this.store.profile(profileId);
    if(p&&this.signingOut.has(p.id))throw new AppError('This account is signing out. Reconnect it before using AI.',401,'sign_in_required');
    if(!p?.access_token)throw new AppError('Connect your ChatGPT plan to use AI explanations.',401,'sign_in_required');
    if(!hasPlan(p))throw new AppError('This account is signed in, but has not allowed ChatGPT plan usage. Enable it in account settings.',403,'plan_permission_required');
    if(p.expires_at>this.now()+60000)return p.access_token;
    if(this.refreshes.has(p.id))return this.refreshes.get(p.id);
    const version=this.sessionVersion(p.id);
    const current=()=>this.sessionVersion(p.id)===version&&!this.signingOut.has(p.id);
    const promise=(async()=>{try{
      if(!p.refresh_token)throw new AppError('Your session expired. Sign in to ChatGPT again.',401,'sign_in_required');
      const data=await this.exchange({grant_type:'refresh_token',client_id:p.client_id,refresh_token:p.refresh_token,resource:RESOURCE});
      if(data.id_token)await this.validateIdToken(data.id_token,p.client_id,null,p.subject);
      if(!current())throw new AppError('This ChatGPT connection changed. Try again with the selected account.',409,'session_changed');
      const fields=this.tokenFields(data,p.scopes);fields.refresh_token=data.refresh_token||p.refresh_token;fields.id_token=data.id_token||p.id_token;
      Object.assign(p,fields);await this.store.save();
      if(!hasPlan(p))throw new AppError('ChatGPT plan usage permission is no longer enabled.',403,'plan_permission_required');
      return p.access_token;
    }catch(e){if(current()&&(e.code==='invalid_grant'||e.code==='sign_in_required')){delete p.access_token;delete p.refresh_token;delete p.id_token;await this.store.save();}throw e;}finally{this.refreshes.delete(p.id);}})();
    this.refreshes.set(p.id,promise);return promise;
  }
  async switchAccount(id){await this.access(id);this.store.data.activeId=id;await this.store.save();return this.store.publicStatus();}
  async signOut(id=this.store.data.activeId){
    const p=this.store.profile(id);if(!p)throw new AppError('Account not found.');
    this.invalidateSession(p.id);this.signingOut.add(p.id);
    try{
    let revoked=!p.refresh_token;
    if(p.refresh_token){try{const config=await this.discovery();for(let i=0;i<2;i++){const res=await this.fetcher(config.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:p.refresh_token,token_type_hint:'refresh_token',client_id:p.client_id}),signal:AbortSignal.timeout(8000)});if(res.ok){revoked=true;break;}if(res.status<500)break;}}catch{}}
    delete p.access_token;delete p.refresh_token;delete p.id_token;delete p.expires_at;
    if(this.store.data.activeId===p.id)this.store.data.activeId=null;
    await this.store.save();this.lastResult=null;
    return {revoked,message:revoked?'Signed out.':'Signed out locally. Remote revocation was not confirmed; you can disconnect CodeStory in ChatGPT settings.'};
    }finally{this.signingOut.delete(p.id);}
  }
}
export {safeEqual};
