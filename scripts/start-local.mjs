import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.CODESTORY_PORT||4173);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Choose a valid CODESTORY_PORT between 1024 and 65535.');
const origin='http://127.0.0.1:'+port;
async function healthy(){try{const response=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(800)});return response.ok&&(await response.json()).app==='CodeStory';}catch{return false;}}
async function openBrowser(){const command=process.platform==='darwin'?'open':process.platform==='win32'?'cmd':'xdg-open';const args=process.platform==='win32'?['/c','start','',origin]:[origin];const child=spawn(command,args,{stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();}
async function main(){
  if(!await healthy()){
    const directory=path.join(root,'.local');await fs.mkdir(directory,{recursive:true,mode:0o700});
    const stat=await fs.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('CodeStory needs a real .local directory.');
    await fs.chmod(directory,0o700);
    const log=await fs.open(path.join(directory,'server.log'),'a',0o600);await log.chmod(0o600);
    let child;try{child=spawn(process.execPath,[path.join(root,'runtime','server.mjs')],{cwd:root,detached:true,stdio:['ignore',log.fd,log.fd],env:process.env});child.unref();}finally{await log.close();}
    let spawnError;child.once('error',error=>{spawnError=error;});
    let ready=false;for(let i=0;i<25;i++){if(spawnError)throw spawnError;if(await healthy()){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,200));}
    if(!ready)throw new Error('CodeStory could not start. Check .local/server.log for the startup error.');
  }
  console.log('CodeStory is running at '+origin+'\nYou can close this window. Use Stop CodeStory.command when you want to stop the app.');
  if(process.argv.includes('--open'))await openBrowser();
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
