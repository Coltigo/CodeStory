/** Evidence for a source call; no evaluation or runtime argument binding. */
export function projectHandoff(project,edge){
  const file=project.files.find(f=>f.path===edge.from.path),targetFile=project.files.find(f=>f.path===edge.to.path),target=targetFile?.model?.symbols.find(s=>s.id===edge.to.localId);
  const facts=[...(file?.model?.inspection?.handoffs||[]),...(file?.model?.inspection?.unresolvedCalls||[])];
  const matches=facts.filter(f=>edge.callStart!==undefined?f.start===edge.callStart:f.startLine===edge.line&&f.name===edge.callName);
  const fact=matches.length===1?matches[0]:null;
  const args=(fact?.arguments||[]).map(a=>({expression:a.expression,keyword:!!a.keyword,unpacked:!!a.unpacked,parameter:null}));
  const params=(target?.params||[]).map(p=>p.match(/^\s*([\p{L}_][\p{L}\p{N}_]*)\s*(?::|=|$)/u)?.[1]||null);
  const ordinary=target&&(!target.qualifiedName||target.qualifiedName===target.name)&&params.every(Boolean)&&!target.params.some(p=>/^\s*[*/]/.test(p));
  if(ordinary&&args.every(a=>!a.unpacked)){
    let position=0;for(const a of args){const keyword=a.keyword?a.expression.match(/^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=/u)?.[1]:null;a.parameter=keyword?(params.includes(keyword)?keyword:null):params[position++]||null;}
    const names=args.map(a=>a.parameter);if(names.some(n=>!n)||new Set(names).size!==names.length)for(const a of args)a.parameter=null;
  }
  return {from:edge.from,to:edge.to,line:edge.line,endLine:fact?.endLine||edge.line,callName:edge.callName,hasArgumentEvidence:!!fact,conditional:edge.conditional,arguments:args,resultName:fact?.resultName||null,passedToCall:fact?.passedToCall||null,returnedDirectly:!!fact?.returnedDirectly,awaited:!!fact?.awaited,guards:fact?.controlContext||[],definitionTime:!!edge.definitionTime,timing:target?.generator?(target.async?'async-generator':'generator'):target?.async?'async':'ordinary',targetName:target?.qualifiedName||target?.name||edge.callName,returnExpressions:target?.returns||[],source:fact?file.code.slice(fact.start,fact.end):null};
}

export function projectHandoffContext(project,edge){
 const value=projectHandoff(project,edge),short=text=>text.length>240?text.slice(0,237)+'…':text;
 return {...value,source:value.source?short(value.source):null,arguments:value.arguments.slice(0,12).map(a=>({...a,expression:short(a.expression)})),returnExpressions:value.returnExpressions.slice(0,8).map(short),guards:value.guards.slice(0,8),previewLimits:{characters:240,arguments:12,returns:8,completeSourceSuppliedSeparately:true}};
}
