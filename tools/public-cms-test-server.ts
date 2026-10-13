/** Loopback-only test host for real Payload REST + PostgreSQL.
 * Only Cloudflare's external HTTP transport is stubbed using the backend's
 * NODE_ENV=test-only seam. Never start this as an application/deployment server.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

if (process.env.NODE_ENV !== 'test') throw new Error('This harness requires NODE_ENV=test.')
const db = new URL(process.env.DATABASE_URL || '')
if (!['localhost','127.0.0.1'].includes(db.hostname)) throw new Error('Only a disposable loopback database is allowed.')
const port = Number(process.env.PUBLIC_CMS_TEST_PORT || 3201)
const cmsRequire = createRequire(new URL('../apps/cms/package.json', import.meta.url))
const loadCms = (name: string) => import(pathToFileURL(cmsRequire.resolve(name)).href)
const config = (await import('../apps/cms/src/payload.config')).default
const routes = await loadCms('@payloadcms/next/routes')
const { api, setupFixtures, newRunId, lexical } = await import('../apps/cms/tests/integration/helpers')
const { setTurnstileFetchForTests } = await import('../apps/cms/src/lib/turnstile')
const runId = newRunId()
const f = await setupFixtures(runId)
let siteverifyCalls = 0
setTurnstileFetchForTests(async (_url: string, options: RequestInit) => {
  siteverifyCalls++
  const token = new URLSearchParams(String(options.body)).get('response')
  return Response.json(token === 'public-integration-valid'
    ? { success:true, hostname:'127.0.0.1', action:'submit-story' }
    : { success:false, 'error-codes':['timeout-or-duplicate'] })
})
const edition = JSON.parse(readFileSync(new URL('../src/data/stories.json', import.meta.url), 'utf8'))
const first = edition.stories[0]
const bytes = readFileSync(new URL('../public/'+first.image, import.meta.url))
const media = await f.payload.create({collection:'media',overrideAccess:true,
  data:{alt:runId+' published photograph',caption:'CMS integration caption',credit:'CMS integration credit'},
  file:{data:bytes,name:runId+'-fixture.jpg',mimetype:'image/jpeg',size:bytes.length},
})
const published = await f.seedArticle({status:'published',publishedAt:new Date().toISOString(),
  bylineName:'CMS integration byline',featuredImage:media.id,content:lexical('Published text from real Payload and PostgreSQL.'),
  corrections:[{note:'A verified fixture correction.',correctedAt:new Date().toISOString()}],legacyUrl:first.source,
})
const reporterDraft = await f.createArticle(f.tokens.reporter,{status:'draft'})
const handlers: Record<string, any> = {
  GET:routes.REST_GET(config),POST:routes.REST_POST(config),PATCH:routes.REST_PATCH(config),
  DELETE:routes.REST_DELETE(config),OPTIONS:routes.REST_OPTIONS(config),
}
const reply = (res: any, value: unknown, status=200) => {
  res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'})
  res.end(JSON.stringify(value))
}
async function submission(reference: string) {
  const result = await f.payload.find({collection:'submissions',where:{reference:{equals:reference}},overrideAccess:true,limit:1})
  const doc = result.docs[0]
  return doc?.title.startsWith(runId) ? doc : null
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1:'+port)
    if (url.pathname === '/__test/fixtures') return reply(res,{runId,publishedSlug:published.slug,draftSlug:reporterDraft.json.doc.slug,siteverifyCalls})
    if (url.pathname === '/__test/submission') {
      const doc = await submission(url.searchParams.get('reference') || '')
      if (!doc) return reply(res,{},404)
      return reply(res,{reference:doc.reference,status:doc.status,phone:doc.phone,categorySuggestion:doc.categorySuggestion,location:doc.location,title:doc.title})
    }
    if (url.pathname === '/__test/publish' && req.method === 'POST') {
      const chunks=[];for await(const chunk of req) chunks.push(chunk)
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const doc=await submission(body.reference)
      if (!doc) return reply(res,{},404)
      const reporter=await api('PATCH',`/api/articles/${reporterDraft.id}`,{token:f.tokens.reporter,body:{status:'published'}})
      const converted=await api('POST',`/api/submissions/${doc.id}/convert`,{token:f.tokens.eic,body:{category:f.catA.id}})
      if (converted.status!==201) return reply(res,{convertStatus:converted.status},500)
      const id=converted.json.article.id
      const before=await api('GET',`/api/articles/${id}`)
      const review=await api('PATCH',`/api/articles/${id}`,{token:f.tokens.eic,body:{status:'in_review'}})
      const approve=await api('PATCH',`/api/articles/${id}`,{token:f.tokens.eic,body:{status:'approved',bylineName:'Integration editor'}})
      const publish=await api('PATCH',`/api/articles/${id}`,{token:f.tokens.eic,body:{status:'published'}})
      return reply(res,{reporterPublishStatus:reporter.status,convertStatus:converted.status,anonymousBeforeStatus:before.status,
        reviewStatus:review.status,approveStatus:approve.status,publishStatus:publish.status,slug:converted.json.article.slug,id})
    }
    if (!url.pathname.startsWith('/api/')) return reply(res,{},404)
    const handler=handlers[req.method || 'GET']
    if (!handler) return reply(res,{},405)
    const chunks=[];for await(const chunk of req) chunks.push(chunk)
    const body=Buffer.concat(chunks)
    const request=new Request(url,{method:req.method,headers:req.headers as HeadersInit,
      ...(body.length?{body}:{}),
    })
    const response=await handler(request,{params:Promise.resolve({slug:url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent)})})
    res.writeHead(response.status,Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch(error) {
    console.error('CMS test request failed:',error instanceof Error?error.message:'unknown error')
    reply(res,{error:'Test request failed'},500)
  }
})
server.listen(port,'127.0.0.1',()=>console.log(`Real Payload REST test host ready on port ${port}; PostgreSQL active; external Siteverify transport STUBBED.`))
let stopping=false
async function stop(){if(stopping)return;stopping=true;server.close();setTurnstileFetchForTests(undefined);await f.cleanup();process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop)
