/**
 * Local-only state: what cannot be rebuilt from a shape log.
 *
 * Synced collections are derived and get dropped on a schema bump; these do not, and get real
 * migrations instead. Drafts, unsent mutations and UI state live here — starting with the
 * desktop tab strip.
 */

export { active, empty, transitions, type Strip, type Tab } from './tabs';
export {
  bootTarget,
  createWriter,
  keyOf,
  memoryStore,
  restore,
  reviveStrip,
  webStore,
  type StripKey,
  type StripStore,
  type StripWriter,
} from './storage';
