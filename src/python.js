import { parser } from '@lezer/python';

const colors = ['violet', 'teal', 'amber', 'rose', 'blue', 'green'];
const definitions = new Set(['FunctionDefinition', 'ClassDefinition']);
const comprehensions = /ComprehensionExpression$/;
const nodeKey = node => `${node.name}:${node.from}`;

// This is a static reading of source. It never imports or executes uploaded Python.
export function analyzePython(code, filename) {
  const root = parser.parse(code).topNode;
  const chunks = [], symbols = [], highlights = [], tokens = [], comments = [];
  const scopes = new Map(), chunksByNode = new Map(), memberWrites = [];
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
  const lineAt = pos => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (lineStarts[mid] <= pos) low = mid; else high = mid;
    }
    return low + 1;
  };
  const text = node => code.slice(node.from, node.to);
  const children = node => {
    const out = [];
    for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
    return out;
  };
  function walk(node, visit) {
    if (visit(node) === false) return;
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child, visit);
  }
  const unknown = {kind:'value'};
  const makeScope = (type, parent, qualifier = '') => ({type, parent, qualifier, bindings:new Map(), globals:new Set(), nonlocals:new Set(), writes:new Set(), replacedMembers:new Set()});
  const moduleScope = makeScope('module', null);
  const nearestFunction = scope => {for (let current = scope; current; current = current.parent) if (current.type === 'function') return current; return null;};
  function bind(scope, name, entity = unknown, write = true) {
    if (!name) return;
    if (!scope.bindings.has(name)) scope.bindings.set(name, new Set());
    scope.bindings.get(name).add(entity);
    if (write) scope.writes.add(name);
  }
  function bindTarget(node, scope) {
    if (node.name === 'VariableName') bind(scope, text(node));
    else if (node.name === 'MemberExpression') {
      const parts = children(node);
      if (parts.length === 3 && parts[0].name === 'VariableName' && parts[2].name === 'PropertyName') memberWrites.push({scope, receiver:text(parts[0]), member:text(parts[2])});
    } else if (!['SubscriptExpression', 'TypeDef'].includes(node.name)) {
      for (const child of children(node)) bindTarget(child, scope);
    }
  }
  function parameterFacts(paramList) {
    if (!paramList) return {params:[], names:[]};
    const parts = children(paramList), parenthesized = parts[0]?.name === '(';
    let start = parenthesized ? parts[0].to : paramList.from;
    const params = [], names = [];
    const add = end => {
      const value = code.slice(start, end).trim();
      if (!value) return;
      params.push(value);
      // Direct parameter names exclude names inside annotations and default values.
      const boundary = parts.find(part => part.from >= start && part.from < end && ['TypeDef', 'AssignOp'].includes(part.name))?.from ?? end;
      const name = parts.find(part => part.from >= start && part.from < boundary && part.name === 'VariableName');
      if (name) names.push(text(name));
    };
    for (const child of parts) if (child.name === ',' || child.name === ')') {add(child.from); start = child.to;}
    if (!parenthesized) add(paramList.to);
    return {params, names};
  }
  function importNames(node) {
    const parts = children(node), importIndex = parts.findIndex(part => part.name === 'import');
    const result = [];
    let group = [];
    const add = () => {
      const aliasIndex = group.findIndex(part => part.name === 'as');
      const name = aliasIndex >= 0 ? group.slice(aliasIndex + 1).find(part => part.name === 'VariableName') : group.find(part => part.name === 'VariableName');
      if (name) result.push(text(name));
      group = [];
    };
    for (const part of parts.slice(importIndex + 1)) {
      if (part.name === ',') add(); else group.push(part);
    }
    add();
    return result;
  }
  function docstring(body) {
    const first = children(body).find(part => ![':', 'Comment'].includes(part.name));
    if (first?.name !== 'ExpressionStatement' || first.firstChild?.name !== 'String') return null;
    const raw = text(first.firstChild);
    const match = raw.match(/^[ru]*("""|'''|"|')([\s\S]*)\1$/i);
    return match ? match[2].trim() : raw;
  }
  let firstError;
  walk(root, node => {
    if (node.type.isError && !firstError) firstError = node;
    if (!node.firstChild && node.to > node.from) {
      const name = node.name;
      const label = name === 'String' ? 'string' : name === 'Number' ? 'num' : /^(def|return|if|else|elif|for|in|import|from|class|async|await|try|except|finally|raise|with|as|and|or|not|None|True|False|lambda|pass|yield|global|nonlocal|while|break|continue|match|case|del|assert)$/.test(name) ? 'keyword' : name === 'Comment' ? 'comment' : 'name';
      tokens.push({start:node.from, end:node.to, type:{label}});
      if (label === 'comment') comments.push({start:node.from, end:node.to});
    }
  });
  if (firstError) throw new Error(`Couldn't parse ${filename}: could not recognize Python syntax near line ${lineAt(firstError.from)}. Check indentation and syntax; valid newer syntax or destructured with-as targets may exceed this parser’s grammar.`);

  for (const outer of children(root)) {
    if (outer.name === 'Comment') continue;
    const node = outer.name === 'DecoratedStatement' ? children(outer).find(child => definitions.has(child.name)) || outer : outer;
    const kind = node.name === 'ExpressionStatement' && node.firstChild?.name === 'String' ? 'documentation' : node.name === 'FunctionDefinition' ? 'function' : node.name === 'ClassDefinition' ? 'class' : /^(ImportStatement|ImportFromStatement)$/.test(node.name) ? 'import' : node.name === 'AssignStatement' ? 'data' : 'execution';
    const chunk = {id:`c${chunks.length}`, start:outer.from, end:outer.to, startLine:lineAt(outer.from), endLine:lineAt(Math.max(outer.from, outer.to - 1)), kind, names:[], symbolIds:[], nodeType:node.name, typeLabel:node.name.replace(/([A-Z])/g, ' $1').trim(), calls:[], branches:[]};
    if (kind === 'import') {
      chunk.from = text(node).replace(/^(from|import)\s+/, '').split(/\s+import\s+/)[0];
      chunk.names = importNames(node);
    }
    if (kind === 'class') chunk.names = [text(children(node).find(child => child.name === 'VariableName'))];
    if (kind === 'data') {
      const bindings = makeScope('temporary', null);
      collectAssignments(node, bindings);
      chunk.names = [...bindings.bindings.keys()];
    }
    chunks.push(chunk);
    walk(outer, child => {chunksByNode.set(nodeKey(child), chunk);});
  }
  if (!chunks.length) throw new Error('This file contains only comments. Add a statement or function to create a story.');

  function collectAssignments(node, scope) {
    const parts = children(node);
    let segment = [];
    for (const part of parts) {
      if (part.name === 'AssignOp' || part.name === 'UpdateOp') {
        segment.forEach(target => bindTarget(target, scope)); segment = [];
      } else if (part.name !== 'TypeDef') segment.push(part);
    }
    if (node.name === 'AssignStatement' && !parts.some(part => part.name === 'AssignOp')) {
      const first = parts.find(part => part.name !== 'TypeDef');
      if (first) bindTarget(first, scope);
    }
  }
  // First gather bindings for each lexical scope. Python considers an assignment
  // anywhere in a function local to that entire function, including earlier calls.
  function discover(node, scope, decorators = [], conditional = false) {
    if (node.name === 'DecoratedStatement') {
      const parts = children(node), definition = parts.find(part => definitions.has(part.name));
      if (definition) discover(definition, scope, parts.filter(part => part.name === 'Decorator'), conditional);
      return;
    }
    if (definitions.has(node.name)) {
      const parts = children(node), nameNode = parts.find(part => part.name === 'VariableName');
      const name = text(nameNode), body = parts.find(part => part.name === 'Body');
      const qualifier = scope.qualifier ? `${scope.qualifier}.${name}` : name;
      const childScope = makeScope(node.name === 'FunctionDefinition' ? 'function' : 'class', scope, qualifier);
      scopes.set(nodeKey(node), childScope);
      if (node.name === 'FunctionDefinition') {
        const facts = parameterFacts(parts.find(part => part.name === 'ParamList'));
        const classScope = scope.type === 'class' ? scope : null;
        const symbol = {id:`s${symbols.length}`, name, qualifiedName:qualifier, ownerId:nearestFunction(scope)?.symbol?.id ?? null, className:classScope?.qualifier ?? null, chunkId:chunksByNode.get(nodeKey(node)).id, color:colors[symbols.length % colors.length], start:node.from, end:node.to, startLine:lineAt(node.from), endLine:lineAt(Math.max(node.from, node.to - 1)), async:parts.some(part => part.name === 'async'), params:facts.params, returns:[], calls:[], locals:new Set(), docstring:docstring(body), decorators:decorators.map(text), conditional, branches:[]};
        childScope.symbol = symbol;
        childScope.classScope = classScope;
        childScope.receiverName = classScope && !decorators.some(decorator => /^@staticmethod\s*$/.test(text(decorator))) ? facts.names[0] : null;
        facts.names.forEach(param => bind(childScope, param, unknown, false));
        symbols.push(symbol);
        const chunk = chunksByNode.get(nodeKey(node));
        chunk.symbolIds.push(symbol.id);
        if (chunk.kind === 'function' && scope === moduleScope) chunk.names.push(name);
        highlights.push({start:nameNode.from, end:nameNode.to, symbolId:symbol.id});
        bind(scope, name, {kind:'function', symbol});
      } else bind(scope, name, {kind:'class', scope:childScope});
      if (body) for (const part of children(body)) discover(part, childScope, [], conditional);
      return;
    }
    if (node.name === 'LambdaExpression') return;
    if (comprehensions.test(node.name)) {
      // Assignment expressions bind outside a comprehension; its for-targets do not.
      walk(node, part => {
        if (part.name === 'LambdaExpression') return false;
        if (part.name === 'NamedExpression') {
          const target = children(part).find(child => child.name === 'VariableName');
          if (target) bind(scope, text(target));
        }
      });
      return;
    }
    if (node.name === 'CapturePattern') {
      const target = children(node).find(part => part.name === 'VariableName');
      if (target) bind(scope, text(target));
    }
    if (node.name === 'AsPattern') {
      const parts = children(node), alias = parts.findIndex(part => part.name === 'as');
      if (alias >= 0 && parts[alias + 1]) bindTarget(parts[alias + 1], scope);
    }
    if (node.name === 'AssignStatement' || node.name === 'UpdateStatement') collectAssignments(node, scope);
    if (node.name === 'ImportStatement' || node.name === 'ImportFromStatement') {
      const parts=children(node),at=parts.findIndex(p=>p.name==='import'),from=parts.findIndex(p=>p.name==='from');
      const module=from<0?null:code.slice(parts[from].to,parts[at].from).trim();
      let conditional=false;for(let p=node.parent;p;p=p.parent)if(/^(If|Try|For|While|Match)Statement$/.test(p.name))conditional=true;
      let group=[];const add=()=>{if(!group.length)return;const as=group.findIndex(p=>p.name==='as'),original=code.slice(group[0].from,(as<0?group.at(-1):group[as-1]).to).trim();const local=as<0?(from<0?original.split('.')[0]:original):text(group[as+1]);if(local!=='*')bind(scope,local,{kind:'import',module:module??original,imported:from<0?null:original,access:from<0?(as<0?original:local):local,line:lineAt(node.from),conditional});group=[];};
      for(const p of parts.slice(at+1)){if([',',')'].includes(p.name))add();else if(!['(','Comment'].includes(p.name))group.push(p);}add();
      if (children(node).some(part => part.name === '*')) scope.wildcardImport = true;
    }
    if (node.name === 'ScopeStatement') {
      const parts = children(node), target = parts[0]?.name === 'global' ? scope.globals : scope.nonlocals;
      parts.filter(part => part.name === 'VariableName').forEach(part => target.add(text(part)));
    }
    if (node.name === 'ForStatement') {
      const parts = children(node), from = parts.findIndex(part => part.name === 'for'), to = parts.findIndex(part => part.name === 'in');
      parts.slice(from + 1, to).forEach(part => bindTarget(part, scope));
    }
    if (node.name === 'WithStatement' || node.name === 'TryStatement') {
      const parts = children(node);
      for (let index = 0; index < parts.length; index++) if (parts[index].name === 'as' && parts[index + 1]) bindTarget(parts[index + 1], scope);
    }
    if (node.name === 'NamedExpression') {
      const name = children(node).find(part => part.name === 'VariableName');
      if (name) bind(scope, text(name));
    }
    if (node.name === 'DeleteStatement') children(node).slice(1).forEach(part => bindTarget(part, scope));
    for (const part of children(node)) discover(part, scope, [], conditional || /^(If|Try|While|For|Match)Statement$/.test(node.name));
  }
  discover(root, moduleScope);

  // Global/nonlocal declarations override normal local binding collection. Writes
  // through them deliberately make the destination uncertain rather than guessing.
  for (const scope of scopes.values()) {
    for (const name of scope.globals) {
      if (scope.writes.has(name)) bind(moduleScope, name);
      scope.bindings.delete(name);
    }
    for (const name of scope.nonlocals) {
      if (scope.writes.has(name)) {
        let outer = scope.parent;
        while (outer && (outer.type !== 'function' || !outer.bindings.has(name))) outer = outer.parent;
        if (outer) bind(outer, name);
      }
      scope.bindings.delete(name);
    }
    if (scope.symbol) scope.symbol.locals = new Set(scope.bindings.keys());
  }
  function lexicalParent(scope) {
    let parent = scope.parent;
    if (['function', 'comprehension'].includes(scope.type)) while (parent?.type === 'class') parent = parent.parent;
    return parent;
  }
  function bindingOf(scope, name) {
    if (scope.globals.has(name)) scope = moduleScope;
    else if (scope.nonlocals.has(name)) {
      scope = lexicalParent(scope);
      while (scope && (scope.type !== 'function' || !scope.bindings.has(name))) scope = lexicalParent(scope);
    }
    for (let current = scope; current; current = lexicalParent(current)) {
      if (current.wildcardImport) return null;
      if (current.bindings.has(name)) {
        const values = current.bindings.get(name);
        return {scope:current, entity:values.size === 1 ? [...values][0] : null};
      }
    }
    return null;
  }
  function classForReceiver(scope, receiver) {
    const binding = bindingOf(scope, receiver);
    if (binding?.entity?.kind === 'class') return binding.entity.scope;
    if (binding?.scope.classScope && binding.scope.receiverName === receiver && !binding.scope.writes.has(receiver)) return binding.scope.classScope;
    return null;
  }
  for (const write of memberWrites) classForReceiver(write.scope, write.receiver)?.replacedMembers.add(write.member);
  function targetOf(scope, name) {
    if (!name.includes('.')) return bindingOf(scope, name)?.entity?.symbol?.id;
    const parts = name.split('.');
    if (parts.length !== 2) return undefined;
    const [receiver, method] = parts, classScope = classForReceiver(scope, receiver);
    if (classScope?.replacedMembers.has(method)) return undefined;
    const methods = classScope?.bindings.get(method);
    return methods?.size === 1 ? [...methods][0].symbol?.id : undefined;
  }
  function comprehensionScope(node, parent) {
    const scope = makeScope('comprehension', parent), parts = children(node);
    let collecting = false;
    for (const part of parts) {
      if (part.name === 'for') collecting = true;
      else if (part.name === 'in') collecting = false;
      else if (collecting) bindTarget(part, scope);
    }
    const firstIn = parts.findIndex(part => part.name === 'in');
    const firstIterable = firstIn >= 0 ? parts.slice(firstIn + 1).find(part => !['for', 'if', ']', '}', ')'].includes(part.name)) : null;
    return {scope, firstIterable};
  }
  function addCall(callee, node, scope, kind) {
    const name = text(callee);
    if (!/^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(name)) return;
    const targetId = targetOf(scope, name);
    const binding=bindingOf(scope,name.split('.')[0]),entity=binding?.entity;
    const replaced=memberWrites.some(w=>w.receiver===name.split('.')[0]&&bindingOf(w.scope,w.receiver)?.entity===entity);
    let importedRef=null;
    if(!targetId&&entity?.kind==='import'&&!entity.conditional&&!replaced){
      const suffix=name===entity.access?'':name.startsWith(entity.access+'.')?name.slice(entity.access.length+1):null;
      if(suffix!==null)importedRef={module:entity.module,name:entity.imported?(suffix?entity.imported+'.'+suffix:entity.imported):suffix,importLine:entity.line,fromImport:entity.imported!==null};
    }
    const call = {name, start:callee.from, end:callee.to, line:lineAt(callee.from), direct:callee.name === 'VariableName', resolved:true,bindingKind:entity?.kind||(binding?'ambiguous':'unbound'),...(importedRef?{importedRef}:{}), ...(targetId ? {targetId} : {}), ...(kind ? {kind} : {})};
    chunksByNode.get(nodeKey(node))?.calls.push(call);
    nearestFunction(scope)?.symbol.calls.push(call);
  }
  function read(node, scope) {
    if (node.name === 'DecoratedStatement') {
      for (const part of children(node)) {
        if (part.name === 'Decorator') {
          // @helper implicitly calls helper when the definition is evaluated.
          const expression = children(part).find(child => child.name !== 'At');
          if (expression && ['VariableName', 'MemberExpression'].includes(expression.name)) addCall(expression, part, scope, 'decorator');
          else read(part, scope);
        } else read(part, scope);
      }
      return;
    }
    if (definitions.has(node.name)) {
      for (const part of children(node)) read(part, part.name === 'Body' ? scopes.get(nodeKey(node)) : scope);
      return;
    }
    // Anonymous functions are values; their eventual invocation is not inferred.
    if (node.name === 'LambdaExpression') return;
    if (comprehensions.test(node.name)) {
      const local = comprehensionScope(node, scope);
      for (const part of children(node)) read(part, local.firstIterable && part.from === local.firstIterable.from && part.to === local.firstIterable.to ? scope : local.scope);
      return;
    }
    if (node.name === 'CallExpression' && node.firstChild) addCall(node.firstChild, node, scope);
    const symbol = nearestFunction(scope)?.symbol;
    if (node.name === 'ReturnStatement' && symbol) {
      const expression = node.firstChild?.nextSibling;
      if (expression) symbol.returns.push(code.slice(expression.from, node.to).trim());
    }
    if (['YieldStatement','YieldExpression'].includes(node.name) && symbol) symbol.generator = true;
    if (/^(If|While|For|Match)Statement$/.test(node.name)) {
      const parts = children(node), body = parts.find(part => part.name === 'Body');
      const condition = code.slice(parts[0]?.to ?? node.from, body?.from ?? node.to).trim();
      const branch = {type:node.name.replace('Statement', '').toLowerCase(), condition, line:lineAt(node.from)};
      chunksByNode.get(nodeKey(node))?.branches.push(branch);
      symbol?.branches.push(branch);
    }
    for (const part of children(node)) read(part, scope);
  }
  read(root, moduleScope);
  symbols.forEach(symbol => {symbol.returns = [...new Set(symbol.returns)];});
  return {code, filename, language:'Python', chunks, symbols, highlights, tokens, comments, lineCount:lineStarts.length, moduleBindings:[...moduleScope.bindings.keys()],moduleWildcard:!!moduleScope.wildcardImport, moduleExports:[...moduleScope.bindings].filter(([,values])=>!moduleScope.wildcardImport&&values.size===1&&[...values][0].kind==='function'&&![...values][0].symbol.conditional).map(([name,values])=>({name,id:[...values][0].symbol.id})), analysisNotes:['Python links use lexical names and methods on a recognizable class receiver. Runtime aliases, inheritance, imported implementations, anonymous functions, and dynamically replaced methods are not traced. Branches describe possible paths; code is not executed.','The editor grammar does not cover every Python version or valid syntax form. Destructured with-as targets may need a simpler named target for local analysis.']};
}
