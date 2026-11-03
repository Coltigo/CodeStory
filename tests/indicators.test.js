import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installMovingIndicators} from '../src/indicators.js';

test('shared indicators follow navigation, pressed modes and tabs, and remeasure changed labels',async()=>{
 const dom=new JSDOM(`<header class="topbar"><nav><button aria-current="page">Workspace</button><button>AI Connections</button><button>Help</button></nav></header><div class="segmented"><button aria-pressed="true">Beginner</button><button aria-pressed="false">Developer</button></div><div class="segmented"><button aria-pressed="true">Literal</button><button aria-pressed="false">Story</button></div><div class="tabs" role="tablist"><button aria-selected="true">Storyline</button><button aria-selected="false">Call map</button></div>`,{pretendToBeVisual:true});
 const {document}=dom.window;
 try{
  const groups=[...document.querySelectorAll('nav,.segmented,.tabs')];let secondWidth=120;
  for(const group of groups){group.getBoundingClientRect=()=>({left:20,top:6,width:260,height:43});for(const [i,button] of [...group.querySelectorAll('button')].entries())button.getBoundingClientRect=()=>({left:20+i*110,top:10,width:i===1?secondWidth:100,height:35});}
  installMovingIndicators(document);const tick=()=>new Promise(resolve=>setTimeout(resolve,50));await tick();
  for(const group of groups){assert.equal(group.querySelectorAll('.moving-indicator').length,1);const bar=group.querySelector('.moving-indicator');assert.equal(bar.style.transform,'translateX(0px)');assert.equal(bar.style.width,'100px');assert.equal(bar.getAttribute('aria-hidden'),'true');if(group.classList.contains('segmented')){assert.equal(bar.style.height,'35px');assert.equal(bar.style.top,'4px');}else{assert.equal(bar.style.height,'');assert.equal(bar.style.top,'');}}
  for(const group of groups){const [first,second]=group.querySelectorAll('button');const attribute=first.hasAttribute('aria-current')?'aria-current':first.hasAttribute('aria-pressed')?'aria-pressed':'aria-selected';if(attribute==='aria-current')first.removeAttribute(attribute);else first.setAttribute(attribute,'false');second.setAttribute(attribute,attribute==='aria-current'?'page':'true');}
  await tick();for(const group of groups){assert.equal(group.querySelector('.moving-indicator').style.transform,'translateX(110px)');assert.equal(group.querySelector('.moving-indicator').style.width,'120px');}
  secondWidth=150;dom.window.dispatchEvent(new dom.window.Event('resize'));await tick();for(const group of groups)assert.equal(group.querySelector('.moving-indicator').style.width,'150px');
 }finally{dom.window.close();}
});
