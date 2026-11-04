import {storyCall,storyWorkflow,storyAssignment} from './story-facts.js';
const display=s=>s.qualifiedName||s.name;
export const WORKSHOP_PREMISE='In a little workshop, a courier named Pip carries labeled packages between helpers. Each helper has a job card, and a choice on a card can send the work down a different path. This story is a metaphor for what the code could do, not a report of a real run. Open “What the code actually does” whenever you want the literal explanation.';

/** Conservative file-level limits; a model may also decline a misleading story. */
export function storyReadiness(model,{ai=false}={}){
  let reason='';
  if(!ai&&model.chunks.some(c=>c.kind==='text'))reason='This language does not have enough verified structure here to tell a reliable, simple story.';
  else if(model.chunks.some(c=>c.partial)||(model.analysisNotes||[]).some(n=>/parser recovered|parser.*recover|HTML is incomplete/i.test(n)))reason='Some of this file could not be fully understood by the parser. A story could hide important missing details.';
  else if(model.chunks.length>24||model.symbols.length>12)reason='This file has too many parts for one short, easy-to-follow story. A smaller section will make a clearer story.';
  else if((model.lineCount||0)>350)reason='This file is longer than the local story limit of 350 lines. Try a smaller section; comments and blank lines also count toward this limit.';
  else if(model.symbols.some(s=>(s.branches||[]).length>6||(s.dependencies||[]).length>8))reason='A helper in this file has too many choices or connections to simplify into a clear story yet.';
  return {available:!reason,reason};
}
const quoted=value=>`“${value}”`;
const short=value=>value.length<=140?value:value.slice(0,137)+'…';
function action(expression,symbol,model){
  const text=expression.trim();let m;
  if(model?.language==='Python'&&['sum','len'].every(name=>symbol?.calls.some(c=>c.name===name)&&symbol.calls.filter(c=>c.name===name).every(c=>c.bindingKind==='unbound'&&!c.targetId))&&(m=/^sum\((\w+)\)\s*\/\s*len\(\1\)$/.exec(text)))return `adds up the numbers in ${m[1]} and divides the total by how many there are`;
  if((m=/^(\w+)\s*([\/-])\s*(-?\d+(?:\.\d+)?)$/.exec(text)))return ({'+':`adds ${m[3]} to ${m[1]}`,'-':`takes ${m[3]} away from ${m[1]}`,'*':`multiplies ${m[1]} by ${m[3]}`,'/':`divides ${m[1]} by ${m[3]}`})[m[2]];
  if(/^(['"]).*\1$/.test(text))return `writes ${quoted(text.slice(1,-1))} on a reply card`;
  if(/^-?\d+(\.\d+)?$/.test(text))return `puts the number ${text} on a reply card`;
  if(/^\w+$/.test(text))return `puts ${text} on the return tray`;
  if(/^f['"]/.test(text))return 'fills the spaces in a message with the values named on the card';
  return `follows the calculation on the job card: ${quoted(short(text))}`;
}
function conditionText(text){
  if(/^not \w+$/.test(text))return text.replace(/^not (\w+)$/,'the check treats $1 as false');
  const operators={'>=':' is at least ','<=':' is at most ','===':' equals ','==':' equals ','!==':' does not equal ','!=':' does not equal ','>':' is greater than ','<':' is less than '};
  // Keep quoted data byte-for-byte; operators inside a string are not comparisons.
  return text.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\s*(?:===|!==|>=|<=|==|!=|>|<)\s*)/g,part=>operators[part.trim()]||part);
}
function deliveries(details,target){
  if(!details?.args.length)return 'This request has no argument packages to carry.';
  const packages=details.args.map(value=>quoted(short(value))).join(' and ');
  const plain=target.params.every(param=>/^[A-Za-z_]\w*$/.test(param))&&details.args.length===target.params.length;
  const renamed=plain?details.args.flatMap((value,index)=>value!==target.params[index]?[`At this workbench, the ${quoted(short(value))} package gets the local label ${target.params[index]}.`]:[]):[];
  return `Pip carries ${packages} to that workbench. ${renamed.length?renamed.join(' '):'The helper reads the package labels to find the values for this job.'}`;
}
function messageScene(expression){
  const match=/^[fF](['"])([^\n]*)\1$/.exec(expression.trim());if(!match)return '';
  const fields=[...match[2].matchAll(/(?<!\{)\{([A-Za-z_]\w*)(?::\.(\d)f)?\}(?!\})/g)];
  if(!fields.length||/[{}]/.test(match[2].replace(/(?<!\{)\{([A-Za-z_]\w*)(?::\.(\d)f)?\}(?!\})/g,'')))return '';
  const places=fields.map(field=>field[1]);
  const precision=fields.filter(field=>field[2]!==undefined).map(field=>`For ${field[1]}, the card asks for ${Number(field[2])===1?'one digit':field[2]+' digits'} after the decimal point.`);
  return `Pip lays the packages beside a message card with spaces to fill. The spaces are named ${places.join(' and ')}. The helper takes the value for each space from the package with that name. ${precision.join(' ')} The words and marks between those spaces stay in the message too. All these pieces become one text message. The helper hands that new message back to Pip, ready for the caller to use.`;
}
export function storyFunction(symbol,model,level='beginner'){
  const helpers=(symbol.dependencies||[]).map(id=>model.symbols.find(s=>s.id===id)).filter(Boolean).map(display);
  const decisions=(symbol.branches||[]).filter(b=>['if','switch','match'].includes(b.kind||b.type));
  const intro=`Pip stops beside ${display(symbol)}’s workbench, where a job card is waiting. ${symbol.params.length?`If a request arrives, Pip brings packages labeled ${symbol.params.join(', ')}. The labels help this helper keep the incoming values apart.`:'This helper’s card asks for no named input packages. Pip can bring the request without inventing a supply to go with it.'} The card gives this helper a particular part of the workshop’s work.`;
  const collaboration=helpers.length?`${display(symbol)} does not have to do every part alone. The job card names ${helpers.join(' and ')} as coworkers to ask for help. Pip can carry those requests between their workbenches. Each coworker keeps a separate job card, so a request for help leads to another part of the same story.`:'';
  let job='';
  if(decisions.length){const question=decisions[0].condition;job=`Pip reaches a fork in the instructions${question?`: ${quoted(short(conditionText(question)))}`:'. There is a choice to make'}. If the answer is yes, Pip follows the first path; otherwise, Pip follows the other path, or carries on if there is no other path.`;if(symbol.returns.length)job+=` The possible reply cards in this job are ${symbol.returns.map(r=>quoted(short(r))).join(' and ')}. The condition decides which reply is reached; the story does not say which path was taken.`;}
  else if(symbol.returns.length===1)job=`When this job reaches its return instruction, ${display(symbol)} ${action(symbol.returns[0],symbol,model)}. That reply goes back to whoever asked for the job.`;
  else if(symbol.returns.length>1)job='The card has more than one possible reply. Pip must follow the instructions to find which one is reached.';
  else job='Pip follows the steps on the card. There is no written return message here, so the story does not add one.';
  const simpleChoice=model.language==='Python'&&decisions.length===1&&model.code.slice(symbol.start,symbol.end).match(/^(?:async )?def [^\n]+\n([ \t]+)if ([^\n]+):\n\1[ \t]+return ([^\n]+)\n(?:\1else:\n\1[ \t]+return ([^\n]+)|\1return ([^\n]+))\s*$/);
  if(simpleChoice)job=`Pip comes to a fork in the job card. If ${conditionText(simpleChoice[2])}, ${display(symbol)} ${action(simpleChoice[3],symbol,model)}. Otherwise, the helper ${action(simpleChoice[4]||simpleChoice[5],symbol,model)}. Only the path chosen by that check supplies the reply. This story does not say which path was taken.`;
  let timing='The card waits here until someone calls on this helper.';
  if(model.language==='Python'&&symbol.generator){job='Pip gets a ticket for a job that waits. Asking for the next item lets the helper carry on until it hands over an item at a yield instruction. A return ends this series of items; it is not an ordinary reply package.';timing=symbol.async?'This ticket needs an async request for each next item. The helper can wait between items.':'Calling the helper makes the ticket; the work waits until someone asks for items.';}
  else if(model.language==='Python'&&symbol.async){job='Pip gets a ticket for work that waits, instead of a finished reply. The helper starts when someone awaits or schedules that work. If the job reaches a return, its reply belongs to that waiting work.';timing='Making the ticket alone does not finish the job.';}
  const workflow=storyWorkflow(symbol,model);
  if(workflow.length){
    const scenes=workflow.map((step,index)=>`${index?'The next request on the card goes':'The first request on the card goes'} to ${display(step.target)}, a coworker of ${display(symbol)}. ${deliveries(step,step.target)} ${step.binding?`If the coworker sends a reply, Pip puts it in a package labeled ${step.binding}. That label keeps the reply ready for the instructions that follow.`:`Whatever reply this coworker sends becomes ${display(symbol)}’s own reply. Pip can carry it back to whoever asked ${display(symbol)} for help.`}`);
    return [intro,...scenes,timing].join('\n\n');
  }
  const message=model.language==='Python'&&symbol.returns.length===1&&!symbol.async&&!symbol.generator?messageScene(symbol.returns[0]):'';if(message)job=message;
  const close=symbol.returns.length&&!symbol.generator&&!symbol.async&&!message?'Pip takes the reply from this workbench back to whoever asked for the job. That caller can use the reply in its own part of the work.':'';
  return [intro,[collaboration,job].filter(Boolean).join(' '),[close,timing].filter(Boolean).join(' ')].filter(Boolean).join('\n\n');
}
export function describeStoryChunk(chunk,model,level,literal){
  const members=chunk.symbolIds.map(id=>model.symbols.find(s=>s.id===id)).filter(Boolean),first=members[0];
  // Only use resolved chapter calls, rather than making friends from similar names.
  const helpers=[...new Set(chunk.calls.filter(c=>c.targetId&&c.resolved!==false).map(c=>c.targetId))].map(id=>model.symbols.find(s=>s.id===id)).filter(Boolean).map(display);
  let title,body;
  if(chunk.kind==='documentation'){title='A note on the workshop door';body='Pip stops at a note pinned to the door. It tells readers about this file. Reading the note does not start any of the workshop’s jobs.';}
  else if(chunk.kind==='import'){title='Supplies from outside';body=`Pip finds a list of supplies that come from outside the workshop${chunk.from?': '+chunk.from:''}. The team can use them in its jobs. Their makers’ instructions are elsewhere, so we cannot follow those jobs in this file.`;}
  else if(chunk.kind==='markup'){title='A place for everything';body=`Pip opens the workshop’s room plan. This part marks out ${chunk.tag?'a '+chunk.tag+' space':'a space on the page'}${chunk.parentChunkId?' inside a larger space':''}. Smaller spaces can fit inside it, like boxes inside a bigger box. This plan arranges a page; it does not send the helpers off to work.`;}
  else if(chunk.kind==='style'){title='The decorating card';body='Pip finds a decorating card beside the room plan. It gives the page its appearance. The card helps decide how things look; it is not a request for one of the helpers to do a calculation.';}
  else if(chunk.kind==='script'){title='An extra job card';body='A separate job card is tucked into the page. It holds script instructions, or points to a script stored elsewhere. Pip leaves that card visible in the source; this local story does not guess what its hidden helpers do or when they start.';}
  else if(chunk.kind==='query'){title='At the records desk';body=`Pip visits the workshop’s records desk with a ${chunk.operation||'database'} request${chunk.tables?.length?' for '+chunk.tables.join(', '):''}. The request says which records to read or change. The desk must use the real records and the rules on that request. Our story does not make up what is in the drawers or which answers will come back.`;}
  else if(chunk.kind==='class'){title='Plans for a team';body=`Pip finds the plan for ${chunk.names.join(', ')||'a team'}.${members.length?' It has places for '+members.map(display).join(', ')+'.':''} A team plan says what its members can do. Drawing the plan does not mean any of those jobs has started.`;}
  else if(first){title='At '+display(first)+'’s workbench';body=storyFunction(first,model,level);}
  else if(chunk.kind==='data'){
    title='A package with a name';const assignment=storyAssignment(chunk,model);
    const contents=assignment&&['String','Number','ArrayExpression','Boolean','None'].includes(assignment.expression)?`The label says ${assignment.name}, and the source puts ${quoted(short(assignment.expression==='String'&&/^(['"]).*\1$/.test(assignment.value)?assignment.value.slice(1,-1):assignment.value))} inside. `:'';
    body=`Pip pauses at the workshop’s supply shelf. A package here has the name ${chunk.names.length?chunk.names.join(', '):'shown in the source'}. ${contents}That name lets another instruction ask for this value again. Pip can keep the label in mind when the same name appears later in the story. The label and the value have different jobs: one identifies the package, and the other is what it holds. Setting out this supply does not by itself ask a helper to do a job.`;
  }
  else if(chunk.kind==='type'){title='The package guide';body='Pip opens a guide showing what a package should look like. The labels help the team recognize the kinds of values they expect. This page describes the guide; it does not invent a new delivery.';}
  else if(chunk.kind==='directive'){title='A rule on the wall';body='Pip checks a rule pinned above the workbench. This instruction tells the language how to treat part of the file. The rest of the workshop must follow that rule.';}
  else if(helpers.length){
    title='Pip visits a friend';const calls=chunk.calls.filter(c=>c.targetId&&c.resolved!==false),details=calls.map(c=>({call:c,details:storyCall(c,model)}));
    const requests=details.map(({call,details})=>{const friend=model.symbols.find(s=>s.id===call.targetId);return `Pip takes the request to his friend ${display(friend)}. ${details?deliveries(details,friend):'The source beside the story shows the details that travel with this request.'} This friend has a job card of their own, ready to explain their part.`;});
    const assignment=storyAssignment(chunk,model),direct=details.length===1&&details[0].details&&assignment?.from===details[0].details.from&&assignment?.to===details[0].details.to;
    body=[`A request is waiting for Pip at the workshop counter. He looks for the friend whose name is on it. ${requests.join(' ')}`,`${direct?`If that call sends back a reply, Pip labels it ${assignment.name}. The reply can now be referred to by that name in the instructions that follow.`:'A reply, if the request produces one, follows the instructions in this section.'} The friend’s colored name is the sign for the next workbench in the story. ${chunk.branches?.length?'A choice guards this request, so Pip must take an allowed path before making the visit.':'Pip can follow that sign to see how the friend’s job fits into this request.'}`].join('\n\n');
  }
  else if(chunk.calls.some(c=>c.name==='print'||c.name==='console.log')){title='A message on the noticeboard';const print=chunk.calls.find(c=>c.name==='print'||c.name==='console.log'),details=storyCall(print,model);body=`Pip arrives at the workshop’s noticeboard with a message to show. ${details?.args.length?`The display request names ${details.args.map(quoted).join(' and ')} as the message to bring.`:'The source beside this scene shows the message on the display request.'} This is where the workshop asks for something to be made visible. A reader can see the displayed message without being another helper in the job. Pip does not carry this display away as a returned reply to a caller. Showing a message and returning a package are two different kinds of work. The story describes the display instruction; the original code determines the message it would show.`;}

  else{title='Another card in the workshop';body='Pip finds another instruction card. It belongs to this file, but there is no verified request here for a named helper in the workshop. The literal explanation below tells you what this section shows.';}
  return {title,body,concept:'Workshop scene',term:'',literal};
}
