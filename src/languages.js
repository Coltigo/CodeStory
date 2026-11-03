import {parser as htmlParser} from '@lezer/html';
import {parser as javaParser} from '@lezer/java';
import {parser as csharpParser} from './csharp/parser.js';
import PostgreSQL from 'node-sql-parser/build/postgresql.js';
import MySQL from 'node-sql-parser/build/mysql.js';
import SQLite from 'node-sql-parser/build/sqlite.js';
import TransactSQL from 'node-sql-parser/build/transactsql.js';

const colors=['violet','teal','amber','rose','blue','green'];
const children=node=>{const result=[];for(let child=node.firstChild;child;child=child.nextSibling)result.push(child);return result;};
function walk(node,visit){if(!node||visit(node)===false)return;for(let child=node.firstChild;child;child=child.nextSibling)walk(child,visit);}
const text=(code,node)=>node?code.slice(node.from,node.to):'';
function sourceTools(code,filename,language){
  const starts=[0];for(let i=0;i<code.length;i++)if(code[i]==='\n')starts.push(i+1);
  const lineAt=pos=>{let low=0,high=starts.length;while(low+1<high){const middle=(low+high)>>1;if(starts[middle]<=pos)low=middle;else high=middle;}return low+1;};
  const model={code,filename,language,chunks:[],symbols:[],highlights:[],tokens:[],comments:[],lineCount:starts.length,analysisNotes:[]};
  function chunk(from,to,kind,nodeType,names=[],extra={}){
    if(to<=from||!code.slice(from,to).trim())return null;
    const item={id:`c${model.chunks.length}`,start:from,end:to,startLine:lineAt(from),endLine:lineAt(Math.max(from,to-1)),kind,nodeType,typeLabel:nodeType.replace(/([a-z])([A-Z])/g,'$1 $2'),names,symbolIds:[],calls:[],...extra};
    model.chunks.push(item);return item;
  }
  return {model,lineAt,chunk};
}
function treeTokens(root,model,offset=0){
  walk(root,node=>{
    if(node.to<=node.from)return;
    const comment=/Comment$/.test(node.name);
    // Strings and comments are whole ranges, including interpolated strings.
    const literal=/String|TextBlock|CharacterLiteral|AttributeValue|ScriptText|StyleText/.test(node.name);
    if(comment||literal||!node.firstChild){
      const start=node.from-offset,end=node.to-offset;
      if(start<0||end>model.code.length)return false;
      const label=comment?'comment':literal?'string':/IntegerLiteral|RealLiteral|FloatingPointLiteral/.test(node.name)?'num':/Keyword|PrimitiveType|SimpleType/.test(node.name)||/^(public|private|protected|static|class|interface|return|if|else|new|void|package|import|throw|try|catch|for|while|boolean|null|true|false)$/.test(node.name)?'keyword':'name';
      model.tokens.push({start,end,type:{label}});
      if(comment)model.comments.push({start,end});
      return false;
    }
  });
}

