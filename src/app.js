import {installProjects} from './projects-view.js';
import {installTabKeys} from './tabs.js';
import {functionTiming} from './semantics.js';
import {analyze,orderedChunks,describeChunk,humanize,MAX_CHARS} from './parser.js';
import {samples} from './samples.js';
import {languageSupport,languageIcon,assertTextSource} from './support.js';
import {WORKSHOP_PREMISE,describeStoryChunk,storyFunction,storyReadiness} from './narrative.js';
import {installConnections,PROVIDER_COPY} from './connections.js';
import {installDialogMotion} from './dialogs.js';
import {installMovingIndicators} from './indicators.js';
import {renderInspection,renderNameExplorer,inspectionTitle} from './inspection-view.js';
const $=id=>document.getElementById(id);
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let aiResult=null,accountStatus={active:null,accounts:[]},csrfToken=null,availableModels=[],analyzing=false,analysisController=null,authTimer=null,authPolling=false,lastAuthFeedback=0;
let connectionNotice='',modelsLoading=false,modelsRequest=0,statusRequest=0,pendingAnalysis=null,fileReadRequest=0,connectionUI=null,projectUI=null,workspaceArea='single',returnArea='single',hasUserWork=false;
function currentConnection(){if(Object.hasOwn(accountStatus,'connection'))return accountStatus.connection;const active=accountStatus.active;return active?{id:active.id,kind:'chatgpt_plan',provider:'chatgpt',label:active.email,ready:active.connected&&active.planEnabled,billing:'plan'}:null;}
let model=analyze(samples[1].code,samples[1].filename), mode='beginner',storyMode=false,activeId=model.concepts[0], selectedSymbol=null,view='inspection',nameSelection=null,nameOpener=null,selectedSourceRange=null,sampleIndex=1,completed=new Set(),toastTimer,sourceHistory=[];
const cssColor=s=>`var(--${s.color})`;
const symbolById=id=>model.symbols.find(s=>s.id===id);
const chapterById=id=>model.chunks.find(c=>c.id===id);
const symbolLabel=s=>s.qualifiedName||s.name;
const chip=id=>{const s=symbolById(id);return s?`<button class="function-chip" data-symbol="${s.id}" style="--symbol:${cssColor(s)}" title="Explore ${esc(symbolLabel(s))}">${esc(symbolLabel(s))}<span>↗</span></button>`:'';};
const lineRange=c=>c.startLine===c.endLine?`L${c.startLine}`:`L${c.startLine}–${c.endLine}`;
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2600);}
function getChunks(){const level=storyMode?'developer':mode;return aiResult?(level==='beginner'?aiResult.story.conceptOrder:aiResult.story.flowOrder).map(id=>chapterById(id)):orderedChunks(model,level);}
function getLiteralDescription(c){const text=aiResult?.story.chapters.find(x=>x.id===c.id);return text?{title:text.title,body:mode==='beginner'?text.beginner:text.developer,concept:text.concept,term:text.term}:describeChunk(c,model,mode);}
function getDescription(c){const literal=getLiteralDescription(c);if(!storyMode)return literal;const text=aiResult?.story.chapters.find(x=>x.id===c.id);return text?.storyBeginner?{title:literal.title,body:mode==='beginner'?text.storyBeginner:text.storyDeveloper,concept:'Workshop scene',term:'',literal}:describeStoryChunk(c,model,mode,literal);}
function richText(text){
  const candidates=new Map();for(const s of model.symbols){candidates.set(symbolLabel(s),s);if(model.symbols.filter(x=>x.name===s.name).length===1)candidates.set(s.name,s);}
  const names=[...candidates.keys()].filter(Boolean).sort((a,b)=>b.length-a.length);if(!names.length)return esc(text);
  const pattern=new RegExp('(?<![\\w$])('+names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')(?![\\w$])','g');
  let html='',offset=0;for(const match of text.matchAll(pattern)){html+=esc(text.slice(offset,match.index));const symbol=candidates.get(match[0]);html+=`<button class="inline-symbol" data-symbol="${symbol.id}" style="--symbol:${cssColor(symbol)}">${esc(match[0])}</button>`;offset=match.index+match[0].length;}return html+esc(text.slice(offset));
}
function completionLabel(chapter,number){return `Chapter ${number}: ${getDescription(chapter).title}. Mark ${completed.has(chapter.id)?'incomplete':'complete'}`;}
function toggleCompletion(button){
  const id=button.dataset.complete,chapter=chapterById(id);if(!chapter)return;
  if(completed.has(id))completed.delete(id);else completed.add(id);
  const done=completed.has(id);button.classList.toggle('is-complete',done);button.setAttribute('aria-pressed',String(done));button.setAttribute('aria-label',completionLabel(chapter,Number(button.dataset.number)));button.title=done?'Mark incomplete':'Mark complete';button.textContent=done?'✓':button.dataset.number;renderChapterNav();
}
function inspectionLink(fact){return `<button class="line-link" data-inspect-start="${fact.startLine}" data-inspect-end="${fact.endLine}" data-inspect-chunk="${fact.chunkId}" aria-label="Show inspection source lines ${fact.startLine} through ${fact.endLine}">${lineRange(fact)} ↗</button>`;}
function showNameExplorer(){const el=$('inspection-name-explorer');if(!el)return;el.hidden=!nameSelection;if(nameSelection)el.innerHTML=renderNameExplorer(model,nameSelection.value,nameSelection.scopeId,{esc,link:inspectionLink});}
function renderChapterNav(){
  $('chapter-nav').innerHTML=getChunks().map((c,i)=>`<button data-chapter="${c.id}" class="${c.id===activeId?'active':''}" ${c.id===activeId?'aria-current="step"':''}><span class="nav-num">${String(i+1).padStart(2,'0')}</span><span>${esc(view==='inspection'?inspectionTitle(c):getDescription(c).title)}</span><span class="mini-dot ${completed.has(c.id)?'is-complete':''}" aria-hidden="true">${completed.has(c.id)?'✓':''}</span>${completed.has(c.id)?'<span class="sr-only">Completed</span>':''}</button>`).join('');
}
function render(){
  const chunks=getChunks();
  for(const id of ['side-filename','crumb-filename','source-filename'])$(id).textContent=model.filename;
  $('file-icon').textContent=languageIcon(model.language);
  $('side-stats').textContent=`${model.language} · ${model.lineCount} lines`;
  $('chapter-count').textContent=String(chunks.length).padStart(2,'0');$('story-count').textContent=chunks.length;
  $('source-language').textContent=model.language;
  $('map-tab').querySelector('span').textContent=['HTML','SQL'].includes(model.language)?'Structure map':'Call map';
  $('literal-mode').classList.toggle('selected',!storyMode);$('story-mode').classList.toggle('selected',storyMode);$('literal-mode').setAttribute('aria-pressed',String(!storyMode));$('story-mode').setAttribute('aria-pressed',String(storyMode));
  $('story-premise').hidden=!storyMode||view!=='story';$('story-premise-text').textContent=aiResult?.story.narrative?.premise||WORKSHOP_PREMISE;$('story-mode-note').textContent=aiResult?'AI story · grounded in the supplied file':'Local story · based on visible structure';
  document.body.classList.toggle('narrative-active',storyMode);
  $('language-notice').classList.toggle('experimental',!model.support.official);
  $('language-notice').innerHTML=`<div><strong>${esc(model.language)} · ${esc(model.support.label)}</strong>${model.warnings.length?`<p>${model.warnings.map(esc).join(' ')}</p>`:''}</div>${model.analysisNotes.length?`<details><summary>Analysis limits</summary><ul>${model.analysisNotes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></details>`:''}`;
  $('beginner').classList.toggle('selected',mode==='beginner');$('developer').classList.toggle('selected',mode==='developer');
  $('beginner').setAttribute('aria-pressed',String(mode==='beginner'));$('developer').setAttribute('aria-pressed',String(mode==='developer'));
  renderChapterNav();
  $('story').innerHTML=chunks.map((c,i)=>{
    const d=getDescription(c),ids=[...new Set([...c.symbolIds,...c.symbolIds.flatMap(id=>symbolById(id).dependencies),...c.calls.map(call=>call.targetId).filter(Boolean)])];
    return `<article class="chapter ${activeId===c.id?'active':''}" id="chapter-${c.id}" data-card="${c.id}"><button type="button" class="chapter-number ${completed.has(c.id)?'is-complete':''}" data-complete="${c.id}" data-number="${String(i+1).padStart(2,'0')}" aria-pressed="${completed.has(c.id)}" aria-label="${esc(completionLabel(c,i+1))}" title="${completed.has(c.id)?'Mark incomplete':'Mark complete'}">${completed.has(c.id)?'✓':String(i+1).padStart(2,'0')}</button><div class="chapter-card"><div class="chapter-heading"><span class="chapter-category">${esc(d.concept)}</span><button class="line-link" data-source="${c.id}" aria-label="Show lines ${c.startLine} through ${c.endLine}">${lineRange(c)} ↗</button></div><h2>${esc(d.title)}</h2>${d.body.split(/\n\s*\n/).map(p=>`<p>${richText(p)}</p>`).join('')}${d.literal?`<details class="literal-explanation"><summary>What the code actually does</summary><p>${richText(d.literal.body)}</p></details>`:''}${ids.length?`<div class="function-chips">${ids.map(chip).join('')}</div>`:''}${mode==='beginner'&&d.term?`<div class="concept-note"><strong>${storyMode?'About this metaphor':'A quick definition'}</strong>${esc(d.term)}</div>`:''}</div></article>`;
  }).join('');
  $('file-inspection').innerHTML=renderInspection(model,{esc,chip,link:inspectionLink,activeId,hasAI:!!aiResult,analyzing});showNameExplorer();
  renderSource();renderInspector();renderMap();renderAIUI();setView(view);
}
function renderSource(){
  const tokens=model.tokens.filter(t=>t.end>t.start),highlights=model.highlights;
  let offset=0;
  $('code').innerHTML=model.code.split('\n').map((line,i)=>{
    const begin=offset,end=begin+line.length;offset=end+1;
    const ranges=[...tokens.filter(t=>t.start<end&&t.end>begin).map(t=>{const label=typeof t.type==='string'?t.type:t.type.label;let cls=label==='string'?'string':label==='num'?'num':t.type.keyword||label==='keyword'?'keyword':label==='comment'?'comment':'';return {start:Math.max(begin,t.start),end:Math.min(end,t.end),cls};}),...(model.comments||[]).filter(t=>t.start<=end&&t.end>=begin).map(t=>({start:Math.max(begin,t.start),end:Math.min(end,t.end),cls:'comment'}))];
    const hs=highlights.filter(h=>h.start>=begin&&h.end<=end);
    const cuts=[...new Set([begin,end,...ranges.flatMap(r=>[r.start,r.end]),...hs.flatMap(r=>[r.start,r.end])])].sort((a,b)=>a-b);
    let html='';for(let k=0;k<cuts.length-1;k++){const a=cuts[k],b=cuts[k+1],fragment=esc(model.code.slice(a,b)),h=hs.find(h=>h.start<=a&&h.end>=b),r=ranges.find(r=>r.cls&&r.start<=a&&r.end>=b);if(h){const s=symbolById(h.symbolId);html+=`<button class="code-function" data-symbol="${s.id}" style="--symbol:${cssColor(s)}" aria-label="Explore ${esc(s.name)}">${fragment}</button>`;}else html+=r?.cls?`<span class="token-${r.cls}">${fragment}</span>`:fragment;}
    return `<div class="code-line" data-line="${i+1}"><span class="line-no">${i+1}</span><span class="line-text">${html||' '}</span></div>`;
  }).join('');
  markLines(false);
}
function markLines(scroll=true){const c=selectedSourceRange||chapterById(activeId);if(!c)return;$('source-range').textContent=`Selected: ${lineRange(c)}`;document.querySelectorAll('.code-line').forEach(el=>el.classList.toggle('focus',Number(el.dataset.line)>=c.startLine&&Number(el.dataset.line)<=c.endLine));if(scroll){const line=$('code').querySelector(`[data-line="${c.startLine}"]`);if(line)$('code-scroll').scrollTo({top:Math.max(0,line.offsetTop-$('code').offsetTop-45),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}
function renderInspector(){
  const el=$('inspector'),s=symbolById(selectedSymbol);
  if(!s){el.innerHTML=`<div class="inspector-eyebrow">MEET THE FUNCTIONS <span>↗</span></div><div class="placeholder-icon">ƒ</div><h3>There’s a reason for every step.</h3><p>Click a colored function in a chapter or the source to see its inputs, return expressions, and connections.</p>`;return;}
  const aiFunction=aiResult?.story.functions.find(f=>f.id===s.id);
  const external=[...new Set(s.calls.filter(c=>!c.targetId||!s.dependencies.includes(c.targetId)).map(c=>c.name))];
  const narrative=storyMode?(aiFunction?(mode==='beginner'?aiFunction.storyBeginner:aiFunction.storyDeveloper)||storyFunction(s,model,mode):storyFunction(s,model,mode)):null;
  el.innerHTML=`<div class="inspector-eyebrow"><span>FUNCTION EXPLORER</span><button data-close-inspector aria-label="Close function explorer">×</button></div><h3 style="color:${cssColor(s)}">${esc(symbolLabel(s))}</h3><p>${s.async?'An async function. ':''}${mode==='beginner'?functionTiming(s,model.language)+' These are the inputs and connections visible in this file.':'Static analysis of '+lineRange(s)+'. Dynamic dispatch and external implementations are not resolved.'}</p>${narrative?`<div class="inspector-section"><strong>STORY MODE · WORKSHOP METAPHOR</strong><p class="narrative-purpose">${richText(narrative)}</p></div>`:''}${s.docstring?`<div class="inspector-section"><strong>DOCUMENTATION</strong><p>${esc(s.docstring)}</p></div>`:''}${aiFunction?`<div class="inspector-section"><span class="ai-label">AI EXPLANATION</span><p class="ai-purpose">${richText(aiFunction.purpose)}</p></div><div class="inspector-section"><strong>SIDE EFFECTS</strong><p>${esc(aiFunction.sideEffects)}</p></div>${aiFunction.caveats?`<div class="inspector-section"><strong>CONTEXT &amp; CAVEATS</strong><p>${esc(aiFunction.caveats)}</p></div>`:''}`:''}<div class="inspector-section"><strong>INPUTS ${s.params.length?'· '+s.params.length:''}</strong><code>${s.params.length?s.params.map(esc).join('\n'):'No named parameters'}</code></div><div class="inspector-section"><strong>RETURN EXPRESSIONS</strong><code>${s.returns.length?s.returns.map(r=>esc(r.length>350?r.slice(0,350)+'…':r)).join('\n\n'):'No explicit return expression found'}</code></div><div class="inspector-section"><strong>CALLS IN THIS FILE</strong>${s.dependencies.length?`<div class="function-chips">${s.dependencies.map(chip).join('')}</div>`:'<p>No confidently resolved calls to other functions in this file.</p>'}</div>${s.incoming.length?`<div class="inspector-section"><strong>CALLED BY</strong><div class="function-chips">${s.incoming.map(chip).join('')}</div></div>`:''}${external.length?`<div class="inspector-section"><strong>OTHER CALLS · IMPLEMENTATION NOT TRACED</strong><code>${external.map(esc).join('\n')}</code></div>`:''}<button class="jump-link" data-source="${s.chunkId}">View ${lineRange(s)} in source ↗</button>`;
}
function renderMap(){
 if(['HTML','SQL'].includes(model.language)){
  $('call-map').innerHTML=`<p class="map-note">${model.language==='HTML'?'Document sections and their containing elements, in source order. This is page structure, not a function-call graph.':'SQL statements and their referenced tables, in source order. This is a query reading guide, not a database execution plan.'}</p>${model.chunks.map(c=>`<div class="map-node"><div><button class="line-link" data-source="${c.id}">${esc(c.names.join(', ')||c.operation||c.typeLabel)}</button><small>${lineRange(c)}</small></div><p class="structure-summary">${esc(c.tables?.length?'Referenced tables: '+c.tables.join(', '):c.clauses?.length?'Clauses: '+c.clauses.join(', '):c.tag?'Element: '+c.tag:c.typeLabel)}</p>${c.parentChunkId?`<div class="structure-links">Inside <button data-source="${c.parentChunkId}">${esc(chapterById(c.parentChunkId)?.names.join(', ')||'containing element')}</button></div>`:''}</div>`).join('')}`;return;
 }
 $('call-map').innerHTML=`<p class="map-note">A map of confidently resolved calls between functions and methods in this file. It is a static reading guide, not a runtime trace. A function may be called from several places.</p>${model.symbols.length?model.symbols.map(s=>`<div class="map-node"><div>${chip(s.id)}<small>${model.entryIds.includes(s.id)?'POSSIBLE ENTRY':'FUNCTION'} · ${lineRange(s)}</small></div>${s.dependencies.length?`<span class="map-arrow">↓ calls</span><div class="function-chips">${s.dependencies.map(chip).join('')}</div>`:'<p>No confidently resolved call to another local function.</p>'}${s.incoming.length?`<p>Called by ${s.incoming.map(id=>esc(symbolById(id).name)).join(', ')}</p>`:''}</div>`).join(''):'<p class="map-note">No individually resolved function definitions were found. The storyline still explains the file’s top-level sections.</p>'}<div class="info-note">Imports, dynamic calls, inheritance, callbacks, and runtime branches may need more context. Analysis limits describe what this language parser resolves. Unconnected functions are still included in the story.</div>`;
}
function activate(id,scrollStory=false){if(activeId!==id){sourceHistory.push({activeId,selectedSymbol,selectedSourceRange,view});if(sourceHistory.length>100)sourceHistory.shift();$('source-back').hidden=false;}selectedSourceRange=null;activeId=id;document.querySelectorAll('[data-card]').forEach(el=>el.classList.toggle('active',el.dataset.card===id));document.querySelectorAll('[data-chapter]').forEach(el=>{el.classList.toggle('active',el.dataset.chapter===id);el.removeAttribute('aria-current');if(el.dataset.chapter===id)el.setAttribute('aria-current','step');});markLines();if(scrollStory){const inspect=view==='inspection';setView(inspect?'inspection':'story');$(inspect?'inspection-'+id:'chapter-'+id)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});}}
function selectSymbol(id){const s=symbolById(id);if(!s)return;activate(s.chunkId);selectedSymbol=id;renderInspector();$('inspector').classList.add('mobile-open');if(innerWidth<=760)$('inspector').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});}
function setView(next){
  view=next==='inspection'&&!model.inspection?'story':next;
  $('story').hidden=view!=='story';$('call-map').hidden=view!=='map';$('file-inspection').hidden=view!=='inspection';$('inspection-tab').hidden=!model.inspection;
  for(const [id,value]of[['inspection-tab','inspection'],['story-tab','story'],['map-tab','map']]){$(id).classList.toggle('active',value===view);$(id).setAttribute('aria-selected',String(value===view));$(id).tabIndex=value===view?0:-1;}
  document.body.classList.toggle('inspecting-file',view==='inspection');$('story-premise').hidden=!storyMode||view!=='story';$('file-overview').hidden=!aiResult||view!=='story';
  document.querySelector('.side-label .eyebrow').textContent=view==='inspection'?'IN THIS FILE':'IN THIS STORY';renderChapterNav();
}
function setMode(next){mode=next;render();toast(next==='beginner'?'Beginner mode: concepts first':'Developer mode: entry points and calls');}
function storyAvailability(){const local=storyReadiness(model);return !local.available?local:aiResult?.story.narrative?.available===false?{available:false,reason:aiResult.story.narrative.reason}:local;}
function showStoryUnavailable(){ $('story-unavailable-reason').textContent=storyAvailability().reason;if(!$('story-unavailable-dialog').open)$('story-unavailable-dialog').showModal();}
function setStoryMode(value){if(value&&!storyAvailability().available){showStoryUnavailable();return;}storyMode=value;view='story';render();toast(value?'Story Mode: a journey through the workshop':'Literal explanations');}
function openInput(){ renderInputLanguage();$('input-error').textContent='';$('input-dialog').showModal();setTimeout(()=>$('code-input').focus(),20);}
function inputTab(upload){$('paste-section').hidden=upload;$('upload-section').hidden=!upload;$('paste-tab').classList.toggle('active',!upload);$('upload-tab').classList.toggle('active',upload);}
function renderInputLanguage(){const support=languageSupport($('filename').value);$('input-language').textContent=`${support.language} · ${support.label}${support.warning?' — '+support.warning:''}`;$('input-language').classList.toggle('experimental',!support.official);$('analyze-button').textContent=support.language==='Python'?'Inspect file':'Create storyline';}
function setInput(code,filename){fileReadRequest++;$('code-input').value=code;$('filename').value=filename;$('input-size').textContent=`${code.length.toLocaleString()} / 80,000 characters`;renderInputLanguage();}
async function loadFile(file){const request=++fileReadRequest;if(!file)return;if(file.size>80000){$('input-error').textContent='This first version supports files up to 80 KB. Choose a smaller code file.';return;}try{const code=await file.text();if(request!==fileReadRequest)return;assertTextSource(code);setInput(code,file.name);$('uploaded-name').textContent=`✓ ${file.name} · ${(file.size/1000).toFixed(1)} KB`;$('input-error').textContent='';}catch(error){if(request===fileReadRequest)$('input-error').textContent=error.message||'This file could not be read. Try pasting its source code instead.';}}
function cancelCurrentAnalysis(){analysisController?.abort();analysisController=null;analyzing=false;pendingAnalysis=null;}
function loadModel(code,filename){const parsed=analyze(code,filename);hasUserWork=true;sourceHistory=[];$('source-back').hidden=true;fileReadRequest++;cancelCurrentAnalysis();$('consent-dialog').close();clearAIError();aiResult=null;model=parsed;nameSelection=null;nameOpener=null;selectedSourceRange=null;const storyBlocked=storyMode&&!storyAvailability().available;if(storyBlocked)storyMode=false;activeId=getChunks()[0].id;selectedSymbol=null;completed=new Set();setView(model.inspection?'inspection':'story');document.querySelector('.source-panel').classList.remove('mobile-open');$('inspector').classList.remove('mobile-open');render();if(storyBlocked)showStoryUnavailable();}
function info(kind){
  if(kind==='ai'){$('info-eyebrow').textContent='A CLEARER EXPLANATION';$('info-title').textContent='Choose how AI helps you read.';$('info-body').innerHTML=`<p>AI explanations should name the actual inputs, operations, conditions, and outputs visible in your code. Beginner mode defines concepts as they matter; Developer adds useful technical detail. Story Mode connects the same facts through a workshop metaphor.</p><p>Open <strong>AI Connections</strong> to use an eligible ChatGPT plan or an API key from OpenAI, Claude, or Gemini. Each connection uses its own provider’s allowance, credits, and billing. CodeStory never switches to another provider automatically.</p><p>Python starts with a local file inspection. Its source-backed facts accompany the original file in an AI scan. Before analysis, review the selected file, model, connection, and billing notice. Only confirming <strong>Analyze with AI</strong> sends your source. Both detail levels and explanation styles are generated together; switching either control makes no additional request.</p><div class="info-note">ChatGPT sign-in is stored in the protected local account file. API keys stay only in local server memory and must be reconnected after restarting. Local AI is a setup preview and does not connect to a model yet.</div><p>Local structural reading remains available without an account. AI descriptions can be wrong; use the source links and literal facts to check them.</p>`;}
  else{$('info-eyebrow').textContent='A CLEARER WAY TO READ';$('info-title').textContent='Follow the thread.';$('info-body').innerHTML=`<ol><li><strong>Add a file.</strong> Paste or upload Python, HTML, JavaScript, Java, C#, or SQL. Other plain-text languages can be read experimentally, with a quality warning. Code is parsed as text and never executed.</li><li><strong>Inspect Python first.</strong> Python files open in File inspector. Explore inputs, returns, assignments, choices, loops, imports and known calls. Click a value name to find statements in the same scope, or a line badge to see its exact source. Continue to AI scan when you want interpretation; sending the file still requires your confirmation.</li><li><strong>Choose your reading level.</strong> Beginner introduces concepts first. Developer follows known calls or document/query structure. Choose Literal for direct explanations, or Story Mode for a consistent workshop metaphor. Every scene keeps a literal explanation and source links.</li><li><strong>Connect the pieces.</strong> Click a chapter to highlight its original lines. Click a colored function to inspect parameters, returns, and callers.</li><li><strong>Take it with you.</strong> Export the reading guide as Markdown or PDF.</li></ol><div class="info-note">The story is a reading order, not proof of execution order. Local analysis resolves the structures supported by each language parser. Python includes methods and nested definitions; dynamic dispatch, imports, aliases, and runtime branches can require more context. HTML and SQL show structure rather than pretending to trace execution. Files remain in this tab until reload; no history is saved.</div>`;}
  $('info-dialog').showModal();
}
$('literal-mode').onclick=()=>setStoryMode(false);$('story-mode').onclick=()=>setStoryMode(true);$('new-code').onclick=openInput;$('beginner').onclick=()=>setMode('beginner');$('developer').onclick=()=>setMode('developer');$('inspection-tab').onclick=()=>setView('inspection');$('story-tab').onclick=()=>setView('story');$('map-tab').onclick=()=>setView('map');$('help-button').onclick=()=>info('help');$('ai-button').onclick=()=>info('ai');
$('sample-button').onclick=()=>{sampleIndex=(sampleIndex+1)%samples.length;const s=samples[sampleIndex];loadModel(s.code,s.filename);toast(`Loaded ${s.filename}`);window.scrollTo({top:0,behavior:'smooth'});};
$('example-select').innerHTML=samples.map((s,i)=>`<option value="${i}">${esc(s.filename)} · ${esc(languageSupport(s.filename).language)}</option>`).join('');$('example-select').value=String(sampleIndex);
$('load-example').onclick=()=>{sampleIndex=Number($('example-select').value);const s=samples[sampleIndex];setInput(s.code,s.filename);inputTab(false);$('input-error').textContent='';};
$('paste-tab').onclick=()=>inputTab(false);$('upload-tab').onclick=()=>inputTab(true);$('file-input').onchange=e=>loadFile(e.target.files[0]);
$('code-input').oninput=()=>{fileReadRequest++;$('input-size').textContent=`${$('code-input').value.length.toLocaleString()} / 80,000 characters`;};
$('filename').oninput=()=>{fileReadRequest++;renderInputLanguage();};
$('code-input').onkeydown=e=>{if(e.key==='Tab'){e.preventDefault();const el=e.target,start=el.selectionStart,end=el.selectionEnd;el.setRangeText('  ',start,end,'end');el.dispatchEvent(new Event('input'));}};
for(const name of ['dragenter','dragover'])$('drop-zone').addEventListener(name,e=>{e.preventDefault();$('drop-zone').classList.add('dragging');});
for(const name of ['dragleave','drop'])$('drop-zone').addEventListener(name,e=>{e.preventDefault();$('drop-zone').classList.remove('dragging');if(name==='drop'){if(e.dataTransfer.files.length>1){$('input-error').textContent='Single file reads one file at a time. Use Projects · Beta to load several Python files.';return;}loadFile(e.dataTransfer.files[0]);}});
$('analyze-button').onclick=()=>{const button=$('analyze-button');button.disabled=true;try{loadModel($('code-input').value,$('filename').value.trim()||'untitled.js');$('input-dialog').close();toast(model.inspection?'Python inspection complete. Continue with an AI scan.':'Your storyline is ready.');window.scrollTo({top:0,behavior:'smooth'});}catch(error){$('input-error').textContent=error.message;}finally{button.disabled=false;}};
$('export-button').onclick=()=>$('export-dialog').showModal();
$('export-markdown').onclick=()=>{
  $('export-dialog').close();
  const fence='`'.repeat(Math.max(3,...[...model.code.matchAll(/`+/g)].map(m=>m[0].length+1)));
  const text=[`# ${model.filename} — CodeStory`,'',`Reading level: ${mode}.`,`Explanation mode: ${storyMode?'Story Mode (workshop metaphor)':'Literal'}.`,aiResult?'Generated with AI using '+aiResult.model+' through '+(aiResult.connection?.kind==='api_key'?(PROVIDER_COPY[aiResult.connection.provider]?.label||'an API connection'):'a ChatGPT plan')+'.':'Generated with local structural analysis.',`${model.language} · ${model.support.label}`,'This is a reading guide, not a runtime trace.','',...model.warnings,...model.analysisNotes,'',...(storyMode?[aiResult?.story.narrative?.premise||WORKSHOP_PREMISE,'']:[]),...getChunks().flatMap((c,i)=>{const d=getDescription(c);return [`## ${i+1}. ${d.title}`,'',d.body,'',...(d.literal?['Literal explanation:','',d.literal.body,'']:[]),`Original lines ${c.startLine}–${c.endLine}`,'',fence+model.language.toLowerCase(),model.code.slice(c.start,c.end),fence,''];})].join('\n');
  const blob=new Blob([text],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=model.filename+'.story.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Story exported as Markdown');
};
let printState=null;
function preparePrint(){if(printState)return;printState={view,title:document.title};document.title=model.filename+' — CodeStory';setView('story');}
function finishPrint(){if(!printState)return;const previous=printState;printState=null;document.title=previous.title;setView(previous.view);}
window.addEventListener('beforeprint',preparePrint);window.addEventListener('afterprint',finishPrint);
$('export-pdf').onclick=()=>{ $('export-dialog').close();preparePrint();try{window.print();}catch{finishPrint();toast('Printing could not open. Try your browser’s Print menu.');}};
$('source-back').onclick=()=>{const previous=sourceHistory.pop();if(!previous)return;activeId=previous.activeId;selectedSymbol=previous.selectedSymbol;selectedSourceRange=previous.selectedSourceRange;view=previous.view;render();markLines();$('source-back').hidden=!sourceHistory.length;};
$('copy-source').onclick=async()=>{try{await navigator.clipboard.writeText(model.code);toast('Original source copied');}catch{toast('Clipboard access is unavailable in this browser');}};
document.addEventListener('click',e=>{
  if(e.target.closest('[data-inspection-scan]')){if(aiResult)setView('story');else $('explain-button').click();return;}
  const inspectSource=e.target.closest('[data-inspect-start]');if(inspectSource){const startLine=Number(inspectSource.dataset.inspectStart),endLine=Number(inspectSource.dataset.inspectEnd);activate(inspectSource.dataset.inspectChunk);selectedSourceRange={startLine,endLine};markLines();document.querySelector('.source-panel').classList.add('mobile-open');if(innerWidth<=760)document.querySelector('.source-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});return;}
  const inspectName=e.target.closest('[data-inspect-value]');if(inspectName){nameOpener=inspectName;nameSelection={value:inspectName.dataset.inspectValue,scopeId:inspectName.dataset.inspectScope};showNameExplorer();$('inspection-name-explorer').focus({preventScroll:true});$('inspection-name-explorer').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});return;}
  if(e.target.closest('[data-close-name-explorer]')){nameSelection=null;showNameExplorer();(nameOpener?.isConnected?nameOpener:$('inspection-tab')).focus({preventScroll:true});return;}
  const completion=e.target.closest('[data-complete]');if(completion){toggleCompletion(completion);return;}const symbol=e.target.closest('[data-symbol]');if(symbol){selectSymbol(symbol.dataset.symbol);return;}const source=e.target.closest('[data-source]');if(source){activate(source.dataset.source);document.querySelector('.source-panel').classList.add('mobile-open');if(innerWidth<=760)document.querySelector('.source-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});return;}const nav=e.target.closest('[data-chapter]');if(nav){activate(nav.dataset.chapter,true);return;}const card=e.target.closest('[data-card]');if(card)activate(card.dataset.card);if(e.target.closest('[data-close-inspector]')){selectedSymbol=null;$('inspector').classList.remove('mobile-open');renderInspector();}});
for(const id of ['input-dialog','info-dialog','account-dialog','consent-dialog','export-dialog','story-unavailable-dialog'])$(id).addEventListener('click',e=>{if(e.target===$(id)){const rect=$(id).getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)$(id).close();}});
render();
refreshConnection(true).catch(showConnectionNotice);

async function api(path,{method='GET',body,signal}={}){
  let response;try{response=await fetch(path,{method,headers:method==='POST'?{'Content-Type':'application/json','X-CodeStory-Token':csrfToken||''}:{},body:body?JSON.stringify(body):undefined,signal,credentials:'same-origin'});}catch(error){if(error.name==='AbortError'||signal?.aborted)throw error;const unavailable=new Error('Cannot reach CodeStory’s local server. Start CodeStory, then refresh this page. Your file is still in this tab.');unavailable.code='local_server_unavailable';throw unavailable;}
  let data;
  try{data=await response.json();}catch(error){if(error.name==='AbortError'||signal?.aborted)throw error;if(response.ok)throw new Error('CodeStory received an incomplete response. Please retry.');data={};}
  signal?.throwIfAborted();
  if(!response.ok){const error=new Error(data.error||'CodeStory could not complete this request.');error.code=data.code;error.requestId=data.requestId;throw error;}
  return data;
}
function showAIError(error){const el=$('ai-error');el.hidden=false;el.textContent=error.message||'The analysis could not finish. Your local storyline is still available.';if(/limit|quota|eligible|permission|auth|sign_in/.test(error.code||'')){const link=document.createElement('a');link.href=PROVIDER_COPY[currentConnection()?.provider]?.url||'https://chatgpt.com/settings/usage';link.target='_blank';link.rel='noopener noreferrer';link.textContent='Review connection usage ↗';el.append(link);}if(error.requestId){const detail=document.createElement('small');detail.textContent=' Request: '+error.requestId;el.append(detail);}}
function clearAIError(){$('ai-error').hidden=true;$('ai-error').textContent='';}
function showConnectionNotice(error){connectionNotice=error.message||String(error);$('auth-feedback').textContent=connectionNotice+' Local analysis is still available.';renderAIUI();}
function renderAIUI(){
  projectUI?.refreshConnection();
  const connection=currentConnection(),connected=!!connection?.ready,isAPI=connection?.kind==='api_key';
  $('account-button').textContent=connected?'◉ '+connection.label:'AI Connections';
  $('account-button').classList.toggle('connected',!!connected);
  $('account-button').title=connected?'AI Connections · '+connection.label:'Choose your AI connection';
  $('ai-status-title').textContent=analyzing?'Connecting the pieces…':aiResult?'Your AI reading guide is ready.':modelsLoading?'Loading AI models…':connected&&availableModels.length?(isAPI?`${PROVIDER_COPY[connection.provider]?.label||'API'} connection selected.`:'Your ChatGPT plan is connected.'):'Your local storyline is ready.';
  $('ai-status-description').textContent=analyzing?'Generating literal and Story Mode explanations for both levels. This may take a minute.':aiResult?'Both levels and Story Mode are ready. Changing either toggle uses no additional AI.':connectionNotice?`AI connection: ${connectionNotice} You can keep reading and uploading files with local analysis.`:modelsLoading?'Your local storyline is available while the model list loads.':connected&&availableModels.length?'Choose a model, review the notice, and explain this file.':connected?'No AI models are available yet. Check your connection or refresh models in account settings. Local analysis is available.':'Uploads and local explanations work without an account. Choose an AI connection when you want deeper explanations.';
  $('explain-button').textContent=analyzing?'Analyzing…':connected?(availableModels.length?(aiResult?'Analyze again ↗':'Explain with AI ↗'):'Check AI connection'):'Connect AI';
  if(model.inspection&&!aiResult&&!analyzing){$('ai-status-title').textContent='Step 1 complete: Python file inspected.';$('ai-status-description').textContent=connectionNotice?`AI connection: ${connectionNotice} Offline file inspection and local analysis remain available.`:modelsLoading?'Your file inspection is ready while AI models load.':connected&&availableModels.length?'Step 2: choose a model, review the sharing notice, and scan this file with AI.':'Step 2: connect an AI account, then scan this file for deeper explanations and Story Mode.';if(connected&&availableModels.length)$('explain-button').textContent='Scan with AI ↗';}
  document.querySelectorAll('[data-inspection-scan]').forEach(button=>{button.disabled=analyzing;});
  $('explain-button').disabled=analyzing;$('model-select').disabled=analyzing||!connected||!availableModels.length;$('cancel-analysis').hidden=!analyzing;
  $('refresh-models').disabled=analyzing||modelsLoading;
  document.querySelector('.ai-banner').classList.toggle('spinning',analyzing);
  connectionUI?.render({...accountStatus,busy:analyzing||!!accountStatus.busy});
  $('analysis-kind').textContent=aiResult?'AI + SOURCE ANALYSIS':'LOCAL ANALYSIS';
  $('file-overview').hidden=!aiResult||view!=='story';
  if(aiResult){$('overview-text').innerHTML=richText(storyMode&&aiResult.story.narrative?aiResult.story.narrative.overview:aiResult.story.overview);$('limitations-list').innerHTML=aiResult.story.limitations.map(l=>`<li>${esc(l)}</li>`).join('');$('limitations').hidden=!aiResult.story.limitations.length;}
}
function renderAccounts(){
  $('account-list').innerHTML=accountStatus.accounts.map(a=>`<div class="account-row"><div><strong>${esc(a.email)}</strong><small>${esc(a.label)}</small><p>${a.active?'Active connection · ':''}${a.connected?(a.planEnabled?'ChatGPT plan enabled':'Plan permission needed'):'Signed out'}</p></div><div class="account-row-actions">${a.connected&&a.planEnabled&&!a.active?`<button data-account-switch="${a.id}">Use account</button>`:''}${true?`<button data-account-connect="${a.id}" ${a.connected&&!a.planEnabled?'data-enable-plan="true"':''}>${a.connected&&!a.planEnabled?'Enable plan':'Reconnect'}</button>`:''}${a.connected?`<button data-account-signout="${a.id}">Sign out</button>`:''}</div></div>`).join('');
  $('add-account').textContent=accountStatus.accounts.length?'Add another ChatGPT account':'Continue with ChatGPT';
}
async function refreshModels(refresh=false){
  if(!currentConnection()?.ready)return false;
  const accountId=currentConnection().id,request=++modelsRequest;
  const previous=$('model-select').value;
  modelsLoading=true;availableModels=[];connectionNotice='';
  $('model-select').innerHTML='<option value="">Loading models…</option>';renderAIUI();
  try{
    const data=await api('/api/models'+(refresh?'?refresh=1':''));
    if(request!==modelsRequest||accountId!==currentConnection()?.id)return false;
    availableModels=Array.isArray(data.models)?data.models:[];
    $('model-select').innerHTML=availableModels.length?availableModels.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join(''):'<option value="">No models available</option>';
    if(availableModels.length)$('model-select').value=availableModels.some(m=>m.id===previous)?previous:availableModels[0].id;
    return availableModels.length>0;
  }catch(error){
    if(request!==modelsRequest||accountId!==currentConnection()?.id)return false;
    availableModels=[];$('model-select').innerHTML='<option value="">AI models unavailable</option>';showConnectionNotice(error);return false;
  }finally{if(request===modelsRequest){modelsLoading=false;renderAIUI();}}
}
async function refreshConnection(loadModels=false){
  const request=++statusRequest,data=await api('/api/status');if(request!==statusRequest)return data;csrfToken=data.csrfToken;
  const old=currentConnection();accountStatus=data;const next=currentConnection(),changed=old?.id!==next?.id||old?.ready!==next?.ready;
  if(changed){modelsRequest++;modelsLoading=false;availableModels=[];connectionNotice='';cancelCurrentAnalysis();aiResult=null;clearAIError();render();}
  if(!next?.ready){availableModels=[];connectionNotice='';$('model-select').innerHTML='<option value="">Connect to choose a model</option>';}
  renderAccounts();renderAIUI();
  if(next?.ready&&(loadModels||changed))await refreshModels();
  const result=data.authResult;
  if(result&&result.at>lastAuthFeedback&&result.status!=='pending'){
    lastAuthFeedback=result.at;$('auth-feedback').textContent=result.message;
    if(result.status==='connected'){toast('ChatGPT plan connected');}
    else if(result.status==='failed')showConnectionNotice(new Error(result.message));
    if(authTimer){clearInterval(authTimer);authTimer=null;}
  }
  return data;
}
async function beginSignIn(profileId=null,enablePlan=false){
  clearAIError();
  $('auth-feedback').textContent='Opening ChatGPT sign-in in your browser…';$('auth-fallback').hidden=true;
  try{
    await refreshConnection();
    const result=await api('/api/auth/start',{method:'POST',body:{profileId,enablePlan}});
    $('auth-feedback').textContent='Finish signing in with ChatGPT and allow plan usage. This window will update when you return.';
    $('auth-fallback').href=result.authorizationUrl;$('auth-fallback').hidden=false;
    if(authTimer)clearInterval(authTimer);
    authTimer=setInterval(async()=>{if(authPolling)return;authPolling=true;try{await refreshConnection();}catch{}finally{authPolling=false;}},1500);
  }catch(error){$('auth-feedback').textContent=error.message;}
}
$('account-button').onclick=()=>connectionUI?.open();
$('add-account').onclick=()=>beginSignIn();
$('refresh-models').onclick=async()=>{clearAIError();if(!currentConnection()?.ready){$('auth-feedback').textContent='Choose an AI connection to load models. Local analysis is ready to use.';return;}if(await refreshModels(true))$('auth-feedback').textContent='Model list refreshed.';else if(!connectionNotice)$('auth-feedback').textContent='No AI models are available for this connection yet. You can keep using local analysis.';};
$('explain-button').onclick=()=>{
  clearAIError();if(!currentConnection()?.ready){connectionUI?.open();return;}
  if(!$('model-select').value||!availableModels.some(m=>m.id===$('model-select').value)){connectionUI?.open();connectionUI?.notify(connectionNotice||'Reconnect your provider or refresh models to enable AI explanations. Local analysis is ready to use.');return;}
  const connection=currentConnection(),isAPI=connection.kind==='api_key',providerName=isAPI?PROVIDER_COPY[connection.provider]?.label||'AI provider':'OpenAI';
  pendingAnalysis={snapshot:model,modelId:$('model-select').value,connectionId:connection.id};
  $('consent-title').textContent=`Send this file to ${providerName}?`;
  $('consent-sharing').textContent=`The file contents, filename, and parsed structure will be sent to ${providerName}. Remove secrets or private data you do not want to send.`;
  $('consent-billing-title').textContent=isAPI?'Uses your API connection.':'Uses your ChatGPT plan.';
  $('consent-billing').textContent=isAPI?PROVIDER_COPY[connection.provider].billing:'This shares your existing allowance. Extra credits may be used if enabled in ChatGPT settings.';
  $('consent-filename').textContent=model.filename;$('consent-file-icon').textContent=languageIcon(model.language);
  $('consent-details').textContent=`${model.language} · ${model.code.length.toLocaleString()} characters · ${availableModels.find(m=>m.id===$('model-select').value)?.name} · ${connection.label}`;
  $('consent-dialog').showModal();
};
$('stay-local').onclick=()=>{pendingAnalysis=null;$('consent-dialog').close();};
$('consent-dialog').addEventListener('close',()=>{pendingAnalysis=null;});
$('cancel-analysis').onclick=()=>analysisController?.abort();
$('confirm-analysis').onclick=async()=>{
  if(analyzing)return;
  const consent=pendingAnalysis;pendingAnalysis=null;$('consent-dialog').close();
  if(!consent||consent.snapshot!==model||consent.connectionId!==currentConnection()?.id)return;
  const {snapshot,modelId,connectionId}=consent,controller=new AbortController();
  analyzing=true;analysisController=controller;renderAIUI();clearAIError();
  try{
    const result=await api('/api/analyze',{method:'POST',body:{code:snapshot.code,filename:snapshot.filename,model:modelId,connectionId,consent:true},signal:controller.signal});
    if(snapshot!==model||analysisController!==controller)return;controller.signal.throwIfAborted();
    if(!result.story||!['conceptOrder','flowOrder','chapters','functions','limitations'].every(key=>Array.isArray(result.story[key])))throw new Error('CodeStory received an incomplete explanation. Your local storyline is still available. Please retry.');
    aiResult=result;view='story';const storyBlocked=storyMode&&!storyAvailability().available;if(storyBlocked)storyMode=false;if(accountStatus.connection)accountStatus.connection.analysisVerified=true;activeId=getChunks()[0].id;render();if(storyBlocked)showStoryUnavailable();toast(result.cached?'Loaded the saved explanation from this session':'Your AI storyline is ready.');
  }catch(error){if(snapshot!==model||analysisController!==controller)return;if(error.name==='AbortError')toast('Analysis canceled');else showAIError(error);}
  finally{if(analysisController===controller){analyzing=false;analysisController=null;renderAIUI();}}
};
document.addEventListener('click',async e=>{
  const reconnect=e.target.closest('[data-account-connect]');if(reconnect)return beginSignIn(reconnect.dataset.accountConnect,reconnect.dataset.enablePlan==='true');
  const change=e.target.closest('[data-account-switch]'),signout=e.target.closest('[data-account-signout]');
  if(!change&&!signout)return;
  try{
    clearAIError();cancelCurrentAnalysis();const path=change?'/api/auth/switch':'/api/auth/signout',profileId=change?change.dataset.accountSwitch:signout.dataset.accountSignout;
    const result=await api(path,{method:'POST',body:{profileId}});$('auth-feedback').textContent=result.message||'Account switched.';aiResult=null;await refreshConnection(true);render();
  }catch(error){$('auth-feedback').textContent=error.message;}
});
window.addEventListener('focus',()=>refreshConnection(false).catch(showConnectionNotice));
function openWorkspaceArea(area){workspaceArea=area;returnArea=area;$('connections-page').hidden=true;document.querySelector('.workspace').hidden=area!=='single';$('projects-page').hidden=area!=='projects';for(const id of ['reader-nav','projects-nav','connections-nav'])$(id).removeAttribute('aria-current');$(area==='projects'?'projects-nav':'reader-nav').setAttribute('aria-current','page');if(area==='projects')projectUI?.open();}
connectionUI=installConnections({document,api,getStatus:()=>accountStatus,refreshConnection,onOpen:()=>{if(workspaceArea!=='connections')returnArea=workspaceArea;workspaceArea='connections';$('projects-page').hidden=true;$('projects-nav').removeAttribute('aria-current');},onClose:()=>openWorkspaceArea(returnArea),openAccounts:()=>{renderAccounts();$('account-dialog').showModal();}});
projectUI=installProjects({document,api,getConnection:currentConnection,getModels:()=>availableModels,getBusy:()=>analyzing,setBusy:(busy,controller)=>{if(busy){analyzing=true;analysisController=controller;}else if(analysisController===controller){analyzing=false;analysisController=null;}renderAIUI();},openConnections:()=>connectionUI.open(),changed:()=>{hasUserWork=true;}});
$('projects-nav').onclick=()=>openWorkspaceArea('projects');$('reader-nav').onclick=()=>openWorkspaceArea('single');
document.querySelector('.brand').onclick=event=>{event.preventDefault();openWorkspaceArea('single');};
window.addEventListener('beforeunload',event=>{if(hasUserWork||projectUI?.hasWork()){event.preventDefault();event.returnValue='';}});
installDialogMotion(document);
installMovingIndicators(document);
installTabKeys(document);
