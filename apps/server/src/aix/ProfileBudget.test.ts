import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  AixDiscoveryError,
  type AixBudgetLayer,
  type AixBudgetStatus,
} from "../provider/AixDiscovery.ts";
import * as ProfileBudget from "./ProfileBudget.ts";

const CHECKED_AT = "2026-11-15T12:00:00.000Z";
const FINGERPRINT = "31856f096850388598e6fd0e9f8558421534a68ebe848a79679f5119bdad7315";

const layer = (
  scope: string,
  budget: number | null,
  spent: number,
  reset: { readonly resets_at?: string | null; readonly budget_duration?: string | null } = {
    resets_at: "2026-12-01T00:00:00Z",
    budget_duration: "1mo",
  },
): AixBudgetLayer => ({ scope, budget_usd: budget, spent_usd: spent, ...reset });

const budget = (overrides: Partial<AixBudgetStatus> = {}): AixBudgetStatus => ({
  status: "available",
  project_id: null,
  layers: [layer("key", 50, 25), layer("tenant", null, 900)],
  key_fingerprint: FINGERPRINT,
  gateway: { gateway: "aihub" },
  ...overrides,
});

const budgetFor = (
  read: (profileName: string) => Effect.Effect<AixBudgetStatus, AixDiscoveryError> = () =>
    Effect.succeed(budget()),
) => {
  const reads: Array<string> = [];
  return ProfileBudget.make({
    readBudget: (profileName) =>
      Effect.suspend(() => {
        reads.push(profileName);
        return read(profileName);
      }),
  }).pipe(Effect.map((service) => ({ service, reads })));
};

it.each([
  {
    name: "a project key",
    budget: {
      project_id: "6dc2eb8d-45c5-4cbe-884f-127fbb7d18cc",
      layers: [layer("key", 175, 175), layer("project", 500, 250), layer("tenant", null, 300)],
    },
    expected: {
      usedPercent: 100,
      amounts: { currency: "USD", spent: 175, total: 175 },
      aixProject: {
        id: "6dc2eb8d-45c5-4cbe-884f-127fbb7d18cc",
        amounts: { currency: "USD", spent: 250, total: 500 },
      },
    },
  },
  {
    name: "a personal key with an uncapped key layer",
    budget: {
      layers: [layer("key", null, 1), layer("personal", 50, 12.5), layer("tenant", null, 99)],
    },
    expected: { usedPercent: 25, amounts: { currency: "USD", spent: 12.5, total: 50 } },
  },
  {
    name: "overspend",
    budget: { layers: [layer("key", 200, 210)] },
    expected: { usedPercent: 100, amounts: { currency: "USD", spent: 210, total: 200 } },
  },
])("maps $name to one budget window", ({ budget, expected }) => {
  const limits = ProfileBudget.budgetUsageLimits({
    profileName: "ac",
    budget,
    checkedAt: CHECKED_AT,
  });
  expect(limits.windows[0]).toEqual({
    id: "aix-budget:ac",
    kind: "other",
    label: "Gateway budget · ac",
    usedPercent: expected.usedPercent,
    amounts: expected.amounts,
    resetsAt: "2026-12-01T00:00:00.000Z",
    windowDurationMins: 43200,
  });
  if ("aixProject" in expected) expect(limits.aixProject).toEqual(expected.aixProject);
  else expect(limits.aixProject).toBeUndefined();
});

it("takes the reset and window from aix and omits ones it cannot read", () => {
  const window = (reset: Parameters<typeof layer>[3]) =>
    ProfileBudget.budgetUsageLimits({
      profileName: "ac",
      budget: { project_id: "", layers: [layer("key", 100, 25, reset)] },
      checkedAt: CHECKED_AT,
    });
  expect(
    window({ resets_at: "2026-11-20T00:00:00+00:00", budget_duration: "30d" }).windows[0],
  ).toMatchObject({ resetsAt: "2026-11-20T00:00:00.000Z", windowDurationMins: 43200 });
  const unreadable = window({ resets_at: "soon", budget_duration: "weekly" });
  expect(unreadable.windows[0]).toMatchObject({ usedPercent: 25 });
  expect(unreadable.windows[0]?.resetsAt).toBeUndefined();
  expect(unreadable.windows[0]?.windowDurationMins).toBeUndefined();
  expect(unreadable.aixProject).toBeUndefined();
});

it.each([
  {
    name: "an uncapped key without using the tenant layer",
    layers: [layer("key", null, 1), layer("personal", null, 2), layer("tenant", 100, 99)],
    message: "This aix profile's key has no budget limit.",
  },
  {
    name: "a $0 cap",
    layers: [layer("key", 0, 0)],
    message: "This aix profile's key has a $0 budget.",
  },
])("reports $name without a window", ({ layers, message }) => {
  expect(
    ProfileBudget.budgetUsageLimits({
      profileName: "ac",
      budget: { layers },
      checkedAt: CHECKED_AT,
    }),
  ).toMatchObject({ windows: [], unavailable: { reason: "unsupported", message } });
});

