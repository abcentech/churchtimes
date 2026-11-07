import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkReaderHeadroom,minimumReaderHeadroom} from '../tools/check-reader-budget.mjs';
import budgets from '../tools/public-quality-budgets.json' with {type:'json'};
test('Reader entry retains at least 3 KiB below the unchanged public JS ceiling',()=>{
 assert.equal(minimumReaderHeadroom,3072);
 const boundary=budgets.maxInitialJsGzipBytes-3072;
 assert.equal(checkReaderHeadroom({initialJsGzipBytes:boundary}).headroomBytes,3072);
 assert.throws(()=>checkReaderHeadroom({initialJsGzipBytes:boundary+1}),/headroom/);
 assert.throws(()=>checkReaderHeadroom({initialJsGzipBytes:NaN}),/headroom/);
});
