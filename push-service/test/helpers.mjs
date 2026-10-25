// A fake HTTP/2 session for the APNs exchange: request(headers) -> a stream that answers with the
// given status and reason (or hangs forever for timeout tests). Records every exchange.
import { EventEmitter } from 'node:events';

export function fakeApns({ status = 200, reason = null, hang = false } = {}) {
  const calls = [];
  let closed = false;
  const connect = async ({ host }) => ({
    request(headers) {
      const req = new EventEmitter();
      req.setEncoding = () => {};
      req.end = (body) => {
        calls.push({ host, headers, body });
        if (hang) return;
        setTimeout(() => {
          req.emit('response', { ':status': status });
          req.emit('data', reason ? JSON.stringify({ reason }) : '{}');
          req.emit('end');
        }, 0);
      };
      return req;
    },
    close() { closed = true; },
    on() {},
  });
  return { connect, calls, wasClosed: () => closed };
}
