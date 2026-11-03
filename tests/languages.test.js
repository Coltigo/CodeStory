import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeLanguage,describeLanguageChunk} from '../src/languages.js';

function checkSource(model){
  assert.ok(model.chunks.length);
  for(const item of model.chunks){assert.ok(item.start<item.end);assert.ok(model.code.slice(item.start,item.end).trim());assert.equal(item.startLine,model.code.slice(0,item.start).split('\n').length);assert.equal(item.endLine,model.code.slice(0,item.end-1).split('\n').length);}
  const ordered=[...model.chunks].sort((a,b)=>a.start-b.start);
  for(let i=1;i<ordered.length;i++)assert.ok(ordered[i-1].end<=ordered[i].start,`Overlapping sections: ${ordered[i-1].id}, ${ordered[i].id}`);
  for(const token of model.tokens)assert.ok(token.start>=0&&token.end<=model.code.length);
}

test('HTML parses nested elements and inert embedded sections with source relationships',()=>{
  const code='<!doctype html>\n<html>\n<head><title>Useful page</title><style>p { color: blue; }</style></head>\n<body><main id="app"><h1>Welcome</h1><p>Read me</p></main><script src="app.js"></script></body>\n</html>';
  const model=analyzeLanguage(code,'index.html','HTML');checkSource(model);
  assert.ok(model.chunks.some(c=>c.names.includes('<main#app>')));
  const script=model.chunks.find(c=>c.kind==='script');assert.equal(script.externalSource,'app.js');
  assert.match(describeLanguageChunk(script,model).body,/outside this file/);
  assert.ok(model.chunks.some(c=>c.kind==='style'));
  assert.ok(model.chunks.find(c=>c.names.includes('<h1>')).parentChunkId);
  assert.deepEqual(model.preferredFlow,model.chunks.map(c=>c.id));assert.deepEqual(model.symbols,[]);
});
test('HTML optional closing tags and text containing code are preserved',()=>{
  const code='<ul><li>One<li>Two</ul><pre>if (x &lt; 3) say("hello");</pre>';
  const model=analyzeLanguage(code,'list.htm','HTML');checkSource(model);assert.equal(model.code,code);assert.equal(model.symbols.length,0);
});
test('Java extracts static methods, parameters, returns, entry point and unique local links',()=>{
  const code='package demo;\nimport java.util.List;\npublic class Main {\n  static int add(int a, int b) { return a + b; }\n  public static void main(String[] args) { int total = add(2, 3); System.out.println(total); }\n}';
  const model=analyzeLanguage(code,'Main.java','Java');checkSource(model);
  const add=model.symbols.find(s=>s.simpleName==='add'),main=model.symbols.find(s=>s.simpleName==='main');
  assert.deepEqual(add.params,['int a','int b']);assert.deepEqual(add.returns,['a + b']);assert.equal(main.entryPoint,true);
  assert.equal(main.calls.find(c=>c.sourceName==='add').targetId,add.id);
  assert.equal(main.calls.find(c=>c.sourceName==='System.out.println').direct,false);
  assert.ok(main.calls.every(c=>c.resolved===true));assert.equal(model.analysisNotes.some(n=>/recovered syntax/.test(n)),false);
});
test('Java overloads, object receivers, and virtual calls are not assigned guessed targets',()=>{
  const code='class A { static int help(int x){return x;} static int help(String x){return 0;} int work(){return 1;} void run(A other){ help(1); other.work(); work(); } }';
  const model=analyzeLanguage(code,'A.java','Java'),run=model.symbols.find(s=>s.simpleName==='run');
  assert.equal(new Set(model.symbols.map(s=>s.name)).size,model.symbols.length);
  assert.ok(run.calls.every(c=>!c.direct&&!c.targetId));
});
test('C# patched grammar handles ordinary types, namespaces, expression bodies and calls',()=>{
  const code='using System;\nnamespace Demo {\n  public class Program {\n    public static void Main(string[] args) { int answer = Add(2, 3); Console.WriteLine(answer); }\n    static int Add(int left, int right) => left + right;\n  }\n}';
  const model=analyzeLanguage(code,'Program.cs','C#');checkSource(model);
  const main=model.symbols.find(s=>s.simpleName==='Main'),add=model.symbols.find(s=>s.simpleName==='Add');
  assert.equal(main.name,'Demo.Program.Main');assert.equal(main.entryPoint,true);assert.deepEqual(add.params,['int left','int right']);assert.deepEqual(add.returns,['left + right']);
  assert.equal(main.calls.find(c=>c.sourceName==='Add').targetId,add.id);
  assert.equal(main.calls.find(c=>c.sourceName==='Console.WriteLine').direct,false);
  assert.equal(model.analysisNotes.some(n=>/recovered syntax/.test(n)),false);
});
test('C# this receivers, constructors, overloads and virtual dispatch remain distinct',()=>{
  const code='class A { public A(int n){} public virtual int Help(){return 1;} static int Add(int n){return n;} static int Add(string n){return 0;} void Run(A other){ this.Help(); other.Help(); Add(1); } }';
  const model=analyzeLanguage(code,'A.cs','C#');checkSource(model);
  const run=model.symbols.find(s=>s.simpleName==='Run');assert.ok(model.symbols.some(s=>s.constructor));assert.ok(run.calls.every(c=>!c.direct));
  assert.deepEqual(run.calls.map(c=>c.sourceName),['this.Help','other.Help','Add']);
});
test('C# top-level statements and local helpers are parsed in their own grammar context',()=>{
  const code='using System;\nConsole.WriteLine(Double(3));\nint Double(int number) => number * 2;';
  const model=analyzeLanguage(code,'small.cs','C#');checkSource(model);
  const helper=model.symbols.find(s=>s.simpleName==='Double');assert.ok(helper);assert.deepEqual(helper.returns,['number * 2']);
  assert.ok(model.chunks.some(c=>c.kind==='execution'&&c.calls.some(call=>call.targetId===helper.id)));
  assert.equal(model.analysisNotes.some(n=>/recovered syntax/.test(n)),false);
});
test('C# file-scoped namespaces and generic return types keep the correct method names',()=>{
  const code='namespace Useful.Tools;\nclass Worker { static Task<string> Load(string name) { return Fetch(name); } static Task<string> Fetch(string name) { return null; } }';
  const model=analyzeLanguage(code,'Worker.cs','C#');checkSource(model);
  assert.deepEqual(model.symbols.map(s=>s.name),['Useful.Tools.Worker.Load','Useful.Tools.Worker.Fetch']);
});
test('C# constructors can omit base initializers and interface methods remain declarations',()=>{
  const code='namespace Demo { interface IWorker { int Work(int n); } class Worker { public int Count {get;set;} public Worker(int n){Count=n;} } }';
  const model=analyzeLanguage(code,'Worker.cs','C#');checkSource(model);
  assert.ok(model.symbols.some(s=>s.name==='Demo.IWorker.Work'&&s.virtualDispatch));
  assert.ok(model.symbols.some(s=>s.constructor&&s.params[0]==='int n'));
  assert.ok(model.chunks.some(c=>c.kind==='data'&&c.names.includes('Count')));
  assert.equal(model.analysisNotes.some(n=>/recovered syntax/.test(n)),false);
});
test('C# interpolation consumes braces and preserves nested calls in regular and verbatim strings',()=>{
  const code='using System;\nclass Converter { static string Describe(double n) => "cool"; static void Main(){ double n=20; Console.WriteLine($"{n} F - {Describe(n)}"); Console.WriteLine($@"value {{literal}} {Describe(n)} end"); } }';
  const model=analyzeLanguage(code,'Converter.cs','C#');checkSource(model);
  assert.equal(model.analysisNotes.some(n=>/recovered syntax/.test(n)),false);
  const describe=model.symbols.find(s=>s.simpleName==='Describe'),main=model.symbols.find(s=>s.simpleName==='Main');
  assert.equal(main.calls.filter(c=>c.targetId===describe.id).length,2);
  assert.ok(main.calls.filter(c=>c.targetId===describe.id).every(c=>code.slice(c.start,c.end)==='Describe'));
});
test('SQL splits statements without splitting quoted semicolons and derives table/CTE relationships',()=>{
  const code="-- a useful query\nCREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100));\nINSERT INTO users (id, name) VALUES (1, 'Ada; Lovelace');\nWITH active AS (SELECT id, name FROM users WHERE id > 0) SELECT active.name FROM active JOIN profiles ON profiles.user_id = active.id ORDER BY active.name;";
  const model=analyzeLanguage(code,'users.sql','SQL');checkSource(model);
  assert.equal(model.chunks.length,3);assert.deepEqual(model.chunks.map(c=>c.operation),['CREATE','INSERT','SELECT']);
  const query=model.chunks[2];assert.deepEqual(query.ctes,['active']);assert.ok(query.tables.includes('users'));assert.ok(query.tables.includes('profiles'));assert.ok(!query.tables.includes('active'));assert.ok(query.clauses.includes('join'));assert.ok(query.clauses.includes('where'));
  assert.equal(query.partial,false);assert.deepEqual(model.symbols,[]);assert.deepEqual(model.preferredFlow,model.chunks.map(c=>c.id));
});
test('SQL clauses do not invent DISTINCT or LIMIT from empty AST placeholders',()=>{
  const model=analyzeLanguage('SELECT name FROM people;','simple.sql','SQL');assert.deepEqual(model.chunks[0].clauses,[]);assert.deepEqual(model.chunks[0].tables,['people']);
});
test('SQL column aliases are not mistaken for physical table references',()=>{
  const model=analyzeLanguage('SELECT u.name, p.title FROM users AS u JOIN profiles AS p ON p.user_id = u.id;','aliases.sql','SQL');assert.deepEqual(model.chunks[0].tables,['users','profiles']);
});
test('SQL PostgreSQL dollar strings and unsupported vendor statements preserve source with bounded claims',()=>{
  const model=analyzeLanguage("SELECT $$hello; world$$;\nVACUUM (ANALYZE, VERBOSE) unusual_table;",'vendor.sql','SQL');checkSource(model);
  assert.equal(model.chunks.length,2);const partial=model.chunks.find(c=>c.partial);assert.ok(partial);assert.deepEqual(partial.tables,[]);assert.match(describeLanguageChunk(partial,model).body,/could not fully parse/);assert.ok(model.analysisNotes.some(n=>/partially parsed/.test(n)));
});
