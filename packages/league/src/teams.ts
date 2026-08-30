import fs from "node:fs";
import path from "node:path";

import { z } from "zod";
import { defaultPsDir, TEAMS_DIR } from "./paths.js";
import { loadShowdown, type ShowdownApi } from "./showdown.js";
import type { JsonObject, JsonValue } from "./types.js";
import { asRecords, isRecord, text } from "./value.js";

const POOL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface TeamProvenance {
  placement: number | null;
  player: string;
  handle: string;
  swiss: string;
  paste: string;
}

export const teamProvenanceSchema: z.ZodType<TeamProvenance> = z.strictObject({
  placement: z.number().nullable(),
  player: z.string(),
  handle: z.string(),
  swiss: z.string(),
  paste: z.string(),
});

export interface PoolEvent {
  name: string;
  game: string;
  regulation: string;
  location: string;
  dates: string;
  players: number | null;
  structure: string;
  url: string;
  cut: number | null;
  seeding: string;
  reconstructedSpreads: boolean;
}

/**
 * `provenance` is the normalized reading the views share. `source` keeps the manifest block
 * verbatim because each event names its own extra keys, and republishing must not drop them.
 */
export interface Team {
  id: string;
  packed: string;
  seed?: number;
  provenance?: TeamProvenance;
  source?: JsonObject;
}

/** The manifest blocks a pool cannot be rebuilt from its team files alone. */
export interface PoolMetadata {
  event?: JsonObject;
  spreads?: JsonObject;
}

export interface TeamPool {
  id: string;
  format: string;
  teams: Team[];
  event: PoolEvent | null;
  metadata: PoolMetadata;
}

const poolNumberSchema = z.number();

interface PoolManifestTeam {
  id: string;
  file: string;
  seed?: number;
  source?: JsonObject;
}

interface PoolManifestHeader extends PoolMetadata {
  id: string;
  format: string;
}

interface PoolManifest extends PoolMetadata {
  id: string;
  format: string;
  teams: PoolManifestTeam[];
}

function block(value: JsonValue | undefined): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}
function readMetadata(manifest: JsonObject): PoolMetadata {
  const metadata: PoolMetadata = {};
  const event = block(manifest.event);
  const spreads = block(manifest.spreads);
  if (event) metadata.event = event;
  if (spreads) metadata.spreads = spreads;
  return metadata;
}

function readEvent(manifest: JsonObject): PoolEvent | null {
  const event = block(manifest.event);
  if (!event) return null;
  const spreads = block(manifest.spreads) ?? {};
  const players = poolNumberSchema.safeParse(event.players);
  const cut = poolNumberSchema.safeParse(event.cut);
  return {
    name: text(event.name),
    game: text(event.game),
    regulation: text(event.regulation),
    location: text(event.location),
    dates: text(event.dates),
    players: players.success ? players.data : null,
    structure: text(event.structure),
    url: text(event.url),
    cut: cut.success ? cut.data : null,
    seeding: text(event.seeding),
    reconstructedSpreads: spreads.reconstructed === true,
  };
}

function readProvenance(entry: JsonObject): TeamProvenance | undefined {
  const record = block(entry.source);
  if (!record) return undefined;
  const placement = poolNumberSchema.safeParse(record.placement);
  return {
    placement: placement.success ? placement.data : null,
    player: text(record.player),
    handle: text(record.handle),
    swiss: text(record.swiss),
    paste: text(record.paste) || text(record.teamlist),
  };
}

