export const SIDE = '11111111-1111-4111-8111-111111111111';
export const PARENT = '22222222-2222-4222-8222-222222222222';
export const OTHER = '33333333-3333-4333-8333-333333333333';
export const OWNER = '44444444-4444-4444-8444-444444444444';
export function agent(id = 'a1', text = 'first answer') { return { type: 'agentMessage', id, text, phase: 'final_answer' }; }
export function user(id = 'u1', text = 'question') { return { type: 'userMessage', id, content: [{ type: 'text', text }] }; }
export function snapshot(items = [user(), agent()], { complete = true, sideId = SIDE, parentId = PARENT } = {}) {
  return { id: sideId, hostId: 'local', ephemeral: true, sideConversation: true,
    forkedFromId: parentId, sideConversationParentNavigationPath: `/local/${parentId}`,
    turns: [], threadRuntimeStatus: { type: 'idle' },
    turnHistory: { kind: 'canonical', history: { isComplete: complete,
      islands: [{ entries: [{ value: 't1' }] }],
      entitiesByKey: { t1: { turnId: 'turn1', status: 'completed', items } } } },
    turnsPagination: { hasLoadedOldest: complete, olderCursor: null, isLoadingOlder: false } };
}
