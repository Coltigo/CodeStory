export function projectFileRole(project,path,entryId){
 const entry=project.nodes.find(n=>n.id===entryId);if(entry?.path===path)return 'Starting file';
 if(project.links.some(e=>e.crossFile&&e.to.path===path))return 'Called helper';
 if(project.links.some(e=>e.crossFile&&e.from.path===path))return 'Coordinates helpers';
 if(project.imports.some(i=>i.targetPath===path))return 'Referenced source';return 'Additional context';
}
