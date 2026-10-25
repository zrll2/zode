// "Run: <command>" / "Edit: <file name>" — the tool plus its key input, never more than 80 characters,
// plus the shared risky verdict. Shared between the Mac app (cards, dialogs) and the relay (push
// notifications), so both word a permission request the same way.
import { isRiskyRequest } from './risk.mjs';

const clip = (str, max = 80) => { const s = String(str); return s.length <= max ? s : s.slice(0, max - 1) + '…'; };

export function summarizeRequest(params) {
  const input = params?.input && typeof params.input === 'object' ? params.input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const toolName = typeof params?.toolName === 'string' && params.toolName ? params.toolName : '';
  let detail;
  if (command) detail = `Run: ${command}`;
  else if (filePath) detail = `Edit: ${filePath.split('/').filter(Boolean).pop() || filePath}`;
  else detail = toolName || 'Permission request';
  return {
    text: clip(detail),
    detail,
    risky: isRiskyRequest(params),
  };
}
