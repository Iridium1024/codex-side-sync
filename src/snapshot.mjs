import { fail, identity } from './errors.mjs';

export function normalizeSnapshot(state, { sideId, parentId, maxMessages = 5000 } = {}) {
  sideId = identity(sideId, 'side_id'); parentId = identity(parentId, 'parent_id');
  if (state?.id !== sideId || state.hostId !== 'local') fail('identity_mismatch');
  if (state.sideConversation !== true || state.ephemeral !== true) fail('not_side');
  // A fork alone is not proof of a Side-parent relationship.
  if (state.forkedFromId !== parentId ||
    state.sideConversationParentNavigationPath !== `/local/${parentId}`) fail('parent_mismatch');
  let turns, complete = false;
  const history = state.turnHistory;
  if (history?.kind === 'canonical') {
    const h = history.history;
    if (!Array.isArray(h?.islands) || !h?.entitiesByKey || typeof h.isComplete !== 'boolean') fail('unsupported_snapshot_shape');
    turns = [];
    const entities = new Set();
    for (const island of h.islands) {
      if (!Array.isArray(island.entries)) fail('unsupported_snapshot_shape');
      for (const entry of island.entries) {
        if (typeof entry.value !== 'string' || !Object.hasOwn(h.entitiesByKey, entry.value)) fail('unsupported_snapshot_shape');
        if (entities.has(entry.value)) fail('ambiguous_history');
        entities.add(entry.value); turns.push(h.entitiesByKey[entry.value]);
      }
    }
    complete = h.isComplete === true;
  } else if (history == null && Array.isArray(state.turns)) {
    turns = state.turns;
    complete = state.turnsPagination?.hasLoadedOldest === true && state.turnsPagination?.olderCursor == null;
  } else fail('unsupported_snapshot_shape');
  if (state.turnsPagination?.hasLoadedOldest === false ||
    state.turnsPagination?.isLoadingOlder || state.turnsPagination?.olderCursor != null) complete = false;
  for (const turn of turns) {
    if (turn?.itemsPagination && (turn.itemsPagination.hasLoadedOldest !== true ||
      turn.itemsPagination.olderCursor != null || turn.itemsPagination.isLoadingOlder)) complete = false;
  }
  const { messages, warnings } = normalizeTurns(turns, maxMessages);
  return { identity: { host_id: 'local', parent_id: parentId, side_id: sideId },
    complete, completeness_source: 'desktop_snapshot_flags_not_independently_verified',
    messages, warnings,
    runtime_status: typeof state.threadRuntimeStatus?.type === 'string' ? state.threadRuntimeStatus.type : 'unknown' };
}

export function normalizeTurns(turns, maxMessages = 5000) {
  const messages = [], ids = new Set(), warnings = new Set();
  for (const turn of turns) {
    if (!turn || !Array.isArray(turn.items)) fail('unsupported_snapshot_shape');
    for (const item of turn.items) {
      if (item?.type !== 'userMessage' && item?.type !== 'agentMessage') continue;
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) fail('ambiguous_message_id');
      if (messages.length >= maxMessages) fail('message_limit', { max_messages: maxMessages });
      ids.add(item.id);
      let text, nonText = false;
      if (item.type === 'agentMessage') {
        if (typeof item.text !== 'string') fail('assistant_content_unavailable');
        text = item.text;
      } else {
        if (!Array.isArray(item.content)) fail('unsupported_snapshot_shape');
        if (item.content.some(x => x?.type === 'text' && typeof x.text !== 'string')) fail('unsupported_snapshot_shape');
        text = item.content.filter(x => x?.type === 'text').map(x => x.text).join('\n');
        nonText = item.content.some(x => x?.type !== 'text');
        if (nonText) warnings.add('non_text_content_not_returned');
      }
      messages.push({ id: item.id, turn_id: typeof turn.turnId === 'string' ? turn.turnId : null,
        role: item.type === 'agentMessage' ? 'assistant' : 'user', text,
        phase: typeof item.phase === 'string' ? item.phase : null,
        turn_status: typeof turn.status === 'string' ? turn.status : null,
        has_non_text_content: nonText });
    }
  }
  return { messages, warnings: [...warnings] };
}
