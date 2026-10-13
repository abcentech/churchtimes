export function campaign(placement) {
  const sizes = {
    'homepage-billboard': {desktop:[970,250],mobile:[320,100]},
    'article-inline': {desktop:[728,90],mobile:[320,100]},
    'mobile-banner': {mobile:[320,50]},
  };
  return {id:`demo-${placement}`,status:'active',sponsor:'Demo campaign — test fixture',alt:'Campaign preview: direct advertising supports independent journalism',priority:1,
    startsAt:'2020-01-01T00:00:00Z',endsAt:'2099-01-01T00:00:00Z',destinationUrl:'https://example.org/campaign',placements:[placement],
    creatives:{[placement]:Object.fromEntries(Object.entries(sizes[placement]).map(([viewport,[width,height]])=>[viewport,{src:`ad-fixtures/${width}-${height}.svg`,width,height}]))}};
}
export const fixtureConfig = {campaigns:['homepage-billboard','article-inline','mobile-banner'].map(campaign),adsense:{enabled:false,reviewed:false}};
export async function configureAds(page, config = fixtureConfig) {
  await page.route('**/src/data/advertising.json*', route => route.fulfill({contentType:'application/javascript',body:`export default ${JSON.stringify(config)};`}));
  await page.route('**/ad-fixtures/*.svg', route => {
    const [width,height] = new URL(route.request().url()).pathname.split('/').pop().replace('.svg','').split('-').map(Number);
    const small = width === 320;
    return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#e9ece4"/><rect width="8" height="100%" fill="#9c4d35"/><text x="${small?20:40}" y="${height/2-4}" font-family="Georgia,serif" font-size="${small?18:32}" fill="#172b2e">Campaign preview</text><text x="${small?20:40}" y="${height/2+18}" font-family="Arial,sans-serif" font-size="${small?10:15}" fill="#172b2e">TEST FIXTURE — NOT A LIVE ADVERT</text></svg>`});
  });
}
