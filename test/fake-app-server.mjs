import { createInterface } from 'node:readline';

// Synthetic fixture only. Each invocation receives its configuration as JSON.
const config = JSON.parse(process.argv[2]);
let historyPasses = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.id == null) continue;
  let result;
  if (request.method === 'initialize') result = {};
  else if (request.method === 'thread/list') {
    const params = request.params;
    const attached = config.ignoreFilter || params.attachedToThreadId === config.parent;
    result = { data: attached ? [{ id: config.side, ephemeral: false, status: { type: 'idle' } }] : [],
      nextCursor: null };
  } else if (request.method === 'thread/turns/list') {
    const secondPage = request.params.cursor === 'next-page';
    if (!secondPage) historyPasses++;
    const text = config.changeDuringRead && historyPasses > 1 ? 'changed' : 'first answer';
    const turn = secondPage
      ? { id: 'turn2', status: 'completed', itemsView: 'full', items: [
        { type: 'agentMessage', id: 'a2', text, phase: 'final_answer' }] }
      : { id: 'turn1', status: config.inProgress ? 'inProgress' : 'completed', itemsView: 'full', items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'question' }] },
        { type: 'commandExecution', id: 'cmd1', aggregatedOutput: 'SECRET-TOOL-OUTPUT' },
        { type: 'agentMessage', id: 'a1', text: 'progress', phase: 'commentary' }] };
    result = { data: [turn], nextCursor: secondPage ? null : 'next-page' };
  } else {
    send({ id: request.id, error: { code: -32601, message: 'unsupported method' } });
    continue;
  }
  send({ id: request.id, result });
}
