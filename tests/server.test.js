import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createCodeStory} from '../src/server/index.js';
import {ISSUER,PLAN_SCOPE} from '../src/server/auth.js';
const navigate=(url,headers)=>new Promise((resolve,reject)=>{
  const request=http.get(url,{headers},response=>{response.resume();response.on('end',()=>resolve({status:response.statusCode,location:response.headers.location}));});request.on('error',reject);
});
test('local HTTP boundary rejects cross-origin writes, invalid hosts, and private files',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-server-'));
  const app=await createCodeStory({port:0,root:process.cwd(),dataDir:dir,browserOpener:async()=>true,fetcher:async()=>{throw new Error('Unexpected external request');}});
  try{
    const status=await (await fetch(app.origin+'/api/status')).json();assert.ok(status.csrfToken);assert.equal(status.active,null);assert.ok(!JSON.stringify(status).includes('access_token'));
    assert.equal((await fetch(app.origin+'/')).status,200);
    assert.equal((await fetch(app.origin+'/.local/accounts.json')).status,404);
    const invalidHost=await new Promise((resolve,reject)=>{const request=http.get(app.origin+'/api/status',{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(invalidHost,403);
    assert.equal((await fetch(app.origin+'/api/auth/start',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json','X-CodeStory-Token':status.csrfToken},body:'{}'})).status,403);
    assert.equal((await fetch(app.origin+'/api/auth/start',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:'{}'})).status,403);
    const response=await fetch(app.origin+'/api/analyze',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-CodeStory-Token':status.csrfToken},body:JSON.stringify({code:'print(1)',filename:'test.py',consent:false})});assert.equal(response.status,400);assert.equal((await response.json()).code,'consent_required');
    const noAuth=await fetch(app.origin+'/api/models');assert.equal(noAuth.status,401);
  }finally{await app.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('accepts the cross-site OAuth document callback and landing page, while rejecting cross-site API reads',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-oauth-http-'));
  const keys=await generateKeyPair('RS256');const jwk={...await exportJWK(keys.publicKey),kid:'http-test-key',alg:'RS256',use:'sig'};
  let authorizationUrl,exchanges=0;
  const fetcher=async(url,options)=>{
    if(String(url).includes('openid-configuration'))return Response.json({issuer:ISSUER,authorization_endpoint:ISSUER+'/api/accounts/authorize',token_endpoint:ISSUER+'/api/accounts/oauth/token',revocation_endpoint:ISSUER+'/api/accounts/oauth/revoke',jwks_uri:ISSUER+'/.well-known/jwks.json'});
    if(String(url).includes('jwks'))return Response.json({keys:[jwk]});
    if(String(url).endsWith('/token')){
      exchanges++;const body=new URLSearchParams(options.body);assert.equal(body.get('client_id'),'oaiapp_http_test');assert.equal(body.get('redirect_uri'),app.origin+'/auth/callback');assert.ok(body.get('code_verifier'));
      const token=await new SignJWT({sub:'http-test-user',email:'http@example.test',nonce:authorizationUrl.searchParams.get('nonce')}).setProtectedHeader({alg:'RS256',kid:'http-test-key'}).setIssuer(ISSUER).setAudience('oaiapp_http_test').setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({access_token:'fake-http-access',refresh_token:'fake-http-refresh',id_token:token,token_type:'Bearer',expires_in:3600,scope:'openid email '+PLAN_SCOPE});
    }
    throw new Error('Unexpected external request');
  };
  const app=await createCodeStory({port:0,root:process.cwd(),dataDir:dir,fetcher,browserOpener:async url=>{authorizationUrl=new URL(url);return true;}});
  const navigation={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
  try{
    const status=await (await fetch(app.origin+'/api/status')).json();
    const started=await fetch(app.origin+'/api/auth/start',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-CodeStory-Token':status.csrfToken},body:'{}'});assert.equal(started.status,200);
    const callback=new URL(app.origin+'/auth/callback');callback.search=new URLSearchParams({state:authorizationUrl.searchParams.get('state'),code:'fake-http-code',client_id:'oaiapp_http_test'});
    const response=await navigate(callback,navigation);assert.equal(response.status,303);assert.equal(response.location,'/?auth=complete');assert.equal(exchanges,1);
    assert.equal((await navigate(app.origin+response.location,navigation)).status,200);
    const connected=await (await fetch(app.origin+'/api/status')).json();assert.equal(connected.active.planEnabled,true);assert.equal(connected.active.email,'http@example.test');
    assert.equal((await fetch(app.origin+'/api/status',{headers:navigation})).status,403);
    assert.equal((await fetch(app.origin+'/auth/callback',{headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'},redirect:'manual'})).status,403);
    const replay=await navigate(callback,navigation);assert.equal(replay.location,'/?auth=failed');assert.equal(exchanges,1);
  }finally{await app.close();await fs.rm(dir,{recursive:true,force:true});}
});
