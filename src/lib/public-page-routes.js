import {normalizeBasePath,validReportSlug} from './public-routes.js';
// Clean public paths share their browser views with the existing hash navigation.
export function publicPageRoute(path,basePath='/') {
  const base=normalizeBasePath(basePath);
  if(!path.startsWith(base))return null;
  const relative=path.slice(base.length).replace(/\/$/,'');
  if(['latest','about','contact','advertise'].includes(relative))return [relative];
  const category=relative.match(/^category\/([^/]+)$/);
  return category && validReportSlug(category[1])?['category',category[1]]:null;
}
