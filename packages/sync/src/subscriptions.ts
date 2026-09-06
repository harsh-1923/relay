/**
 * Effect-with-inverse registry: every subscription registers its own teardown.
 *
 * Electric subscriptions live outside the React tree and outlive any component, which is
 * exactly where the leak happens. A collection that nobody unsubscribes keeps long-polling for
 * the life of the page, and the symptom — a slow climb in open requests until the browser's
 * per-origin cap is hit — appears far from the cause.
 *
 * ~50 lines we own rather than a Cordis dependency: React's `useEffect` cleanup already
 * provides this discipline *inside* the tree, and layering a second lifecycle system under it
 * means two things that believe they own teardown.
 *
 * **Subscriptions are independent of what is rendered.** Holding a room's subscription open
 * while another room is on screen is the point: switching rooms is then a local query against
 * data already present, and a room updated while you were elsewhere is already correct when
 * you arrive. Rendering does not drive this; `retain` and `release` do.
 */

export interface Entry {
  /** What is subscribed — a room id, a conversation id, the org. */
  key: string;
  /** Called when the last holder releases. Must be idempotent. */
  dispose: () => void;
}

export interface Registry {
  /**
   * Subscribe, or take a share in an existing subscription.
   *
   * Returns the release function for *this* holder. Two components asking for the same room
   * share one subscription, and it survives until both let go — which is what stops a
   * remount from tearing down and immediately re-establishing a shape.
   */
  retain: (key: string, create: () => () => void) => () => void;
  /** Whether anything currently holds this key. For tests and diagnostics. */
  has: (key: string) => boolean;
  /** Live keys, for diagnostics — "what is this client actually subscribed to". */
  keys: () => string[];
  /** Tear everything down. Sign-out, account switch, and test teardown. */
  clear: () => void;
}

export function createRegistry(): Registry {
  const held = new Map<string, { count: number; dispose: () => void }>();

  return {
    retain(key, create) {
      const existing = held.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        held.set(key, { count: 1, dispose: create() });
      }

      // Released is per-holder, not per-key: calling it twice must not decrement someone
      // else's share. A component that unmounts twice under StrictMode would otherwise tear
      // down a subscription another component still holds.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const entry = held.get(key);
        if (!entry) return;
        entry.count -= 1;
        if (entry.count > 0) return;
        held.delete(key);
        entry.dispose();
      };
    },

    has: (key) => held.has(key),
    keys: () => [...held.keys()],

    clear() {
      // Copy first: dispose may itself release, which would mutate the map mid-iteration.
      for (const entry of [...held.values()]) entry.dispose();
      held.clear();
    },
  };
}
