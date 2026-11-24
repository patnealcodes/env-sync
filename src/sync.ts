import { syncWorkflow, type SyncResult } from "./workflow.js";
export type { SyncResult } from "./workflow.js";

/** Manually sync without prompting. A failed backup always leaves the local file intact. */
export function syncEnv(exampleFile: string, localFile: string): SyncResult {
  const work = syncWorkflow(exampleFile, localFile);
  let step = work.next();
  while (!step.done) step = work.next(false);
  return step.value;
}