it.effect("reads each profile once for all of its instances until the TTL passes", () =>
  Effect.gen(function* () {
    const { service, reads } = yield* budgetFor();

    yield* Effect.all(
      [service.usageLimits("ac"), service.usageLimits("ac"), service.usageLimits("nim")],
      { concurrency: "unbounded" },
    );
    yield* service.usageLimits("ac");
    expect(reads).toEqual(["ac", "nim"]);

    yield* TestClock.adjust("1 minute");
    const limits = yield* service.usageLimits("ac");
    expect(reads).toHaveLength(3);
    expect(limits.windows[0]).toMatchObject({
      id: `aix-budget:ac#credential:${FINGERPRINT}`,
      usedPercent: 50,
    });
    expect(limits.credentialFingerprint).toBe(FINGERPRINT);
  }),
);

it.effect.each([
  {
    name: "a missing profile",
    read: Effect.fail(new AixDiscoveryError({ reason: "profile-not-found" })),
    unavailable: { reason: "probeFailed", message: "aix could not resolve this profile." },
  },
  {
    name: "a rejected key",
    read: Effect.fail(new AixDiscoveryError({ reason: "gateway-rejected" })),
    unavailable: { reason: "probeFailed", message: "The aix gateway rejected this profile's key." },
  },
  {
    name: "an unreachable gateway",
    read: Effect.fail(new AixDiscoveryError({ reason: "gateway-unavailable" })),
    unavailable: { reason: "probeFailed", message: "The aix gateway could not be reached." },
  },
  {
    name: "a stuck aix",
    read: Effect.fail(new AixDiscoveryError({ reason: "timeout" })),
    unavailable: { reason: "probeFailed", message: "The aix gateway budget request timed out." },
  },
  {
    name: "unrecognized aix output",
    read: Effect.fail(new AixDiscoveryError({ reason: "invalid-schema" })),
    unavailable: { reason: "probeFailed", message: "aix returned an unrecognized budget." },
  },
  {
    name: "a direct Anthropic profile",
    read: Effect.succeed(
      budget({ status: "unsupported", layers: null, gateway: { gateway: "anthropic" } }),
    ),
    unavailable: {
      reason: "unsupported",
      message: "This aix profile connects directly to Anthropic, which reports no gateway budget.",
    },
  },
  {
    name: "a gateway without budgets",
    read: Effect.succeed(budget({ status: "unsupported", layers: null })),
    unavailable: {
      reason: "unsupported",
      message: "This aix gateway reports no budget for this profile's key.",
    },
  },
  {
    name: "an unreadable budget",
    read: Effect.succeed(budget({ status: "unavailable", layers: null })),
    unavailable: { reason: "probeFailed", message: "The aix gateway budget could not be read." },
  },
])("reports $name without a window", ({ read, unavailable }) =>
  Effect.gen(function* () {
    const { service } = yield* budgetFor(() => read);
    const limits = yield* service.usageLimits("ae");
    expect(limits.profileName).toBe("ae");
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable).toEqual(unavailable);
  }),
);

it.effect("reads one profile budget at a time", () =>
  Effect.gen(function* () {
    const { service, reads } = yield* budgetFor(() => Effect.never);
    yield* service.usageLimits("slow").pipe(Effect.forkChild);
    const queued = yield* service.usageLimits("queued").pipe(Effect.forkChild);
    yield* TestClock.adjust("1 minute");
    expect(reads).toEqual(["slow"]);
    yield* Fiber.interrupt(queued);
  }),
);

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    usageLimits: {
      checkedAt: CHECKED_AT,
      windows: [{ id: "codex-weekly", kind: "weekly", label: "Weekly", usedPercent: 40 }],
    },
    ...overrides,
  }) as ServerProvider;

it.effect("replaces usage limits only on an enabled Claude budget owner", () =>
  Effect.gen(function* () {
    const { service, reads } = yield* budgetFor(() =>
      Effect.succeed(budget({ layers: [layer("key", 200, 199.1)] })),
    );
    const run = (
      profileName: string | undefined,
      isBudgetOwner: boolean,
      snapshot: ServerProvider,
    ) =>
      ProfileBudget.withAixProfileBudget(
        profileName,
        isBudgetOwner,
      )(snapshot).pipe(Effect.provideService(ProfileBudget.AixProfileBudget, service));

    const manual = provider();
    expect(yield* run(undefined, false, manual)).toBe(manual);
    const disabled = provider({ enabled: false });
    expect(yield* run("nim4", true, disabled)).toBe(disabled);
    const codex = provider();
    expect(yield* run("nim4", true, codex)).toBe(codex);
    const opencode = provider({ driver: ProviderDriverKind.make("opencode") });
    expect(yield* run("nim4", true, opencode)).toBe(opencode);
    const notOwner = provider({ driver: ProviderDriverKind.make("claudeAgent") });
    expect(yield* run("nim4", false, notOwner)).toBe(notOwner);
    expect(reads).toEqual([]);

    const managed = yield* run(
      "nim4",
      true,
      provider({ driver: ProviderDriverKind.make("claudeAgent") }),
    );
    expect(managed.usageLimits?.profileName).toBe("nim4");
    expect(managed.usageLimits?.windows[0]).toMatchObject({ label: "Gateway budget · nim4" });
    expect(managed.usageLimits?.windows[0]?.usedPercent).toBeCloseTo(99.55, 6);
  }),
);
