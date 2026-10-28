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

test('sed commands that write or execute are denied, quoted or not', () => {
  for (const c of [
    "sed -n 'w /tmp/x' f",                                        // w command, inside quotes
    'sed -n "W /tmp/x" f',                                        // W (append to file)
    "sed -n '/TODO/r /etc/hosts' f",                              // r (read file into output)
    'sed -n "4R f" f',                                            // R (read line from file)
    "sed 's/a/b/e' f",                                            // e flag: execute
    "sed -n 's/a/b/w /tmp/x' f",                                  // w flag: write
    "sed -n 's/a/b/ge' f",                                        // g + e flags
    "sed 's/x/y/2w out' f",                                       // count + w flag
    "sed -n 's/ser/remove/w notes.txt' notes.txt",                // w flag on a plain inspection-looking script
    'sed -i s/a/b/ f',                                            // in place (short)
    'sed -I.bak s/a/b/ f',                                        // in place (BSD -I with suffix)
    'sed --in-place s/a/b/ f',                                    // in place (long)
    'sed 1p f -i',                                                // in place moved after the script (getopt permutation)
    'sed -f script.sed f',                                        // script from a file we cannot inspect
    'sed --file=script.sed f',
    "sed -e 'w /tmp/x' f",                                        // script via -e
    "sed -e's/a/b/e' f",                                          // script attached to -e, e flag
    'sed -n p f -e w',                                            // -e smuggled in after the script
    'sed -e 1p f -i',                                             // in place moved after the file (getopt permutation)
    'sed -e "w /tmp/x" f',                                        // write smuggled through -e
    'sed --expression "w /tmp/x" f',
    'sed -n "{p;}" f',                                            // blocks are not on the safe list
    'sed -n "20q" f',                                             // q (quit) is not on the safe list either
  ]) assert.equal(ro(c), false, c);
});

test('sed read forms still pass, including quoted multi-command scripts', () => {
  for (const c of [
    "sed -n '1,20p' a.ts",
    "sed -n '/TODO/p' src/a.ts",
    "sed -n '1,20 s/a/b/p' f",                                    // address + range + s///p
    "sed 's/a/b/g' f",
    'sed -E -n "s/(x)/[\\1]/p" f',
    'sed -n p f',
    "sed -n 's/ser/remove/gp' notes.txt",                         // letters that look like commands are inside the bodies
    "sed -n '$p' f",
    'sed -n 30,60p f',
    "sed -e '1p' a.ts",                                           // with -e the positional is an input file, not a script
    "sed --expression '1,20p' a.ts",
  ]) assert.equal(ro(c), true, c);
});

test('output-file flags of read-only tools are denied', () => {
  for (const c of [
    'sort -o /tmp/x a', 'sort -ofile a', 'sort --output=/tmp/x a', 'sort --output /tmp/x a',
    'uniq a b',                                                   // uniq IN OUT writes OUT
    'uniq -- -x out',                                             // -- does not hide the output file
    'tree -o /tmp/x',
    'find . -fprint /tmp/x', 'find . -fprintf /tmp/x "%p"', 'find . -fls /tmp/x',
  ]) assert.equal(ro(c), false, c);
  for (const c of ['sort a', 'sort -r a', 'uniq -c a', 'uniq -f2 a', 'tree /x', 'du -sh /x']) assert.equal(ro(c), true, c);
});

test('git read subcommands only; mutators and config injection denied', () => {
  for (const c of [
    'git remote add x https://y', 'git remote set-url x https://y', 'git remote remove x',
    'git branch tmp', 'git branch -m a b', 'git branch --delete x',
    'git config x y', 'git config core.autocrlf true',
    'git -c diff.external=evil diff',                             // one-shot config arms an external diff runner
    'git diff --output=/tmp/pwn', 'git log --output=/tmp/pwn', 'git show HEAD --output=/tmp/pwn',
    'git --git-dir /tmp/x rev-parse HEAD',                        // unknown global option
    'git status --porcelain && git push',
  ]) assert.equal(ro(c), false, c);
  for (const c of [
    'git status --porcelain', 'git -C /x diff', 'git log --oneline', 'git show HEAD', 'git rev-parse HEAD',
    'git ls-files', 'git ls-files -o',
    'git branch', 'git branch -a', 'git branch -r', 'git branch --list', 'git branch --show-current',
    'git remote', 'git remote -v',
    'git config --get user.name', 'git config --list',
    'git --no-pager diff',
  ]) assert.equal(ro(c), true, c);
});
