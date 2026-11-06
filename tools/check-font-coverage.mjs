// Which Nigerian-language characters each shipped web font really contains (reads the WOFF2 cmap table).
// Usage: node tools/check-font-coverage.mjs [--json]. Read-only; no network.
import {readFile,readdir} from 'node:fs/promises';
import {brotliDecompressSync} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
// Yoruba dotted vowels and s, Igbo dotted vowels and n, Hausa hooked letters, tone marks (precomposed and combining).
export const NIGERIAN_CHARACTERS={
  yoruba:'ẹẸọỌṣṢàáèéìíòóùúńǹḿÀÁÈÉÌÍÒÓÙÚ',
  igbo:'ịỊọỌụỤṅṄñÑ',
  hausa:'ɓƁɗƊƙƘƴƳʼ',
  combining:'̣̀́̄',
};
const readBase128=(view,state)=>{let value=0;for(let i=0;i<5;i++){const byte=view.getUint8(state.offset++);value=(value<<7)|(byte&0x7f);if(!(byte&0x80))return value>>>0;}throw new Error('Bad UIntBase128');};
// Returns the decompressed cmap table of a WOFF2 font.
export function woff2Cmap(buffer) {
  const view=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength);
  if(view.getUint32(0)!==0x774f4632)throw new Error('Not a WOFF2 file');
  const numTables=view.getUint16(12),compressedLength=view.getUint32(20);
  const state={offset:48},tables=[];
  for(let i=0;i<numTables;i++) {
    const flags=view.getUint8(state.offset++),tagIndex=flags&0x3f,version=flags>>6;
    if(tagIndex===63)state.offset+=4;
    const origLength=readBase128(view,state);
    const transformed=(tagIndex===10||tagIndex===11)?version===0:version!==0;
    const length=transformed?readBase128(view,state):origLength;
    tables.push({tagIndex,length});
  }
  const data=brotliDecompressSync(buffer.subarray(state.offset,state.offset+compressedLength));
  let offset=0;
  for(const table of tables){if(table.tagIndex===0)return data.subarray(offset,offset+table.length);offset+=table.length;}
  throw new Error('No cmap table');
}
export function cmapCodePoints(cmap) {
  const view=new DataView(cmap.buffer,cmap.byteOffset,cmap.byteLength),points=new Set();
  const count=view.getUint16(2);
  for(let i=0;i<count;i++) {
    const platform=view.getUint16(4+i*8),encoding=view.getUint16(6+i*8),at=view.getUint32(8+i*8),format=view.getUint16(at);
    if(!(platform===0||(platform===3&&(encoding===1||encoding===10))))continue;
    if(format===4) {
      const segments=view.getUint16(at+6)/2,ends=at+14,starts=ends+segments*2+2,deltas=starts+segments*2,ranges=deltas+segments*2;
      for(let s=0;s<segments;s++) {
        const end=view.getUint16(ends+s*2),start=view.getUint16(starts+s*2),delta=view.getInt16(deltas+s*2),rangeOffset=view.getUint16(ranges+s*2);
        for(let c=start;c<=end&&c!==0xffff;c++) {
          const glyph=rangeOffset?view.getUint16(ranges+s*2+rangeOffset+(c-start)*2):(c+delta)&0xffff;
          if(glyph)points.add(c);
        }
      }
    } else if(format===12) {
      const groups=view.getUint32(at+12);
      for(let g=0;g<groups;g++){const start=view.getUint32(at+16+g*12),end=view.getUint32(at+20+g*12);for(let c=start;c<=end;c++)points.add(c);}
    }
  }
  return points;
}
export async function fontCoverage(file) {
  const points=cmapCodePoints(woff2Cmap(await readFile(file)));
  return Object.fromEntries(Object.entries(NIGERIAN_CHARACTERS).map(([language,chars])=>[language,[...chars].filter(c=>!points.has(c.codePointAt(0)))]));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const root=fileURLToPath(new URL('../node_modules/@fontsource-variable/',import.meta.url)),report={};
  for(const family of ['newsreader','dm-sans'])for(const name of (await readdir(join(root,family,'files'))).filter(name=>/-wght-(normal|italic)\.woff2$/.test(name)).sort())
    report[name]=await fontCoverage(join(root,family,'files',name));
  if(process.argv.includes('--json'))process.stdout.write(JSON.stringify(report,null,2)+'\n');
  else for(const [name,missing] of Object.entries(report))console.log(name.padEnd(42),Object.entries(missing).map(([language,chars])=>`${language}: ${chars.length?'missing '+chars.map(c=>c.normalize('NFC').length&&/\p{M}/u.test(c)?'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0'):c).join(''):'ok'}`).join(' | '));
}
