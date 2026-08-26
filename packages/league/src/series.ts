export type {
  EngineSetup,
  ExperimentOptions,
  GameSeed,
  SeriesFold,
  SeriesGameResult,
} from "./series-core.js";
export {
  chanceEventCounts,
  closedSheetsFormat,
  foldSeriesGames,
  makeEngine,
  mapLimit,
  seriesSeedSchedule,
  SINGLE_ELIMINATION_GAME_LIMIT,
} from "./series-core.js";
export type {
  CompletedSeriesFields,
  RecordedSeries,
  RecordedSeriesContext,
} from "./recorded-series.js";
export {
  readCompletedSeriesDecisionRows,
  readCompletedSeriesEvidence,
  readCompletedSeriesGameLogs,
  recordedSeriesMetadataSchema,
  RECORDED_SERIES_METADATA_SCHEMA_VERSION,
  resolveAttemptLineage,
  selectCompletedDecisionRows,
  SERIES_ATTEMPT_SCHEMA_VERSION,
  SERIES_GAME_COMPLETION_SCHEMA_VERSION,
  storedSeriesMetadataSchema,
} from "./recorded-series.js";
export type { Bo3Context, Bo3Result } from "./live-recorded-series.js";
export { playBo3, playRecordedSeries } from "./live-recorded-series.js";
