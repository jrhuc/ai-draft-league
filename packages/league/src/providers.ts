import { z } from "zod";
import type { JsonValue } from "./types.js";

export type ReasoningLevel = string;

export type OpenRouterRouting = { order?: string[]; allow_fallbacks: boolean };

export function openRouterRouting(): OpenRouterRouting {
  const pin = process.env.VGC_OPENROUTER_PIN?.trim();
  if (pin?.includes(","))
    throw new Error("VGC_OPENROUTER_PIN accepts exactly one upstream provider");
  const routing: OpenRouterRouting = { allow_fallbacks: false };
  if (pin) routing.order = [pin];
  return routing;
}

/** `VGC_MODEL_UPSTREAM=opencode:muse-spark-1.3-contributor-free=muse-spark-1.3,...` bills a seat to another model id on the same provider without changing its recorded identity. */
export function modelUpstreamRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  for (const entry of (process.env.VGC_MODEL_UPSTREAM ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.lastIndexOf("=");
    if (separator < 1 || separator === trimmed.length - 1)
      throw new Error(`VGC_MODEL_UPSTREAM entry must be <provider>:<model>=<upstream model id>: ${trimmed}`);
    parseSpec(trimmed.slice(0, separator));
    routes.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return routes;
}

const VARIANT = /^[a-z0-9][a-z0-9._-]*$/i;

/** Any OpenCode variant id; availability on the selected model is checked by the host. */
export const reasoningLevelSchema = z.string().regex(VARIANT);

export function isReasoningLevel(value: JsonValue | undefined): value is ReasoningLevel {
  return typeof value === "string" && VARIANT.test(value);
}

export interface ModelReasoningConfig {
  reasoning?: ReasoningLevel;
  reasoningByModel?: Readonly<Record<string, ReasoningLevel>>;
}

export function reasoningForModel(
  model: string,
  config: ModelReasoningConfig,
): ReasoningLevel | undefined {
  return config.reasoningByModel?.[model] ?? config.reasoning;
}

export function parseSpec(value: string) {
  if (value === "random") return { provider: "random", model: "random" };
  const separator = value.indexOf(":");
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (
    separator < 1 ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(provider) ||
    !model ||
    model.startsWith("-") ||
    /[\s\p{Cc}]/u.test(model)
  )
    throw new Error("Expected <OpenCode-provider-id>:<model-id> or random");
  return { provider, model };
}

export function validateReasoning(level?: string): void {
  if (level !== undefined && !isReasoningLevel(level))
    throw new Error(`invalid model variant ${JSON.stringify(level)}`);
}

export function validateModelExecution(
  models: readonly string[],
  config: ModelReasoningConfig,
): void {
  for (const model of models) {
    parseSpec(model);
    validateReasoning(reasoningForModel(model, config));
  }
}
