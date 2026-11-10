// `ao report [--days N] [--json] [--dir METRICS_DIR] [--audit-dir PROJECTS_DIR]`
// How long agents waited on a person. Reads the day files straight from disk, read-only:
// no daemon is contacted, nothing is written, nothing old is pruned.
import {
  DEFAULT_METRICS_DIR,
  DEFAULT_PROJECTS_DIR,
  readEpisodesFromDir,
  readAutoApprovals,
  summarizeEpisodes,
  formatReport,
} from "../intervention-metrics.js";

const MAX_DAYS = 90; // the daemon keeps 90 days of day files

function option(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** @returns {number} exit code */
export function runReport(argv, { dir = DEFAULT_METRICS_DIR, auditDir = DEFAULT_PROJECTS_DIR, now = Date.now, log = console.log, error = console.error } = {}) {
  const rawDays = option(argv, "--days");
  const days = rawDays === undefined ? 7 : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    error(`--days must be a whole number from 1 to ${MAX_DAYS}`);
    return 2;
  }
  const metricsDir = option(argv, "--dir") ?? dir;
  const projectsDir = option(argv, "--audit-dir") ?? auditDir;
  const { episodes, badLines } = readEpisodesFromDir(metricsDir);
  const audit = projectsDir ? readAutoApprovals(projectsDir, { now: now(), days }) : null;
  const report = summarizeEpisodes(episodes, { now: now(), days, audit, badLines });
  log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}
