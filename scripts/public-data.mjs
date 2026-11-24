import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const pages = ['index.html', 'insights-test/index.html'];
const dataLine = /^const DATA=(.*);$/gm;
const intensive = /(темп|интервал|быстр|порог|м[- ]?темп|марафонск|ускор|фартлек|\b400\b|\b800\b|\b1000\b|\b2000\b|\b3000\b|горк)/i;

const collections = {
  records: 'date distance is_quality',
  races: 'row date name distance seconds target pb style minutes vdot surface blog_title blog_url effort distance_cat clean_name type effort_label category series goal_label dist_class prep limited_by',
  monthly: 'month km runs',
  yearly: 'year km runs longest',
  marathon_preps: 'date name time_min weekly_km runs_week longest long_share runs20 runs30 quality_week total',
  prs: 'metric date where kind current_seconds goal_seconds gap_seconds progress current_value goal_value gap_value',
  long_runs: 'date distance duration_min pace_min content official race_name',
  milestones: 'year title text',
  blog_notes: 'title text url',
  goals: 'metric kind status goal_seconds goal_value',
  goal_pairs: 'metric kind date where current_seconds goal_seconds gap_seconds progress current_value goal_value gap_value',
  all_marathon_preps: 'date name time_min weekly_km runs_week longest runs20 quality_week target',
  trail_story: 'year title text',
  injuries: 'date title text',
  quotes: 'date title quote url',
  start_mix: 'name count',
  series_counts: 'name count',
  weekday_all: 'day km runs',
  evolution: 'date marathon_min capacity_km',
  start_mix_v4: 'name count',
  series_counts_v4: 'name count',
  trail_story_v4: 'year title text y',
  full_insights: 'title text',
  evolution_v4: 'date marathon_min capacity_km',
  evolution_anchors_v4: 'date marathon_min capacity_km kind label distance',
};

function requireData(condition) {
  if (!condition) throw new Error('Invalid dashboard data');
}

function isScalar(value) {
  return value === null || ['string', 'boolean', 'number'].includes(typeof value);
}

function select(row, fields) {
  requireData(row && typeof row === 'object' && !Array.isArray(row));
  const published = {};
  for (const field of fields.split(' ')) {
    if (!Object.hasOwn(row, field)) continue;
    const value = row[field];
    if (field === 'prep' && value !== null) {
      published.prep = select(value, 'weekly_km runs_week longest long_share runs20 runs30 quality_week total');
    } else {
      requireData(isScalar(value));
      published[field] = value;
    }
  }
  return published;
}

function publicData(input, deriveQuality = false) {
  const output = {};
  for (const [collection, fields] of Object.entries(collections)) {
    requireData(Array.isArray(input[collection]));
    output[collection] = input[collection].map(row => select(row, fields));
  }
  output.records.forEach((row, i) => {
    if (deriveQuality) {
      const workout = input.records[i];
      const { content, comment } = workout;
      requireData(Object.hasOwn(workout, 'content') || Object.hasOwn(workout, 'comment'));
      requireData([content, comment].every(value => value == null || typeof value === 'string'));
      row.is_quality = intensive.test(`${content || ''} ${comment || ''}`);
    }
    requireData(/^\d{4}-\d{2}-\d{2}$/.test(row.date)
      && typeof row.distance === 'number' && Number.isFinite(row.distance)
      && typeof row.is_quality === 'boolean');
  });
  requireData(Array.isArray(input.years) && input.years.every(Number.isInteger));
  requireData(typeof input.methodology_v4 === 'string');
  output.years = input.years;
  output.meta = select(input.meta, 'generated max_date');
  output.methodology = select(input.methodology, 'speed endurance check');
  output.methodology_v4 = input.methodology_v4;
  return output;
}

function readDashboard(html) {
  const matches = [...html.matchAll(dataLine)];
  requireData(matches.length === 1);
  return JSON.parse(matches[0][1]);
}

function checkDashboard(html) {
  const data = readDashboard(html);
  requireData(isDeepStrictEqual(data, publicData(data)));
  requireData(!/["']comment["']\s*[:=]/.test(html));
}

function build(inputPath) {
  let source = 0;
  if (inputPath !== '-') {
    source = realpathSync(resolve(inputPath));
    const location = relative(realpathSync(root), source);
    requireData(location === '..' || location.startsWith('..' + sep) || isAbsolute(location));
  }
  const data = publicData(JSON.parse(readFileSync(source, 'utf8')), true);
  const json = JSON.stringify(data).replaceAll('<', '\\u003c');
  const output = pages.map(page => {
    const html = readFileSync(resolve(root, page), 'utf8');
    readDashboard(html);
    const updated = html.replace(dataLine, () => `const DATA=${json};`);
    checkDashboard(updated);
    return updated;
  });
  pages.forEach((page, i) => writeFileSync(resolve(root, page), output[i]));
}

function checkRepository() {
  for (const page of pages) checkDashboard(readFileSync(resolve(root, page), 'utf8'));
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  const approvedFile = /^(?:index\.html|insights-test\/index\.html|README\.md|AGENTS\.md|\.gitattributes|\.github\/workflows\/public-data\.yml|scripts\/public-data\.mjs|site\.webmanifest|favicon(?:-16x16|-32x32)?\.(?:ico|png|svg)|(?:android-chrome-192x192|android-chrome-512x512|apple-touch-icon)\.png|assets\/[\w-]+\.(?:png|webp)|notes\/(?:index\.html|app(?:\.v\d+)?\.js|styles(?:\.v\d+)?\.css|assets\/covers\/[\w-]+\.webp))$/;
  if (paths.some(path => path && !approvedFile.test(path))) {
    throw new Error('Unapproved file in the public repository');
  }
}

try {
  const [command, inputPath, ...extra] = process.argv.slice(2);
  if (command === 'build' && inputPath && extra.length === 0) build(inputPath);
  else if (command === 'check' && !inputPath) checkRepository();
  else throw new Error('Invalid command');
} catch {
  // Input can contain private text. Never print it or the JSON parser's error.
  console.error('Public data check failed. Review the allowlist, file paths and input schema.');
  process.exitCode = 1;
}
