import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {AccountStore,ChatGPTAuth,ISSUER,RESOURCE,PLAN_SCOPE} from '../src/server/auth.js';
const keys=await generateKeyPair('RS256');const publicJwk={...await exportJWK(keys.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
async function fixture({scope='openid email '+PLAN_SCOPE}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-auth-'));const store=new AccountStore(dir);await store.init();let requestedNonce,refreshCount=0,exchangeBody;
  const config={issuer:ISSUER,authorization_endpoint:ISSUER+'/api/accounts/authorize',token_endpoint:ISSUER+'/api/accounts/oauth/token',revocation_endpoint:ISSUER+'/api/accounts/oauth/revoke',jwks_uri:ISSUER+'/.well-known/jwks.json'};
  const fetcher=async(url,options)=>{
    if(String(url).includes('openid-configuration'))return Response.json(config);
    if(String(url).includes('jwks'))return Response.json({keys:[publicJwk]});
    if(String(url).endsWith('/revoke'))return new Response(null,{status:200});
    if(String(url).endsWith('/token')){const body=new URLSearchParams(options.body);exchangeBody=body;
      if(body.get('grant_type')==='refresh_token'){refreshCount++;return Response.json({access_token:'refreshed-token',refresh_token:'rotated-token',expires_in:3600,token_type:'Bearer'});}
      const token=await new SignJWT({sub:'test-subject',email:'test@example.test',nonce:requestedNonce}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer(ISSUER).setAudience('oaiapp_test').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({access_token:'test-access-token',refresh_token:'test-refresh-token',id_token:token,scope,expires_in:3600,token_type:'Bearer'});
    }throw new Error('Unexpected test URL');
  };
  const auth=new ChatGPTAuth(store,{fetcher});
  async function signIn(nonceOverride){const url=new URL(await auth.start('http://127.0.0.1:4173/auth/callback'));requestedNonce=nonceOverride||url.searchParams.get('nonce');return auth.callback(new URLSearchParams({state:url.searchParams.get('state'),code:'one-time-code',client_id:'oaiapp_test'}));}
  return {auth,store,dir,signIn,get exchangeBody(){return exchangeBody;},get refreshCount(){return refreshCount;},cleanup:()=>fs.rm(dir,{recursive:true,force:true})};
}
test('registration uses PKCE, a stable host, plan scope, and an exact loopback callback',async()=>{const f=await fixture();try{const a=new URL(await f.auth.start('http://127.0.0.1:4173/auth/callback')),b=new URL(await f.auth.start('http://127.0.0.1:4173/auth/callback'));assert.equal(a.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(a.searchParams.get('agent_name_hint'),'CodeStory');assert.ok(a.searchParams.get('scope').includes(PLAN_SCOPE));assert.equal(a.searchParams.get('resource'),RESOURCE);assert.equal(a.searchParams.get('ext_agent_host_id'),b.searchParams.get('ext_agent_host_id'));assert.notEqual(a.searchParams.get('state'),b.searchParams.get('state'));assert.notEqual(a.searchParams.get('code_challenge'),b.searchParams.get('code_challenge'));assert.equal(a.searchParams.get('code_challenge_method'),'S256');}finally{await f.cleanup();}});
test('validates the signed identity, stores private tokens, exposes only safe account metadata, reuses registration',async()=>{const f=await fixture();try{const result=await f.signIn();assert.equal(result.status,'connected');assert.equal(f.exchangeBody.get('client_id'),'oaiapp_test');assert.equal(f.exchangeBody.get('redirect_uri'),'http://127.0.0.1:4173/auth/callback');assert.ok(f.exchangeBody.get('code_verifier'));assert.equal(await f.auth.access(),'test-access-token');assert.ok(!JSON.stringify(f.store.publicStatus()).includes('test-access-token'));const mode=(await fs.stat(f.store.file)).mode&0o777;assert.equal(mode,0o600);const next=new URL(await f.auth.start('http://127.0.0.1:54321/auth/callback',f.store.data.activeId));assert.equal(next.searchParams.get('client_id'),'oaiapp_test');assert.ok(!next.searchParams.has('agent_name_hint'));}finally{await f.cleanup();}});
test('rejects mismatched nonce and unknown callback state without saving tokens',async()=>{const f=await fixture();try{await assert.rejects(()=>f.auth.callback(new URLSearchParams({state:'wrong'})),e=>e.code==='invalid_state');await assert.rejects(()=>f.signIn('wrong-nonce'),e=>e.code==='invalid_nonce');assert.equal(f.store.data.profiles.length,0);const retry=new URL(await f.auth.start('http://127.0.0.1:4173/auth/callback'));assert.equal(retry.searchParams.get('client_id'),'oaiapp_test');}finally{await f.cleanup();}});
test('serializes token refresh and retains scopes when refresh omits scope',async()=>{const f=await fixture();try{await f.signIn();f.store.profile().expires_at=0;const tokens=await Promise.all([f.auth.access(),f.auth.access(),f.auth.access()]);assert.deepEqual(tokens,['refreshed-token','refreshed-token','refreshed-token']);assert.equal(f.refreshCount,1);assert.equal(f.store.profile().refresh_token,'rotated-token');assert.ok(f.store.profile().scopes.includes(PLAN_SCOPE));}finally{await f.cleanup();}});
test('signout clears secrets, revokes renewal, and retains client mapping',async()=>{const f=await fixture();try{await f.signIn();const id=f.store.data.activeId;assert.equal((await f.auth.signOut()).revoked,true);assert.equal(f.store.profile(id).client_id,'oaiapp_test');assert.equal(f.store.profile(id).access_token,undefined);assert.equal(f.store.profile(id).refresh_token,undefined);assert.equal(f.store.data.activeId,null);}finally{await f.cleanup();}});
test('identity-only consent remains signed in and prevents AI access',async()=>{
  const f=await fixture({scope:'openid profile email'});
  try{assert.equal((await f.signIn()).status,'permission_needed');assert.ok(f.store.publicStatus().active.connected);assert.equal(f.store.publicStatus().active.planEnabled,false);await assert.rejects(()=>f.auth.access(),e=>e.code==='plan_permission_required');}
  finally{await f.cleanup();}
});
test('transient refresh errors preserve credentials and HTTP diagnostics; a later refresh can succeed',async()=>{
  const f=await fixture();
  try{
    await f.signIn();f.store.profile().expires_at=0;const original=f.auth.fetcher;
    for(const status of [429,503]){
      f.auth.fetcher=async()=>Response.json({error:'temporarily_unavailable'},{status,headers:{'x-request-id':'test-refresh-request'}});
      await assert.rejects(()=>f.auth.access(),e=>e.status===status&&e.code==='temporarily_unavailable'&&e.requestId==='test-refresh-request');
      assert.equal(f.store.profile().refresh_token,'test-refresh-token');assert.equal(f.store.profile().access_token,'test-access-token');
    }
    f.auth.fetcher=original;assert.equal(await f.auth.access(),'refreshed-token');
  }finally{await f.cleanup();}
});
test('terminal refresh rejection clears secrets without losing registration',async()=>{
  const f=await fixture();
  try{await f.signIn();f.store.profile().expires_at=0;f.auth.fetcher=async()=>Response.json({error:'invalid_grant'},{status:400});await assert.rejects(()=>f.auth.access(),e=>e.code==='invalid_grant');assert.equal(f.store.profile().client_id,'oaiapp_test');assert.equal(f.store.profile().access_token,undefined);assert.equal(f.store.profile().refresh_token,undefined);}
  finally{await f.cleanup();}
});
test('ID tokens require the expected issuer, audience, expiration, and signature',async()=>{
  const f=await fixture();
  try{
    await f.auth.discovery();
    for(const changes of [{iss:'https://untrusted.example'},{aud:'another-client'},{exp:Math.floor(Date.now()/1000)-120},{exp:undefined}]){
      const token=await new SignJWT({sub:'test-subject',iss:ISSUER,aud:'oaiapp_test',exp:Math.floor(Date.now()/1000)+3600,...changes}).setProtectedHeader({alg:'RS256',kid:'test-key'}).sign(keys.privateKey);
      await assert.rejects(()=>f.auth.validateIdToken(token,'oaiapp_test'),e=>e.code==='invalid_identity');
    }
    const other=await generateKeyPair('RS256');
    const token=await new SignJWT({sub:'test-subject'}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer(ISSUER).setAudience('oaiapp_test').setExpirationTime('1h').sign(other.privateKey);
    await assert.rejects(()=>f.auth.validateIdToken(token,'oaiapp_test'),e=>e.code==='invalid_identity');
  }finally{await f.cleanup();}
});
test('account registrations stay separate even for the same email; a returning account cannot change identity',async()=>{
  const f=await fixture();
  try{
    await f.signIn();const first=f.store.profile(),originalToken=first.access_token,original=f.auth.fetcher;
    let newSubject='test-subject',pendingNonce;
    f.auth.fetcher=async(url,options)=>{
      if(!String(url).endsWith('/token'))return original(url,options);
      const clientId=new URLSearchParams(options.body).get('client_id');
      const idToken=await new SignJWT({sub:newSubject,email:'test@example.test',nonce:pendingNonce}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer(ISSUER).setAudience(clientId).setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({access_token:'second-token',refresh_token:'second-refresh',id_token:idToken,scope:PLAN_SCOPE,expires_in:3600,token_type:'Bearer'});
    };
    const secondStart=new URL(await f.auth.start('http://127.0.0.1:4173/auth/callback'));assert.equal(secondStart.searchParams.get('client_id'),'dynamic_agent_client');pendingNonce=secondStart.searchParams.get('nonce');
    await f.auth.callback(new URLSearchParams({state:secondStart.searchParams.get('state'),code:'second-code',client_id:'oaiapp_second'}));
    const secondId=f.store.data.activeId;assert.equal(f.store.data.profiles.length,2);assert.notEqual(first.id,secondId);assert.equal(first.access_token,originalToken);
    const returning=new URL(await f.auth.start('http://127.0.0.1:4173/auth/callback',first.id));pendingNonce=returning.searchParams.get('nonce');newSubject='wrong-subject';
    await assert.rejects(()=>f.auth.callback(new URLSearchParams({state:returning.searchParams.get('state'),code:'wrong-account-code'})),e=>e.code==='account_mismatch');
    assert.equal(f.store.data.activeId,secondId);assert.equal(first.access_token,originalToken);
  }finally{await f.cleanup();}
});
test('signout blocks new access and a pending refresh cannot restore credentials afterward',async()=>{
  const f=await fixture();let finishRefresh,finishRevocation,refreshStarted,revokeStarted;
  const refreshReady=new Promise(resolve=>{refreshStarted=resolve;}),revokeReady=new Promise(resolve=>{revokeStarted=resolve;});
  try{
    await f.signIn();const id=f.store.data.activeId;f.store.profile().expires_at=0;const original=f.auth.fetcher;
    f.auth.fetcher=async(url,options)=>{
      if(String(url).endsWith('/token')&&new URLSearchParams(options.body).get('grant_type')==='refresh_token'){refreshStarted();return new Promise(resolve=>{finishRefresh=resolve;});}
      if(String(url).endsWith('/revoke')){revokeStarted();return new Promise(resolve=>{finishRevocation=resolve;});}
      return original(url,options);
    };
    const refresh=f.auth.access();await refreshReady;
    const signingOut=f.auth.signOut();await revokeReady;
    await assert.rejects(()=>f.auth.access(id),e=>e.code==='sign_in_required');
    finishRevocation(new Response(null,{status:200}));await signingOut;
    const rejected=assert.rejects(()=>refresh,e=>e.code==='session_changed');
    finishRefresh(Response.json({access_token:'late-access',refresh_token:'late-refresh',token_type:'Bearer',expires_in:3600}));await rejected;
    assert.equal(f.store.profile(id).access_token,undefined);assert.equal(f.store.profile(id).refresh_token,undefined);assert.equal(f.store.data.activeId,null);
    const saved=JSON.parse(await fs.readFile(f.store.file,'utf8')).profiles.find(profile=>profile.id===id);assert.equal(saved.access_token,undefined);assert.equal(saved.refresh_token,undefined);assert.equal(saved.client_id,'oaiapp_test');
  }finally{await f.cleanup();}
});
test('a stale refresh rejection cannot clear a newly reconnected session',async()=>{
  const f=await fixture();let finishRefresh,refreshStarted;
  const ready=new Promise(resolve=>{refreshStarted=resolve;});
  try{
    await f.signIn();const id=f.store.data.activeId;f.store.profile().expires_at=0;const original=f.auth.fetcher;
    const authorization=new URL(await f.auth.start('http://127.0.0.1:4173/auth/callback',id));
    f.auth.fetcher=async(url,options)=>{
      if(!String(url).endsWith('/token'))return original(url,options);
      if(new URLSearchParams(options.body).get('grant_type')==='refresh_token'){refreshStarted();return new Promise(resolve=>{finishRefresh=resolve;});}
      const identity=await new SignJWT({sub:'test-subject',email:'test@example.test',nonce:authorization.searchParams.get('nonce')}).setProtectedHeader({alg:'RS256',kid:'test-key'}).setIssuer(ISSUER).setAudience('oaiapp_test').setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({access_token:'new-login-access',refresh_token:'new-login-refresh',id_token:identity,scope:PLAN_SCOPE,token_type:'Bearer',expires_in:3600});
    };
    const refresh=f.auth.access();await ready;
    await f.auth.callback(new URLSearchParams({state:authorization.searchParams.get('state'),code:'new-login-code'}));
    const rejected=assert.rejects(()=>refresh,e=>e.code==='invalid_grant');finishRefresh(Response.json({error:'invalid_grant'},{status:400}));await rejected;
    assert.equal(await f.auth.access(id),'new-login-access');assert.equal(f.store.profile(id).refresh_token,'new-login-refresh');
    const saved=JSON.parse(await fs.readFile(f.store.file,'utf8')).profiles.find(profile=>profile.id===id);assert.equal(saved.access_token,'new-login-access');
  }finally{await f.cleanup();}
});
