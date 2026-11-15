import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import type { ProviderDriver, ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";
import { OpenCodeAixUsageLimits, OpenCodeDriver } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import type { OpenCodeSettings } from "@t3tools/provider-opencode/settings";

import * as ServerConfig from "../../config.ts";
import { AixProfileBudget } from "../../aix/ProfileBudget.ts";
import {
  getAixProfileStatus,
  streamAixProfileStatusChanges,
  withAixCatalogStatus,
} from "../../aix/ProviderInstanceSync.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  OPENCODE_AIX_PROVIDER_ID,
  type OpenCodeAixModel,
  openCodeAixProfileReference,
  withOpenCodeAixRuntime,
} from "../OpenCodeAixLaunch.ts";

const AIX_SLUG_PREFIX = `${OPENCODE_AIX_PROVIDER_ID}/`;

const aixModels = (
  customModels: OpenCodeSettings["customModels"],
): ReadonlyArray<OpenCodeAixModel> =>
  customModels.map((model) => {
    const slug = typeof model === "string" ? model : model.slug;
    const id = slug.startsWith(AIX_SLUG_PREFIX) ? slug.slice(AIX_SLUG_PREFIX.length) : slug;
    return { id, name: typeof model === "string" ? id : (model.name ?? id) };
  });

type OpenCodeAixLaunchEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | OpenCodeRuntime.OpenCodeRuntime
  | Path.Path
  | SecureRandom.SecureRandom;

/** OpenCode driver that injects an aix profile's gateway at each server start; other instances are unchanged. */
export const makeOpenCodeAixDriver = <R>(
  createOpenCodeInstance: ProviderDriver<
    OpenCodeSettings,
    R,
    ProviderUsageReaderEnv<typeof OpenCodeDriver>
  >["create"],
): ProviderDriver<
  OpenCodeSettings,
  R | ServerConfig.ServerConfig | OpenCodeAixLaunchEnv,
  ProviderUsageReaderEnv<typeof OpenCodeDriver>
> => ({
  ...OpenCodeDriver,
  create: Effect.fn("OpenCodeAixDriver.create")(function* (input) {
    const profileReference = openCodeAixProfileReference({
      aixProfile: input.config.aixProfile,
      environment: input.environment,
    });
    if (profileReference._tag === "invalid") {
      return yield* new ProviderDriverError({
        driver: OpenCodeDriver.driverKind,
        instanceId: input.instanceId,
        detail:
          "T3_AIX_PROFILE must match the aixProfile marker and resolve on this host. Run aix sync or refresh the provider, then check `aix profiles --json`.",
      });
    }
    if (profileReference._tag === "manual") return yield* createOpenCodeInstance(input);
    if (input.config.serverUrl.trim().length > 0) {
      return yield* new ProviderDriverError({
        driver: OpenCodeDriver.driverKind,
        instanceId: input.instanceId,
        detail:
          "OpenCode aix profiles start an isolated local server; clear the configured Server URL.",
      });
    }

    const { stateDir } = yield* ServerConfig.ServerConfig;
    const base = yield* OpenCodeRuntime.OpenCodeRuntime;
    const aixRuntime = yield* withOpenCodeAixRuntime(base, {
      profileName: profileReference.profile,
      models: aixModels(input.config.customModels),
      stateDir,
    });
    const budget = yield* Effect.serviceOption(AixProfileBudget);
    return yield* createOpenCodeInstance(input).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, { ...base, ...aixRuntime }),
      Option.isSome(budget)
        ? Effect.provideService(OpenCodeAixUsageLimits, {
            read: budget.value.usageLimits(profileReference.profile),
          })
        : (effect) => effect,
      Effect.flatMap((instance) =>
        Effect.gen(function* () {
          const profileStatusChanges = yield* streamAixProfileStatusChanges(
            profileReference.profile,
          );
          const withCatalogStatus = (provider: Parameters<typeof withAixCatalogStatus>[0]) =>
            getAixProfileStatus(profileReference.profile).pipe(
              Effect.map((stale) => withAixCatalogStatus(provider, stale)),
            );
          const snapshot = instance.snapshot;
          return {
            ...instance,
            snapshot: {
              ...snapshot,
              getSnapshot: snapshot.getSnapshot.pipe(Effect.flatMap(withCatalogStatus)),
              refresh: snapshot.refresh.pipe(Effect.flatMap(withCatalogStatus)),
              streamChanges: Stream.merge(
                snapshot.streamChanges.pipe(Stream.mapEffect(withCatalogStatus)),
                profileStatusChanges.pipe(
                  Stream.mapEffect(() => snapshot.getSnapshot),
                  Stream.mapEffect(withCatalogStatus),
                ),
                { haltStrategy: "left" },
              ),
            },
          };
        }),
      ),
    );
  }),
});

export const OpenCodeAixDriver = makeOpenCodeAixDriver(OpenCodeDriver.create);
