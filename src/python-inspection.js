import {parser} from '@lezer/python';
export const INSPECTION_VERSION='python-inspection-v1';
const children=node=>{const result=[];for(let n=node?.firstChild;n;n=n.nextSibling)result.push(n);return result;};
const unique=values=>[...new Set(values)];

/** Source facts only: never imports, evaluates or executes the user's file. */
export function inspectPython(model){
  if(model.language!=='Python')return null;
  const {code}=model,root=parser.parse(code).topNode,starts=[0];
  for(let i=0;i<code.length;i++)if(code[i]==='\n')starts.push(i+1);
  const lineAt=pos=>{let low=0,high=starts.length;while(low+1<high){const mid=(low+high)>>1;if(starts[mid]<=pos)low=mid;else high=mid;}return low+1;};
  const text=node=>code.slice(node.from,node.to);
  const symbols=new Map(model.symbols.map(s=>[s.start,s]));
  const calls=new Map(model.chunks.flatMap(c=>c.calls).map(call=>[call.start,call]));
  const facts={version:INSPECTION_VERSION,language:'Python',scope:'single-file',executed:false,assignments:[],returns:[],decisions:[],loops:[],imports:[],handoffs:[],unresolvedCalls:[]};
  const location=(node,context)=>({start:node.from,end:node.to,startLine:lineAt(node.from),endLine:lineAt(Math.max(node.from,node.to-1)),chunkId:model.chunks.find(c=>c.start<=node.from&&c.end>=node.to)?.id||null,scopeId:context.scopeId,scopeKind:context.scopeKind,...(context.definitionHeader?{definitionHeader:true}:{}),controlContext:context.guards.map(g=>({kind:g.kind,line:g.line}))});
  const add=(collection,node,context,properties)=>{const fact={id:'pi-'+collection+'-'+facts[collection].length,...location(node,context),...properties};facts[collection].push(fact);return fact;};
  function names(node){const result=[];const visit=n=>{if(['FunctionDefinition','ClassDefinition','LambdaExpression'].includes(n.name))return;if(n.name==='VariableName')result.push(text(n));for(const child of children(n))visit(child);};visit(node);return unique(result);}
  function pathSummary(body){return children(body).filter(n=>![':', 'Comment'].includes(n.name)).slice(0,4).map(n=>({kind:n.name.replace(/Statement$/,''),source:text(n).split('\n')[0],startLine:lineAt(n.from),endLine:lineAt(Math.max(n.from,n.to-1))}));}
  function argumentFacts(list,target,callee){
    if(!list)return [];
    const parts=children(list),segments=[];let segment=[];
    for(const part of parts){if(part.name==='Comment')continue;if(['(',')',','].includes(part.name)){if(segment.length){segments.push(segment);segment=[];}}else segment.push(part);}
    if(segment.length)segments.push(segment);
    const parameters=(target?.params||[]).map(p=>p.match(/^\s*([\p{L}_][\p{L}\p{N}_]*)\s*(?::|=|$)/u)?.[1]||null);
    const simpleSignature=!!target&&parameters.every(Boolean)&&!target.params.some(p=>/^[\s]*[*/]/.test(p));
    const simplePositionals=simpleSignature&&callee?.name==='VariableName';
    let positional=0,unpacked=false;
    const args=segments.map(parts=>{
      const expression=code.slice(parts[0].from,parts.at(-1).to),keyword=parts[0].name==='VariableName'&&parts[1]?.name==='AssignOp';
      const spread=parts.some(p=>['*','**'].includes(p.name)||p.name==='UnpackExpression')||/^\*/.test(expression);
      let parameter=null;
      if(keyword&&simpleSignature&&parameters.includes(text(parts[0])))parameter=text(parts[0]);
      else if(!keyword&&!unpacked&&!spread&&simplePositionals)parameter=parameters[positional]||null;
      if(spread)unpacked=true;
      if(!keyword)positional++;
      return {expression,parameter,readNames:unique(parts.slice(keyword?2:0).flatMap(names)),...(keyword?{keyword:true}:{}),...(spread?{unpacked:true}:{})};
    });
    const named=args.map(a=>a.parameter).filter(Boolean);
    const invalidSimple=!!simplePositionals&&!args.some(a=>a.unpacked)&&(new Set(named).size!==named.length||args.some(a=>!a.parameter));
    if(invalidSimple)for(const arg of args){arg.parameter=null;arg.bindingIssue='The written arguments do not match the simple declared signature; call success is not established.';}
    return args;
  }
  function visit(node,context){
    const parts=children(node);
    if(node.name==='FunctionDefinition'){
      const symbol=symbols.get(node.from);
      for(const part of parts)visit(part,part.name==='Body'&&symbol?{scopeId:symbol.id,scopeKind:'function',guards:[]}:part.name==='Body'?context:{...context,definitionHeader:true});
      return;
    }
    if(node.name==='ClassDefinition'){
      for(const part of parts)visit(part,part.name==='Body'?{...context,scopeId:'class:'+node.from,scopeKind:'class'}:context);
      return;
    }
    if(node.name==='LambdaExpression')return;
    if(node.name==='AssignStatement'||node.name==='UpdateStatement'){
      const operators=parts.map((p,i)=>['AssignOp','UpdateOp'].includes(p.name)?i:-1).filter(i=>i>=0),last=operators.at(-1);
      if(last!==undefined){
        const expression=parts[last+1],left=parts.filter((p,i)=>i<last&&!['AssignOp','TypeDef'].includes(p.name));
        add('assignments',node,context,{targets:left.map(text),expression:expression?code.slice(expression.from,node.to).trim():'',operator:text(parts[last]),readNames:expression?names(expression):[],writeKind:left.some(n=>['MemberExpression','SubscriptExpression'].includes(n.name))?'attribute-or-index':'binding'});
      }
    }
    if(node.name==='ReturnStatement'||node.name==='YieldStatement'||node.name==='YieldExpression'){
      const expression=parts.find(p=>!['return','yield','from'].includes(p.name));
      add('returns',node,context,{kind:node.name.startsWith('Yield')?'yield':'return',...(parts.some(p=>p.name==='from')?{delegated:true}:{}),readNames:expression?names(expression):[],expression:expression?code.slice(expression.from,node.to).trim():null});
    }
    if(node.name==='ImportStatement'||node.name==='ImportFromStatement'){
      const keyword=parts.findIndex(p=>p.name==='import'),from=parts.findIndex(p=>p.name==='from'),bindings=[];let group=[];
      const bind=()=>{if(!group.length)return;const as=group.findIndex(p=>p.name==='as');const original=code.slice(group[0].from,(as<0?group.at(-1):group[as-1]).to).trim();const local=as>=0?text(group[as+1]):from>=0?original:original.split('.')[0];bindings.push({imported:original,local});group=[];};
      for(const part of parts.slice(keyword+1)){if([',',')'].includes(part.name))bind();else if(!['(', 'Comment'].includes(part.name))group.push(part);}bind();
      add('imports',node,context,{statement:text(node).trim(),module:from>=0?code.slice(parts[from].to,parts[keyword].from).trim():null,bindings});
    }
    if(node.name==='IfStatement'){
      const paths=[];let label=null,keyword=null;
      for(const part of parts){if(['if','elif','else'].includes(part.name)){label=part.name;keyword=part;}
        if(part.name==='Body'){paths.push({kind:label,condition:label==='else'?null:code.slice(keyword.to,part.from).trim(),startLine:lineAt(part.from),endLine:lineAt(Math.max(part.from,part.to-1)),statements:pathSummary(part)});}}
      const decision=add('decisions',node,context,{kind:'if',condition:paths[0]?.condition||'',readNames:unique(parts.filter(p=>!['Body','if','else','elif'].includes(p.name)).flatMap(names)),paths,hasElse:paths.some(p=>p.kind==='else')});
      for(const part of parts)visit(part,part.name==='Body'?{...context,guards:[...context.guards,{kind:'if',line:decision.startLine}]}:context);
      return;
    }
    if(node.name==='MatchStatement'){
      const body=parts.find(p=>p.name==='MatchBody');
      const paths=children(body).filter(p=>p.name==='MatchClause').map(clause=>{const p=children(clause),suite=p.find(c=>c.name==='Body');return {kind:'case',condition:code.slice(p[0].to,suite?.from??clause.to).trim(),startLine:lineAt(clause.from),endLine:lineAt(Math.max(clause.from,clause.to-1)),statements:suite?pathSummary(suite):[]};});
      add('decisions',node,context,{kind:'match',condition:code.slice(parts[0].to,body?.from??node.to).trim(),readNames:unique(parts.filter(p=>p!==body).flatMap(names)),paths,hasElse:false});
      for(const part of parts)visit(part,{...context,guards:[...context.guards,{kind:'match',line:lineAt(node.from)}]});return;
    }
    if(['ForStatement','WhileStatement'].includes(node.name)){
      const body=parts.find(p=>p.name==='Body'),inIndex=parts.findIndex(p=>p.name==='in'),elseIndex=parts.findIndex(p=>p.name==='else');
      const loop=add('loops',node,context,{kind:node.name==='ForStatement'?'for':'while',header:code.slice(node.from,body?.from??node.to).trim(),...(inIndex>=0?{target:code.slice((parts.find(p=>p.name==='for')||parts[0]).to,parts[inIndex].from).trim(),iterable:code.slice(parts[inIndex].to,body.from).trim()}:{condition:code.slice(parts[0].to,body?.from??node.to).trim()}),readNames:inIndex>=0?unique(parts.slice(inIndex+1,parts.indexOf(body)).flatMap(names)):unique(parts.slice(1,parts.indexOf(body)).flatMap(names)),hasElse:elseIndex>=0,body:body?pathSummary(body):[]});
      for(const part of parts)visit(part,part.name==='Body'?{...context,guards:[...context.guards,{kind:loop.kind,line:loop.startLine}]}:context);return;
    }
    if(node.name==='Decorator'){
      const expression=parts.find(p=>p.name!=='At'),call=expression&&calls.get(expression.from);
      if(call?.kind==='decorator'&&['VariableName','MemberExpression'].includes(expression.name)){
        const target=model.symbols.find(s=>s.id===call.targetId),definition=children(node.parent).find(n=>n.name==='FunctionDefinition'||n.name==='ClassDefinition');
        add(target?'handoffs':'unresolvedCalls',node,context,{name:call.name,arguments:[],resultName:null,returnedDirectly:false,timing:'definition-time',definitionTime:true,definitionName:definition?text(children(definition).find(n=>n.name==='VariableName')):null,...(target?{toId:target.id}:{})});
      }
      for(const part of parts)visit(part,{...context,definitionHeader:true});return;
    }
    if(node.name==='CallExpression'){
      const callee=parts[0],call=calls.get(callee?.from),target=model.symbols.find(s=>s.id===call?.targetId);
      const args=argumentFacts(parts.find(p=>p.name==='ArgList'),target,callee);
      // Match offsets from the existing scope-aware resolver; never resolve by name here.
      const awaited=node.parent?.name==='AwaitExpression',container=awaited?node.parent:node;
      const parent=container.parent,parentParts=children(parent),assign=parent?.name==='AssignStatement'&&parentParts.length===3&&parentParts[0].name==='VariableName'&&parentParts[2].from===container.from&&parentParts[2].to===container.to&&text(parentParts[1])==='='?text(parentParts[0]):null;
      const properties={name:call?.name||text(callee),bindingKind:call?.bindingKind||'unknown',arguments:args,resultName:assign,passedToCall:parent?.name==='ArgList'&&parent.parent?.name==='CallExpression'?calls.get(parent.parent.firstChild?.from)?.name||null:null,awaited,returnedDirectly:parent?.name==='ReturnStatement',timing:target?.generator?(target.async?'deferred-async-generator':'deferred-generator'):target?.async?'deferred-async':'not-inferred'};
      if(target)add('handoffs',node,context,{...properties,toId:target.id});
      else add('unresolvedCalls',node,context,properties);
    }
    // Comprehensions, exception handling and short-circuit expressions can gate calls.
    const guarded=/ComprehensionExpression$/.test(node.name)||(['TryStatement','ConditionalExpression','BooleanExpression'].includes(node.name)||(node.name==='BinaryExpression'&&parts.some(p=>['and','or'].includes(p.name))));
    for(const part of parts)visit(part,guarded?{...context,guards:[...context.guards,{kind:node.name,line:lineAt(node.from)}]}:context);
  }
  visit(root,{scopeId:'module',scopeKind:'module',guards:[]});
  facts.summary={functions:model.symbols.length,classes:0,imports:facts.imports.length,assignments:facts.assignments.length,decisions:facts.decisions.length,loops:facts.loops.length,handoffs:facts.handoffs.length,unresolvedCalls:facts.unresolvedCalls.length};
  const countClasses=node=>{if(node.name==='ClassDefinition')facts.summary.classes++;for(const child of children(node))countClasses(child);};countClasses(root);
  facts.notes=['This is a static inspection of one file. It does not run code, install imports, or verify runtime values or correctness.','Argument labels follow recognizable local signatures. Unpacking, dynamic calls, decorators, aliases and external implementations may need more context.','Scope labels show where statements are written. Name references do not prove which earlier value reaches a use; globals, nonlocals and comprehension bindings are not traced here.','This first pass does not expand every binding form: comprehension targets, with-as bindings, exception names and match captures may require AI context.','Control context lists enclosing source constructs. An earlier return or exception can still prevent a later statement from running.'];
  return facts;
}

