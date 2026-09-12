import { id } from "./reference-mechanics.js";
import type { JsonObject, Pid } from "./types.js";
import { asRecord, asRecords, count, text } from "./value.js";

export interface ObservedHit {
  turn: number;
  attacker: string;
  attackerSide: Pid;
  move: string;
  target: string;
  targetSide: Pid;
  hpBefore: number;
  hpAfter: number;
  fainted: boolean;
  crit: boolean;
  helpingHand: boolean;
  spreadTargets: number;
  markers: string[];
}

export interface ObservedTurnOrder {
  turn: number;
  moves: Array<{ species: string; side: Pid; move: string }>;
}

export interface DamagePrediction {
  pid: Pid;
  turn: number;
  attacker: string;
  defender: string;
  move: string;
  min: number;
  max: number;
  shownHp: number;
  ko: "both" | "one" | "none" | null;
  crit: boolean;
  helpingHand: boolean;
  spread: boolean;
}

export interface OrderPrediction {
  pid: Pid;
  turn: number;
  first: string;
  second: string;
  firstMove: string | null;
  secondMove: string | null;
  actsFirst: string | null;
}

export interface MechanicsFinding {
  kind: "damage-range" | "ko-missed" | "ko-unexpected" | "order";
  game: number;
  turn: number;
  pid: Pid;
  detail: string;
}

export interface GameMechanicsAudit {
  damagePredictions: number;
  damageMatched: number;
  orderPredictions: number;
  orderMatched: number;
  findings: MechanicsFinding[];
}

const SURVIVAL_MARKERS = new Set(["Focus Sash", "Sturdy", "Disguise", "Ice Face", "Endure"]);
const SCREENS = new Set(["Reflect", "Light Screen", "Aurora Veil"]);
const RANGE_TOLERANCE = 2;

interface SlotState {
  species: string;
  hp: number;
}

interface PendingMove {
  turn: number;
  attacker: string;
  attackerSide: Pid;
  attackerChangedForme: boolean;
  helpingHand: boolean;
  move: string;
  spreadTargets: number;
  hits: Map<string, ObservedHit>;
}

function slotSide(ident: string): Pid {
  return ident.trim().startsWith("p2") ? "p2" : "p1";
}

function slotKey(ident: string): string {
  return ident.trim().slice(0, 3);
}

function hpPercent(value: string): number | null {
  const [hp] = value.trim().split(/\s+/);
  if (!hp || hp === "0" || hp.endsWith("fnt")) return 0;
  const match = /^(\d+)\/(\d+)/.exec(hp);
  if (!match || !Number(match[2])) return null;
  return Math.round((Number(match[1]) * 100) / Number(match[2]));
}

function afterColon(value: string): string {
  const index = value.indexOf(":");
  return index === -1 ? value.trim() : value.slice(index + 1).trim();
}

/** Tool arguments name species loosely ("Aegislash" for Aegislash-Blade, "Mega Altaria" for
 * Altaria-Mega), so a match accepts the exact id or the same base species. */
export function speciesMatches(argument: string, species: string): boolean {
  const wanted = id(argument);
  const seen = id(species);
  if (wanted === seen) return true;
  const base = id(species.split("-", 1)[0]!);
  return wanted === base || wanted.startsWith(base) || wanted.endsWith(base);
}

export interface ObservedGame {
  hits: ObservedHit[];
  orders: ObservedTurnOrder[];
}

