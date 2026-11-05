import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './mcp.mjs';

const { server, service } = createServer();
let closing = false;
async function stop() {
  if (closing) return;
  closing = true; service.dispose();
  await server.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdin.once('end', stop);
try { await server.connect(new StdioServerTransport()); }
catch { service.dispose(); process.stderr.write('MCP startup failed\n'); process.exitCode = 1; }
