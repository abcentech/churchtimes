import {normalizeBasePath,validReportSlug} from './public-routes.js';
// Clean public paths share their browser views with the existing hash navigation.
export function publicPageRoute(path,basePath='/') {
  const base=normalizeBasePath(basePath);
  if(!path.startsWith(base))return null;
  const relative=path.slice(base.length).replace(/\/$/,'');
  if(['latest','about','contact','advertise'].includes(relative))return [relative];
  if(relative==='give'||relative==='give/thanks')return relative.split('/');
  // Reader trust and author pages (tools/public-routes/reader-pages.mjs, src/features/reader/reader-pages.js).
  const reader=relative.match(/^(?:(corrections)|about\/(editorial-standards|ownership)|author\/([a-z0-9]+(?:-[a-z0-9]+)*))$/);
  if(reader)return reader[1]?[reader[1]]:reader[2]?['trust',reader[2]]:['author',reader[3]];
  const category=relative.match(/^category\/([^/]+)$/);
  return category && validReportSlug(category[1])?['category',category[1]]:null;
}
