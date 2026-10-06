// §S2 — the server's analytics cache.
//
// The four analytics reads (velocity, burndown, forecast and the plan-change
// counts) are pure derivations over what the store holds, plus the current
// date. So an answer is held per (project key, read, its parameters) and
// served again until either:
//   - an `events`-kind store change fires for THAT project (every plan,
//     queue, release and run write emits it — the writes that can move the
//     figures), which drops the whole project's held answers; or
//   - the UTC day rolls over: the figures' rolling windows and "today"
//     position move with the date, so an answer computed on an earlier day is
//     never served (the project's held answers are dropped on the first read
//     of a new day).
// An `agents`-kind change (a heartbeat or registration) never moves the
// figures and never invalidates; one project's change never touches another
// project's answers. A project's deletion emits `events` for it, so held
// answers never outlive the projects that exist. Nothing is persisted: the
// cache lives in memory beside its store, subscribed once to its change feed.
import type { ChangeKind, Store } from "./store.ts";

/** The UTC calendar day an instant falls on, `YYYY-MM-DD`. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** One project's held answers, all computed on `day`. */
interface ProjectAnswers {
  day: string;
  answers: Map<string, object>;
}

export class AnalyticsCache {
  private readonly byProject = new Map<string, ProjectAnswers>();

  constructor(store: Store) {
    store.onChange((kind, projectKey) => this.onStoreChange(kind, projectKey));
  }

  /**
   * The held answer for `projectKey`'s read `slot` (the read's name and its
   * parameters), or `compute()`'s, held when it is an answer. A `null` from
   * `compute` (the read's "nothing to analyse" refusal) is returned and never
   * held.
   */
  answer<T extends object>(
    projectKey: string,
    slot: readonly (string | number | undefined)[],
    compute: () => T | null,
  ): T | null {
    const day = utcDay(Date.now());
    const key = JSON.stringify(slot);
    let held = this.byProject.get(projectKey);
    if (held !== undefined && held.day !== day) held = undefined;
    const cached = held?.answers.get(key);
    // A slot names exactly one read, so what it holds is that read's `T`.
    if (cached !== undefined) return cached as T;
    const computed = compute();
    if (computed === null) return null;
    if (held === undefined) {
      held = { day, answers: new Map() };
      this.byProject.set(projectKey, held);
    }
    held.answers.set(key, computed);
    return computed;
  }

  private onStoreChange(kind: ChangeKind, projectKey?: string): void {
    if (kind !== "events") return;
    if (projectKey === undefined) this.byProject.clear();
    else this.byProject.delete(projectKey);
  }
}

const caches = new WeakMap<Store, AnalyticsCache>();

/** The one analytics cache for `store`, created (and subscribed) on first use. */
export function analyticsCacheFor(store: Store): AnalyticsCache {
  let cache = caches.get(store);
  if (cache === undefined) {
    cache = new AnalyticsCache(store);
    caches.set(store, cache);
  }
  return cache;
}
