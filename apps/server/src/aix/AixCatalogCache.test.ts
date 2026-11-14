import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as AixCatalogCache from "./AixCatalogCache.ts";

const failureCode = (error: { readonly code: string }) => error.code;

const counted = (values: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const load = Effect.gen(function* () {
      const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
      return values[Math.min(call, values.length) - 1] ?? "none";
    });
    return { calls, load };
  });

describe("AixCatalogCache", () => {
  effectIt.effect("reads at once on a cold cache, then hits within the 24h TTL", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      const { calls, load } = yield* counted(["a"]);
      const options = { force: false, failureCode };

      const first = yield* cache.read("work", load, options);
      yield* TestClock.adjust("23 hours");
      const second = yield* cache.read("work", load, options);

      expect(first.value).toBe("a");
      expect(second.value).toBe("a");
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  );

  effectIt.effect("reloads once the 24h TTL has passed", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      const { calls, load } = yield* counted(["a", "b"]);
      const options = { force: false, failureCode };

      yield* cache.read("work", load, options);
      yield* TestClock.adjust("24 hours");
      const next = yield* cache.read("work", load, options);

      expect(next.value).toBe("b");
      expect(yield* Ref.get(calls)).toBe(2);
    }),
  );

  effectIt.effect("starts the TTL after a slow load finishes", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      const options = { force: false, failureCode };

      const loading = yield* Effect.forkChild(
        cache.read("slow", Effect.sleep("2 hours").pipe(Effect.as("ready")), options),
      );
      yield* TestClock.adjust("2 hours");
      yield* Fiber.join(loading);
      yield* TestClock.adjust("23 hours");
      yield* TestClock.adjust("59 minutes");
      expect(yield* cache.isExpired("slow")).toBe(false);

      yield* TestClock.adjust("1 minute");
      expect(yield* cache.isExpired("slow")).toBe(true);
    }),
  );

  effectIt.effect("a forced read bypasses the TTL immediately", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      const { calls, load } = yield* counted(["a", "b"]);

      yield* cache.read("work", load, { force: false, failureCode });
      const forced = yield* cache.read("work", load, { force: true, failureCode });

      expect(forced.value).toBe("b");
      expect(yield* Ref.get(calls)).toBe(2);
    }),
  );

  effectIt.effect("concurrent reads for one key load once", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      const calls = yield* Ref.make(0);
      const gate = yield* Deferred.make<void>();
      const load = Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1);
        yield* Deferred.await(gate);
        return "a";
      });
      const options = { force: false, failureCode };

      const fibers = yield* Effect.forEach([1, 2, 3], () =>
        Effect.forkChild(cache.read("work", load, options)),
      );
      yield* Deferred.succeed(gate, undefined);
      const reads = yield* Effect.forEach(fibers, Fiber.join);

      expect(reads.map((read) => read.value)).toEqual(["a", "a", "a"]);
      expect(yield* Ref.get(calls)).toBe(1);
    }),
  );

  effectIt.effect("a failed reload keeps the last valid value and marks it stale", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      const failing = Effect.fail({ code: "status-503" });

      yield* cache.read("work", Effect.succeed("valid"), { force: false, failureCode });
      yield* TestClock.adjust("25 hours");
      const kept = yield* cache.read("work", failing, { force: false, failureCode });

      expect(kept.value).toBe("valid");
      expect(kept.stale?.code).toBe("status-503");
      expect(kept.stale?.since).toBe(25 * 60 * 60 * 1000);

      yield* TestClock.adjust("1 hour");
      const stillStale = yield* cache.read("work", failing, { force: false, failureCode });
      expect(stillStale.stale?.since).toBe(25 * 60 * 60 * 1000);
    }),
  );

  effectIt.effect("a successful reload clears the stale mark", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      yield* cache.read("work", Effect.succeed("valid"), { force: false, failureCode });
      yield* cache.read("work", Effect.fail({ code: "status-503" }), {
        force: true,
        failureCode,
      });

      const recovered = yield* cache.read("work", Effect.succeed("fresh"), {
        force: true,
        failureCode,
      });

      expect(recovered.value).toBe("fresh");
      expect(recovered.stale).toBeUndefined();
    }),
  );

  effectIt.effect("a failed first load has nothing to keep and fails", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();

      const result = yield* cache
        .read("work", Effect.fail({ code: "status-503" }), { force: false, failureCode })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  effectIt.effect("keys are independent", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();

      yield* cache.read("work", Effect.succeed("w"), { force: false, failureCode });
      const other = yield* cache.read("claude", Effect.succeed("c"), { force: false, failureCode });

      expect(other.value).toBe("c");
    }),
  );

  effectIt.effect("drops entries for profiles that are no longer listed", () =>
    Effect.gen(function* () {
      const cache = yield* AixCatalogCache.make<string>();
      yield* cache.read("removed-profile\0endpoint", Effect.succeed("old"), {
        force: false,
        failureCode,
      });
      yield* cache.retain((key) => key.startsWith("active-profile\0"));

      const missing = yield* cache
        .read("removed-profile\0endpoint", Effect.fail({ code: "status-503" }), {
          force: true,
          failureCode,
        })
        .pipe(Effect.result);

      expect(Result.isFailure(missing)).toBe(true);
    }),
  );
});
