// A fake ZCode agent for tests. It raises two permission requests and one ordinary request, and logs every line it receives.
import fs from 'node:fs';
const log = process.env.STUB_LOG;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
setTimeout(() => {
  out({ id: 'server-1', method: 'interaction/requestPermission', params: { sessionId: 's1', toolName: 'Write', reason: 'needs approval', riskLevel: 'medium', requestId: 'r1', input: { file_path: '/x' } } });
  out({ id: 'server-2', method: 'session/requestRuntimePreferences', params: { sessionId: 's1', scope: 'user-execution' } });
  out({ id: 'server-3', method: 'interaction/requestPermission', params: { sessionId: 's1', toolName: 'Edit', reason: 'r', riskLevel: 'low', requestId: 'r3', input: {} } });
}, 300);
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { fs.appendFileSync(log, buf.slice(0, i) + '\n'); buf = buf.slice(i + 1); } });
