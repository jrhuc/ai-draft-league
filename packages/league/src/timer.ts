import type { BattleStream } from "pokemon-showdown";
import type { RoomBattleBridge, RoomBattleTimer, TimerPlayer } from "./showdown.js";
import { loadRoomBattleTimer } from "./showdown.js";
import type { JsonValue, Pid, TimerScale } from "./types.js";

export type TimerEvent = "autodefault" | "forfeit" | "tie";

const TIMER_SCALE_MIN = 0.5;
const TIMER_SCALE_MAX = 4;
export const DEFAULT_TIMER_SCALE: TimerScale = "off";
interface TimerRequestStart {
  seconds?: number;
  turnSeconds?: number;
}

interface TimerRequestStarts {
  p1: TimerRequestStart | undefined;
  p2: TimerRequestStart | undefined;
}

interface TimerRequestPayload {
  wait?: boolean;
  update?: boolean;
  timer?: {
    turnSeconds: number | undefined;
    seconds: number | undefined;
  };
}

export function parseTimerScale(value: JsonValue | undefined): TimerScale | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "off" || value === "untimed") return "off";
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale < TIMER_SCALE_MIN || scale > TIMER_SCALE_MAX) {
    throw new Error(
      `timer scale must be 'off' or a number between ${TIMER_SCALE_MIN} and ${TIMER_SCALE_MAX}`,
    );
  }
  return scale;
}

export class TimerAdapter {
  private readonly players: TimerPlayer[];
  private readonly bySlot: Record<Pid, TimerPlayer>;
  private readonly timer: RoomBattleTimer;
  private readonly enabled: boolean;
  private readonly requestStart: TimerRequestStarts = {
    p1: undefined,
    p2: undefined,
  };
  private readonly battle: RoomBattleBridge;

  constructor(
    format: string,
    private readonly stream: BattleStream,
    private readonly onEvent: (pid: Pid, event: TimerEvent) => void,
    psDir: string,
    scale: TimerScale,
  ) {
    this.enabled = scale !== "off";
    this.players = (["p1", "p2"] as const).map((slot) => ({
      slot,
      name: slot,
      active: true,
      knownActive: true,
      eliminated: false,
      request: { isWait: "cantUndo" },
      sendRoom() {},
    }));
    this.bySlot = { p1: this.players[0]!, p2: this.players[1]! };
    const room = { add: () => room, update: () => room };
    this.battle = {
      format,
      challengeType: "challenge",
      ended: false,
      players: this.players,
      playerTable: {},
      room,
      turn: 0,
      requestCount: 0,
      stream: {
        write: (command) => {
          const match = /^>(p[12]) default$/.exec(command);
          if (match) {
            const pid: Pid = match[1] === "p1" ? "p1" : "p2";
            this.bySlot[pid].request.isWait = true;
            this.onEvent(pid, "autodefault");
          }
          return this.stream.write(command);
        },
      },
      tie: () => {
        for (const player of this.players) this.onEvent(player.slot, "tie");
        return this.stream.write(">forcetie");
      },
      forfeitPlayer: (player) => {
        player.eliminated = true;
        player.request.isWait = true;
        this.onEvent(player.slot, "forfeit");
        return this.stream.write(`>forcelose ${player.slot}`);
      },
    };
    const Timer = loadRoomBattleTimer(psDir);
    this.timer = new Timer(this.battle);
    if (scale !== "off" && scale !== 1) this.scaleSettings(scale);
    if (this.enabled) this.timer.start();
  }

  private scaleSettings(scale: number): void {
    const settings = this.timer.settings;
    for (const key of ["starting", "grace", "addPerTurn", "maxPerTurn", "maxFirstTurn"] as const) {
      if (settings[key] && Number.isFinite(settings[key])) {
        settings[key] = Math.max(5, Math.round((settings[key] * scale) / 5) * 5);
      }
    }
    for (const player of this.players) {
      player.secondsLeft = settings.starting + settings.grace;
    }
  }

  setPlayer(pid: Pid, name: string): void {
    this.bySlot[pid].name = name;
  }

  receive(message: string): string {
    const lines = message.split("\n");
    if (lines[0] === "update") {
      for (const line of lines.slice(1)) {
        if (line.startsWith("|turn|")) this.battle.turn = Number(line.slice(6));
      }
    } else if (lines[0] === "sideupdate") {
      const pid = lines[1] === "p1" || lines[1] === "p2" ? lines[1] : undefined;
      const player = pid === undefined ? undefined : this.bySlot[pid];
      const line = lines[2] ?? "";
      if (player && pid && line.startsWith("|request|")) {
        const request: TimerRequestPayload = JSON.parse(line.slice(9));
        player.request = { isWait: request.wait ? "cantUndo" : false };
        this.battle.requestCount += 1;
        if (this.enabled) {
          if (!request.update) this.timer.nextRequest(player);
          this.requestStart[pid] = {
            seconds: player.secondsLeft,
            turnSeconds: player.turnSecondsLeft,
          };
          if (!request.wait) {
            request.timer = { turnSeconds: player.turnSecondsLeft, seconds: player.secondsLeft };
            lines[2] = `|request|${JSON.stringify(request)}`;
          }
        }
      } else if (player && line.startsWith("|error|[Invalid choice]")) {
        player.request.isWait = line.includes("Can't undo") ? "cantUndo" : false;
      }
    } else if (lines[0] === "end") {
      this.battle.ended = true;
      if (this.enabled) this.timer.end();
    }
    return lines.join("\n");
  }

  choose(pid: Pid, choice: string): void | Promise<void> {
    const player = this.bySlot[pid];
    if (player.request.isWait) return;
    player.request.isWait = true;
    /** A concession is a stream-level command, not a battle choice: the sim has no "forfeit" choice
     * string, so the menu option maps to forcelose for the conceding side. */
    if (choice === "forfeit") return this.stream.write(`>forcelose ${pid}`);
    return this.stream.write(`>${pid} ${choice}`);
  }

  end(): void {
    this.battle.ended = true;
    if (this.enabled) this.timer.end();
  }
}
