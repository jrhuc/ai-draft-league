const FAMILIES: Array<[RegExp, string]> = [
  [/muse/, "muse"],
  [/claude|anthropic/, "claude"],
  [/gpt|openai|\bo[134]\b/, "gpt"],
  [/gemini|gemma|google/, "gemini"],
  [/grok|xai/, "grok"],
  [/kimi|moonshot/, "kimi"],
  [/deepseek/, "deepseek"],
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
  return provider && provider !== spec ? provider : "";
}

export const FRANCHISE_TONES = ["#F0B35B", "#9ECBFF", "#7ED4A6", "#F29E8E", "#C9A7F5", "#7FD6D0", "#F5D76E", "#B5C4FF"];

export function tone(index: number): string {
  return FRANCHISE_TONES[((index % FRANCHISE_TONES.length) + FRANCHISE_TONES.length) % FRANCHISE_TONES.length]!;
}

export function seconds(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function tokens(count: number | null): string {
  if (count === null) return "";
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
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

export function baseSpecies(species: string): string {
  return spriteKey(species.replace(/^Mega /, "").replace(/ [XY]$/, ""));
}

export function spriteKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function statusLabel(code: string | null | undefined): string {
  const labels: { [code: string]: string } = { brn: "burned", par: "paralyzed", slp: "asleep", frz: "frozen", psn: "poisoned", tox: "poisoned" };
  return code ? (labels[code] ?? code) : "";
}

export function formatLabel(id: string): string {
  const m = id.match(/^gen(\d)championsvgc(\d{4})reg([a-z]+)(bo\d)?$/);
  if (!m) return id;
  const reg = m[3]!.toUpperCase().split("").join("-");
  return `Pokémon Champions ${m[2]} · Reg ${reg}${m[4] ? ` · ${m[4]!.replace("bo", "Bo")}` : ""}`;
}
