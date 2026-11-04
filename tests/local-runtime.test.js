import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalRuntime,LocalPreferences} from '../src/server/local-runtime.js';
const endpoint='http://127.0.0.1:11434/v1';
function setup({external=false,missing=false}={}){let ready=external,time=0,child;const commands=[],kills=[];const runtime=new LocalRuntime({now:()=>time,delay:async ms=>{time+=ms;},findBinary:async()=>'/fixture/ollama',fetcher:async()=>{if(!ready)throw Error('not running');return Response.json({data:[]});},spawner:(command,args,options)=>{commands.push({command,args,options});child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.kill=signal=>{kills.push(signal);ready=false;child.signalCode=signal;child.emit('exit',null,signal);};if(missing)queueMicrotask(()=>child.emit('error',Error('missing')));else ready=true;return child;}});return {runtime,commands,kills};}

test('managed Ollama starts with fixed arguments and loopback environment and closes only its child',async()=>{
 const f=setup();const started=await f.runtime.start({runner:'ollama',endpoint});assert.equal(started.managed,true);assert.equal(started.starting,false);assert.deepEqual(f.commands[0].args,['serve']);assert.equal(f.commands[0].options.shell,false);assert.equal(f.commands[0].options.env.OLLAMA_HOST,'127.0.0.1:11434');assert.equal(f.commands[0].options.env.OLLAMA_NO_CLOUD,'1');assert.equal((await f.runtime.stop()).stopped,true);assert.deepEqual(f.kills,['SIGTERM']);assert.equal((await f.runtime.stop()).stopped,false);
});
test('existing servers are reused and never stopped by CodeStory',async()=>{
 const f=setup({external:true});const result=await f.runtime.start({runner:'ollama',endpoint});assert.equal(result.reused,true);assert.equal(result.managed,false);await f.runtime.close();assert.equal(f.commands.length,0);assert.deepEqual(f.kills,[]);
});
test('invalid endpoints, unsupported lifecycle runners and missing executables have actionable failures',async()=>{
 const f=setup();await assert.rejects(()=>f.runtime.start({runner:'ollama',endpoint:'http://example.test:1234/v1'}));await assert.rejects(()=>f.runtime.start({runner:'lmstudio',endpoint}),/Developer tab/);assert.equal(f.commands.length,0);const missing=setup({missing:true});await assert.rejects(()=>missing.runtime.start({runner:'ollama',endpoint}),/Install Ollama/);assert.equal(missing.runtime.status().managed,false);
});
test('closing a runner manager prevents future process creation',async()=>{
 const f=setup();await f.runtime.close();await assert.rejects(()=>f.runtime.start({runner:'ollama',endpoint}),/shutting down/);assert.equal(f.commands.length,0);
});
test('local preferences persist only approved nonsecret fields and use private permissions',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-prefs-'));try{const p=new LocalPreferences(dir);await p.init();assert.equal(p.value.autoStart,false);await p.save({runner:'ollama',endpoint,model:'example/local:7b',autoStart:true,key:'not-to-be-saved',accounts:['not-to-be-saved']});const disk=await fs.readFile(p.file,'utf8');assert.ok(!disk.includes('not-to-be-saved'));assert.deepEqual(Object.keys(JSON.parse(disk)).sort(),['autoStart','endpoint','model','runner']);assert.equal((await fs.stat(p.file)).mode&0o777,0o600);const restored=new LocalPreferences(dir);await restored.init();assert.equal(restored.value.model,'example/local:7b');assert.equal(restored.value.autoStart,true);await restored.save({runner:'lmstudio',endpoint:'http://127.0.0.1:1234/v1',model:'local',autoStart:true});assert.equal(restored.value.autoStart,false);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('preference writes reject symlinks and preserve their target',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-prefs-link-'));try{const target=path.join(dir,'target');await fs.writeFile(target,'keep');await fs.symlink(target,path.join(dir,'local-preferences.json'));const p=new LocalPreferences(dir);await assert.rejects(()=>p.save({runner:'ollama',endpoint,model:'local'}));assert.equal(await fs.readFile(target,'utf8'),'keep');}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('HTTP lifecycle and preferences routes require CSRF and clean up the managed runner on CodeStory shutdown',async()=>{
 const {createCodeStory}=await import('../src/server/index.js');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-runtime-http-'));let starts=0,stops=0,managed=false;
 const runtime={closed:false,status:()=>({managed,starting:false,endpoint:managed?endpoint:null,message:'Fixture runner'}),start:async()=>{starts++;managed=true;return runtime.status();},stop:async()=>{const stopped=managed;if(stopped)stops++;managed=false;return {...runtime.status(),stopped};},close:async()=>{runtime.closed=true;return runtime.stop();}};
 const fetcher=async url=>{assert.ok(String(url).startsWith(endpoint));return Response.json({data:[{id:'fixture-local'}]});};let app=await createCodeStory({port:0,dataDir:dir,fetcher,localRuntime:runtime});
 try{let status=await (await fetch(app.origin+'/api/status')).json();const post=(route,body,token=status.csrfToken)=>fetch(app.origin+route,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-CodeStory-Token':token},body:JSON.stringify(body)});
 assert.equal((await post('/api/local/start',{runner:'ollama',endpoint},'wrong')).status,403);assert.equal(starts,0);assert.equal((await post('/api/local/start',{runner:'ollama',endpoint})).status,200);assert.equal(starts,1);
 assert.equal((await post('/api/connections/local',{runner:'ollama',endpoint,model:'fixture-local',autoStart:true})).status,200);status=await (await fetch(app.origin+'/api/status')).json();assert.equal(status.localPreferences.model,'fixture-local');assert.equal(status.localPreferences.autoStart,true);assert.equal(status.localRuntime.managed,true);assert.equal((await post('/api/local/stop',{})).status,200);assert.equal(stops,1);assert.equal((await (await fetch(app.origin+'/api/status')).json()).connection,null);
 await post('/api/local/start',{runner:'ollama',endpoint});await app.close();assert.equal(stops,2);app=null;
 }finally{await app?.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('saved auto-start reconnects an existing runner without spawning or shutting down its server',async()=>{
 const {createCodeStory}=await import('../src/server/index.js');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codestory-auto-local-'));const preferences=new LocalPreferences(dir);await preferences.save({runner:'ollama',endpoint,model:'fixture-local',autoStart:true});let starts=0,kills=0;
 const runtime=new LocalRuntime({fetcher:async()=>Response.json({data:[{id:'fixture-local'}]}),spawner:()=>{starts++;throw Error('Must not spawn for an existing server');}});const app=await createCodeStory({port:0,dataDir:dir,localRuntime:runtime,fetcher:async()=>Response.json({data:[{id:'fixture-local'}]})});
 try{let status;for(let i=0;i<50;i++){status=await (await fetch(app.origin+'/api/status')).json();if(!status.busy)break;await new Promise(r=>setTimeout(r,5));}assert.equal(status.connection.kind,'local');assert.equal(status.connection.preferredModel,'fixture-local');assert.equal(status.localRuntime.managed,false);assert.equal(starts,0);}finally{await app.close();await fs.rm(dir,{recursive:true,force:true});}
});
