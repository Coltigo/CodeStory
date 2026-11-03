const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const PROVIDER_COPY={
  openai:{label:'OpenAI API',billing:'Uses OpenAI Platform API credits and billing, separately from your ChatGPT plan allowance.',url:'https://platform.openai.com/settings/organization/billing/overview'},
  anthropic:{label:'Claude API',billing:'Uses Claude Console API credits, billing, and limits. This does not spend your Claude chat allowance; eligible plans may include API credits.',url:'https://platform.claude.com/settings/billing'},
  gemini:{label:'Gemini API',billing:'Uses your API project’s quota and billing. This does not connect your Google AI consumer-plan allowance.',url:'https://ai.google.dev/gemini-api/docs/billing'}
};
export function installConnections({document,api,getStatus,refreshConnection,openAccounts,onOpen=()=>{},onClose=()=>{}}){
  const $=id=>document.getElementById(id),window=document.defaultView;let connecting=false,latestStatus=getStatus();
  function feedback(message,tone='neutral'){$('connection-feedback').textContent=message;$('connection-feedback').dataset.tone=tone;$('connection-feedback').setAttribute('role',tone==='error'?'alert':'status');}
  function open(){onOpen();$('connections-page').hidden=false;document.querySelector('.workspace').hidden=true;$('connections-nav').setAttribute('aria-current','page');$('reader-nav').removeAttribute('aria-current');if(window.location.hash!=='#connections')window.history.replaceState(null,'','#connections');$('connections-title').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
  function close(){ $('connections-page').hidden=true;document.querySelector('.workspace').hidden=false;$('reader-nav').setAttribute('aria-current','page');$('connections-nav').removeAttribute('aria-current');if(window.location.hash)window.history.replaceState(null,'',window.location.pathname+window.location.search);onClose();$('account-button').focus();}
  function active(status){if(Object.hasOwn(status,'connection'))return status.connection;const account=status.active;return account?{id:account.id,kind:'chatgpt_plan',provider:'chatgpt',label:account.email,ready:account.connected&&account.planEnabled}:null;}
  function render(status=getStatus()){
    latestStatus=status;const connection=active(status),plan=status.active,usingPlan=connection?.kind==='chatgpt_plan';
    $('plan-connection-card').classList.toggle('active',!!(usingPlan&&connection.ready));
    $('plan-connection-status').textContent=plan?.connected?(plan.planEnabled?(usingPlan?'Selected · ':'')+plan.email:'Signed in · plan permission needed'):'Not connected';
    $('plan-connection-status').classList.toggle('connected',!!(plan?.connected&&plan.planEnabled));
    $('plan-connect').textContent=plan?.connected?'Manage ChatGPT accounts':'Sign in with ChatGPT';
    $('use-plan').hidden=!(plan?.connected&&plan.planEnabled&&!usingPlan);
    $('selected-connection').textContent=connection?.ready?`${connection.label} · ${connection.kind==='api_key'?PROVIDER_COPY[connection.provider]?.label||'API key':'ChatGPT plan'}`:'Local analysis · no AI connection selected';
    $('connection-verification').textContent=connection?.ready?(connection.analysisVerified?'A complete AI analysis has succeeded in this server session.':'Model access can be checked without code. A complete AI analysis still needs to be verified.'):'You can upload and read code without an AI connection.';
    const profiles=status.apiConnections||[];
    $('api-connection-list').innerHTML=profiles.length?profiles.map(p=>`<div class="connection-item ${connection?.id===p.id?'active':''}"><div><strong>${escape(p.label)}</strong><p>${escape(PROVIDER_COPY[p.provider]?.label||p.provider)} · ${connection?.id===p.id?'Selected':'Available this session'}</p><small>${p.analysisVerified?'Analysis verified this session':'Model list checked; analysis not yet verified'}</small></div><div class="connection-actions">${connection?.id!==p.id?`<button class="button secondary" data-use-api="${escape(p.id)}">Use connection</button>`:''}<button class="button secondary" data-remove-api="${escape(p.id)}">Disconnect</button></div></div>`).join(''):'<p class="connection-empty">No API keys connected. Keys are kept only until CodeStory stops.</p>';
    for(const button of document.querySelectorAll('#api-connection-list button, #use-plan'))button.disabled=connecting||!!status.busy;
    $('connect-api').disabled=connecting||!!status.busy;$('connect-api').textContent=connecting?'Checking model access…':'Connect and use API key';
  }
  function providerInfo(){const copy=PROVIDER_COPY[$('api-provider').value];$('api-billing-note').textContent=copy.billing;$('api-billing-link').href=copy.url;$('api-key').value='';}
  $('connections-nav').onclick=open;$('reader-nav').onclick=close;$('back-to-reader').onclick=close;$('plan-connect').onclick=openAccounts;
  $('api-provider').onchange=providerInfo;
  $('local-runner').onchange=()=>{$('local-endpoint').value=$('local-runner').value==='ollama'?'http://127.0.0.1:11434/v1':'http://127.0.0.1:1234/v1';};
  async function select(id){if(connecting)return;try{feedback('Selecting your AI connection…');await refreshConnection(false);await api('/api/connections/select',{method:'POST',body:{id}});await refreshConnection(true);feedback('Connection selected. Return to your file to review the notice before analysis.','success');}catch(error){feedback(error.message,'error');}finally{render();}}
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
    try{await refreshConnection(false);await api('/api/connections/remove',{method:'POST',body:{id:remove.dataset.removeApi}});await refreshConnection(true);feedback('API key disconnected and removed from memory.','success');}catch(error){feedback(error.message,'error');}
  });
  window.addEventListener('hashchange',()=>window.location.hash==='#connections'?open():close());
  providerInfo();render(latestStatus);if(window.location.hash==='#connections'||new URLSearchParams(window.location.search).has('auth'))open();
  return {open,close,render,notify:feedback,isBusy:()=>connecting};
}
