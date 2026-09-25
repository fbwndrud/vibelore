import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executePinnedDraft } from '../src/core/draft-execution.js';
import { emptyStoryState } from '../engine/src/continuity/story-state.js';

test('the final provider request capture preserves Unicode and hashes NFD/NFC differently',async()=>{
 const execute=async(text)=>{
  let sent;
  const result=await executePinnedDraft({resolvedInputs:{
   compiler:{identity:{workId:'w',chapter:1},episode:{writerText:text},authorCraft:{writerText:'Follow the plan.'},continuity:{castIds:[],locations:[]}},
   engine:{foundation:{workId:'w',genre:'other',worldFacts:[],characters:[],genreProfile:{invariants:[]}},prevState:emptyStoryState('w'),chapterNumber:1,model:{provider:'host',modelId:'test'}},
  }},{provider:{async complete(request){sent=request;return{text:'A door opens.'};}}});
  assert.equal(result.ok,true);assert.deepEqual(result.value.providerRequest,sent);return result.value;
 };
 const nfd='Cafe\u0301';const nfc=nfd.normalize('NFC');const a=await execute(nfd),b=await execute(nfc);
 assert.match(JSON.stringify(a.providerRequest),new RegExp(nfd));assert.notEqual(a.providerRequestHash,b.providerRequestHash);
});
