// Production browser coverage with SYNTHETIC C2 fields and a CMS API STUB; not real CMS integration.
import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicServer} from '../tools/serve-public.mjs';
const article={id:1,status:'published',slug:'synthetic-report',title:'Editorial title',excerpt:'Editorial excerpt',seoTitle:'Synthetic search title',seoDescription:'Synthetic search description',publishedAt:'2026-10-16T00:00:00Z',content:'Synthetic article text',corrections:[]};
let dist;
test.beforeAll(async()=>{dist=await mkdtemp(join(tmpdir(),'public-routing-build-'));execFileSync('node',['node_modules/vite/bin/vite.js','build','--outDir',dist],{env:{...process.env,VITE_PUBLIC_CMS_URL:'https://cms.example.test',VITE_PUBLIC_SITE_URL:'https://public.example.test'},stdio:'pipe'});});
test.afterAll(async()=>{await rm(dist,{recursive:true,force:true});});
for(const template of ['/{slug}/','/reports/{slug}/'])test('CMS API STUB '+template+' survives hydration and internal link navigation',async({page})=>{
 const server=createPublicServer({dist,cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',articlePathTemplate:template,fetchImpl:async url=>Response.json({docs:new URL(url).pathname==='/api/articles'?[article]:[],totalPages:1})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port,path=template.replace('{slug}',article.slug),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://cms.example.test/**',route=>route.fulfill({json:{docs:[article],totalPages:1}}));
 try {
  await page.goto(origin+path);await expect(page.locator('h1')).toHaveText(article.title);await expect(page.locator('.newsroom-article-body')).toContainText(article.content);
  await expect(page).toHaveTitle(article.seoTitle+' — Church Times Nigeria');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',article.seoDescription);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://public.example.test'+path);
  await page.goto(origin+'/latest/');const link=page.getByRole('link',{name:article.title,exact:true});await expect(link).toHaveAttribute('href',path);await link.click();
  await expect(page).toHaveURL(origin+path);await expect(page).toHaveTitle(article.seoTitle+' — Church Times Nigeria');expect(errors).toEqual([]);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
