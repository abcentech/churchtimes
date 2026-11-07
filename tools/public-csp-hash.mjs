// Print the exact executable base-bootstrap hash after the final public build.
// This is a policy input; it does not set or deploy a Content-Security-Policy.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const file=process.argv[2] || new URL('../dist/index.html',import.meta.url);
const html=await readFile(file,'utf8');
const script=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
 .find(([,attributes])=>/\bid=(['"])public-base-bootstrap\1/.test(attributes));
if(!script || /\bsrc\s*=/.test(script[1]))throw new Error('Expected one inline public-base-bootstrap script in the built HTML.');
console.log(`'sha256-${createHash('sha256').update(script[2],'utf8').digest('base64')}'`);
