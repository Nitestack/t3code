import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as NodeUtil from "node:util";

import { AixDiscoveryError, type ResolvedEnvironment } from "../provider/AixDiscovery.ts";
import * as ProfileBudget from "./ProfileBudget.ts";

const SENTINEL_KEY = "sk-aix-budget-sentinel-do-not-leak";
const CHECKED_AT = "2026-11-15T12:00:00.000Z";

const litellm = (profileName: string, endpoint = "https://gateway.test"): ResolvedEnvironment => ({
  profileName,
  endpoint,
  endpointKind: "unknown",
  apiKey: SENTINEL_KEY,
});

const keyInfo = (info: Record<string, unknown>) =>
  Option.getOrThrow(ProfileBudget.decodeKeyInfo({ key: "hashed", info }));

const fakeHttp = (
  respond: (request: HttpClientRequest.HttpClientRequest) => Response | "transport-error",
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    const response = respond(request);
    return response === "transport-error"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error(`connect failed for Bearer ${SENTINEL_KEY}`),
            }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { client, requests };
};

const budgetFor = (
  http: ReturnType<typeof fakeHttp>,
  resolve: (profileName: string) => Effect.Effect<ResolvedEnvironment, AixDiscoveryError> = (
    profileName,
  ) => Effect.succeed(litellm(profileName)),
) => {
  let resolves = 0;
  return ProfileBudget.make({
    resolveEnvironment: (profileName) => {
      resolves += 1;
      return resolve(profileName);
    },
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http.client),
    Effect.map((service) => ({ service, resolves: () => resolves })),
  );
};

it("decodes LiteLLM key info amounts sent as strings or numbers", () => {
  expect(keyInfo({ spend: "123.81", max_budget: "150.0000000000" }).info).toMatchObject({
    spend: 123.81,
    max_budget: 150,
  });
  expect(keyInfo({ spend: 0.37, max_budget: 150 }).info).toMatchObject({
    spend: 0.37,
    max_budget: 150,
  });
  expect(keyInfo({ spend: 1, max_budget: null, expires: null }).info.max_budget).toBeNull();
  expect(keyInfo({}).info).toEqual({});
  expect(ProfileBudget.decodeKeyInfo({ info: { max_budget: "lots" } })).toEqual(Option.none());
  expect(ProfileBudget.decodeKeyInfo({ detail: "missing" })).toEqual(Option.none());
});

it.each([
  {
    name: "spend against a cap",
    info: { spend: "123.81", max_budget: "150.0000000000" },
    usedPercent: (123.81 / 150) * 100,
  },
  { name: "overspend as a full bar", info: { spend: 210, max_budget: 200 }, usedPercent: 100 },
  {
    name: "a reported budget window and reset",
    info: {
      spend: 5,
      max_budget: 50,
      budget_duration: "30d",
      budget_reset_at: "2026-12-01T00:00:00+00:00",
    },
    usedPercent: 10,
    resetsAt: "2026-12-01T00:00:00.000Z",
    windowDurationMins: 43200,
  },
  {
    name: "an unreadable duration and reset as absent",
    info: { spend: 5, max_budget: 50, budget_duration: "weekly", budget_reset_at: "soon" },
    usedPercent: 10,
  },
])("maps $name to one stable budget window", ({ name: _name, info, usedPercent, ...expected }) => {
  const limits = ProfileBudget.keyInfoUsageLimits({
    profileName: "ac",
    keyInfo: keyInfo(info),
    checkedAt: CHECKED_AT,
  });
  expect(limits).toEqual({
    checkedAt: CHECKED_AT,
    windows: [
      {
        id: "aix-budget:ac",
        kind: "other",
        label: "Gateway budget",
        usedPercent: expect.closeTo(usedPercent, 6),
        ...expected,
      },
    ],
  });
});

it.each([
  { name: "no cap", info: { spend: 4 }, message: "This aix profile's key has no budget limit." },
  {
    name: "a null cap",
    info: { spend: 4, max_budget: null },
    message: "This aix profile's key has no budget limit.",
  },
  {
    name: "a $0 cap",
    info: { spend: "0", max_budget: "0" },
    message: "This aix profile's key has a $0 budget.",
  },
  {
    name: "a negative cap",
    info: { spend: 0, max_budget: -1 },
    message: "This aix profile's key has a $0 budget.",
  },
])("reports $name without a window", ({ info, message }) => {
  expect(
    ProfileBudget.keyInfoUsageLimits({
      profileName: "acs",
      keyInfo: keyInfo(info),
      checkedAt: CHECKED_AT,
    }),
  ).toEqual({
    checkedAt: CHECKED_AT,
    windows: [],
    unavailable: { reason: "unsupported", message },
  });
});

