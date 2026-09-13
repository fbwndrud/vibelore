import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePublicationManifest } from '../../src/core/validation-contract.js';
const foundation={characters:[{id:'lead'}]};
test('publication manifest validates real shape and canonical IDs before permissive extraction',()=>{
 for(const raw of ['', '{"cast":[]}', '{"cast":[{"characterId":"lead","addressTermsUsed":["sir"]}]}'])assert.equal(validatePublicationManifest(raw,{foundation}).valid,true);
 for(const raw of [undefined,' ','not json','{}','{"cast":[null]}','{"cast":[{"characterId":"unknown"}]}','{"cast":[{"characterId":"lead","addressTermsUsed":2}]}','{"schemaVersion":99,"cast":[]}'])assert.equal(validatePublicationManifest(raw,{foundation}).valid,false,String(raw));
});
