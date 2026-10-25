// risk: the shared risky-command classifier. The fixture table is a plain array on purpose: the
// phone repo (app/src/approvals.ts) carries the same rules and can copy the table verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRiskyRequest, RISKY_FIXTURES } from '../risk.mjs';

test('the fixture table: every command, risky or safe, exactly as the classifier sees it', () => {
  for (const f of RISKY_FIXTURES) {
    assert.equal(isRiskyRequest({ riskLevel: f.riskLevel, input: { command: f.command } }), f.risky, f.command);
  }
});

test('non-string commands and missing fields are never risky; the classics ignore riskLevel', () => {
  for (const junk of [
    undefined, null, 42, 'x',
    {}, { riskLevel: 'high' },
    { riskLevel: 'high', input: {} },
    { riskLevel: 'high', input: { command: 42 } },
    { riskLevel: 'high', input: { file_path: '/etc/hosts' } },              // an edit request has no command
    { riskLevel: 'high', input: { command: null } },
  ]) {
    assert.equal(isRiskyRequest(junk), false);
  }
  assert.equal(isRiskyRequest({ riskLevel: 42, input: { command: 'rm -rf /' } }), true);
  assert.equal(isRiskyRequest({ riskLevel: undefined, input: { command: 'sudo ls' } }), true);
  assert.equal(isRiskyRequest({ input: { command: 'git push --force' } }), true);
});
