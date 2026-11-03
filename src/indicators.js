/** Slide a filled selection in bordered switches, and an underline in navigation. */
export function installMovingIndicators(document){
  const win=document.defaultView;
  for(const group of document.querySelectorAll('.topbar nav,.segmented,.tabs[role="tablist"]')){
    const indicator=document.createElement('span');indicator.className='moving-indicator';indicator.setAttribute('aria-hidden','true');group.append(indicator);group.classList.add('moving-selection');
    let frame=0,placed=false;
    const update=()=>{frame=0;const selected=group.querySelector('button[aria-current="page"],button[aria-pressed="true"],button[aria-selected="true"]');if(!selected)return;const box=group.getBoundingClientRect(),target=selected.getBoundingClientRect();if(!box.width||!target.width)return;
      indicator.style.width=target.width+'px';if(group.classList.contains('segmented')){indicator.style.height=target.height+'px';indicator.style.top=(target.top-box.top-group.clientTop+group.scrollTop)+'px';}indicator.style.transform=`translateX(${target.left-box.left-group.clientLeft+group.scrollLeft}px)`;
      if(!placed){placed=true;win.requestAnimationFrame(()=>group.classList.add('indicator-ready'));}
    };
    const schedule=()=>{if(!frame)frame=win.requestAnimationFrame(update);};
    const observer=new win.MutationObserver(schedule);observer.observe(group,{subtree:true,attributes:true,attributeFilter:['aria-current','aria-pressed','aria-selected']});
    if(win.ResizeObserver){const resize=new win.ResizeObserver(schedule);resize.observe(group);for(const button of group.querySelectorAll('button'))resize.observe(button);}
    win.addEventListener('resize',schedule);document.fonts?.ready.then(schedule);schedule();
  }
}