export function loadPool(name = "test", teamsDir = TEAMS_DIR): TeamPool {
  if (!POOL_SLUG.test(name))
    throw new Error("pool name must be lowercase letters, digits, and dashes");
  const poolDir = path.resolve(teamsDir, name);
  const manifestPath = path.join(poolDir, "pool.json");
  const manifest = block(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  if (!manifest) throw new Error(`invalid pool manifest ${manifestPath}`);
  const id = text(manifest.id);
  const format = text(manifest.format);
  const entries = asRecords(manifest.teams);
  if (!id) throw new Error(`${manifestPath} needs a pool id`);
  if (!format.endsWith("bo3"))
    throw new Error(`${manifestPath} needs a Pokémon Showdown BO3 format`);
  if (entries.length < 2) throw new Error(`${manifestPath} must contain at least two teams`);

  const seen = new Set<string>();
  const teams = entries.map((entry) => {
    const teamId = text(entry.id);
    const filename = text(entry.file);
    if (!POOL_SLUG.test(teamId))
      throw new Error(`invalid team id ${JSON.stringify(teamId)} in ${manifestPath}`);
    if (!filename) throw new Error(`every team in ${manifestPath} needs a file`);
    if (seen.has(teamId))
      throw new Error(`duplicate team id ${JSON.stringify(teamId)} in ${manifestPath}`);
    seen.add(teamId);
    const teamPath = path.resolve(poolDir, filename);
    if (path.dirname(teamPath) !== poolDir || path.basename(teamPath) !== filename) {
      throw new Error(`team file ${JSON.stringify(filename)} escapes its pool directory`);
    }
    const stats = fs.lstatSync(teamPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`team file ${JSON.stringify(filename)} must be a regular file`);
    }
    const packed = fs.readFileSync(teamPath, "utf8").trim();
    if (!packed) throw new Error(`team ${JSON.stringify(teamId)} is empty`);
    const provenance = readProvenance(entry);
    const source = block(entry.source);
    const seed = poolNumberSchema.safeParse(entry.seed);
    const team: Team = { id: teamId, packed };
    if (seed.success) team.seed = seed.data;
    if (provenance) team.provenance = provenance;
    if (source) team.source = source;
    return team;
  });
  const seeded = teams.filter((team) => team.seed !== undefined);
  if (seeded.length && seeded.length !== teams.length)
    throw new Error(`${manifestPath} seeds only ${seeded.length} of ${teams.length} teams`);
  if (new Set(seeded.map((team) => team.seed)).size !== seeded.length)
    throw new Error(`${manifestPath} repeats a seed`);
  return { id, format, teams, event: readEvent(manifest), metadata: readMetadata(manifest) };
}

type ShowdownSets = NonNullable<ReturnType<ShowdownApi["Teams"]["unpack"]>>;

function removeUnsupportedMetadata(
  sets: ShowdownSets,
  format: string | undefined,
  psDir: string,
): void {
  if (!format) return;
  const { Dex } = loadShowdown(psDir);
  if (!Dex.formats.get(format).mod.startsWith("champions")) return;
  for (const set of sets) delete set.teraType;
}

function enforceBaseFormes(sets: ShowdownSets, psDir = defaultPsDir()): void {
  const { Dex } = loadShowdown(psDir);
  for (const set of sets) {
    const species = Dex.species.get(set.species || set.name);
    if (!species.exists || (!species.isMega && species.forme !== "Primal")) continue;
    const required = species.requiredItem ?? "";
    const stone = required ? Dex.items.get(required) : undefined;
    const baseName =
      Object.entries(stone?.megaStone ?? {}).find(
        ([, mega]) => id(mega) === id(species.name),
      )?.[0] ?? species.baseSpecies;
    const base = Dex.species.get(baseName);
    if (!required || id(set.item ?? "") !== id(required)) {
      throw new Error(
        `${species.name} must be entered as ${base.name} holding ${required || "its trigger item"}: team sheets use base formes`,
      );
    }
    const baseAbilities = Object.values(base.abilities).filter(Boolean);
    if (set.ability && !baseAbilities.some((ability) => id(ability) === id(set.ability))) {
      throw new Error(
        `${species.name} must use one of ${base.name}'s abilities (${baseAbilities.join("/")}), not ${set.ability}`,
      );
    }
    if (!set.name || id(set.name) === id(species.name)) set.name = base.name;
    set.species = base.name;
  }
}

export function normalizePackedTeam(
  packed: string,
  psDir = defaultPsDir(),
  format?: string,
): string {
  const { Teams } = loadShowdown(psDir);
  const sets = Teams.unpack(packed);
  if (!sets) throw new Error("packed team does not unpack");
  enforceBaseFormes(sets, psDir);
  removeUnsupportedMetadata(sets, format, psDir);
  const repacked = Teams.pack(sets);
  if (!repacked) throw new Error("Showdown produced an empty packed team");
  return repacked;
}

