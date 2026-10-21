// Per-call request lifetimes for a server the listener builds once per MCP session.
//
// registerPublicOperation without an OperationContext bounds every call by the SDK default request budget
// (10 s), which clamps a longer declared handler bound. The SDK's supported seam is a lifetime from
// createServerBudgets, but its reference adapter builds one server per request and hands that request's
// lifetime to it. This listener keeps one server per session, so a lifetime fixed at registration would be one
// request budget shared by every later call. Instead each call reads `context.lifetime` once (operation.ts) and
// gets a fresh lifetime that finishes with the call's handler stage, as the SDK's own default path does.
import type {OperationContext, RequestLifetime, RequestBudgets} from '@saga-a2ui/mcp/server';

/** Finishes `lifetime` once its handler stage has settled, so no request timer outlives the call. */
function finishingWith(lifetime:RequestLifetime):RequestLifetime{
  return new Proxy(lifetime,{
    get(target,property){
      if(property==='run') return async (...args:Parameters<RequestLifetime['run']>)=>{
        try { return await target.run(...args); } finally { target.finish(); }
      };
      const value=Reflect.get(target,property,target) as unknown;
      return typeof value==='function'?value.bind(target):value;
    },
  });
}

/** An operation context whose every call runs under its own lifetime started from `budgets`. */
export function perCallLifetime(budgets:RequestBudgets):OperationContext{
  return {get lifetime(){ return finishingWith(budgets.startRequest()); }};
}
