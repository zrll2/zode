import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCommand as ro, decidePermission as decide } from '../approval-policy.mjs';

const allowed = [
  'ls -la /Applications/ZCode.app/Contents/Resources/ 2>/dev/null | head -40; echo "---"; cat /x/app-update.yml 2>/dev/null; /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /x/Info.plist 2>/dev/null; file /a /b',
  'git -C /x status --short', 'git diff HEAD~1', 'grep -rn "foo" src | head', 'find . -name "*.ts" -not -path "./node_modules/*"', 'sed -n 1,20p a.ts', 'cd /x && ls',
];
const denied = [
  'rm -rf x', 'npm install', 'npm --version', 'curl http://x', 'cat a > b', 'echo hi >> f', 'sed -i s/a/b/ f', 'find . -delete', 'git push', 'git branch -D x', 'git checkout .',
  'cat ~/.ssh/id_rsa', 'cat .env', 'ls $(pwd)', 'ls `pwd`', 'node x.js', 'cat <<EOF\nx\nEOF', 'ls; rm a', 'cat ~/.zcode/v2/credentials.json', 'python3 -c "1"', 'git config user.email a@b.c',
];
test('read-only commands are allowed', () => { for (const c of allowed) assert.equal(ro(c), true, c); });
test('everything else is denied', () => { for (const c of denied) assert.equal(ro(c), false, c); });
test('decidePermission: commands, paths inside and outside the worktree, unknown input', () => {
  assert.equal(decide({ input: { command: 'rm -rf x' } }, '/w').decision, 'deny');
  assert.equal(decide({ input: { command: 'ls' } }, '/w').decision, 'allow');
  assert.equal(decide({ input: { file_path: '/w/src/a.ts' } }, '/w').decision, 'allow');
  assert.equal(decide({ input: { file_path: '/etc/hosts' } }, '/w').decision, 'deny');
  assert.equal(decide({ input: { file_path: '/w/../x' } }, '/w').decision, 'deny');
  assert.equal(decide({}, '/w').decision, 'deny');
});
