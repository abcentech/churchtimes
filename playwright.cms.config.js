import { defineConfig } from '@playwright/test';
import existing from './playwright.config.js';
const publicUrl=process.env.PUBLIC_FRONTEND_TEST_URL || 'http://127.0.0.1:5177';
const ssrUrl=process.env.PUBLIC_SSR_TEST_URL || 'http://127.0.0.1:5373';
const cmsUrl = process.env.PUBLIC_CMS_TEST_URL || 'http://127.0.0.1:3201';
const aliasUrl=process.env.PUBLIC_ALIAS_TEST_URL || 'http://127.0.0.1:5179';
const browserCmsUrl=cmsUrl.replace('127.0.0.1','cms.churchtimes.localhost');
export default defineConfig({
  ...existing,testDir:'./cms-integration-tests',fullyParallel:false,workers:1,
  use:{...existing.use,baseURL:publicUrl+'/',launchOptions:{...existing.use.launchOptions,args:[...existing.use.launchOptions.args,'--host-resolver-rules=MAP cms.churchtimes.localhost 127.0.0.1']}},
  webServer:[{command:`npm run dev -- --port ${new URL(publicUrl).port} --strictPort`,url:publicUrl,reuseExistingServer:false,
    env:{VITE_PUBLIC_CMS_URL:cmsUrl,VITE_PUBLIC_SUBMISSIONS_URL:'',
      VITE_PUBLIC_CONTACT_URL:'',VITE_TURNSTILE_SITE_KEY:'1x00000000000000000000AA',VITE_TURNSTILE_ACTION:'submit-story',VITE_PUBLIC_SITE_URL:'https://staging-public.example.test'},
  },{command:'npm run serve:public',url:ssrUrl,reuseExistingServer:false,env:{PORT:new URL(ssrUrl).port,PUBLIC_CMS_URL:cmsUrl,PUBLIC_SITE_URL:'https://staging-public.example.test',PUBLIC_DIST:process.env.PUBLIC_TEST_DIST || 'dist',PUBLIC_INDEXABLE:'false',PUBLIC_ARTICLE_PATH_TEMPLATE:'/reports/{slug}/',PUBLIC_ADS_TXT_LINE:'example.test, synthetic-publisher, DIRECT',PUBLIC_SEARCH_CONSOLE_VERIFICATION:'synthetic-owner-verification'}},{command:`npm run dev -- --port ${new URL(aliasUrl).port} --strictPort`,url:aliasUrl,reuseExistingServer:false,env:{VITE_PUBLIC_CMS_URL:browserCmsUrl,VITE_PUBLIC_SUBMISSIONS_URL:'',VITE_PUBLIC_CONTACT_URL:'',VITE_TURNSTILE_SITE_KEY:'1x00000000000000000000AA',VITE_TURNSTILE_ACTION:'submit-story'}}],
});
