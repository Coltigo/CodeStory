import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppError} from './auth.js';
import {localEndpoint} from './local.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class LocalPreferences {
  constructor(directory){this.file=path.join(directory,'local-preferences.json');this.value={runner:'ollama',endpoint:'http://127.0.0.1:11434/v1',model:'',autoStart:false};this.pending=Promise.resolve();}
  normalize(input){const runner=input.runner;if(!['ollama','lmstudio'].includes(runner))throw new AppError('Choose Ollama or LM Studio.');const endpoint=localEndpoint(input.endpoint),model=input.model||'';if(typeof model!=='string'||model.length>200||/[\x00-\x1f\x7f]/.test(model)||/cloud/i.test(model))throw new AppError('Choose a downloaded local model.');return {runner,endpoint,model,autoStart:runner==='ollama'&&input.autoStart===true};}
  async init(){try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid preference file');this.value=this.normalize(JSON.parse(await fs.readFile(this.file,'utf8')));}catch(error){if(error.code!=='ENOENT')this.notice='Saved local settings could not be read. Choose your runner and save them again.';}}
  save(input){const value=this.normalize(input);const write=async()=>{try{const stat=await fs.lstat(this.file);if(stat.isSymbolicLink()||!stat.isFile())throw new AppError('Local settings need a regular preference file.');}catch(error){if(error.code!=='ENOENT')throw error;}const temp=this.file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});await fs.rename(temp,this.file);this.value=value;return value;};const task=this.pending.then(write,write);this.pending=task;return task;}
}
/** Owns a child handle, never discovers or kills a process by name or saved PID. */
export class LocalRuntime {
  constructor({fetcher=fetch,spawner=spawn,findBinary,delay=wait,now=Date.now}={}){Object.assign(this,{fetcher,spawner,delay,now});this.findBinary=findBinary||async function(){for(const file of ['/opt/homebrew/bin/ollama','/usr/local/bin/ollama','/Applications/Ollama.app/Contents/Resources/ollama']){try{await fs.access(file,fs.constants.X_OK);return file;}catch{}}return 'ollama';};this.child=null;this.endpoint=null;this.starting=false;this.message='';this.closed=false;}
  status(){return {managed:!!this.child,endpoint:this.endpoint,starting:this.starting,message:this.message};}
  async reachable(endpoint){try{const r=await this.fetcher(localEndpoint(endpoint)+'/models',{signal:AbortSignal.timeout(1000),redirect:'error'});await r.body?.cancel();return true;}catch{return false;}}
  async start({runner='ollama',endpoint}={}){
    endpoint=localEndpoint(endpoint);if(this.closed)throw new AppError('CodeStory is shutting down.');if(runner!=='ollama')throw new AppError('Automatic startup currently uses Ollama. Start LM Studio from its Developer tab.',400,'runner_manual_start');
    if(this.starting)throw new AppError('The local server is already starting.',409,'runner_busy');if(this.child&&this.endpoint!==endpoint)throw new AppError('Shut down the CodeStory-managed server before changing its address.',409,'runner_busy');
    if(await this.reachable(endpoint)){this.message=this.child?'Ollama is ready.':'Using your existing server; CodeStory will leave it running.';return {...this.status(),reused:!this.child};}
    if(this.child)throw new AppError('The managed server is not responding. Shut it down before starting it again.',409,'runner_busy');
    this.starting=true;this.message='Starting Ollama…';let failure=null;
    try{const binary=await this.findBinary();if(this.closed)throw new AppError('CodeStory is shutting down.');const url=new URL(endpoint),child=this.spawner(binary,['serve'],{shell:false,stdio:'ignore',windowsHide:true,env:{...Object.fromEntries(Object.entries(process.env).filter(([name])=>!/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name))),OLLAMA_HOST:url.host,OLLAMA_NO_CLOUD:'1',OLLAMA_KEEP_ALIVE:'10m'}});this.child=child;this.endpoint=endpoint;
      child.once('error',()=>{failure=new AppError('Ollama could not start. Install Ollama and make its command available, then try Start server again.',400,'runner_not_installed');});child.once('exit',()=>{if(this.child===child){this.child=null;this.endpoint=null;}});
      const deadline=this.now()+25000;while(this.now()<deadline){if(this.closed)throw new AppError('CodeStory is shutting down.');if(failure)throw failure;if(child.exitCode!==null||child.signalCode)throw new AppError('Ollama exited before becoming ready. Check that its port is available and start it manually to view its error.',502,'runner_exited');if(await this.reachable(endpoint)){this.message='Ollama started by CodeStory. It will stop when CodeStory shuts down.';this.starting=false;return this.status();}await this.delay(250);}
      throw new AppError('Ollama did not become ready in time. Check its installation and port, then try again.',502,'runner_timeout');
    }catch(error){await this.stop();this.message=error.message;throw error;}finally{this.starting=false;}
  }
  async close(){this.closed=true;return this.stop();}
  async stop(){const child=this.child;if(!child){this.message='No server started by CodeStory is running. Existing servers were left untouched.';return {...this.status(),stopped:false};}let exited=false;const exit=new Promise(resolve=>{child.once('exit',()=>{exited=true;resolve();});});if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exit,this.delay(2500)]);if(!exited&&child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}this.child=null;this.endpoint=null;this.message='The server started by CodeStory has been shut down.';return {...this.status(),stopped:true};}
}
