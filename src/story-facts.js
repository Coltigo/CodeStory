import {parser} from '@lezer/python';
// Scene details are syntax facts only. A parser-resolved edge must still approve
// each character relationship; a name or apparent argument never creates an edge.
const cache=new WeakMap();
const children=node=>{const result=[];for(let n=node?.firstChild;n;n=n.nextSibling)result.push(n);return result;};
function pythonNodes(model){
  if(model.language!=='Python')return null;
  if(cache.has(model))return cache.get(model);
  const nodes=new Map();const walk=node=>{if(['CallExpression','FunctionDefinition','AssignStatement'].includes(node.name))nodes.set(node.name+':'+node.from,node);for(const child of children(node))walk(child);};
  walk(parser.parse(model.code).topNode);cache.set(model,nodes);return nodes;
}
export function storyCall(call,model){
  const nodes=pythonNodes(model),node=nodes?.get('CallExpression:'+call.start);if(!node)return null;
  const parts=children(node),callee=parts[0],args=parts.find(n=>n.name==='ArgList');
  if(callee?.name!=='VariableName'||!args)return null;
  const values=children(args).filter(n=>!['(',')',','].includes(n.name));
  if(!values.every(n=>['VariableName','String','Number','Boolean','None','ArrayExpression','TupleExpression'].includes(n.name)))return null;
  // Keyword/star arguments require additional binding context; leave them literal.
  if(children(args).some(n=>['AssignOp','*','**'].includes(n.name)))return null;
  return {name:model.code.slice(callee.from,callee.to),args:values.map(n=>model.code.slice(n.from,n.to)),from:node.from,to:node.to};
}
export function storyWorkflow(symbol,model){
  const node=pythonNodes(model)?.get('FunctionDefinition:'+symbol.start),body=node?.getChild('Body');if(!body||symbol.async||symbol.generator)return [];
  const steps=[];
  for(const statement of children(body).filter(n=>n.name!==':')){
    const parts=children(statement);let expression,binding=null,returns=false;
    if(statement.name==='AssignStatement'&&parts.length===3&&parts[0].name==='VariableName'&&model.code.slice(parts[1].from,parts[1].to)==='='){binding=model.code.slice(parts[0].from,parts[0].to);expression=parts[2];}
    else if(statement.name==='ReturnStatement'&&parts.length===2){expression=parts[1];returns=true;}
    else if(statement.name==='ExpressionStatement'&&parts.length===1&&parts[0].name==='String')continue;
    else return [];
    if(expression.name!=='CallExpression')return [];
    const call=symbol.calls.find(c=>c.start===expression.from&&c.targetId&&symbol.dependencies.includes(c.targetId));
    const target=model.symbols.find(s=>s.id===call?.targetId),details=call&&storyCall(call,model);
    if(!target||!details||target.async||target.generator)return [];
    steps.push({...details,target,binding,returns});
  }
  // Only a flat sequence ending in one return gets a chronological handoff story.
  return steps.length&&steps.at(-1).returns&&steps.slice(0,-1).every(s=>!s.returns)?steps:[];
}
export function storyAssignment(chunk,model){
  const parts=children(pythonNodes(model)?.get('AssignStatement:'+chunk.start));
  if(parts.length!==3||parts[0].name!=='VariableName'||model.code.slice(parts[1].from,parts[1].to)!=='=')return null;
  return {name:model.code.slice(parts[0].from,parts[0].to),value:model.code.slice(parts[2].from,parts[2].to),expression:parts[2].name,from:parts[2].from,to:parts[2].to};
}
