import {failureText} from './feedback.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const PROVIDER_COPY={
  local:{label:'Local AI',billing:'Runs through your local model server. No ChatGPT or API-plan allowance is used.',url:'https://lmstudio.ai/docs/developer'},
  openai:{label:'OpenAI API',billing:'Uses OpenAI Platform API credits and billing, separately from your ChatGPT plan allowance.',url:'https://platform.openai.com/settings/organization/billing/overview'},
  anthropic:{label:'Claude API',billing:'Uses Claude Console API credits, billing, and limits. This does not spend your Claude chat allowance; eligible plans may include API credits.',url:'https://platform.claude.com/settings/billing'},
  gemini:{label:'Gemini API',billing:'Uses your API project’s quota and billing. This does not connect your Google AI consumer-plan allowance.',url:'https://ai.google.dev/gemini-api/docs/billing'}
};
export function installConnections({document,api,getStatus,refreshConnection,openAccounts,onOpen=()=>{},onClose=()=>{}}){
  const $=id=>document.getElementById(id),window=document.defaultView;let connecting=false,latestStatus=getStatus(),preferencesLoaded=false;
  function feedback(message,tone='neutral'){$('connection-feedback').textContent=message;$('connection-feedback').dataset.tone=tone;$('connection-feedback').setAttribute('role',tone==='error'?'alert':'status');}
  function open(){onOpen();$('connections-page').hidden=false;document.querySelector('.workspace').hidden=true;$('connections-nav').setAttribute('aria-current','page');$('reader-nav').removeAttribute('aria-current');if(window.location.hash!=='#connections')window.history.replaceState(null,'','#connections');$('connections-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
  function close(){ $('connections-page').hidden=true;document.querySelector('.workspace').hidden=false;$('reader-nav').setAttribute('aria-current','page');$('connections-nav').removeAttribute('aria-current');if(window.location.hash)window.history.replaceState(null,'',window.location.pathname+window.location.search);onClose();$('account-button').focus();}
  function active(status){if(Object.hasOwn(status,'connection'))return status.connection;const account=status.active;return account?{id:account.id,kind:'chatgpt_plan',provider:'chatgpt',label:account.email,ready:account.connected&&account.planEnabled}:null;}
  function render(status=getStatus()){
    latestStatus=status;if(!preferencesLoaded&&status.localPreferences){const p=status.localPreferences;$('local-runner').value=p.runner;$('local-endpoint').value=p.endpoint;$('local-auto-start').checked=p.autoStart;if(p.model)$('local-model').innerHTML=`<option value="${escape(p.model)}">${escape(p.model)} (saved)</option>`;preferencesLoaded=true;}
    const managed=!!status.localRuntime?.managed,ollama=$('local-runner').value==='ollama';$('local-start').disabled=connecting||!!status.busy||!ollama;$('local-stop').disabled=connecting||!!status.busy||!managed;$('local-save').disabled=connecting||!!status.busy;$('local-auto-start').disabled=connecting||!!status.busy||!ollama;$('local-runtime-status').textContent=status.localNotice||status.localRuntime?.message||(ollama?'Start Ollama here, or connect to a server already running.':'Start and stop LM Studio from its Developer tab. Automatic lifecycle control currently uses Ollama.');
    latestStatus=status;const connection=active(status),plan=status.active,usingPlan=connection?.kind==='chatgpt_plan';
    $('plan-connection-card').classList.toggle('active',!!(usingPlan&&connection.ready));
    $('plan-connection-status').textContent=plan?.connected?(plan.planEnabled?(usingPlan?'Selected · ':'')+plan.email:'Signed in · plan permission needed'):'Not connected';
    $('plan-connection-status').classList.toggle('connected',!!(plan?.connected&&plan.planEnabled));
    $('plan-connect').textContent=plan?.connected?'Manage ChatGPT accounts':'Sign in with ChatGPT';
    $('use-plan').hidden=!(plan?.connected&&plan.planEnabled&&!usingPlan);
    $('selected-connection').textContent=connection?.ready?`${connection.label} · ${connection.kind!=='chatgpt_plan'?PROVIDER_COPY[connection.provider]?.label||'API key':'ChatGPT plan'}`:'Local analysis · no AI connection selected';
    $('connection-verification').textContent=connection?.ready?(connection.analysisVerified?'A complete AI analysis has succeeded in this server session.':'Model access can be checked without code. A complete AI analysis still needs to be verified.'):'You can upload and read code without an AI connection.';
    const profiles=status.apiConnections||[];
    $('api-connection-list').innerHTML=profiles.length?profiles.map(p=>`<div class="connection-item ${connection?.id===p.id?'active':''}"><div><strong>${escape(p.label)}</strong><p>${escape(PROVIDER_COPY[p.provider]?.label||p.provider)} · ${connection?.id===p.id?'Selected':'Available this session'}</p><small>${p.analysisVerified?'Analysis verified this session':'Model list checked; analysis not yet verified'}</small></div><div class="connection-actions">${connection?.id!==p.id?`<button class="button secondary" data-use-api="${escape(p.id)}">Use connection</button>`:''}<button class="button secondary" data-remove-api="${escape(p.id)}">Disconnect</button></div></div>`).join(''):'<p class="connection-empty">No API or local connections. Connections stay in memory until CodeStory stops.</p>';
    for(const button of document.querySelectorAll('#api-connection-list button, #use-plan'))button.disabled=connecting||!!status.busy;
    $('local-discover').disabled=connecting||!!status.busy;$('local-connect').disabled=connecting||!!status.busy||!$('local-model').value;$('local-endpoint').disabled=connecting||!!status.busy;$('local-runner').disabled=connecting||!!status.busy;$('local-model').disabled=connecting||!!status.busy||!$('local-model').value;
    $('connect-api').disabled=connecting||!!status.busy;$('connect-api').textContent=connecting?'Checking model access…':'Connect and use API key';
  }
  function providerInfo(){const copy=PROVIDER_COPY[$('api-provider').value];$('api-billing-note').textContent=copy.billing;$('api-billing-link').href=copy.url;$('api-key').value='';}
  $('connections-nav').onclick=open;$('reader-nav').onclick=close;$('back-to-reader').onclick=close;$('plan-connect').onclick=openAccounts;
  $('api-provider').onchange=providerInfo;
  const localSettings=()=>({runner:$('local-runner').value,endpoint:$('local-endpoint').value.trim(),model:$('local-model').value,autoStart:$('local-auto-start').checked&&$('local-runner').value==='ollama'});
  async function localAction(route,body){if(connecting)return;connecting=true;render();feedback('Updating local model settings…');try{const result=await api(route,{method:'POST',body});await refreshConnection(false);feedback(result.runtime?.message||'Local preferences saved on this computer.','success');}catch(error){feedback(failureText(error),'error');}finally{connecting=false;render();}}
  $('local-start').onclick=()=>localAction('/api/local/start',localSettings());$('local-stop').onclick=()=>localAction('/api/local/stop',{});$('local-save').onclick=()=>localAction('/api/local/preferences',localSettings());
  function resetLocal(){$('local-model').innerHTML='<option value="">Find models first</option>';$('local-model').disabled=true;render();}
  $('local-endpoint').oninput=resetLocal;
  $('local-runner').onchange=()=>{$('local-endpoint').value=$('local-runner').value==='ollama'?'http://127.0.0.1:11434/v1':'http://127.0.0.1:1234/v1';resetLocal();};
  $('local-discover').onclick=async()=>{if(connecting)return;connecting=true;resetLocal();feedback('Finding models on your computer. No source code is sent.');try{await refreshConnection(false);if(localSettings().autoStart)await api('/api/local/start',{method:'POST',body:localSettings()});const data=await api('/api/connections/local/models',{method:'POST',body:{endpoint:$('local-endpoint').value.trim()}});$('local-model').innerHTML=data.models.map(m=>`<option value="${escape(m.id)}">${escape(m.name)}</option>`).join('');$('local-model').disabled=false;feedback('Choose an installed model, then connect.','success');}catch(error){feedback(failureText(error),'error');}finally{connecting=false;render();}};
  $('local-model').onchange=()=>render();
  $('local-connect').onclick=async()=>{if(connecting||!$('local-model').value)return;connecting=true;render();try{await refreshConnection(false);await api('/api/connections/local',{method:'POST',body:{...localSettings(),label:$('local-runner').value==='ollama'?'Ollama':'LM Studio'}});await refreshConnection(true);feedback('Local model selected. Return to your code and review the notice before scanning.','success');}catch(error){feedback(failureText(error),'error');}finally{connecting=false;render();}};
  async function select(id){if(connecting)return;try{feedback('Selecting your AI connection…');await refreshConnection(false);await api('/api/connections/select',{method:'POST',body:{id}});await refreshConnection(true);feedback('Connection selected. Return to your file to review the notice before analysis.','success');}catch(error){feedback(failureText(error),'error');}finally{render();}}
  $('use-plan').onclick=()=>select('chatgpt');
  $('api-connection-form').addEventListener('submit',async event=>{
    event.preventDefault();if(connecting)return;
    if(!$('api-billing-confirm').checked){feedback('Confirm that you understand the provider’s API billing before connecting.','error');$('api-billing-confirm').focus();return;}
    const key=$('api-key').value.trim();if(!key){feedback('Enter an API key for the selected provider.','error');$('api-key').focus();return;}
    const body={provider:$('api-provider').value,label:$('api-label').value.trim(),key,billingConsent:true};$('api-key').value='';connecting=true;render();feedback('Checking your key by loading available models. No source code is being sent.');
    try{await refreshConnection(false);await api('/api/connections/api',{method:'POST',body});await refreshConnection(true);$('api-billing-confirm').checked=false;feedback('API connection selected. Your key stays in this server session; restart requires reconnecting.','success');}
    catch(error){feedback(String(error.message).split(body.key).join('[redacted]')+' Enter the key again to retry.','error');}
    finally{connecting=false;render();}
  });
  document.addEventListener('click',async event=>{
    const use=event.target.closest('[data-use-api]');if(use)return select(use.dataset.useApi);
    const remove=event.target.closest('[data-remove-api]');if(!remove||connecting)return;
    try{await refreshConnection(false);await api('/api/connections/remove',{method:'POST',body:{id:remove.dataset.removeApi}});await refreshConnection(true);feedback('Connection disconnected and removed from memory.','success');}catch(error){feedback(failureText(error),'error');}
  });
  window.addEventListener('hashchange',()=>window.location.hash==='#connections'?open():close());
  providerInfo();render(latestStatus);if(window.location.hash==='#connections'||new URLSearchParams(window.location.search).has('auth'))open();
  return {open,close,render,notify:feedback,isBusy:()=>connecting};
}
