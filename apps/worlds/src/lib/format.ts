import type { CSSProperties } from "react";

const FAMILIES: Array<[RegExp, string]> = [
  [/muse/, "muse"],
  [/claude|anthropic/, "claude"],
  [/gpt|openai|\bo[134]\b/, "gpt"],
  [/gemini|gemma|google/, "gemini"],
  [/grok|xai/, "grok"],
  [/kimi|moonshot/, "kimi"],
  [/deepseek/, "deepseek"],
  [/minimax/, "minimax"],
  [/laguna|poolside/, "poolside"],
  [/qwen|qwq|alibaba/, "qwen"],
  [/glm|z-ai|zhipu/, "glm"],
  [/llama|meta/, "llama"],
  [/mistral|magistral|ministral|codestral/, "mistral"],
];

export function modelFamily(spec: string): string | null {
  const haystack = spec.toLowerCase();
  for (const [pattern, slug] of FAMILIES) if (pattern.test(haystack)) return slug;
  return null;
}

export function modelLabel(spec: string): string {
  return spec.replace(/^[^:]*:/, "").replace(/^[^/]*\//, "");
}

export function modelProvider(spec: string): string {
  const [provider] = spec.split(":");
  if (!provider || provider === spec) return "";
  return provider.startsWith("opencode") ? "opencode" : provider;
}

export const FRANCHISE_TONES = [
  "#C7420F",
  "#2A75BB",
  "#1F8F4E",
  "#C22F53",
  "#7A4BC9",
  "#14837E",
  "#A57C00",
  "#5B64D6",
];

export function tone(index: number): string {
  return FRANCHISE_TONES[
    ((index % FRANCHISE_TONES.length) + FRANCHISE_TONES.length) % FRANCHISE_TONES.length
  ]!;
}
export function toneStyle(color: string): CSSProperties & { "--tone": string } {
  return { "--tone": color };
}

export function seconds(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function tokens(count: number | null): string {
  if (count === null) return "";
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (count >= 1000) {
    const thousands = count / 1000;
    return `${thousands >= 100 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return String(count);
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function evLine(evs: { [stat: string]: number }): string {
  const order = ["hp", "atk", "def", "spa", "spd", "spe"];
  return order
    .filter((stat) => (evs[stat] ?? 0) > 0)
    .map((stat) => `${evs[stat]} ${stat}`)
    .join(" · ");
}

export function displaySpecies(species: string): string {
  const m = species.match(/^(.+)-Mega(?:-([XY]))?$/);
  return m ? `Mega ${m[1]}${m[2] ? ` ${m[2]}` : ""}` : species;
}

export function spriteKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const STATUS_LABELS = new Map([
  ["brn", "burned"],
  ["par", "paralyzed"],
  ["slp", "asleep"],
  ["frz", "frozen"],
  ["psn", "poisoned"],
  ["tox", "poisoned"],
]);

export function statusLabel(code: string | null | undefined): string {
  return code ? (STATUS_LABELS.get(code) ?? code) : "";
}

export function formatLabel(id: string): string {
  const m = id.match(/^gen(\d)championsvgc(\d{4})reg([a-z]+)(bo\d)?$/);
  if (!m) return id;
  const reg = m[3]!.toUpperCase().split("").join("-");
  return `Pokémon Champions ${m[2]} · Reg ${reg}${m[4] ? ` · ${m[4]!.replace("bo", "Bo")}` : ""}`;
}
