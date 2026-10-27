import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import budgets from './public-quality-budgets.json' with {type:'json'};
import {publicAssetSizes} from './public-quality-report.mjs';
export const minimumReaderHeadroom=3072;
export function checkReaderHeadroom(assets,limits=budgets) {
  const headroom=limits.maxInitialJsGzipBytes-assets.initialJsGzipBytes;
  if(!Number.isFinite(headroom)||headroom<minimumReaderHeadroom)throw new Error(`Initial public JS requires at least ${minimumReaderHeadroom} gzip bytes of headroom`);
  return {initialJsGzipBytes:assets.initialJsGzipBytes,headroomBytes:headroom,minimumHeadroomBytes:minimumReaderHeadroom};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const result=checkReaderHeadroom(await publicAssetSizes(resolve(process.argv[2]||'dist')));
  process.stdout.write(JSON.stringify(result)+'\n');
}