export function observeGame(lines: readonly string[]): ObservedGame {
  const slots = new Map<string, SlotState>();
  const changedForme = new Set<string>();
  const helped = new Set<string>();
  const screened = new Set<Pid>();
  const hits: ObservedHit[] = [];
  const orders: ObservedTurnOrder[] = [];
  let turn = 0;
  let pending: PendingMove | null = null;
  let order: ObservedTurnOrder = { turn: 0, moves: [] };

  const flush = () => {
    if (pending) hits.push(...pending.hits.values());
    pending = null;
  };
  const hitFor = (key: string): ObservedHit | undefined => {
    if (!pending || !key) return undefined;
    const existing = pending.hits.get(key);
    if (existing) return existing;
    const slot = slots.get(key);
    const hit: ObservedHit = {
      turn: pending.turn,
      attacker: pending.attacker,
      attackerSide: pending.attackerSide,
      move: pending.move,
      target: slot?.species ?? key,
      targetSide: slotSide(key),
      hpBefore: slot?.hp ?? 100,
      hpAfter: slot?.hp ?? 100,
      fainted: false,
      crit: false,
      helpingHand: pending.helpingHand,
      spreadTargets: pending.spreadTargets,
      markers: [
        ...(pending.attackerChangedForme ? ["attacker changed forme this turn"] : []),
        ...(changedForme.has(key) ? ["target changed forme this turn"] : []),
        ...(screened.has(slotSide(key)) ? ["screen set this turn"] : []),
      ],
    };
    pending.hits.set(key, hit);
    return hit;
  };

  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const [, kind = "", ...args] = line.split("|");
    const key = args[0] ? slotKey(args[0]) : "";
    if (kind === "turn") {
      flush();
      turn = Number(args[0]) || 0;
      changedForme.clear();
      helped.clear();
      screened.clear();
      order = { turn, moves: [] };
      orders.push(order);
    } else if (kind === "switch" || kind === "drag" || kind === "replace") {
      flush();
      const species = (args[1] ?? "").split(",", 1)[0]!.trim();
      if (key) slots.set(key, { species, hp: hpPercent(args[2] ?? "") ?? 100 });
    } else if (kind === "detailschange" || kind === "-formechange") {
      const slot = slots.get(key);
      if (slot && args[1]) slot.species = args[1].split(",", 1)[0]!.trim();
      if (key) changedForme.add(key);
    } else if (kind === "move") {
      flush();
      const attacker = slots.get(key);
      if (!attacker || !args[1]) continue;
      const spread = args.find((arg) => arg.startsWith("[spread]"));
      pending = {
        turn,
        attacker: attacker.species,
        attackerSide: slotSide(key),
        attackerChangedForme: changedForme.has(key),
        helpingHand: helped.has(key),
        move: args[1],
        spreadTargets: spread ? spread.slice(8).trim().split(",").filter(Boolean).length : 1,
        hits: new Map(),
      };
      if (!args.includes("[still]"))
        order.moves.push({ species: attacker.species, side: slotSide(key), move: args[1] });
    } else if (kind === "-sidestart" && SCREENS.has(afterColon(args[1] ?? ""))) {
      screened.add(args[0]?.startsWith("p2") ? "p2" : "p1");
    } else if (kind === "-singleturn" && afterColon(args[1] ?? "") === "Helping Hand") {
      helped.add(key);
    } else if (kind === "-zbroken") {
      hitFor(key)?.markers.push("through Protect");
    } else if (kind === "-damage" || kind === "-heal") {
      const slot = slots.get(key);
      const after = hpPercent(args[1] ?? "");
      if (!slot || after === null) continue;
      const indirect = args.some((arg) => arg.startsWith("[from]"));
      if (kind === "-damage" && !indirect) {
        const hit = hitFor(key);
        if (hit) {
          hit.hpAfter = after;
          hit.fainted = after === 0;
        }
      }
      slot.hp = after;
    } else if (kind === "faint") {
      const slot = slots.get(key);
      if (slot) slot.hp = 0;
    } else if (kind === "-crit") {
      const hit = hitFor(key);
      if (hit) hit.crit = true;
    } else if (kind === "-enditem" && args[1] && SURVIVAL_MARKERS.has(args[1])) {
      hitFor(key)?.markers.push(args[1]);
    } else if (kind === "-activate" && args[1] && SURVIVAL_MARKERS.has(afterColon(args[1]))) {
      hitFor(key)?.markers.push(afterColon(args[1]));
    } else if (kind === "-immune") {
      hitFor(key)?.markers.push("immune");
    }
  }
  flush();
  return { hits: hits.filter((hit) => hit.hpBefore !== hit.hpAfter || hit.markers.length), orders };
}

function koVerdict(result: string): DamagePrediction["ko"] {
  if (/at both evaluated endpoints|Guaranteed (?:OH)?KO/.test(result)) return "both";
  if (/at one evaluated endpoint only|Possible (?:OH)?KO/.test(result)) return "one";
  if (/No (?:OHKO|KO from the shown \d+%) at either|Cannot (?:OH)?KO/.test(result)) return "none";
  return null;
}

export interface Predictions {
  damage: DamagePrediction[];
  order: OrderPrediction[];
}

export function readPredictions(traceRows: readonly JsonObject[]): Predictions {
  const damage: DamagePrediction[] = [];
  const order: OrderPrediction[] = [];
  for (const row of traceRows) {
    if (row.kind !== "decision_trace") continue;
    const pid: Pid = text(row.pid) === "p2" ? "p2" : "p1";
    const turn = count(row.turn) + (text(row.phase) === "forced_switch" ? 1 : 0);
    for (const call of asRecords(row.tool_calls)) {
      const args = asRecord(call.arguments);
      const result = text(call.result);
      if (call.name === "estimate_damage") {
        const range = /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)% of maximum HP/.exec(result);
        if (!range) continue;
        const shown = /Target HP shown: (\d+)%/.exec(result);
        damage.push({
          pid,
          turn,
          attacker: text(args.attacker),
          defender: text(args.defender),
          move: text(args.move),
          min: Number(range[1]),
          max: Number(range[2]),
          shownHp: shown ? Number(shown[1]) : 100,
          ko: koVerdict(result),
          crit: args.is_critical_hit === true || /applied[^.]*critical hit/.test(result),
          helpingHand: args.helping_hand === true,
          spread: /spread \(0\.75x\)/.test(result),
        });
      } else if (call.name === "compare_action_order") {
        const first = /^(.+?) is guaranteed to act first/m.exec(result);
        order.push({
          pid,
          turn,
          first: text(args.first),
          second: text(args.second),
          firstMove: text(args.first_move) || null,
          secondMove: text(args.second_move) || null,
          actsFirst: first ? first[1]!.trim() : null,
        });
      }
    }
  }
  return { damage, order };
}

