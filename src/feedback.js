export function elapsedLabel(milliseconds){const seconds=Math.max(0,Math.floor(milliseconds/1000));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');}
export function failureHelp(error){
 const code=error?.code||'',message=error?.message||'The scan could not finish.';let action='Retry this file. Completed guides remain available.';
 if(code==='local_auth_required')action='This connector supports loopback servers without API authentication. Check your runner’s local server settings.';
 else if(/runner_not_installed/.test(code))action='Install Ollama, reopen CodeStory, then choose Start server. No model is downloaded automatically.';
 else if(/runner_|invalid_local_endpoint/.test(code))action='Check the runner and loopback address in AI Connections. Only a server started by CodeStory can be shut down here.';
 else if(/local_network|local_server_unavailable/.test(code))action='Open AI Connections and start the local server. Check the address, find models, then reconnect.';
 else if(/no_local_models|local_model_unavailable/.test(code))action='Download a text model in your runner, then click Find models. Choose a downloaded model with structured-output support.';
 else if(/timeout|incomplete|response_too_large|local_request_failed|local_context_limit/.test(code))action='Try a smaller file or fewer selected files. In the runner, increase context/output capacity or choose a more capable model. Retry requires your confirmation.';
 else if(/invalid_story|invalid_provider|local_invalid/.test(code))action='The returned guide did not pass validation. Try a model with JSON-schema support or a smaller file; incomplete text was not saved.';
 else if(/quota|rate_limit|api_rate/.test(code))action='Review the selected provider’s quota and billing, or wait before retrying. CodeStory will not switch providers automatically.';
 else if(/auth|sign_in|connection_changed|invalid_model|connection_required/.test(code))action='Open AI Connections, check the selected account and model, then review the sharing notice again.';
 return {message,action};
}
export const failureText=error=>{const {message,action}=failureHelp(error);return message+' Next step: '+action;};
