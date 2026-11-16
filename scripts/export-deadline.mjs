// How long the smoke test waits for a claimed export job to start before it fails early.
// Observed on staging: about 13 minutes from claim to start. 30 minutes leaves margin.
export const startDeadlineMs = 30 * 60 * 1000;

// True when a claimed job is still pending past the start deadline, meaning the worker has not
// started it. A running job is never "stuck" by this rule: the overall wait limit covers it.
export function startedTooLate({ status, claimedAt, now, limitMs = startDeadlineMs }) {
  return status === "pending" && now - claimedAt > limitMs;
}
