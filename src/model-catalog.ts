import { z } from 'zod';
import type { DiscoveredModel, ProviderOption } from './provider-registry.js';
import { readCappedText, redactSecrets } from './sanitize.js';
import { asStrings } from './value.js';

type FetchRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface CatalogArchitecture {
  output_modalities?: string[] | undefined;
  modality?: string | undefined;
}

interface CatalogEntry {
  id?: string | undefined;
  name?: string | undefined;
  supported_parameters?: string[] | undefined;
  architecture?: CatalogArchitecture | undefined;
}

const catalogArchitectureSchema: z.ZodType<CatalogArchitecture> = z.object({
  output_modalities: z.array(z.string()).optional().catch(undefined),
  modality: z.string().optional().catch(undefined),
});
const catalogEntrySchema: z.ZodType<CatalogEntry> = z.object({
  id: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  supported_parameters: z.array(z.string()).optional().catch(undefined),
  architecture: catalogArchitectureSchema.optional().catch(undefined),
});
const catalogEnvelopeSchema = z.object({ data: z.array(z.unknown()) });
const errorObjectSchema = z.object({ message: z.string().optional() }).passthrough();
const errorEnvelopeSchema = z.object({
  error: z.union([z.string(), errorObjectSchema]).optional(),
  message: z.string().optional(),
});

export async function discoverModels(
  provider: ProviderOption,
  apiKey: string | undefined,
  options: { fetch?: FetchRequest; signal?: AbortSignal } = {},
): Promise<DiscoveredModel[]> {
  if (provider.discovery === 'manual') {
    throw new Error(`${provider.label} uses manual model IDs`);
  }
  if (provider.discovery === 'none') throw new Error(`${provider.label} does not have a model catalog`);
  if (!provider.baseUrl) throw new Error('unsupported model catalog provider');
  if (!apiKey) throw new Error(`Missing ${provider.envKey ?? 'API key'} for ${provider.label} model discovery`);

  const request = options.fetch ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const response = await request(`${provider.baseUrl}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  const models = (await responseBody(response, provider.label, apiKey))
    .filter(isTextModel)
    .map(modelFromRecord)
    .filter((model) => model !== undefined);
  return normalizeModels(models);
}

async function responseBody(response: Response, provider: string, apiKey: string): Promise<CatalogEntry[]> {
  const raw = await readCappedText(response, 1_000_000);
  if (raw === undefined) throw new Error(`${provider} model catalog response was too large`);
  if (!response.ok) {
    const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
    throw new Error(`${provider} model discovery failed (${status})${raw ? `: ${errorDetail(raw, apiKey)}` : ''}`);
  }
  try {
    const envelope = catalogEnvelopeSchema.safeParse(JSON.parse(raw));
    if (envelope.success) {
      return envelope.data.data.flatMap((entry) => {
        const parsed = catalogEntrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    }
  } catch {}
  throw new Error(`${provider} returned an invalid model catalog response`);
}

function errorDetail(raw: string, apiKey: string): string {
  let detail = raw;
  try {
    const parsed = errorEnvelopeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      const textError = z.string().safeParse(parsed.data.error);
      const objectError = errorObjectSchema.safeParse(parsed.data.error);
      if (textError.success) detail = textError.data;
      else if (objectError.success) detail = objectError.data.message ?? JSON.stringify(objectError.data);
      else detail = parsed.data.message ?? raw;
    }
  } catch {}
  return redactSecrets(detail, [apiKey]).slice(0, 500);
}

function discoveredModel(id: string, displayName: string | undefined, supportsReasoning: boolean): DiscoveredModel {
  if (displayName) {
    return supportsReasoning ? { id, displayName, supportsReasoning: true } : { id, displayName };
  }
  return supportsReasoning ? { id, supportsReasoning: true } : { id };
}

function modelFromRecord(record: CatalogEntry): DiscoveredModel | undefined {
  const id = record.id?.trim();
  if (!id || /[\p{Cc}\p{Cf}]/u.test(id)) return undefined;
  const displayName = record.name?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  const supportsReasoning = asStrings(record.supported_parameters).includes('reasoning');
  return discoveredModel(id, displayName && displayName !== id ? displayName : undefined, supportsReasoning);
}

function normalizeModels(models: readonly DiscoveredModel[]): DiscoveredModel[] {
  const unique = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const existing = unique.get(model.id);
    if (!existing) unique.set(model.id, model);
    else
      unique.set(
        model.id,
        discoveredModel(
          model.id,
          existing.displayName ?? model.displayName,
          existing.supportsReasoning === true || model.supportsReasoning === true,
        ),
      );
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** OpenRouter entries carry an architecture block; plain OpenAI-style catalogs fall back to id filtering. */
function isTextModel(record: CatalogEntry): boolean {
  const architecture = record.architecture;
  if (!architecture) return isGenerativeModel(record);
  const outputs = asStrings(architecture.output_modalities).map((value) => value.toLowerCase());
  if (outputs.length > 0) return outputs.includes('text');
  const modality = architecture.modality?.trim().toLowerCase();
  if (!modality) return isGenerativeModel(record);
  const separator = modality.lastIndexOf('->');
  return (separator >= 0 ? modality.slice(separator + 2) : modality).includes('text');
}

function isGenerativeModel(record: CatalogEntry): boolean {
  const id = record.id?.trim().toLowerCase();
  return Boolean(
    id &&
      !/(?:embedding|moderation|whisper|dall-e|transcription|computer-use|(?:^|[-_/])(?:tts|image|audio|realtime|sora)(?:[-_/]|$))/.test(
        id,
      ),
  );
}
