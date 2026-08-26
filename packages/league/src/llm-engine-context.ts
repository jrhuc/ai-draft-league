import {
  type AgentContextEvent,
  type AgentContextKind,
  type AgentContextQuery,
  AgentContextStream,
} from "./agent-context.js";
import type { SlotMenu } from "./choices.js";
import type { BattleRequest, JsonObject, Pid } from "./types.js";
import { randomUUID } from "node:crypto";

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
        series_id: this.identity().seriesId ?? null,
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
