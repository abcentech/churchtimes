import { deflateSync, crc32 } from 'node:zlib';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const media={id:3,url:'/api/media/file/community.png',mimeType:'image/png',width:800,height:450,alt:'Community members meeting in Lagos',caption:'Community consultation.',credit:'Church Times Nigeria',sizes:{thumbnail:{url:'/api/media/file/community-400.png',width:400,height:225}}};
const text=value=>({type:'text',text:value,format:0});
const article={id:100,slug:'community-report',status:'published',title:'A public community report',excerpt:'The newsroom reports from Lagos.',category:{id:1,title:'News'},bylineName:'Public correspondent',author:{name:'PRIVATE STAFF ACCOUNT'},publishedAt:'2026-10-13T08:00:00Z',featuredImage:media,corrections:[{note:'The venue name was corrected. <script>unsafe</script>',correctedAt:'2026-10-13T09:00:00Z'}],content:{root:{type:'root',children:[{type:'paragraph',children:[text('Reporting with context and care for our community.')]},{type:'upload',relationTo:'media',value:media}]}}};
function png(width,height){
 const chunk=(name,data)=>{const kind=Buffer.from(name);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const checksum=Buffer.alloc(4);checksum.writeUInt32BE(crc32(Buffer.concat([kind,data]))>>>0);return Buffer.concat([size,kind,data,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc((width*3+1)*height,220);for(let y=0;y<height;y++)pixels[y*(width*3+1)]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(page){
 await page.route('**/api/articles?**',route=>route.fulfill({json:{docs:[article,{...article,status:'approved',title:'Not published'}]}}));
 await page.route('**/api/media/file/**',route=>route.fulfill({contentType:'image/png',body:route.request().url().includes('-400')?png(400,225):png(800,450)}));
}
test('real CMS-shaped article renders public byline, resolved media and corrections safely',async({page})=>{
 await fixture(page);await page.goto('/#report/community-report');
 await expect(page.locator('h1')).toHaveText(article.title);
 await expect(page.locator('.article-header')).toContainText(article.bylineName);
 await expect(page.locator('main')).not.toContainText('PRIVATE STAFF ACCOUNT');
 const image=page.locator('.cms-figure').first().locator('img');
 await expect(image).toHaveAttribute('src',/http:\/\/127.0.0.1:5174\/api\/media\/file/);
 await expect(image).toHaveJSProperty('complete',true);
 expect(await image.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
 await expect(page.locator('.cms-figure').first()).toContainText('Credit: Church Times Nigeria');
 await expect(page.locator('.newsroom-corrections')).toContainText('The venue name was corrected. <script>unsafe</script>');
 await expect(page.locator('.newsroom-corrections time')).toContainText('13 October 2026');
 await expect(page.locator('main script')).toHaveCount(0);
 await expect(page.locator('.newsroom-article-body .cms-figure')).toHaveCount(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);
});
test('published feed maps populated category and public byline without rendering approvals',async({page})=>{
 await fixture(page);await page.goto('/#latest');
 await expect(page.locator('.newsroom-card')).toHaveCount(1);
 await expect(page.locator('.newsroom-card-meta')).toContainText('News');
 await expect(page.locator('.newsroom-card')).toContainText('Public correspondent');
 await expect(page.locator('main')).not.toContainText('Not published');
});
test('broken media collapses without losing the report or correction history',async({page})=>{
 await fixture(page);await page.route('**/api/media/file/**',route=>route.fulfill({status:404,body:'Unavailable'}));
 await page.goto('/#report/community-report');
 await expect(page.locator('h1')).toHaveText(article.title);
 await expect(page.locator('.cms-figure').first()).toHaveCount(0);
 await expect(page.locator('.newsroom-article-body')).toContainText('Reporting with context');
 await expect(page.locator('.newsroom-corrections')).toBeVisible();
});
test('permission and malformed-response failures remain navigable and never become mock articles',async({page})=>{
 await page.route('**/api/articles?**',route=>route.fulfill({status:403,json:{errors:[{message:'PRIVATE SERVER DIAGNOSTIC'}]}}));
 await page.goto('/#latest');
 await expect(page.getByRole('status')).toContainText('Public reporting is unavailable');
 await expect(page.locator('main')).not.toContainText('PRIVATE SERVER DIAGNOSTIC');
 await expect(page.locator('.newsroom-card')).toHaveCount(0);
 await page.unrouteAll({behavior:'wait'});
 await page.route('**/api/articles?**',route=>route.fulfill({contentType:'text/html',body:'<h1>Private server diagnostics</h1>'}));
 await page.goto('/#report/community-report');
 await expect(page.getByRole('status')).toContainText('unreadable response');
 await expect(page.locator('main')).not.toContainText('Private server diagnostics');
 await expect(page.locator('main').getByRole('link',{name:'Explore the current edition'})).toBeVisible();
});