function describeHit(hit: ObservedHit): string {
  const markers = [hit.crit ? "crit" : "", ...hit.markers].filter(Boolean);
  return (
    `${hit.attacker} ${hit.move} into ${hit.target}: ${hit.hpBefore}% → ${hit.hpAfter}%` +
    (hit.fainted ? " (fainted)" : "") +
    (markers.length ? ` [${markers.join(", ")}]` : "")
  );
}

function describePrediction(prediction: DamagePrediction): string {
  return `${prediction.min}-${prediction.max}%` + (prediction.ko ? `, KO ${prediction.ko}` : "");
}

export function auditGame(
  game: number,
  logLines: readonly string[],
  traceRows: Readonly<Record<Pid, readonly JsonObject[]>>,
): GameMechanicsAudit {
  const { hits, orders } = observeGame(logLines);
  const audit: GameMechanicsAudit = {
    damagePredictions: 0,
    damageMatched: 0,
    orderPredictions: 0,
    orderMatched: 0,
    findings: [],
  };
  const seen = new Set<string>();
  const report = (
    kind: MechanicsFinding["kind"],
    turn: number,
    pid: Pid,
    predicted: string,
    observed: string,
  ) => {
    const detail = `predicted ${predicted}; observed ${observed}`;
    const signature = `${kind}|${turn}|${pid}|${detail}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    audit.findings.push({ kind, game, turn, pid, detail });
  };
  for (const pid of ["p1", "p2"] as const) {
    const predictions = readPredictions(traceRows[pid]);
    audit.damagePredictions += predictions.damage.length;
    audit.orderPredictions += predictions.order.length;
    for (const prediction of predictions.damage) {
      const matched = hits.filter(
        (hit) =>
          hit.turn === prediction.turn &&
          id(hit.move) === id(prediction.move) &&
          speciesMatches(prediction.attacker, hit.attacker) &&
          speciesMatches(prediction.defender, hit.target),
      );
      for (const hit of matched) {
        if (
          hit.crit !== prediction.crit ||
          hit.helpingHand !== prediction.helpingHand ||
          hit.spreadTargets > 1 !== prediction.spread
        )
          continue;
        if (hit.markers.includes("immune") || hit.markers.includes("through Protect")) continue;
        audit.damageMatched += 1;
        const survived = hit.markers.some((marker) => SURVIVAL_MARKERS.has(marker));
        const dealt = hit.hpBefore - hit.hpAfter;
        const under = dealt < prediction.min - RANGE_TOLERANCE && !hit.fainted;
        const over = dealt > prediction.max + RANGE_TOLERANCE;
        const predicted = describePrediction(prediction);
        const observed = describeHit(hit);
        if (!survived && (under || over))
          report("damage-range", hit.turn, pid, predicted, observed);
        if (prediction.ko === "both" && !hit.fainted)
          report("ko-missed", hit.turn, pid, predicted, observed);
        if (prediction.ko === "none" && hit.fainted && hit.hpBefore >= prediction.shownHp)
          report("ko-unexpected", hit.turn, pid, predicted, observed);
      }
    }
    for (const prediction of predictions.order) {
      if (!prediction.actsFirst || !prediction.firstMove || !prediction.secondMove) continue;
      if (id(prediction.firstMove) === "switch" || id(prediction.secondMove) === "switch") continue;
      const order = orders.find((entry) => entry.turn === prediction.turn);
      if (!order) continue;
      const find = (species: string, move: string) =>
        order.moves.findIndex(
          (entry) => speciesMatches(species, entry.species) && id(move) === id(entry.move),
        );
      const firstIndex = find(prediction.first, prediction.firstMove);
      const secondIndex = find(prediction.second, prediction.secondMove);
      if (firstIndex === -1 || secondIndex === -1) continue;
      audit.orderMatched += 1;
      const predictedFirst = speciesMatches(prediction.actsFirst, order.moves[firstIndex]!.species);
      if (predictedFirst !== firstIndex < secondIndex) {
        report(
          "order",
          prediction.turn,
          pid,
          `${prediction.actsFirst} acts first (${prediction.first} ${prediction.firstMove} vs ${prediction.second} ${prediction.secondMove})`,
          order.moves.map((entry) => `${entry.species} ${entry.move}`).join(" → "),
        );
      }
    }
  }
  return audit;
}
