import {projectHandoff} from './project-handoffs.js';
import {storyReadiness} from './narrative.js';
const resultFor=(results,path)=>results.get(path)?.result;
/** A bounded tour through verified calls. Revisits are links, never copied scenes. */
export function buildProjectStory(project,results,entryId,level='beginner'){
  const byId=new Map(project.nodes.map(n=>[n.id,n])),entry=byId.get(entryId),events=[],visited=new Set(),stack=new Set(),sceneById=new Map();let cut=false;
  const field=level==='beginner'?'storyBeginner':'storyDeveloper';
  const add=event=>{if(events.length>=160){cut=true;return false;}events.push({...event,eventId:'ps-'+events.length});return true;};
  function scene(node,context=false){
    const file=project.files.find(f=>f.path===node.path),model=file?.model,result=resultFor(results,node.path),narrative=result?.story?.narrative;
    const readiness=model?storyReadiness(model,{ai:!!result}):{available:false,reason:file?.error||'This source could not be inspected.'};
    const available=!!result&&narrative?.available===true&&readiness.available;
    const symbol=model?.symbols.find(s=>s.id===node.localId),chapter=model?.chunks.find(c=>c.id===symbol?.chunkId);
    const explanation=result?.story?.functions?.find(f=>f.id===node.localId),chapterGuide=result?.story?.chapters?.find(c=>c.id===chapter?.id);
    let sections=[];
    if(available&&symbol){sections=[{title:chapterGuide?.title||symbol.qualifiedName||symbol.name,text:explanation?.[field]||chapterGuide?.[field]||'',literal:explanation?.purpose||chapterGuide?.[level]||'',startLine:node.startLine,endLine:node.endLine}].filter(s=>s.text);}
    else if(available&&model){
      const selected=model.chunks.filter(c=>(context||!c.symbolIds.length)&&c.kind!=='import');
      sections=selected.map(c=>{const guide=result.story.chapters?.find(g=>g.id===c.id);return guide?.[field]?{title:guide.title,text:guide[field],literal:guide[level]||'',startLine:c.startLine,endLine:c.endLine}:null;}).filter(Boolean);
      if(!sections.length)sections=[{title:'The room’s plan',text:narrative.overview,literal:result.story.overview,startLine:1,endLine:model.lineCount}].filter(s=>s.text);
    }
    return {type:'scene',node,context,sections,available:available&&!!sections.length,reason:!result?'Scan this file with AI to read its part of the story. Completed scenes in other files remain available.':!readiness.available?readiness.reason:narrative?.reason||'A story was not supplied for this part. The literal guide and source are available.',deferred:!!(symbol?.async||symbol?.generator),functions:symbol?[node.id]:(model?.symbols||[]).map(s=>project.nodes.find(n=>n.path===node.path&&n.localId===s.id)?.id).filter(Boolean)};
  }
  function visit(id,depth=0){
    const node=byId.get(id);if(!node||cut)return;
    if(visited.has(id)){add({type:'revisit',node,target:sceneById.get(id),cycle:stack.has(id)});return;}
    if(depth>=40){cut=true;return;}
    visited.add(id);stack.add(id);const event=scene(node);if(!add(event))return;sceneById.set(id,'ps-'+(events.length-1));
    const edges=project.links.filter(e=>e.from.id===id&&byId.has(e.to.id)).map((edge,index)=>({edge,index})).sort((a,b)=>(a.edge.callStart??a.edge.line)-(b.edge.callStart??b.edge.line)||a.index-b.index).map(x=>x.edge);
    for(const edge of edges){if(cut)break;const handoff=projectHandoff(project,edge);if(!add({type:'handoff',edge,handoff,from:node,to:byId.get(edge.to.id)}))break;visit(edge.to.id,depth+1);if(!add({type:'return',edge,handoff,from:byId.get(edge.to.id),to:node}))break;}
    stack.delete(id);
  }
  if(entry)visit(entry.id);
  const pathFiles=new Set(events.filter(e=>e.type==='scene').map(e=>e.node.path)),context=[];
  for(const file of project.files){if(pathFiles.has(file.path)||!file.model)continue;const node=project.nodes.find(n=>n.path===file.path&&n.localId==='module');if(node)context.push(scene(node,true));}
  const allSymbols=project.nodes.filter(n=>n.localId!=='module'),unvisited=allSymbols.filter(n=>!visited.has(n.id));
  const root=resultFor(results,entry?.path);
  return {entry,events,context,unvisited,cut,sceneCount:events.filter(e=>e.type==='scene').length,opening:root?.story?.narrative?.available?root.story.narrative.overview:'',demo:!!root?.demo};
}
