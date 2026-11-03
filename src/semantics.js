export function functionTiming(symbol,language){
  if(language==='Python'){
    if(symbol.async&&symbol.generator)return 'Calling this async generator creates an async iterator; its body resumes during async iteration.';
    if(symbol.generator)return 'Calling this generator creates an iterator; its body resumes during iteration.';
    if(symbol.async)return 'Calling this async function creates a coroutine; its body runs when the coroutine is awaited or scheduled.';
  }
  return 'This function runs when it is called.';
}
export function functionReturns(symbol,language){
  if(language==='Python'&&symbol.generator)return 'A return ends iteration. Values are produced by yield as the iterator resumes, rather than being ordinary return deliveries to the caller.';
  if(language==='Python'&&symbol.async)return symbol.returns.length?'Its return expressions determine the coroutine’s eventual result.':'No explicit return expression was found; the coroutine completes with no explicit result value.';
  return symbol.returns.length?'Its return expressions describe what it can deliver back to its caller.':'No explicit return expression was found, so this guide does not invent a result delivery.';
}
