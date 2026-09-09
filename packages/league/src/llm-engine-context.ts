import {
  type AgentContextEvent,
  type AgentContextKind,
  type AgentContextQuery,
  AgentContextStream,
} from "./agent-context.js";
import type { SlotMenu } from "./choices.js";
import type { BattleRequest, JsonObject, Pid } from "./types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const historyQuery = z.strictObject({
  game_number: z.number().int().positive(),
  from_turn: z.number().int().nonnegative().default(0),
  offset: z.number().int().nonnegative().default(0),
});

interface ContextIdentity {
  gameId: string;
  seriesId: string | undefined;
  gameNumber: number;
  turn: number;
}

export class LLMEngineContext {
  private readonly stream: AgentContextStream;
  private readonly attempt = randomUUID();

  constructor(
    pid: Pid,
    initial: readonly AgentContextEvent[] | undefined,
    private readonly identity: () => ContextIdentity,
    write: (row: JsonObject) => void,
  ) {
    this.stream = new AgentContextStream(initial, (event) => {
      write({
        kind: "agent_context",
        pid,
        series_id: event.payload.series_id ?? null,
        context_id: event.id,
        sequence: event.sequence,
        context_kind: event.kind,
        payload: event.payload,
      });
    });
  }

  read(query: AgentContextQuery = {}) {
    return this.stream.read(query);
  }

  readHistory(args: JsonObject): string {
    const query = historyQuery.parse(args);
    const lines: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = this.stream.read({ after, limit: 500 });
      for (const event of page.events) {
        const payload = event.payload;
        if (payload.game_number !== query.game_number) continue;
        if (payload.event === "game_begin") lines.length = 0;
        const turn = z.number().optional().parse(payload.turn);
        if (turn !== undefined && turn < query.from_turn) continue;
        if (event.kind === "observation" && Array.isArray(payload.lines)) {
          lines.push(...payload.lines.filter((line): line is string => typeof line === "string"));
        } else if (event.kind === "decision") {
          lines.push(
            JSON.stringify({
              turn: payload.turn,
              submitted_action: payload.action,
              rationale: payload.rationale,
              memory_update: payload.memory_update,
            }),
          );
        } else if (event.kind === "reflection") {
          lines.push(
            JSON.stringify({
              review: payload.summary,
              adjustment: payload.adjustment,
              notebook: payload.notebook,
            }),
          );
        }
      }
      if (!page.more) break;
      after = page.nextCursor!;
    }
    const history = lines.join("\n");
    const end = Math.min(history.length, query.offset + 24_000);
    return JSON.stringify({
      game_number: query.game_number,
      from_turn: query.from_turn,
      text: history.slice(query.offset, end),
      next_offset: end < history.length ? end : null,
      total_characters: history.length,
    });
  }

  append(kind: AgentContextKind, payload: JsonObject): void {
    this.stream.append(kind, { ...payload, attempt_id: this.attempt });
  }

  observe(lines: string[]): void {
    if (!lines.length) return;
    this.append("observation", { ...this.base(), lines });
  }

  request(request: BattleRequest): void {
    this.append("observation", { ...this.base(), event: "battle_request", request });
  }

  menus(menus: SlotMenu[]) {
    return menus.map((menu) => menu.map(({ label, part, kind }) => ({ label, part, kind })));
  }

  private base(): JsonObject {
    const identity = this.identity();
    return {
      game_id: identity.gameId,
      series_id: identity.seriesId ?? null,
      game_number: identity.gameNumber,
      turn: identity.turn,
    };
  }
}
