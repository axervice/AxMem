'use strict';
// Stage-1 heartbeat only: no watchdog, scheduler, recurrence claims or gates.
function recordInvocation(state, result) {
  const now = new Date().toISOString();
  state.lastStartedAt = result.startedAt;
  state.lastCompletedAt = now;
  state.consecutiveFailures = result.errors.length ? state.consecutiveFailures + 1 : 0;
  if (!result.errors.length && result.sourceReady && result.queryRan) state.lastSuccessfulRecallAt = now;
  if (!result.errors.length && result.displayed) state.lastDeliveryAt = now;
  state.lastErrors = result.errors;
  for (const [key, n] of Object.entries({ received: 1, completed: 1, source_ok: +result.sourceReady,
    query_ran: +result.queryRan, matched: result.matched, emitted: result.displayed,
    omitted: result.omitted, errors: +!!result.errors.length })) {
    state.counts[key] = (state.counts[key] || 0) + n;
  }
}
function checkHealth(state) {
  return `最近成功召回查询=${state.lastSuccessfulRecallAt || '尚未验证'}；连续失败=${state.consecutiveFailures}`;
}
module.exports = { recordInvocation, checkHealth };
if (require.main === module && process.argv.includes('--self-test')) {
  const assert = require('node:assert/strict');
  const state = { counts: {}, consecutiveFailures: 0 };
  const r = { startedAt: new Date().toISOString(), sourceReady: true, queryRan: true, matched: 0, displayed: 0, omitted: 0, errors: [] };
  recordInvocation(state, r); assert(state.lastSuccessfulRecallAt); assert.equal(state.consecutiveFailures, 0);
  recordInvocation(state, { ...r, errors: ['source-unavailable'] }); assert.equal(state.consecutiveFailures, 1);
  recordInvocation(state, r); assert.equal(state.consecutiveFailures, 0);
  console.log('recall-health self-test 3/3');
}
