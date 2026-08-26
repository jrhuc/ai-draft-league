import { summarizeBattleEvents } from "./battle-transcript.js";
import type { Pid } from "./types.js";

const CHARACTER_LIMIT = 24000;
const CLIP_MARKER = "[Earlier turns are omitted from this timeline.]";

export class BattleTranscript {
  readonly lines: string[] = [];
  private characters = 0;

  constructor(private readonly pid: Pid) {}

  reset(): void {
    this.lines.length = 0;
    this.characters = 0;
  }

  remember(value: string): void {
    const lines = value.split("\n").filter(Boolean);
    if (!lines.length) return;
    this.lines.push(...lines);
    for (const line of lines) this.characters += line.length;
    this.trim();
  }

  rememberTurnDetail(value: string): void {
    const detail = value.trim().replace(/\.$/, "");
    if (!detail) return;
    let index = this.lines.findLastIndex((line) => /^Turn \d+:/.test(line));
    if (index < 0) index = this.lines.findLastIndex((line) => line.startsWith("Setup:"));
    if (index < 0) {
      this.remember(`Setup: ${detail}.`);
      return;
    }
    const current = this.lines[index]!;
    const base = current.endsWith(".") ? current.slice(0, -1) : current;
    const updated = `${base}${base.endsWith(":") ? " " : "; "}${detail}.`;
    this.characters += updated.length - current.length;
    this.lines[index] = updated;
    this.trim();
  }

  rememberEvents(lines: string[]): void {
    for (const event of summarizeBattleEvents(lines, this.pid)) {
      const turn = /^Turn (\d+) begins\.$/.exec(event);
      if (turn) this.remember(`Turn ${turn[1]}:`);
      else this.rememberTurnDetail(event);
    }
  }

  private trim(): void {
    let length = this.characters + this.lines.length - 1;
    let dropped = false;
    while (length > CHARACTER_LIMIT && this.lines.length > 1) {
      const removed = this.lines.shift()!;
      length -= removed.length + 1;
      this.characters -= removed.length;
      dropped = true;
    }
    if (length > CHARACTER_LIMIT) {
      const line = this.lines[0]!;
      const prefix = /^(?:Turn \d+|Setup):/.exec(line)?.[0] ?? "";
      const retained = Math.max(0, CHARACTER_LIMIT - prefix.length - 2);
      const clipped = `${prefix} …${line.slice(-retained)}`;
      this.characters += clipped.length - line.length;
      this.lines[0] = clipped;
      dropped = true;
    }
    if (dropped && this.lines[0] !== CLIP_MARKER) {
      this.lines.unshift(CLIP_MARKER);
      this.characters += CLIP_MARKER.length;
    }
  }
}
