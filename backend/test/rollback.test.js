import test from 'node:test';
import assert from 'node:assert/strict';
import { rollbackCommit } from '../rollback.js';

test('rollback_commit rejects anything that is not a commit SHA before touching GitHub', async () => {
  for (const sha of ['', 'main', 'HEAD~1', 'abc; rm -rf /', 'zzzzzzz']) {
    const r = await rollbackCommit({ sha });
    assert.equal(r.ok, false);
    assert.match(r.error, /not a commit SHA/);
  }
});
