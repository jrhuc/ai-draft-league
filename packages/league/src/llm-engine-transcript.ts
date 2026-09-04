import { summarizeBattleEvents } from "./battle-transcript.js";
import { TRANSCRIPT_CHARACTER_LIMIT, TRANSCRIPT_CLIP_MARKER } from "./llm-engine-support.js";
import type { Pid } from "./types.js";

const FACT_CHARACTER_LIMIT = 4000;
const FACT_MARKER = "[Earlier revealed facts retained:]";
const DURABLE_FACT =
  / revealed | copied | was blocked by | Mega Evolved| was immune|action failed| could not act| fainted| activated (?:item|ability):|ability .* was suppressed|time expired|time bank ran out/i;

function characterCount(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length, Math.max(0, lines.length - 1));
}

/**
 * The compact private timeline. Once the character cap evicts early turns, the
 * durable reveals they carried (items, abilities, immunities, faints) stay
 * pinned under a marker so a long game never forgets what it learned first.
 */
export class BattleTranscript {
  private readonly timeline: string[] = [];
  private readonly facts: string[] = [];
  private clipped = false;

  constructor(private readonly pid: Pid) {}

  get lines(): string[] {
    if (!this.clipped) return this.timeline;
    const retained = this.facts.filter(
      (fact) => !this.timeline.some((line) => line.includes(fact)),
    );
    return [
      TRANSCRIPT_CLIP_MARKER,
      ...(retained.length ? [FACT_MARKER, ...retained] : []),
      ...this.timeline,
    ];
  }

  reset(): void {
    this.timeline.length = 0;
    this.facts.length = 0;
    this.clipped = false;
  }

  remember(value: string): void {
    const lines = value.split("\n").filter(Boolean);
    if (!lines.length) return;
    this.timeline.push(...lines);
    this.trim();
  }

  rememberTurnDetail(value: string): void {
    const detail = value.trim().replace(/\.$/, "");
    if (!detail) return;
    let index = this.timeline.findLastIndex((line) => /^Turn \d+:/.test(line));
    if (index < 0) index = this.timeline.findLastIndex((line) => line.startsWith("Setup:"));
    if (index < 0) {
      this.remember(`Setup: ${detail}.`);
      return;
    }
    const current = this.timeline[index]!;
    const base = current.endsWith(".") ? current.slice(0, -1) : current;
    this.timeline[index] = `${base}${base.endsWith(":") ? " " : "; "}${detail}.`;
    this.trim();
  }

  rememberEvents(lines: string[]): void {
    for (const event of summarizeBattleEvents(lines, this.pid)) {
      if (DURABLE_FACT.test(event)) this.rememberFact(event);
      const turn = /^Turn (\d+) begins\.$/.exec(event);
      if (turn) this.remember(`Turn ${turn[1]}:`);
      else this.rememberTurnDetail(event);
    }
  }

  private rememberFact(value: string): void {
    if (this.facts.includes(value) || value.length > FACT_CHARACTER_LIMIT) return;
    this.facts.push(value);
    while (characterCount(this.facts) > FACT_CHARACTER_LIMIT) this.facts.shift();
  }

  private trim(): void {
    if (!this.clipped && characterCount(this.timeline) <= TRANSCRIPT_CHARACTER_LIMIT) return;
    this.clipped = true;
    while (characterCount(this.lines) > TRANSCRIPT_CHARACTER_LIMIT && this.timeline.length > 1)
      this.timeline.shift();
    if (characterCount(this.lines) <= TRANSCRIPT_CHARACTER_LIMIT || !this.timeline.length) return;
    const line = this.timeline[0]!;
    const fixed = [TRANSCRIPT_CLIP_MARKER, FACT_MARKER, ...this.facts];
    const available = Math.max(
      0,
      TRANSCRIPT_CHARACTER_LIMIT - characterCount(fixed) - fixed.length,
    );
    const prefix = /^(?:Turn \d+|Setup):/.exec(line)?.[0] ?? "";
    const retained = Math.max(0, available - prefix.length - 2);
    this.timeline[0] = `${prefix} …${line.slice(-retained)}`;
  }
}
