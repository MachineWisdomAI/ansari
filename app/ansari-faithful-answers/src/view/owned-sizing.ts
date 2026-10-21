import type {App} from '@modelcontextprotocol/ext-apps';
// Application-owned sizing uses public App APIs and cancels queued work on retirement.
export function ownSizing(app:App,signal:AbortSignal){
 let frame:number|undefined,stopped=false,lastWidth=-1,lastHeight=-1;
 const refresh=()=>{if(stopped||frame!==undefined)return;frame=requestAnimationFrame(()=>{
  frame=undefined;if(stopped)return;
  const root=document.documentElement,prior=root.style.height;let height:number;
  try{root.style.height='max-content';height=Math.ceil(root.getBoundingClientRect().height);}finally{root.style.height=prior;}
  const width=Math.ceil(window.innerWidth);if(width===lastWidth&&height===lastHeight)return;
  lastWidth=width;lastHeight=height;
  void app.sendSizeChanged({width,height}).catch(()=>{});
 });};
 const observer=new ResizeObserver(refresh);
 const stop=()=>{if(stopped)return;stopped=true;observer.disconnect();if(frame!==undefined){cancelAnimationFrame(frame);frame=undefined;}signal.removeEventListener('abort',stop);};
 if(signal.aborted)stop();else{signal.addEventListener('abort',stop,{once:true});observer.observe(document.documentElement);observer.observe(document.body);refresh();}

}