it.effect.each([
  { endpoint: "https://gateway.test/v1/", expected: "https://gateway.test/key/info" },
  { endpoint: "https://gateway.test?tenant=x", expected: "https://gateway.test/key/info?tenant=x" },
  {
    endpoint: "https://gateway.test/proxy/v1/?tenant=x",
    expected: "https://gateway.test/proxy/key/info?tenant=x",
  },
])("reads key info from $endpoint with the profile key", ({ endpoint, expected }) =>
  Effect.gen(function* () {
    const http = fakeHttp(() => Response.json({ info: { spend: "25", max_budget: "50" } }));
    const { service } = yield* budgetFor(http, (profileName) =>
      Effect.succeed(litellm(profileName, endpoint)),
    );
    const limits = yield* service.usageLimits("p");

    expect(limits.windows.map(({ id, usedPercent }) => [id, usedPercent])).toEqual([
      ["aix-budget:p", 50],
    ]);
    expect(
      http.requests.map((request) => Option.getOrThrow(HttpClientRequest.toUrl(request)).href),
    ).toEqual([expected]);
    expect(http.requests[0]?.headers.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
  }),
);

it.effect("reads each profile once for all of its instances until the TTL passes", () =>
  Effect.gen(function* () {
    const http = fakeHttp(() => Response.json({ info: { spend: 1, max_budget: 50 } }));
    const { service, resolves } = yield* budgetFor(http);

    yield* Effect.all(
      [service.usageLimits("ac"), service.usageLimits("ac"), service.usageLimits("nim")],
      { concurrency: "unbounded" },
    );
    yield* service.usageLimits("ac");
    expect(resolves()).toBe(2);
    expect(http.requests).toHaveLength(2);

    yield* TestClock.adjust("1 minute");
    yield* service.usageLimits("ac");
    expect(resolves()).toBe(3);
    expect(http.requests).toHaveLength(3);
  }),
);

it.effect.each([
  ...[undefined, null].map((spend) => ({
    name: `${spend} spend with a positive cap`,
    respond: () => Response.json({ info: { spend, max_budget: 50 } }),
    unavailable: {
      reason: "probeFailed",
      message: "The aix gateway returned an unrecognized budget.",
    },
  })),
  {
    name: "a rejected key",
    respond: () => new Response(`{"error":"invalid key ${SENTINEL_KEY}"}`, { status: 401 }),
    unavailable: {
      reason: "probeFailed",
      message: "The aix gateway rejected this profile's key (HTTP 401).",
    },
  },
  {
    name: "a server error",
    respond: () => new Response("boom", { status: 500 }),
    unavailable: {
      reason: "probeFailed",
      message: "The aix gateway budget could not be read (HTTP 500).",
    },
  },
  {
    name: "an unreachable gateway",
    respond: () => "transport-error" as const,
    unavailable: { reason: "probeFailed", message: "The aix gateway could not be reached." },
  },
  {
    name: "an unrecognized body",
    respond: () => Response.json({ info: { max_budget: "plenty" } }),
    unavailable: {
      reason: "probeFailed",
      message: "The aix gateway returned an unrecognized budget.",
    },
  },
  {
    name: "a missing gateway route",
    respond: () => new Response("not found", { status: 404 }),
    unavailable: {
      reason: "probeFailed",
      message: "The aix gateway budget could not be read (HTTP 404).",
    },
  },
])("reports $name without a window", ({ respond, unavailable }) =>
  Effect.gen(function* () {
    const { service } = yield* budgetFor(fakeHttp(respond));
    const limits = yield* service.usageLimits("ae");
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable).toEqual(unavailable);
  }),
);

