// Small bounded in-memory TTL cache for anonymous CMS lookups made by the public host (article and category by slug).
// Positive hits live a little longer than misses; failures are never cached, so an outage heals on the next request.
// Concurrent loads of one key share a single CMS request. Oldest entries are evicted first once `max` is reached.
export function createLookupCache({ttlMs=30000,negativeTtlMs=10000,max=500,now=Date.now}={}) {
  const entries=new Map(),inflight=new Map();
  const evict=()=>{
    const time=now();
    for(const [key,entry] of entries)if(entry.expires<=time)entries.delete(key);
    while(entries.size>=max)entries.delete(entries.keys().next().value);
  };
  return {
    // `load` resolves to a value, or null/undefined for "not found" (cached briefly). A rejection propagates uncached.
    async get(key,load) {
      const hit=entries.get(key);
      if(hit&&hit.expires>now())return hit.value;
      if(hit)entries.delete(key);
      if(inflight.has(key))return inflight.get(key);
      const pending=(async()=>{
        const value=await load();
        const normalized=value===undefined?null:value;
        if(max>0){
          evict();
          entries.set(key,{value:normalized,expires:now()+(normalized===null?negativeTtlMs:ttlMs)});
        }
        return normalized;
      })().finally(()=>inflight.delete(key));
      inflight.set(key,pending);
      return pending;
    },
    clear(){entries.clear();},
    get size(){return entries.size;},
  };
}
