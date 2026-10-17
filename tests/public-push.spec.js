import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const appId='11111111-1111-4111-8111-111111111111'; // STUB UUID; not a configured provider application.
async function panel(page,id=appId) {
  await page.goto('/');
  await page.evaluate(async id=>{
    // STUB service-worker and SDK transports. No real provider, registration or permission prompt.
    window.pushTrace=[];window.pushConsent=false;window.pushListeners=[];
    window.pushSet=value=>{window.pushConsent=value;window.pushListeners.forEach(callback=>callback());};
    Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistrations:async()=>[
      {active:{scriptURL:location.origin+'/OneSignalSDKWorker.js'},unregister:async()=>window.pushTrace.push('unregister-own')},
      {active:{scriptURL:location.origin+'/other-worker.js'},unregister:async()=>window.pushTrace.push('unregister-other')},
    ]}});
    const root=document.createElement('section');root.id='push-test-panel';root.setAttribute('aria-label','Notification preferences');document.querySelector('main').append(root);
    const module=await import('/src/lib/public-push.js');window.mountPush=()=>module.mountPublicPush({root,appId:id,hasConsent:()=>window.pushConsent,subscribeConsent:callback=>{window.pushListeners.push(callback);return()=>{};},requestConsent:()=>window.pushTrace.push('request-consent')});window.mountPush();
  },id);
}
test('push is inert without configuration, consent and an explicit reader click',async({page})=>{
  const requests=[];page.on('request',request=>{if(request.url().includes('onesignal'))requests.push(request.url());});
  await panel(page,'');expect(await page.locator('#push-test-panel').textContent()).toBe('');expect(requests).toEqual([]);
  await panel(page);await page.evaluate(()=>window.pushSet(true));expect(requests).toEqual([]);
  await page.evaluate(()=>window.pushSet(false));await page.getByRole('button',{name:'Enable notifications',exact:true}).click();
  await expect(page.locator('#push-test-panel [role="status"]')).toContainText('Choose optional push consent');expect(requests).toEqual([]);
  expect(await page.evaluate(()=>window.pushTrace)).toContain('request-consent');
});
test('keyboard push activation uses one STUB SDK, withdrawal opts out and unregisters only its worker',async({page})=>{
  const requests=[];
  await page.route('https://cdn.onesignal.com/**',async route=>{
    requests.push(route.request().url());
    // STUB provider implementation. It records requested settings and never contacts OneSignal.
    await route.fulfill({contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:`(async()=>{const provider={init:async options=>{window.pushTrace.push(['init',options]);},Notifications:{permission:true,requestPermission:async()=>window.pushTrace.push('permission')},User:{PushSubscription:{optOut:async()=>window.pushTrace.push('opt-out')}}};for(const callback of window.OneSignalDeferred||[])await callback(provider);})();`});
  });
  await panel(page);await page.evaluate(()=>{window.mountPush();window.pushSet(true);});
  await expect(page.getByRole('button',{name:'Enable notifications',exact:true})).toHaveCount(1);
  const button=page.getByRole('button',{name:'Enable notifications',exact:true});await button.focus();await page.keyboard.press('Enter');
  await expect(page.locator('#push-test-panel [role="status"]')).toContainText('Notifications are enabled');
  expect(requests).toEqual(['https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js']);
  const trace=await page.evaluate(()=>window.pushTrace);expect(trace.filter(value=>Array.isArray(value)&&value[0]==='init')).toHaveLength(1);expect(trace).toContain('permission');
  expect(trace[0][1]).toMatchObject({appId,serviceWorkerPath:'/OneSignalSDKWorker.js',serviceWorkerParam:{scope:'/'},autoResubscribe:false});
  await page.evaluate(()=>window.pushSet(false));await expect.poll(()=>page.evaluate(()=>window.pushTrace.includes('unregister-own'))).toBe(true);
  const revoked=await page.evaluate(()=>window.pushTrace);expect(revoked).toContain('opt-out');expect(revoked).not.toContain('unregister-other');
  const results=await new AxeBuilder({page}).include('#push-test-panel').analyze();expect(results.violations).toEqual([]);
});
test('withdrawing consent during SDK loading prevents initialization and browser permission',async({page})=>{
  await page.route('https://cdn.onesignal.com/**',route=>route.fulfill({contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:'// STUB delayed SDK transport; no provider code.'}));
  await panel(page);await page.evaluate(()=>window.pushSet(true));await page.getByRole('button',{name:'Enable notifications',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.OneSignalDeferred?.length)).toBe(1);
  await page.evaluate(async()=>{window.pushSet(false);await window.OneSignalDeferred[0]({init:async()=>window.pushTrace.push('forbidden-init'),Notifications:{requestPermission:async()=>window.pushTrace.push('forbidden-permission')}});});
  await expect(page.locator('#push-test-panel [role="status"]')).toContainText('Push consent is off');
  expect(await page.evaluate(()=>window.pushTrace)).not.toContain('forbidden-init');expect(await page.evaluate(()=>window.pushTrace)).not.toContain('forbidden-permission');
});
