import type { ExecutionEnvironmentCapabilities, ProjectScope } from "@t3tools/contracts";

export function supportsProjectScope(
  capabilities: Partial<ExecutionEnvironmentCapabilities> | null | undefined,
): boolean {
  return capabilities?.projectScope === true;
}

export function projectScopeInput(
  capabilities: Partial<ExecutionEnvironmentCapabilities> | null | undefined,
  scope: ProjectScope,
): { readonly scope?: ProjectScope } {
  return supportsProjectScope(capabilities) ? { scope } : {};
}