/** Bounded facts supplement the original source; they never replace it. */
export function inspectionContext(inspection){
  if(!inspection)return undefined;
  const limits={assignments:30,returns:30,decisions:15,loops:15,imports:20,handoffs:30,unresolvedCalls:20};
  let textTruncated=false,nestedListTruncated=false;
  const excerpt=value=>{if(typeof value==='string'&&value.length>240){textTruncated=true;return value.slice(0,237)+'…';}return value;};
  const compact=value=>{
    if(Array.isArray(value)){if(value.length>12)nestedListTruncated=true;return value.slice(0,12).map(compact);}
    return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','readNames','id'].includes(key)).map(([key,v])=>[key,compact(v)])):excerpt(value);
  };
  const sections=Object.fromEntries(Object.entries(limits).map(([key,limit])=>[key,inspection[key].slice(0,limit).map(compact)]));
  return {version:inspection.version,executed:false,scope:inspection.scope,summary:inspection.summary,...sections,omittedCounts:Object.fromEntries(Object.entries(limits).map(([key,limit])=>[key,Math.max(0,inspection[key].length-limit)])),previewLimits:{textCharacters:240,nestedItems:12,textTruncated,nestedListTruncated},notes:[...inspection.notes,'Fact previews can be shortened; use the supplied original source and line references for complete expressions and lists.']};
}
