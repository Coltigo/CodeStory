/** Automatic activation for horizontal tablists, with one tab in the Tab order. */
export function installTabKeys(document){
  document.addEventListener('keydown',event=>{
    const tab=event.target.closest('[role="tab"]'),group=tab?.closest('[role="tablist"]');if(!group||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=[...group.querySelectorAll('[role="tab"]')].filter(t=>!t.hidden&&!t.disabled);const index=tabs.indexOf(tab);if(index<0)return;event.preventDefault();let next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();
  });
}
