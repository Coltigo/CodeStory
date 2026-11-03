import {functionTiming,functionReturns} from './semantics.js';
import { parse } from '@babel/parser';
import { analyzePython } from './python.js';
import {inspectPython} from './python-inspection.js';
import {analyzeLanguage,describeLanguageChunk} from './languages.js';
import {languageSupport,assertTextSource,analyzeText} from './support.js';

export const MAX_CHARS = 80000;
export const palette = ['violet', 'teal', 'amber', 'rose', 'blue', 'green'];
export const humanize = name => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_$]+/g, ' ').replace(/^./, c => c.toUpperCase());
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const unwrap = node => node.declaration || node;
export function walk(node, visit) {
  if (!node || typeof node !== 'object' || !node.type) return;
  if (visit(node) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(v => walk(v, visit));
    else if (value?.type) walk(value, visit);
  }
}
function calleeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type) && !node.computed) {
    return [calleeName(node.object), calleeName(node.property)].filter(Boolean).join('.');
  }
  return '';
}
function bindings(node, target) {
  if (!node) return;
  if (node.type === 'Identifier') target.add(node.name);
  else if (node.type === 'ObjectPattern') node.properties.forEach(p => bindings(p.value || p.argument, target));
  else if (node.type === 'ArrayPattern') node.elements.forEach(p => bindings(p, target));
  else if (node.type === 'AssignmentPattern') bindings(node.left, target);
  else if (node.type === 'RestElement') bindings(node.argument, target);
}
function functionDefinitions(node) {
  if (node.type === 'FunctionDeclaration' && node.body) return [{name: node.id?.name || 'default', node}];
  if (node.type === 'VariableDeclaration') return node.declarations.filter(d => functionTypes.has(d.init?.type)).map(d => ({name: d.id.name || 'anonymous', node: d.init}));
  return [];
}
function functionFacts(node, code) {
  const calls = [], returns = [], branches=[], locals = new Set();
  (node.params || []).forEach(p => bindings(p, locals));
  walk(node.body || node, n => {
    if (n !== node && functionTypes.has(n.type)) { if(n.id) locals.add(n.id.name); return false; }
    if(n.type==='ClassDeclaration'){if(n.id)locals.add(n.id.name);return false;}
    if(n.type==='CatchClause')bindings(n.param,locals);
    if (n.type === 'VariableDeclarator') bindings(n.id, locals);
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression' || n.type === 'NewExpression') {
      const name = calleeName(n.callee);
      if (name) calls.push({name, start:n.callee.start, end:n.callee.end, line:n.loc.start.line, direct:n.callee.type === 'Identifier'});
    }
    if (n.type === 'ReturnStatement' && n.argument) returns.push(code.slice(n.argument.start, n.argument.end));
    if(n.type==='IfStatement'||n.type==='ConditionalExpression')branches.push({kind:'if',condition:code.slice(n.test.start,n.test.end)});
    if(n.type==='SwitchStatement')branches.push({kind:'switch',condition:code.slice(n.discriminant.start,n.discriminant.end)});
  });
  if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') returns.push(code.slice(node.body.start, node.body.end));
  return {calls, returns: [...new Set(returns)], branches, params: (node.params || []).map(p => code.slice(p.start, p.end)), locals};
}
export function analyze(code, filename = 'untitled.js') {
  assertTextSource(code);
  if (!code.trim()) throw new Error('Add some code before creating a story.');
  if (code.length > MAX_CHARS) throw new Error('This first version supports files up to 80,000 characters. Try a smaller file.');
  const extension = filename.split('.').pop().toLowerCase();
  const support=languageSupport(filename);
  const finish=raw=>finalizeModel({...raw,support,warnings:[...(raw.warnings||[]),...(support.warning?[support.warning]:[])],analysisNotes:raw.analysisNotes||[]});
  if (support.language === 'Python') return finish(analyzePython(code,filename));
  if (['HTML','Java','C#','SQL'].includes(support.language))return finish(analyzeLanguage(code,filename,support.language));
  if (!['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(extension))return finish(analyzeText(code,filename,support.language));
  const ts = ['ts','tsx'].includes(extension);
  let ast;
  try { ast = parse(code, {sourceType:'unambiguous', plugins:[...(ts?['typescript']:[]), ...(!ts || extension === 'tsx'?['jsx']:[])], allowReturnOutsideFunction: true, tokens: true}); }
  catch (error) { throw new Error(`Couldn't parse ${filename}: ${error.reasonCode || 'syntax error'} at line ${error.loc?.line || '?'}, column ${(error.loc?.column || 0) + 1}. Check the code or file extension.`); }
  const chunks = [], symbols = [];
  const programNodes=[...ast.program.directives,...ast.program.body].sort((a,b)=>a.start-b.start);
  programNodes.forEach((outer, index) => {
    const node = unwrap(outer);
    const definitions = functionDefinitions(node);
    let kind = node.type === 'Directive' ? 'directive' : node.type === 'ImportDeclaration' ? 'import' : definitions.length ? 'function' : node.type === 'ClassDeclaration' ? 'class' : /^(TSTypeAliasDeclaration|TSInterfaceDeclaration|TSDeclareFunction)$/.test(node.type) ? 'type' : node.type === 'VariableDeclaration' ? 'data' : 'execution';
    const chunk = {id:`c${index}`, start:outer.start, end:outer.end, startLine:outer.loc.start.line, endLine:outer.loc.end.line, kind, names:[], symbolIds:[], nodeType:node.type, calls:[],locals:new Set(), typeLabel:node.type.replace(/([A-Z])/g,' $1').trim()};
    if(kind === 'directive')chunk.names=[node.value.value];
    if(kind === 'data') chunk.names = node.declarations.flatMap(d=>{const s=new Set();bindings(d.id,s);return [...s];});
    if(kind === 'import') {chunk.names = node.specifiers.map(s=>s.local.name);chunk.from = node.source.value;}
    if(kind === 'class') chunk.names = [node.id?.name || 'default'];
    if(kind === 'type') chunk.names = node.id?.name ? [node.id.name] : [];
    for (const definition of definitions) {
      const facts = functionFacts(definition.node, code);
      const symbol = {id:`s${symbols.length}`, name:definition.name, chunkId:chunk.id, color:palette[symbols.length % palette.length], start:definition.node.start, end:definition.node.end, startLine:definition.node.loc.start.line, endLine:definition.node.loc.end.line, async:!!definition.node.async, ...facts};
      symbols.push(symbol); chunk.names.push(symbol.name); chunk.symbolIds.push(symbol.id); chunk.calls.push(...symbol.calls);
    }
    if(!definitions.length) walk(node, n => {if(functionTypes.has(n.type)||n.type==='ClassDeclaration'){if(n.id&&n!==node)chunk.locals.add(n.id.name);return false;}if(['ClassMethod','ClassPrivateMethod','ObjectMethod'].includes(n.type))return false;if(n.type==='VariableDeclarator')bindings(n.id,chunk.locals);if(n.type==='CatchClause')bindings(n.param,chunk.locals);if(['CallExpression','OptionalCallExpression','NewExpression'].includes(n.type)){const name=calleeName(n.callee);if(name)chunk.calls.push({name,start:n.callee.start,end:n.callee.end,line:n.loc.start.line,direct:n.callee.type==='Identifier'});}});
    chunks.push(chunk);
  });
  if(!chunks.length) throw new Error('This file contains only comments. Add a statement or function to create a story.');
  const highlights=[];
  for(const symbol of symbols){const outer=programNodes.find(n=>n.start<=symbol.start&&n.end>=symbol.end);const node=unwrap(outer);const d=node.type==='FunctionDeclaration'?node.id:node.declarations?.find(d=>d.init?.start===symbol.start)?.id;if(d)highlights.push({start:d.start,end:d.end,symbolId:symbol.id});}
  return finish({code,filename,language:ts?'TypeScript':'JavaScript',chunks,symbols,highlights,tokens:ast.tokens,comments:ast.comments,lineCount:code.split('\n').length,analysisNotes:['JavaScript analysis follows direct top-level function calls. Callbacks, object methods, and dynamic dispatch may need more context.']});
}
function finalizeModel(model) {
  const {chunks,symbols}=model;
  const byId=new Map(symbols.map(s=>[s.id,s])),names=new Map();
  for(const s of symbols){const matches=names.get(s.name)||[];matches.push(s);names.set(s.name,matches);}
  const targetOf=(call,source)=>call.targetId?byId.get(call.targetId):call.resolved==null&&call.direct&&!source?.locals?.has(call.name)&&names.get(call.name)?.length===1?names.get(call.name)[0]:null;
  for(const symbol of symbols) {
    symbol.dependencies = [...new Set(symbol.calls.map(c=>{const target=targetOf(c,symbol);if(target)c.targetId=target.id;return target?.id;}).filter(Boolean))];
    symbol.incoming = [];
  }
  symbols.forEach(s=>s.dependencies.forEach(id=>symbols.find(t=>t.id===id).incoming.push(s.id)));
  chunks.forEach(c=>{if(c.kind==='data'&&c.calls.some(x=>targetOf(x,c)))c.kind='execution';});
  const rootCalls=chunks.filter(c=>c.kind==='execution' || c.kind==='data').flatMap(c=>c.calls.map(x=>targetOf(x,c)?.id).filter(Boolean));
  const explicitEntries=symbols.filter(s=>s.entryPoint).map(s=>s.id);
  const entryIds=[...new Set(rootCalls.length?rootCalls:explicitEntries.length?explicitEntries:symbols.filter(s=>s.incoming.length===0&&!s.ownerId).map(s=>s.id))];
  const flow=[], visited=new Set();
  function visit(chunk) {if(!chunk||visited.has(chunk.id))return;visited.add(chunk.id);flow.push(chunk.id);const deps=chunk.symbolIds.length?chunk.symbolIds.flatMap(id=>byId.get(id)?.dependencies||[]):chunk.calls.map(x=>targetOf(x,chunk)?.id).filter(Boolean);deps.forEach(id=>visit(chunks.find(c=>c.id===byId.get(id)?.chunkId)));}
  (model.preferredFlow||[]).forEach(id=>visit(chunks.find(c=>c.id===id)));
  chunks.filter(c=>c.kind==='execution').forEach(visit);
  entryIds.forEach(id=>visit(chunks.find(c=>c.id===symbols.find(s=>s.id===id).chunkId)));
  chunks.forEach(visit);
  const rank={directive:0,documentation:0,import:0,type:1,data:2,class:3,function:4,execution:5,markup:2,style:3,script:4,query:3,text:5};
  const concepts=[...chunks].sort((a,b)=>(rank[a.kind]??5)-(rank[b.kind]??5) || (a.kind==='function'?a.calls.length-b.calls.length:0) || a.start-b.start).map(c=>c.id);
  const highlights=[...(model.highlights || [])];
  for(const chunk of chunks) for(const call of chunk.calls) {
    const source=symbols.filter(s=>call.start>=s.start&&call.start<s.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
    const target=targetOf(call,source||chunk);
    if(target){call.targetId=target.id;highlights.push({...call,symbolId:target.id});}
    call.resolved=true;
  }

  const result={...model,chunks,symbols,flow,concepts,entryIds,highlights};
  if(result.language==='Python')result.inspection=inspectPython(result);
  return result;
}
export function orderedChunks(model, mode, original=false) {
  return original ? model.chunks : (mode === 'beginner' ? model.concepts : model.flow).map(id=>model.chunks.find(c=>c.id===id));
}
export function describeChunk(chunk, model, mode='beginner') {
  if(['HTML','Java','C#','SQL'].includes(model.language)){const description=describeLanguageChunk(chunk,model,mode);if(description)return description;}
  if(chunk.kind==='text')return {title:`Read source section ${model.chunks.indexOf(chunk)+1}`,body:'This source-text section is preserved with its original line numbers. This language has no dedicated parser here, so its functions, relationships, and execution order have not been verified. AI may offer a tentative explanation after you approve sending the file.',concept:'Unverified source',term:'Experimental support means the quality of parsing and explanations is not guaranteed.'};
  if(chunk.kind==='directive')return {title:'Apply '+chunk.names.join(', '),body:'This directive changes how the following JavaScript is interpreted. It does not itself call a function.',concept:'Language mode',term:'A directive can enable a specific language mode, such as strict mode.'};
  if(chunk.kind==='documentation')return {title:'Read the file description',body:'This text documents the file or its intended use. It is not a function call.',concept:'Documentation',term:'Documentation describes code without running its application logic.'};
  const names=chunk.names.join(', '), s=model.symbols.find(s=>s.chunkId===chunk.id);
  if(chunk.kind==='import') return {title:`Bring in ${chunk.names[0] || 'dependencies'}`,body:`This file brings in ${names || 'code'} from “${chunk.from}”. ${mode==='beginner'?'An import makes code from another file or library available here.':'The imported implementation is outside this file, so its behavior cannot be verified here.'}`,concept:'Dependencies',term:'An import connects this file to code defined elsewhere.'};
  if(chunk.kind==='type') return {title:`Define ${names || 'the data shape'}`,body:`This section describes a type${names?' called '+names:''}. It helps check how data is used. Type declarations do not themselves execute application logic.`,concept:'Types',term:'Types describe the expected shape of values.'};
  if(chunk.kind==='data') return {title:`Set up ${names || 'the starting data'}`,body:`This section declares ${names || 'the values used by this file'}.${chunk.calls.length?' Its initializer also calls '+[...new Set(chunk.calls.map(c=>c.name))].join(', ')+'.':''} ${mode==='beginner'?'These named values can be used by other sections of the file.':'Initializers run when this section is evaluated.'}`,concept:'Data & setup',term:'A variable gives a name to a value so code can refer to it later.'};
  if(chunk.kind==='class') return {title:`Introduce ${names}`,body:`${names} groups related behavior into a class. Its methods and constructor are defined in this section; defining a class does not automatically call its methods.${chunk.symbolIds.length?' Click its colored methods to inspect their individual inputs, returns, and known connections.':''}`,concept:'Structure',term:'A class groups data and operations into a reusable structure.'};
  if(s&&model.language==='Python'&&(s.async||s.generator))return {title:humanize(s.name),body:`${s.qualifiedName||s.name}(${s.params.join(', ')}). ${functionTiming(s,model.language)} ${functionReturns(s,model.language)}`,concept:'Deferred work',term:s.generator?'A generator pauses at yield and resumes when its iterator is advanced.':'A coroutine represents work that can be awaited or scheduled.'};
  if(s) {const calls=[...new Set(s.calls.map(c=>c.name))];return {title:humanize(s.name),body:mode==='beginner'?`${s.name} is a reusable step${s.params.length?' that receives '+s.params.join(', '):' with no named inputs'}. ${calls.length?'It calls '+calls.slice(0,4).join(', ')+(calls.length>4?' and other helpers':'')+' to do part of its work. ':''}${s.returns.length?'It sends a result back to the code that called it.':'There is no explicit returned value in this function.'}`:`${s.async?'Async function':'Function'} ${s.name}(${s.params.join(', ')}). ${calls.length?'Calls '+calls.join(', ')+'. ':''}${s.returns.length?s.returns.length+' return expression'+(s.returns.length===1?'':'s')+' found.':'No explicit return expression.'}`,concept:s.dependencies.length?'Coordination':'Reusable logic',term:'A function is a named set of instructions. Calling it runs those instructions.'};}
  const calls=[...new Set(chunk.calls.map(c=>c.name))];
  return {title:calls.length?`Run ${humanize(calls[0]).toLowerCase()}`:'Continue the main flow',body:calls.length?`This top-level section calls ${calls.join(', ')}. ${mode==='beginner'?'Unlike a function definition, a top-level statement runs when the file reaches it.':'These calls are a starting point for following this file’s flow.'}`:`This ${chunk.typeLabel.toLowerCase()} is part of the file’s top-level flow. Its source is shown alongside this chapter.`,concept:'Execution',term:'A top-level statement runs as the file is evaluated.'};
}
