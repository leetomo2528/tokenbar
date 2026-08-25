'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { estimateCost } = require('./pricing');

/**
 * Claude Code는 세션을 JSONL로 기록합니다.
 *   ~/.claude/projects/<인코딩된-프로젝트-경로>/<세션ID>.jsonl
 *
 * type:"assistant" 라인의 message.usage 안에 토큰 수가 들어있습니다.
 *   input_tokens / output_tokens
 *   cache_creation_input_tokens / cache_read_input_tokens
 *
 * 파일은 append-only라 변경된 파일만 다시 읽으면 됩니다.
 */
function defaultRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 파일 단위 캐시: 경로 -> { mtimeMs, size, events } */
const fileCache = new Map();

/** 이미 집계한 이벤트 uuid. 세션 분기·재개 시 중복을 막습니다. */
function dedupeKey(entry) {
  return entry.uuid || null;
}

async function listSessionFiles(root) {
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    let entries;
    try {
      entries = await fsp.readdir(dirPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) files.push(path.join(dirPath, name));
    }
  }
  return files;
}

/**
 * 한 파일을 스트리밍으로 읽어 assistant 사용량 이벤트만 뽑아냅니다.
 * 세션 파일이 수십 MB까지 커질 수 있어 전체를 메모리에 올리지 않습니다.
 */
function readEvents(filePath) {
  return new Promise((resolve) => {
    const events = [];
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    } catch {
      return resolve(events);
    }
    stream.on('error', () => resolve(events));

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // 쓰는 중인 마지막 줄이 깨져 있을 수 있음
      }
      if (obj.type !== 'assistant') return;
      const usage = obj.message && obj.message.usage;
      if (!usage) return;

      events.push({
        uuid: obj.uuid,
        ts: obj.timestamp ? Date.parse(obj.timestamp) : NaN,
        model: (obj.message && obj.message.model) || null,
        cwd: obj.cwd || null,
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
      });
    });
    rl.on('close', () => resolve(events));
  });
}

async function loadEvents(root) {
  const files = await listSessionFiles(root);
  const all = [];
  const seen = new Set();

  for (const filePath of files) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }

    const cached = fileCache.get(filePath);
    let events;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      events = cached.events;
    } else {
      events = await readEvents(filePath);
      fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, events });
    }

    for (const ev of events) {
      const key = dedupeKey(ev);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      all.push(ev);
    }
  }

  // 사라진 파일은 캐시에서도 제거
  const alive = new Set(files);
  for (const key of fileCache.keys()) {
    if (!alive.has(key)) fileCache.delete(key);
  }

  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return all;
}

function emptyBucket() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };
}

function addTo(bucket, ev) {
  bucket.input += ev.input;
  bucket.output += ev.output;
  bucket.cacheWrite += ev.cacheWrite;
  bucket.cacheRead += ev.cacheRead;
  bucket.cost += estimateCost(ev);
  bucket.calls += 1;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function startOfWeek(d) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // 월요일 시작
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/**
 * 집계. 구독자가 실제로 걱정하는 건 비용이 아니라 한도라,
 * 5시간 롤링 윈도우를 주지표로 둡니다.
 */
async function collect(options = {}) {
  const root = options.root || defaultRoot();
  const windowHours = options.windowHours || 5;
  const now = Date.now();

  const events = await loadEvents(root);

  const result = {
    ok: true,
    root,
    now,
    windowHours,
    windowStart: now - windowHours * 3600 * 1000,
    window: emptyBucket(),
    today: emptyBucket(),
    week: emptyBucket(),
    total: emptyBucket(),
    byModel: {},
    lastActivity: null,
    windowFirstCall: null,
    hasData: events.length > 0,
  };

  const dayStart = startOfDay(now);
  const weekStart = startOfWeek(now);

  for (const ev of events) {
    if (!Number.isFinite(ev.ts)) continue;
    addTo(result.total, ev);

    if (ev.ts >= result.windowStart) {
      addTo(result.window, ev);
      if (result.windowFirstCall === null || ev.ts < result.windowFirstCall) {
        result.windowFirstCall = ev.ts;
      }
      const key = ev.model || 'unknown';
      if (!result.byModel[key]) result.byModel[key] = emptyBucket();
      addTo(result.byModel[key], ev);
    }
    if (ev.ts >= dayStart) addTo(result.today, ev);
    if (ev.ts >= weekStart) addTo(result.week, ev);

    if (result.lastActivity === null || ev.ts > result.lastActivity) {
      result.lastActivity = ev.ts;
    }
  }

  return result;
}

module.exports = { collect, defaultRoot };
