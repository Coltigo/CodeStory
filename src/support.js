export const OFFICIAL_LANGUAGES=['Python','HTML','JavaScript','Java','C#','SQL'];
const extensions={py:'Python',pyw:'Python',html:'HTML',htm:'HTML',js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',java:'Java',cs:'C#',csx:'C#',sql:'SQL',ts:'TypeScript',tsx:'TypeScript',rb:'Ruby',go:'Go',rs:'Rust',c:'C',h:'C/C++',cpp:'C++',cc:'C++',cxx:'C++',hpp:'C++',php:'PHP',swift:'Swift',kt:'Kotlin',kts:'Kotlin',r:'R',sh:'Shell',bash:'Shell',zsh:'Shell',css:'CSS',json:'JSON',yaml:'YAML',yml:'YAML',lua:'Lua',pl:'Perl',scala:'Scala',dart:'Dart',vue:'Vue',svelte:'Svelte',md:'Markdown',txt:'Plain text'};
export function languageSupport(filename='untitled.py'){
  const extension=filename.toLowerCase().split('.').pop(),language=extensions[extension]||'Other language',official=OFFICIAL_LANGUAGES.includes(language);
  return {language,extension,official,level:official?'official':'experimental',label:official?'Official support':'Experimental support',warning:official?'':`${language} is not officially supported. We cannot guarantee the quality of its parsing or explanations. Verify every explanation against the source.`};
}
export const languageIcon=language=>({'Python':'PY','HTML':'<>','JavaScript':'JS','Java':'JV','C#':'C#','SQL':'SQL','TypeScript':'TS'}[language]||'TXT');
export function assertTextSource(code){
  if(typeof code!=='string'||/\u0000/.test(code)||([...code].filter(c=>/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(c)).length>Math.max(2,code.length*.01)))throw new Error('Choose a plain-text source file. Binary files cannot be analyzed.');
}
export function analyzeText(code,filename,language){
  const chunks=[],lines=code.split('\n');let start=0,offset=0,startLine=1;
  function add(end,endLine){if(code.slice(start,end).trim())chunks.push({id:'c'+chunks.length,start,end,startLine,endLine,kind:'text',names:[],symbolIds:[],calls:[],nodeType:'TextSection',typeLabel:'Text section'});start=end;startLine=endLine+1;}
  for(let i=0;i<lines.length;i++){offset+=lines[i].length+(i<lines.length-1?1:0);if((!lines[i].trim()&&i+1-startLine>=3)||i+1-startLine>=24||i===lines.length-1)add(offset,i+1);}
  return {code,filename,language,chunks,symbols:[],highlights:[],tokens:[],comments:[],lineCount:lines.length,analysisNotes:['This is a plain-text reading guide. Language grammar, function definitions, call relationships, and execution order have not been verified.'],preferredFlow:chunks.map(c=>c.id)};
}
