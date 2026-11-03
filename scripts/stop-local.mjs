import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function main(){
  let raw;try{raw=await fs.readFile(path.join(root,'.local','runtime.lock'),'utf8');}catch(error){if(error.code==='ENOENT'){console.log('CodeStory is already stopped.');return;}throw error;}
  const pid=Number(raw);if(!Number.isInteger(pid)||pid<1)throw new Error('CodeStory could not identify its local server.');
  try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){console.log('CodeStory is already stopped.');return;}throw new Error('This session cannot control the background server. Use Stop CodeStory.app in Finder or npm stop in your own Terminal.');}
  let command;try{({stdout:command}=await promisify(execFile)('/bin/ps',['-p',String(pid),'-o','command=']));}catch{throw new Error('Could not verify the recorded CodeStory process.');}
  if(!command.includes(path.join(root,'runtime','server.mjs'))&&!/\bnode\s+runtime\/server\.mjs(?:\s|$)/.test(command.trim()))throw new Error('The recorded process is not a CodeStory server; it was left untouched.');
  process.kill(pid,'SIGTERM');
  console.log('CodeStory stopped.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
