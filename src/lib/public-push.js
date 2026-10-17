// Inert unless the owner configures the public app ID AND the reader explicitly opts in.
export const PUSH_SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
export const PUSH_WORKER_PATH = '/OneSignalSDKWorker.js';
export function validPushAppId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : '';
}
const controllers = new WeakMap();
export function mountPublicPush({root,appId,hasConsent,subscribeConsent,requestConsent,window:win=window,document:doc=document}) {
  appId=validPushAppId(appId);
  if(!root || !appId)return ()=>{};
  if(controllers.has(root))return controllers.get(root);
  const button=doc.createElement('button');button.type='button';button.textContent='Enable notifications';
  const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  root.append(button,status);
  let loading,provider,disposed=false,generation=0;
  const allowed=()=>!disposed&&hasConsent('push')===true;
  const available=()=>win.isSecureContext&&'serviceWorker' in win.navigator&&'Notification' in win;
  const update=()=>{button.disabled=!available();status.textContent=available()?'Notifications are optional. Enable them here after choosing push consent.':'Notifications are unavailable in this browser.';};
  update();
  async function revoke() {
    generation++;
    try {await provider?.User?.PushSubscription?.optOut();}catch{}
    // Do not disturb a different application's root worker.
    try {for(const registration of await win.navigator.serviceWorker.getRegistrations()) {
      const worker=registration.active||registration.waiting||registration.installing;
      if(worker&&new URL(worker.scriptURL).origin===win.location.origin&&new URL(worker.scriptURL).pathname===PUSH_WORKER_PATH)await registration.unregister();
    }}catch{}
  }
  const unsubscribe=subscribeConsent(()=>{if(!allowed()){void revoke();status.textContent='Push consent is off. New notification requests have stopped.';}});
  async function sdk() {
    if(loading)return loading;
    loading=new Promise((resolve,reject)=>{
      const timer=win.setTimeout(()=>reject(Error('unavailable')),10000);
      const script=doc.createElement('script');script.src=PUSH_SDK_URL;script.async=true;script.crossOrigin='anonymous';
      script.onerror=()=>{win.clearTimeout(timer);script.remove();reject(Error('unavailable'));};
      win.OneSignalDeferred=win.OneSignalDeferred||[];
      win.OneSignalDeferred.push(async OneSignal=>{
        try {
          if(!allowed())throw Error('consent');
          await OneSignal.init({appId,serviceWorkerPath:PUSH_WORKER_PATH,serviceWorkerParam:{scope:'/'},autoResubscribe:false,notifyButton:{enable:false},promptOptions:{slidedown:{prompts:[]}}});
          provider=OneSignal;win.clearTimeout(timer);
          if(!allowed()){await revoke();throw Error('consent');}
          resolve(OneSignal);
        }catch(error){win.clearTimeout(timer);reject(error);}
      });
      doc.head.append(script);
    });
    // Keep failure sticky: no duplicate script/init on repeated clicks. Reload permits a fresh attempt.
    return loading;
  }
  button.addEventListener('click',async()=>{
    if(!available())return;
    if(!allowed()){requestConsent();status.textContent='Choose optional push consent, then select Enable notifications.';return;}
    const current=++generation;button.disabled=true;status.textContent='Preparing notification settings…';
    try {
      const OneSignal=await sdk();
      if(!allowed()||current!==generation)return;
      await OneSignal.Notifications.requestPermission();
      if(!allowed()||current!==generation){await revoke();return;}
      status.textContent=OneSignal.Notifications.permission?'Notifications are enabled. You can turn push consent off at any time.':'Notifications remain off. You can change permission in your browser settings.';
    }catch{if(allowed())status.textContent='Notifications could not be enabled. Reload to try again.';}
    finally{if(!disposed)button.disabled=!available();}
  });
  const dispose=()=>{disposed=true;generation++;unsubscribe();button.remove();status.remove();controllers.delete(root);};
  controllers.set(root,dispose);return dispose;
}
