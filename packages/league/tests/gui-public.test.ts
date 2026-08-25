import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTournamentGame, buildTournaments } from '../src/evidence.js';
import { GuiServer } from '../src/gui/server.js';
import { TEAMS_DIR } from '../src/paths.js';
import { loadSeriesRecords } from '../src/records.js';

const TOURNAMENT_RUN = '20260808T130000.000000Z-public02';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeArchiveFixture(root: string) {
  const runsDir = path.join(root, 'runs');
  const recordsPath = path.join(root, 'records.jsonl');
  const tournamentDir = path.join(runsDir, TOURNAMENT_RUN);
  const tournamentSeries = path.join(tournamentDir, 'series', 'tournament-series');
  fs.mkdirSync(tournamentSeries, { recursive: true });
  writeJson(path.join(tournamentDir, 'config.json'), {
    mode: 'tournament',
    pool: 'vr-aug26-top8',
    entrants: [
      { model: 'openai:alpha', team: '3rd-zuniga-froslass-scovillain', seed: 0 },
      { model: 'openai:beta', team: '6th-markl-floette-sneasler', seed: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(tournamentSeries, 'game-1.log'),
    ['|player|p1|openai:alpha|', '|player|p2|openai:beta|', '|turn|1', '|win|openai:alpha'].join('\n'),
    'utf8',
  );
  writeJson(path.join(tournamentSeries, 'p1-decisions.jsonl'), {
    kind: 'decision',
    game_number: 1,
    turn: 1,
    action: 'move 1 +1',
    rationale: 'The exact tournament decision.',
    notebook: 'The exact tournament notebook.',
  });

  const row = {
    schema_version: 1,
    format: 'gen9championsvgc2026regmbbo3',
    winner: 'openai:alpha',
    winner_side: 'p1',
    score: { p1: 2, p2: 0 },
    turns: 1,
    games: [{ number: 1, winner: 'openai:alpha', winner_side: 'p1', turns: 1, seed: [1, 2, 3, 4] }],
    engine_seeds: { p1: 101, p2: 202 },
    reasoning: null,
    decision_stats: { p1: { decisions: 1, tool_lookups: 99 }, p2: { decisions: 1 } },
    run_seed: 303,
    ps_commit: '0000000000000000000000000000000000000000',
    origin: { source: 'import', at: '2026-08-08T14:00:00.000Z' },
    mode: 'tournament',
    run_id: TOURNAMENT_RUN,
    series_id: 'tournament-series',
    series_index: 0,
    entrant_count: 2,
    round: 1,
    timestamp: '2026-08-08T13:30:00.000Z',
    pool: 'vr-aug26-top8',
    players: { p1: 'openai:alpha', p2: 'openai:beta' },
    teams: { p1: '3rd-zuniga-froslass-scovillain', p2: '6th-markl-floette-sneasler' },
    seeds: { p1: 0, p2: 1 },
    advanced: 'openai:alpha',
  };
  fs.writeFileSync(recordsPath, `${JSON.stringify(row)}\n`, 'utf8');
  return { runsDir, recordsPath };
}

async function archiveGet(port: number, pathname: string): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body, json: JSON.parse(body) });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('the tournament routes render imported evidence exactly', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-public-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = writeArchiveFixture(root);
  const rows = loadSeriesRecords(fixture.recordsPath);
  const gui = new GuiServer({
    ...fixture,
    teamsDir: TEAMS_DIR,
    host: '127.0.0.1',
  });
  await gui.listen(0);
  const address = gui.server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => gui.close());

  const tournaments = await archiveGet(address.port, '/api/tournaments');
  assert.equal(tournaments.status, 200);
  assert.deepEqual(tournaments.json, buildTournaments(rows, fixture.runsDir, null, TEAMS_DIR));
  assert.match(tournaments.body, /"evs":/);
  assert.match(tournaments.body, /"seed":3/);
  assert.match(tournaments.body, /"paste":/);

  const tournamentGame = await archiveGet(address.port, `/api/tournament/game?run=${TOURNAMENT_RUN}&series=0&game=1`);
  assert.equal(tournamentGame.status, 200);
  assert.deepEqual(tournamentGame.json, buildTournamentGame(rows, fixture.runsDir, TOURNAMENT_RUN, 0, 1, TEAMS_DIR));
  assert.match(tournamentGame.body, /exact tournament decision/);
  assert.match(tournamentGame.body, /exact tournament notebook/);
});
