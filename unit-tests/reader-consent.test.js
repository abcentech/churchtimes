import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindConsentControls,setConsent} from '../src/lib/reader-consent.js';
test('External form permission changes immediately resynchronise the privacy checkbox',()=>{
 const input={dataset:{consent:'forms'},checked:false,addEventListener(){}};
 bindConsentControls({querySelectorAll:()=>[input]});setConsent('forms',true);assert.equal(input.checked,true);setConsent('forms',false);assert.equal(input.checked,false);
});