function analyzeHTML(code,filename){
  const {model,chunk}=sourceTools(code,filename,'HTML'),root=htmlParser.parse(code).topNode;
  treeTokens(root,model);
  const wrappers=new Set(['html','head','body']);
  function element(node,parentChunkId=null,depth=0){
    const nodes=children(node),opening=nodes.find(n=>n.name==='OpenTag'||n.name==='SelfClosingTag');
    const nameNode=opening&&children(opening).find(n=>n.name==='TagName'),tag=text(code,nameNode).toLowerCase();
    if(!opening||!tag){chunk(node.from,node.to,'markup',node.name,[],{parentChunkId,depth});return;}
    const attributes=children(opening).filter(n=>n.name==='Attribute').map(n=>{
      const parts=children(n),key=parts.find(p=>p.name==='AttributeName'),value=parts.find(p=>/AttributeValue/.test(p.name));
      return {name:text(code,key),value:text(code,value).replace(/^(['"])([\s\S]*)\1$/,'$2')};
    });
    const attr=name=>attributes.find(a=>a.name.toLowerCase()===name)?.value;
    const label=`<${tag}${attr('id')?'#'+attr('id'):''}>`,embedded=tag==='script'||tag==='style';
    const childElements=nodes.filter(n=>n.name==='Element');
    // Keep small semantic elements together; split containers at real element boundaries.
    const split=!embedded&&childElements.length&&(wrappers.has(tag)||childElements.length>1||code.slice(node.from,node.to).split('\n').length>8);
    const facts={tag,attributes,parentChunkId,depth,elementCount:childElements.length};
    if(!split){
      const item=chunk(node.from,node.to,tag==='script'?'script':tag==='style'?'style':'markup',node.name,[label],facts);
      if(item&&embedded){const content=nodes.find(n=>n.name==='ScriptText'||n.name==='StyleText');item.embeddedRange=content?{start:content.from,end:content.to}:null;item.externalSource=attr('src')||null;item.scriptType=attr('type')||null;}
      return;
    }
    const header=chunk(node.from,opening.to,'markup','ElementOpening',[label],{...facts,container:true});
    let cursor=opening.to;
    for(const child of childElements){
      if(code.slice(cursor,child.from).trim())chunk(cursor,child.from,'markup','ElementContent',[label],{...facts,parentChunkId:header.id});
      element(child,header.id,depth+1);cursor=child.to;
    }
    if(code.slice(cursor,node.to).trim())chunk(cursor,node.to,'markup','ElementClosing',[label],{...facts,parentChunkId:header.id,closing:true});
  }
  for(const node of children(root)){
    if(node.name==='Comment')continue;
    if(node.name==='Element')element(node);
    else if(node.name==='DoctypeDecl')chunk(node.from,node.to,'directive',node.name,['HTML document type'],{documentType:true});
    else if(text(code,node).trim())chunk(node.from,node.to,'markup',node.name,[]);
  }
  const errors=[];walk(root,n=>{if(n.type.isError)errors.push(n.from);});
  if(errors.length)model.analysisNotes.push('Some HTML is incomplete or uses template syntax. The document parser recovered its structure; check the original tags.');
  model.analysisNotes.push('HTML chapters describe document structure in source order. Embedded JavaScript, styles, event handlers, and external resources are shown as source sections and are not executed or fully traced.');
  model.preferredFlow=model.chunks.map(c=>c.id);
  if(!model.chunks.length)throw new Error('This HTML contains only comments. Add an element to create a story.');
  return model;
}

const javaConfig={
  parser:javaParser,language:'Java',types:new Set(['ClassDeclaration','InterfaceDeclaration','EnumDeclaration','AnnotationTypeDeclaration']),
  bodies:new Set(['ClassBody','InterfaceBody','EnumBody','AnnotationTypeBody']),methods:new Set(['MethodDeclaration','ConstructorDeclaration']),
  imports:new Set(['ImportDeclaration']),namespaces:new Set(['PackageDeclaration','ModuleDeclaration']),fields:new Set(['FieldDeclaration','ConstantDeclaration','EnumConstant','AnnotationTypeElementDeclaration']),
  name:'Definition',params:'FormalParameters',parameter:'FormalParameter',bodyNames:new Set(['Block','ConstructorBody']),returnName:'ReturnStatement',callName:'MethodInvocation'
};
const csharpConfig={
  parser:csharpParser,language:'C#',types:new Set(['classDecl','structDecl','recordDecl','interfaceDecl','enumDecl']),
  bodies:new Set(['classBody','structBody','recordBody','interfaceBody','enumBody']),methods:new Set(['methodDecl','ctorDecl','LocalFuncDecl','interfaceMethodDecl']),
  imports:new Set(['usingDirective','externAliasDirective']),namespaces:new Set(['namespaceDecl']),fields:new Set(['fieldDecl','constantDecl','propertyDecl','eventDecl','indexerDecl','delegateDecl','interfacePropertyDecl','interfaceEventDecl','interfaceIndexerDecl','enumMemberDecl']),
  name:'TypeIdentifier',params:'formalParams',parameter:'fixedParam',bodyNames:new Set(['Delim','block','methodBody','ctorBody','localFuncBody']),returnName:'returnStmt'
};

function descendants(node,name){const result=[];walk(node,n=>{if(n.name===name)result.push(n);});return result;}
function firstDescendant(node,names){let result=null;walk(node,n=>{if(result)return false;if(names.has(n.name)){result=n;return false;}});return result;}
function parameters(code,node,config){
  const list=firstDescendant(node,new Set([config.params]));
  if(!list)return [];
  // Delim wrappers are grammar nodes in C#. Split only on commas at the parameter-list level.
  let current=list;
  if(config.language==='C#'&&current.firstChild?.name==='Delim')current=current.firstChild;
  const parts=children(current),result=[];let from=parts.find(n=>text(code,n)==='(')?.to??current.from;
  for(const part of parts){const value=text(code,part);if(value===','||value===')'){const entry=code.slice(from,part.from).trim();if(entry)result.push(entry);from=part.to;}}
  if(!result.length){const raw=code.slice(current.from,current.to).replace(/^\(/,'').replace(/\)$/,'').trim();if(raw)result.push(raw);}
  return result;
}

function analyzeObjectLanguage(code,filename,config){
  const {model,lineAt,chunk}=sourceTools(code,filename,config.language);let root=config.parser.parse(code).topNode;
  if(config.language==='C#'){
    let hasTypes=false,errors=0;walk(root,n=>{if(config.types.has(n.name))hasTypes=true;if(n.type.isError)errors++;});
    if(!hasTypes&&errors){const statements=config.parser.configure({top:'Statements'}).parse(code).topNode;let statementErrors=0;walk(statements,n=>{if(n.type.isError)statementErrors++;});if(statementErrors<errors)root=statements;}
  }
  treeTokens(root,model);
  const definitionNodes=new Map(),symbolNodes=new Map();
  function callsOf(node,skipMethods=true){
    const calls=[];
    walk(node,n=>{
      if(n!==node&&(config.types.has(n.name)||skipMethods&&config.methods.has(n.name)||/Lambda|anonMethod/.test(n.name)))return false;
      if(config.language==='Java'&&n.name==='MethodInvocation'){
        const parts=children(n),method=parts.find(p=>p.name==='MethodName'),args=parts.find(p=>p.name==='ArgumentList');
        if(method&&args){const name=code.slice(n.from,args.from).trim().replace(/\s+/g,''),nameLeaf=method.firstChild||method;calls.push({name,sourceName:name,start:nameLeaf.from,end:nameLeaf.to,line:lineAt(n.from),direct:false,resolved:true,unqualified:parts[0]===method});}
      }
      if(config.language==='C#'&&n.name==='MethodName'&&!definitionNodes.has(n.from)){
        const parent=n.parent;
        if(parent&&['Delim','methodDecl','localFuncDecl'].includes(parent.name))return;
        let receiver='';
        if(n.prevSibling&&text(code,n.prevSibling)==='.'){
          const before=n.prevSibling.prevSibling;
          const outerReceiver=parent.name==='memberCall'?parent.prevSibling:null;
          receiver=text(code,before||outerReceiver)||'?';
        }
        const name=receiver?receiver+'.'+text(code,n):text(code,n);
        calls.push({name,sourceName:name,start:n.from,end:n.to,line:lineAt(n.from),direct:false,resolved:true,unqualified:!receiver});
      }
    });return calls;
  }
  function makeMethod(node,scope,parentChunkId){
    const parts=children(node),nameNode=config.language==='Java'?parts.find(n=>n.name==='Definition')||firstDescendant(node,new Set(['Definition'])):firstDescendant(node,new Set(['MethodName']))||firstDescendant(node,new Set(['TypeIdentifier']));
    if(!nameNode)return null;
    const simpleName=text(code,nameNode),name=scope?scope+'.'+simpleName:simpleName;
    definitionNodes.set(nameNode.from,true);
    const item=chunk(node.from,node.to,'function',node.name,[name],{parentChunkId,scope});
    const params=parameters(code,node,config),locals=new Set();
    const paramList=firstDescendant(node,new Set([config.params]));
    if(paramList)for(const id of descendants(paramList,config.language==='Java'?'Definition':'ParamName'))locals.add(text(code,id));
    const returns=[];walk(node,n=>{
      if(n!==node&&(config.methods.has(n.name)||config.types.has(n.name)||/Lambda|anonMethod/.test(n.name))){
        if(config.methods.has(n.name)){const nested=firstDescendant(n,new Set(['MethodName','Definition']));if(nested)locals.add(text(code,nested));}return false;
      }
      if(n.name===config.returnName){const result=code.slice(n.firstChild?.to??n.from,n.to).replace(/;\s*$/,'').trim();if(result)returns.push(result);}
      if(config.language==='Java'&&n.name==='VariableDeclarator'){const id=firstDescendant(n,new Set(['Definition']));if(id)locals.add(text(code,id));}
      if(config.language==='C#'&&n.name==='VarName'&&n.parent?.name!=='PropertyPatternFields')locals.add(text(code,n));
    });
    const methodBody=firstDescendant(node,new Set(['methodBody','localFuncBody']));
    const arrow=(methodBody?children(methodBody):parts).find(n=>text(code,n)==='=>');
    if(arrow){const value=code.slice(arrow.to,methodBody?.to??node.to).replace(/;\s*$/,'').trim();if(value)returns.push(value);}
    const prefix=code.slice(node.from,nameNode.from),virtualDispatch=config.language==='Java'?!/\b(static|private|final)\b/.test(prefix):node.name==='interfaceMethodDecl'||/\b(virtual|override|abstract)\b/.test(prefix);
    const symbol={id:`s${model.symbols.length}`,name,qualifiedName:name,simpleName,scope,signature:params.join(', '),chunkId:item.id,color:colors[model.symbols.length%colors.length],start:node.from,end:node.to,startLine:lineAt(node.from),endLine:lineAt(Math.max(node.from,node.to-1)),async:/\basync\b/.test(prefix),params,returns,calls:[],locals,virtualDispatch,entryPoint:/^(main|Main)$/.test(simpleName)&&/\bstatic\b/.test(prefix),constructor:/Constructor|ctorDecl/.test(node.name)};
    model.symbols.push(symbol);item.symbolIds.push(symbol.id);model.highlights.push({start:nameNode.from,end:nameNode.to,symbolId:symbol.id});symbolNodes.set(symbol.id,node);
    return item;
  }
  function visit(node,scope='',parentChunkId=null){
    if(/Comment$/.test(node.name)||['{','}',';'].includes(node.name))return;
    if(config.imports.has(node.name)){const value=text(code,node).replace(/^(global\s+)?(using|import|extern)\s+/,'').replace(/;\s*$/,'');chunk(node.from,node.to,'import',node.name,[value],{from:value,parentChunkId});return;}
    if(config.methods.has(node.name)){makeMethod(node,scope,parentChunkId);return;}
    if(config.types.has(node.name)){
      const parts=children(node),nameNode=parts.find(n=>n.name===config.name),body=parts.find(n=>config.bodies.has(n.name));
      const typeName=text(code,nameNode)||'anonymous',qualified=scope?scope+'.'+typeName:typeName;
      if(!body){chunk(node.from,node.to,'class',node.name,[qualified],{parentChunkId});return;}
      let bodyNode=body;
      if(config.language==='C#'&&body.firstChild?.name==='Delim')bodyNode=body.firstChild;
      const brace=children(bodyNode).find(n=>text(code,n)==='{');
      const opening=chunk(node.from,brace?.to??body.from,'class',node.name,[qualified],{parentChunkId,scope:qualified,container:true});
      for(const member of children(bodyNode))visit(member,qualified,opening?.id??parentChunkId);
      const closing=children(bodyNode).findLast(n=>text(code,n)==='}');
      if(closing)chunk(closing.from,node.to,'structure','TypeClosing',[qualified],{parentChunkId:opening?.id??parentChunkId,scope:qualified,closing:true});
      return;
    }
    if(config.namespaces.has(node.name)){
      const body=children(node).find(n=>/Body|body/.test(n.name));
      const names=children(node).filter(n=>['TypeIdentifier','Identifier','ScopedIdentifier'].includes(n.name)).map(n=>text(code,n));
      chunk(node.from,body?body.from:node.to,'type',node.name,names.length?names:[text(code,node).replace(/^(package|namespace)\s+/,'').replace(/[;{].*$/s,'').trim()],{parentChunkId});
      if(body){const bodyNode=body.firstChild?.name==='Delim'?body.firstChild:body,namespace=names.join('.'),childScope=namespace?[scope,namespace].filter(Boolean).join('.'):scope;for(const member of children(bodyNode))visit(member,childScope,parentChunkId);}return;
    }
    if(config.fields.has(node.name)){
      const ids=config.language==='Java'?descendants(node,'Definition').map(n=>text(code,n)):children(node).filter(n=>['VarName','PropertyName','MethodName'].includes(n.name)).map(n=>text(code,n));
      if(!ids.length&&node.name==='AnnotationTypeElementDeclaration'){const identifier=children(node).find(n=>n.name==='Identifier');if(identifier)ids.push(text(code,identifier));}
      const item=chunk(node.from,node.to,'data',node.name,ids,{parentChunkId,scope});if(item)item.calls=callsOf(node);return;
    }
    const parts=children(node);
    if(node===root||/^(compilationUnit|namespaceMemberDecl|typeDecl|classMemberDecl|topLevelStmt|EnumBodyDeclarations)$/.test(node.name)){for(const child of parts)visit(child,scope,parentChunkId);return;}
    const item=chunk(node.from,node.to,'execution',node.name,[],{parentChunkId,scope});if(item)item.calls=callsOf(node);
  }
  let fileNamespace='';
  if(config.language==='C#')walk(root,n=>{if(n.name==='namespaceDecl'&&!children(n).some(child=>child.name==='namespaceBody'))fileNamespace=children(n).filter(child=>child.name==='TypeIdentifier').map(child=>text(code,child)).join('.');});
  visit(root,fileNamespace);
  for(const symbol of model.symbols){symbol.calls=callsOf(symbolNodes.get(symbol.id));model.chunks.find(c=>c.id===symbol.chunkId).calls=symbol.calls;}
  // Method names are qualified by declaring type. Do not choose arbitrarily among overloads.
  const duplicateNames=new Map();for(const symbol of model.symbols)duplicateNames.set(symbol.name,(duplicateNames.get(symbol.name)||0)+1);
  for(const symbol of model.symbols)if(duplicateNames.get(symbol.name)>1){symbol.overloaded=true;symbol.name+=`(${symbol.signature})`;model.chunks.find(c=>c.id===symbol.chunkId).names=[symbol.name];}
  for(const item of model.chunks)for(const call of item.calls){
    const owner=model.symbols.find(s=>s.chunkId===item.id),scope=owner?.scope??item.scope;
    const name=call.sourceName.replace(/^this\./,''),candidates=model.symbols.filter(s=>!s.overloaded&&!s.constructor&&!s.virtualDispatch&&s.scope===scope&&s.simpleName===name);
    if((call.unqualified||call.sourceName.startsWith('this.'))&&candidates.length===1&&!owner?.locals.has(name)){
      call.name=candidates[0].name;call.targetId=candidates[0].id;call.direct=true;
    }
  }
  const errors=[];walk(root,n=>{if(n.type.isError)errors.push(lineAt(n.from));});
  if(errors.length)model.analysisNotes.push(`The ${config.language} parser recovered syntax near line ${[...new Set(errors)].slice(0,4).join(', ')}. Newer language features or incomplete source may need AI context; recovered sections are not a compiler validation.`);
  model.analysisNotes.push(`${config.language} relationships include only unique unqualified calls within the same declared type. Overloads, inheritance, interfaces, extension methods, delegates, object receivers, and external code are not resolved.`);
  if(!model.chunks.length)throw new Error(`This ${config.language} file has no readable declarations or statements.`);
  return model;
}

// A lexical statement splitter preserves semicolons inside literals, comments, and
// PostgreSQL dollar strings. Each slice is then parsed by an actual SQL grammar.
function sqlSlices(code){
  const tokens=[],comments=[],slices=[];let start=0,i=0;
  function token(from,to,label){tokens.push({start:from,end:to,type:{label}});}
  while(i<code.length){
    const from=i,ch=code[i];
    if(/\s/.test(ch)){i++;continue;}
    if(code.startsWith('--',i)||code[i]==='#'){while(i<code.length&&code[i]!=='\n')i++;token(from,i,'comment');comments.push({start:from,end:i});continue;}
    if(code.startsWith('/*',i)){let depth=1;i+=2;while(i<code.length&&depth){if(code.startsWith('/*',i)){depth++;i+=2;}else if(code.startsWith('*/',i)){depth--;i+=2;}else i++;}token(from,i,'comment');comments.push({start:from,end:i});continue;}
    const dollar=ch==='$'&&code.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0];
    if(dollar){const close=code.indexOf(dollar,i+dollar.length);i=close<0?code.length:close+dollar.length;token(from,i,'string');continue;}
    if("'\"`[".includes(ch)){
      const end=ch==='['?']':ch;i++;
      while(i<code.length){if(code[i]===end){i++;if(code[i]===end){i++;continue;}break;}if(code[i]==='\\'&&ch!== '[')i+=2;else i++;}
      token(from,Math.min(i,code.length),ch==="'"?'string':'name');continue;
    }
    if(ch===';'){i++;slices.push({start,end:i});start=i;continue;}
    if(/[\w$]/.test(ch)){while(i<code.length&&/[\w$]/.test(code[i]))i++;const word=code.slice(from,i);token(from,i,/^\d/.test(word)?'num':/^(select|from|where|join|left|right|inner|outer|on|group|by|having|order|limit|as|with|insert|into|values|update|set|delete|create|table|view|index|drop|alter|begin|commit|rollback|case|when|then|else|end|and|or|not|null|distinct|union|all)$/i.test(word)?'keyword':'name');continue;}
    i++;
  }
  if(code.slice(start).trim())slices.push({start,end:code.length});
  return {slices,tokens,comments};
}
const sqlDialects=[['PostgreSQL',new PostgreSQL.Parser()],['MySQL',new MySQL.Parser()],['SQLite',new SQLite.Parser()],['TransactSQL',new TransactSQL.Parser()]];
function analyzeSQL(code,filename){
  const {model,chunk}=sourceTools(code,filename,'SQL'),lex=sqlSlices(code);model.tokens=lex.tokens;model.comments=lex.comments;
  let partial=false;
  for(const slice of lex.slices){
    const inside=lex.tokens.filter(t=>t.start>=slice.start&&t.end<=slice.end&&t.type.label!=='comment'),start=inside[0]?.start;
    if(start===undefined)continue;
    const source=code.slice(start,slice.end),tables=new Set(),ctes=new Set(),clauses=new Set();let ast=null,dialect=null;
    for(const [candidate,parser] of sqlDialects){try{ast=parser.astify(source,{parseOptions:{includeLocations:true}});dialect=candidate;break;}catch{/* Try the next shipped grammar; no SQL is executed. */}}
    const list=Array.isArray(ast)?ast:ast?[ast]:[];
    let operation=list[0]?.type?.toUpperCase()||inside[0]&&code.slice(inside[0].start,inside[0].end).toUpperCase()||'SQL';
    function facts(value){
      if(!value||typeof value!=='object')return;
      if(Array.isArray(value)){value.forEach(facts);return;}
      // A column_ref.table is usually a qualifier or alias, not a database object.
      if(value.type!=='column_ref'&&value.table&&typeof value.table==='string')tables.add([value.db,value.table].filter(Boolean).join('.'));
      if(value.with)for(const entry of value.with){const name=entry.name?.value||entry.name;if(typeof name==='string')ctes.add(name);}
      for(const key of ['where','groupby','having','orderby','limit','distinct','set','values','with']){
        const entry=value[key];
        if(entry&&(key!=='limit'||entry.value?.length)&&(key!=='distinct'||entry.type)&&(!Array.isArray(entry)||entry.length))clauses.add(key);
      }
      if(value.join)clauses.add('join');
      for(const [key,entry]of Object.entries(value))if(key!=='loc')facts(entry);
    }
    list.forEach(facts);
    // CTE names are temporary result sets, not physical database tables.
    for(const name of ctes)tables.delete(name);
    const item=chunk(start,slice.end,'query','SQLStatement',[operation],{operation,tables:[...tables],ctes:[...ctes],clauses:[...clauses],dialect,partial:!ast});
    if(item&&!ast)partial=true;
  }
  if(partial)model.analysisNotes.push('Some SQL statements use a dialect or procedural syntax outside the local grammars. Those chapters preserve the source and are marked as partially parsed; their table relationships are not inferred.');
  model.analysisNotes.push('SQL chapters preserve statement order. Table and common-table-expression relationships come from syntax; the database schema, execution plan, data, permissions, and stored routines are not available.');
  model.preferredFlow=model.chunks.map(c=>c.id);
  if(!model.chunks.length)throw new Error('This SQL file contains only comments. Add a statement to create a story.');
  return model;
}

export function analyzeLanguage(code,filename,language){
  if(language==='HTML')return analyzeHTML(code,filename);
  if(language==='Java')return analyzeObjectLanguage(code,filename,javaConfig);
  if(language==='C#')return analyzeObjectLanguage(code,filename,csharpConfig);
  if(language==='SQL')return analyzeSQL(code,filename);
  return null;
}

export function describeLanguageChunk(chunk,model,mode='beginner'){
  const names=chunk.names.join(', ');
  if(model.language==='HTML'){
    if(chunk.documentType)return {title:'Set the HTML document type',body:'The doctype tells a browser to interpret the page using modern HTML rules.',concept:'Document setup',term:'HTML describes a document using nested elements.'};
    if(chunk.kind==='script')return {title:chunk.externalSource?'Connect a JavaScript resource':'Add page behavior',body:chunk.externalSource?`This script element loads “${chunk.externalSource}”. Its implementation is outside this file.`:`This script element contains ${chunk.scriptType==='application/ld+json'?'structured metadata':'code that may add behavior to the page'}. The HTML guide preserves this embedded section; it does not execute or trace its JavaScript.`,concept:'Page behavior',term:'A script element can embed code or load it from another file.'};
    if(chunk.kind==='style')return {title:'Define the page appearance',body:'This style element contains CSS rules for the page. The rules describe presentation; their selectors and cascade need the surrounding document to determine the final appearance.',concept:'Presentation',term:'CSS controls how HTML elements are presented.'};
    if(chunk.closing)return {title:`Close ${names}`,body:`This section finishes ${names}${chunk.parentChunkId?' and returns to its surrounding document structure':''}. Closing an element is a structural boundary, not a function call.`,concept:'Document structure',term:'Nested elements create parent and child relationships in a document.'};
    const attributes=(chunk.attributes||[]).map(a=>a.name).join(', ');
    return {title:chunk.container?`Open ${names}`:names?`Build ${names}`:'Add document content',body:`${names||'This section'} ${chunk.container?'contains the sections that follow':'contributes content or structure to the page'}.${attributes?' It declares the attributes '+attributes+'.':''}${chunk.parentChunkId?' It belongs inside an earlier parent element.':''}${mode==='developer'?' Source order and nesting are preserved; layout, script timing, and runtime DOM changes are not inferred.':''}`,concept:'Document structure',term:'An element uses a tag and optional attributes to describe part of a page.'};
  }
  if(model.language==='SQL'&&chunk.kind==='query'){
    if(chunk.partial)return {title:`Read the ${chunk.operation} statement`,body:'This statement is preserved as source, but the local SQL grammars could not fully parse it. Its exact behavior and relationships need dialect context or AI analysis.',concept:'SQL dialect context',term:'SQL dialects add database-specific syntax to the shared language.'};
    const purpose={SELECT:'Read a result set',INSERT:'Add rows',UPDATE:'Change rows',DELETE:'Remove rows',CREATE:'Define a database object',ALTER:'Change a database object',DROP:'Remove a database object',TRUNCATE:'Empty a table',BEGIN:'Start a transaction',COMMIT:'Commit a transaction',ROLLBACK:'Roll back a transaction'}[chunk.operation]||`${chunk.operation} statement`;
    const clauseNames={where:'filter rows',join:'join related rows',groupby:'group rows',having:'filter groups',orderby:'sort the result',limit:'limit the result',distinct:'remove duplicate results',with:'name temporary result sets',set:'assign values',values:'provide row values'};
    const clauses=chunk.clauses.map(c=>clauseNames[c]).filter(Boolean);
    return {title:purpose,body:`This ${chunk.operation} statement${chunk.tables.length?' references '+chunk.tables.join(', '):' has no named table reference in the parsed syntax'}.${chunk.ctes.length?' It defines the temporary result sets '+chunk.ctes.join(', ')+'.':''}${clauses.length?' Its clauses '+clauses.join(', ')+'.':''} ${mode==='beginner'?'The database decides how to carry out this request.':'The syntactic relationships do not prove an execution plan or the resulting data.'}`,concept:'Database operations',term:'SQL statements describe operations on data; their order and transaction context can matter.'};
  }
  if((model.language==='Java'||model.language==='C#')&&chunk.kind==='type')return {title:`Declare ${names||'the namespace'}`,body:'This declaration groups or names code. It establishes organization and visibility; it does not call the methods that follow.',concept:'Code organization',term:'Packages and namespaces organize related types and avoid naming collisions.'};
  if((model.language==='Java'||model.language==='C#')&&chunk.kind==='class')return {title:`Introduce ${names}`,body:`${names} declares a type that groups related members. Its methods and fields appear in the following sections; declaring the type does not call those methods.`,concept:'Types & structure',term:'A type groups related state and behavior.'};
  if((model.language==='Java'||model.language==='C#')&&chunk.closing)return {title:`Finish ${names}`,body:`This closing boundary ends the definition of ${names}. It does not call a method.`,concept:'Types & structure',term:'Braces mark the boundaries of a declared type or block.'};
  return null;
}
