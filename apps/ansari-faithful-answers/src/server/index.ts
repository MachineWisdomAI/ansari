import {listen} from './http-server.js';
import {writeOperationLog} from './operation-log.js';
const service = await listen();
writeOperationLog({event: 'startup', port: service.port});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void service.close().then(() => process.exit(0)); });
}
