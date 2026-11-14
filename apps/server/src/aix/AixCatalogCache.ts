import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

/** Profile lists and per-profile catalogs are re-read at most once per TTL unless forced. */
const CATALOG_TTL = Duration.hours(24);
const CATALOG_TTL_MILLIS = Duration.toMillis(CATALOG_TTL);

export interface StaleMarker {
  /** Epoch milliseconds of the refresh that failed. */
  readonly since: number;
  /** Failure code only; error messages and response bodies can echo credentials. */
  readonly code: string;
}

export interface CatalogRead<A> {
  readonly value: A;
  readonly stale: StaleMarker | undefined;
}

export interface CatalogReadOptions<E> {
  readonly force: boolean;
  readonly failureCode: (error: E) => string;
  readonly fallbackKey?: string | undefined;
}

export interface CatalogCache<A> {
  readonly read: <E>(
    key: string,
    load: Effect.Effect<A, E>,
    options: CatalogReadOptions<E>,
  ) => Effect.Effect<CatalogRead<A>, E>;
  readonly retain: (keep: (key: string) => boolean) => Effect.Effect<void>;
  readonly isExpired: (key: string) => Effect.Effect<boolean>;
}

interface Entry<A> {
  readonly value: A;
  /** Successful loads so far, including this one; a read that started earlier can reuse it. */
  readonly loadedAt: number;
  readonly fetchedAt: number;
  readonly stale: StaleMarker | undefined;
}

/**
 * Read-through cache keyed by a non-secret identity. Reads share one lock. A read reuses a value
 * that a load finished after the read began, so concurrent callers load once. A failed load keeps
 * the last valid value and marks it stale; with no value yet, the failure is returned.
 */
export const make = Effect.fn("AixCatalogCache.make")(function* <A>() {
  const entries = new Map<string, Entry<A>>();
  const lock = yield* Semaphore.make(1);
  let loads = 0;

  const read = Effect.fn("AixCatalogCache.read")(function* <E>(
    key: string,
    load: Effect.Effect<A, E>,
    options: CatalogReadOptions<E>,
  ) {
    const loadsAtRequest = loads;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const current = entries.get(key);
        if (
          current !== undefined &&
          (current.loadedAt > loadsAtRequest ||
            (!options.force && now - current.fetchedAt < CATALOG_TTL_MILLIS))
        ) {
          return { value: current.value, stale: current.stale };
        }

        const loaded = yield* Effect.result(load);
        const finishedAt = yield* Clock.currentTimeMillis;
        if (Result.isSuccess(loaded)) {
          loads += 1;
          entries.set(key, {
            value: loaded.success,
            loadedAt: loads,
            fetchedAt: finishedAt,
            stale: undefined,
          });
          return { value: loaded.success, stale: undefined };
        }
        const stale = { since: finishedAt, code: options.failureCode(loaded.failure) };
        const fallback =
          current ??
          (options.fallbackKey === undefined ? undefined : entries.get(options.fallbackKey));
        if (fallback === undefined) return yield* Effect.fail(loaded.failure);
        entries.set(key, { ...fallback, stale });
        return { value: fallback.value, stale };
      }),
    );
  });

  const retain = Effect.fn("AixCatalogCache.retain")(function* (keep: (key: string) => boolean) {
    yield* lock.withPermits(1)(
      Effect.sync(() => {
        for (const key of entries.keys()) {
          if (!keep(key)) entries.delete(key);
        }
      }),
    );
  });

  const isExpired = Effect.fn("AixCatalogCache.isExpired")(function* (key: string) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const entry = entries.get(key);
        if (entry === undefined) return true;
        return (yield* Clock.currentTimeMillis) - entry.fetchedAt >= CATALOG_TTL_MILLIS;
      }),
    );
  });

  return { read, retain, isExpired } satisfies CatalogCache<A>;
});