export function packTeam(exportText: string, psDir = defaultPsDir(), format?: string): string {
  const { Teams } = loadShowdown(psDir);
  const team = Teams.import(exportText);
  if (!team) throw new Error("Showdown could not parse team export");
  enforceBaseFormes(team, psDir);
  removeUnsupportedMetadata(team, format, psDir);
  const packed = Teams.pack(team);
  if (!packed) throw new Error("Showdown produced an empty packed team");
  return packed;
}

export function validateTeam(packed: string, format: string, psDir = defaultPsDir()): void {
  const { Dex, Teams, TeamValidator } = loadShowdown(psDir);
  const sets = Teams.unpack(packed) ?? [];
  for (const set of sets) {
    const species = Dex.species.get(set.species || set.name);
    if (!species.exists || (!species.isMega && species.forme !== "Primal")) continue;
    const required = species.requiredItem ?? "";
    const stone = required ? Dex.items.get(required) : undefined;
    const baseName =
      Object.entries(stone?.megaStone ?? {}).find(
        ([, mega]) => id(mega) === id(species.name),
      )?.[0] ?? species.baseSpecies;
    throw new Error(
      `${species.name} must be entered as ${baseName} holding ${required || "its trigger item"}: team sheets use base formes`,
    );
  }
  const problems = new TeamValidator(format).validateTeam(sets);
  if (problems?.length) throw new Error(problems.join("\n"));
}

export interface TeamDraft {
  id: string;
  paste: string;
  seed?: number;
  source?: JsonObject;
}

export interface PoolContents extends PoolMetadata {
  teams: TeamDraft[];
}

export function createPool(
  name: string,
  format: string,
  contents: PoolContents,
  teamsDir = TEAMS_DIR,
  psDir = defaultPsDir(),
): string {
  const drafts = contents.teams;
  if (!POOL_SLUG.test(name))
    throw new Error("pool name must be lowercase letters, digits, and dashes");
  if (!format.endsWith("bo3"))
    throw new Error('format must be a Pokémon Showdown BO3 format id (ending in "bo3")');
  if (drafts.length < 2) throw new Error("a pool needs at least two teams");
  if (drafts.length > 32) throw new Error("a pool supports at most 32 teams");
  const poolDir = path.resolve(teamsDir, name);
  if (fs.existsSync(poolDir))
    throw new Error(
      `pool ${JSON.stringify(name)} already exists; pools are immutable snapshots, so pick a new name`,
    );
  const seenIds = new Set<string>();
  const seenTeams = new Map<string, string>();
  const teams = drafts.map((draft) => {
    const id = draft.id.trim();
    if (!POOL_SLUG.test(id))
      throw new Error(
        `team id ${JSON.stringify(draft.id)} must be lowercase letters, digits, and dashes`,
      );
    if (seenIds.has(id)) throw new Error(`duplicate team id ${JSON.stringify(id)}`);
    seenIds.add(id);
    const packed = packTeam(draft.paste, psDir, format);
    try {
      validateTeam(packed, format, psDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`team ${JSON.stringify(id)} is not legal in ${format}:\n${detail}`);
    }
    const clash = seenTeams.get(packed);
    if (clash)
      throw new Error(
        `team ${JSON.stringify(id)} is byte-for-byte the same team as ${JSON.stringify(clash)}`,
      );
    seenTeams.set(packed, id);
    return { id, packed, draft };
  });
  fs.mkdirSync(poolDir, { recursive: true });
  for (const team of teams)
    fs.writeFileSync(path.join(poolDir, `${team.id}.team`), `${team.packed}\n`, "utf8");
  const header: PoolManifestHeader = { id: name, format };
  if (contents.event) header.event = contents.event;
  if (contents.spreads) header.spreads = contents.spreads;
  const manifest: PoolManifest = {
    ...header,
    teams: teams.map((team) => {
      const entry: PoolManifestTeam = {
        id: team.id,
        file: `${team.id}.team`,
        seed: team.draft.seed,
      };
      if (team.draft.source) entry.source = team.draft.source;
      return entry;
    }),
  };
  fs.writeFileSync(
    path.join(poolDir, "pool.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return poolDir;
}

export function validatePool(pool: TeamPool, psDir = defaultPsDir()): void {
  for (const team of pool.teams) {
    try {
      validateTeam(team.packed, pool.format, psDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid team ${JSON.stringify(team.id)}: ${detail}`);
    }
  }
}