it.effect("reports a timed-out budget read as a failed probe", () =>
  Effect.gen(function* () {
    const http = {
      client: HttpClient.make(() => Effect.never),
      requests: [],
    };
    const { service } = yield* budgetFor(http);
    const fiber = yield* service.usageLimits("slow").pipe(Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    const limits = yield* Fiber.join(fiber);
    expect(limits.unavailable).toEqual({
      reason: "probeFailed",
      message: "The aix gateway budget request timed out.",
    });
  }),
);

it.effect("does not query a direct Anthropic profile or one aix cannot resolve", () =>
  Effect.gen(function* () {
    const http = fakeHttp(() => Response.json({}));
    const { service } = yield* budgetFor(http, (profileName) =>
      profileName === "ae2"
        ? Effect.succeed({
            profileName,
            endpoint: "https://api.anthropic.com",
            endpointKind: "anthropic",
            apiKey: SENTINEL_KEY,
          })
        : Effect.fail(new AixDiscoveryError({ reason: "profile-not-found" })),
    );

    expect((yield* service.usageLimits("ae2")).unavailable).toEqual({
      reason: "unsupported",
      message: "This aix profile connects directly to Anthropic, which reports no gateway budget.",
    });
    expect((yield* service.usageLimits("gone")).unavailable).toEqual({
      reason: "probeFailed",
      message: "aix could not resolve this profile.",
    });
    expect(http.requests).toEqual([]);
  }),
);

it.effect("keeps the profile key out of usage limits and logs on every path", () => {
  const lines: Array<string> = [];
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const querySentinel = "aix-budget-query-sentinel-do-not-leak";
  const logger = Logger.make(({ message, cause }) => {
    lines.push(NodeUtil.inspect(message, { depth: 10 }), Cause.pretty(cause));
  });
  return Effect.gen(function* () {
    const responses: Record<string, () => Response | "transport-error"> = {
      ok: () => Response.json({ key: SENTINEL_KEY, info: { spend: "1", max_budget: "2" } }),
      rejected: () => new Response(SENTINEL_KEY, { status: 401 }),
      broken: () => new Response(`{"info":"${SENTINEL_KEY}"}`, { status: 200 }),
      offline: () => "transport-error",
    };
    const http = fakeHttp((request) => {
      const profile = new URL(request.url).hostname.split(".")[0] ?? "";
      return (responses[profile] ?? responses.ok!)();
    });
    const { service } = yield* budgetFor(http, (profileName) =>
      Effect.succeed(
        litellm(profileName, `https://${profileName}.gateway.test?credential=${querySentinel}`),
      ),
    );
    const results = yield* Effect.forEach(Object.keys(responses), service.usageLimits);

    expect(results.map((limits) => limits.unavailable?.reason)).toEqual([
      undefined,
      "probeFailed",
      "probeFailed",
      "probeFailed",
    ]);
    expect(JSON.stringify(results)).not.toContain(SENTINEL_KEY);
    expect(lines.join("\n")).not.toContain(SENTINEL_KEY);
    expect(spans.length).toBeGreaterThan(0);
    const traceData = JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(span.attributes),
        events: span.events,
      })),
    );
    expect(traceData).not.toContain(SENTINEL_KEY);
    expect(traceData).not.toContain(querySentinel);
    expect(JSON.stringify(results)).not.toContain(querySentinel);
    expect(lines.join("\n")).not.toContain(querySentinel);
  }).pipe(
    Effect.withTracer(tracer),
    Effect.withTracerEnabled(true),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
});

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

it.effect("replaces only an enabled aix-managed instance's usage limits", () =>
  Effect.gen(function* () {
    const http = fakeHttp(() => Response.json({ info: { spend: 199.1, max_budget: 200 } }));
    const { service } = yield* budgetFor(http);
    const run = (profileName: string | undefined, snapshot: ServerProvider) =>
      ProfileBudget.withAixProfileBudget(profileName)(snapshot).pipe(
        Effect.provideService(ProfileBudget.AixProfileBudget, service),
      );

    const manual = provider();
    expect(yield* run(undefined, manual)).toBe(manual);
    const disabled = provider({ enabled: false });
    expect(yield* run("nim4", disabled)).toBe(disabled);
    expect(http.requests).toEqual([]);

    const managed = yield* run("nim4", provider());
    expect(managed.usageLimits?.windows.map(({ id }) => id)).toEqual(["aix-budget:nim4"]);
    expect(managed.usageLimits?.windows[0]?.usedPercent).toBeCloseTo(99.55, 6);
  }),
);
