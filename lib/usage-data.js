import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 4247762216;
const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function resolveTimeZone(config) {
  return config?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function monthKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(Number(timestamp)));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

export function currentMonth(timeZone) {
  return monthKey(Date.now(), timeZone);
}

export function previousMonth(month) {
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function getOpenCodeApiKey(dshHome = resolveDshHome()) {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY.trim();
  const credentialsPath = path.join(dshHome, '.credentials.yaml');
  if (!fs.existsSync(credentialsPath)) return null;
  const text = fs.readFileSync(credentialsPath, 'utf8');
  const match = text.match(/^\s*OPENCODE_API_KEY:\s*(.+?)\s*$/m);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

export function findDshOpenCodeSessionId(dshHome = resolveDshHome()) {
  if (process.env.OPENCODE_SESSION_ID) return process.env.OPENCODE_SESSION_ID.trim();
  const profilesRoot = path.join(dshHome, 'profiles');
  if (!fs.existsSync(profilesRoot)) return null;
  const candidates = [];
  walkFiles(profilesRoot, (filePath) => {
    if (!/(?:cordis\.patch\.yml|cordis\.yml)$/.test(filePath)) return;
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    const match = text.match(/x-opencode-session\s*:\s*["']?([A-Za-z0-9_-]+)/);
    if (match) candidates.push({ filePath, sessionId: match[1] });
  });
  candidates.sort((a, b) => {
    const aPatch = a.filePath.endsWith('cordis.patch.yml') ? 1 : 0;
    const bPatch = b.filePath.endsWith('cordis.patch.yml') ? 1 : 0;
    return bPatch - aPatch || a.filePath.localeCompare(b.filePath);
  });
  return candidates[0]?.sessionId || null;
}

export function collectLocalUsage({ dshHome = resolveDshHome(), timeZone, month } = {}) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    return { months: {}, filesFound: 0, filesRead: 0, filesSkipped: 0 };
  }

  const files = selectSessionFiles(sessionsRoot);
  const byMonth = new Map();
  let filesRead = 0;
  let filesSkipped = 0;

  for (const file of files) {
    let text;
    try {
      text = decodeSessionFile(file.path);
      filesRead++;
    } catch {
      filesSkipped++;
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== 'assistant/message' || !event.data?.usage) continue;
      if (!Number.isFinite(Number(event.time))) continue;
      const eventMonth = monthKey(Number(event.time), timeZone);
      if (month && eventMonth !== month) continue;

      const sourceInfo = event.data?.message?.source || {};
      const replay = sourceInfo?.replayState?.response || {};
      const provider = String(sourceInfo.provider || replay.provider || 'unknown');
      const model = String(sourceInfo.model || replay.model || 'unknown');
      const usage = event.data.usage;
      const item = getMonth(byMonth, eventMonth);
      const row = getModel(item, provider, model);
      row.requests++;
      row.inputTokens += number(usage.inputTokens);
      row.outputTokens += number(usage.outputTokens);
      row.reasoningTokens += number(usage.reasoningTokens);
      row.cacheReadTokens += number(usage.cacheReadTokens);
      row.cacheWriteTokens += number(usage.cacheWriteTokens);
      row.totalTokens += number(usage.totalTokens);
    }
  }

  const months = {};
  for (const [key, value] of byMonth) months[key] = finishMonth(value);
  return { months, filesFound: files.length, filesRead, filesSkipped };
}

export async function collectOpenCodeRequestLog({ dshHome = resolveDshHome(), timeZone, month, sessionId } = {}) {
  const apiKey = getOpenCodeApiKey(dshHome);
  if (!apiKey) throw new Error('找不到 OPENCODE_API_KEY');
  if (!sessionId) throw new Error('找不到 x-opencode-session');

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'dsh-usage-plugin/0.1.0',
    Accept: 'application/json',
  };

  const unique = new Map();
  let cursor = null;
  let retentionDays = null;
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      category: 'inference',
      sessionID: sessionId,
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);
    const data = JSON.parse(
      await fetchText(`https://opencode.ai/console/api/request-logs?${params}`, headers)
    );
    for (const item of data.items || []) {
      if (item.id) unique.set(item.id, item);
      else unique.set(`${item.startedAt}-${item.requestID}-${unique.size}`, item);
    }
    retentionDays = data.retentionDays ?? retentionDays;
    cursor = typeof data.nextCursor === 'string'
      ? data.nextCursor
      : data.nextCursor?.id ?? data.nextCursor?.cursor ?? null;
    if (!cursor) break;
  }

  const items = [...unique.values()].filter((item) =>
    monthKey(number(item.startedAt), timeZone) === month
  );
  const byMonth = new Map();
  const outcomes = {};
  const userAgents = new Set();

  for (const item of items) {
    const provider = String(item.provider || 'unknown');
    const model = String(item.model || item.requestedModel || 'unknown');
    const row = getModel(getMonth(byMonth, month), provider, model);
    const inputTokens = number(item.inputTokens);
    const outputTokens = number(item.outputTokens);
    const cacheReadTokens = number(item.cacheReadTokens);
    const cacheWriteTokens = number(item.cacheWriteTokens);
    row.requests++;
    row.inputTokens += inputTokens;
    row.outputTokens += outputTokens;
    row.reasoningTokens += number(item.reasoningTokens);
    row.cacheReadTokens += cacheReadTokens;
    row.cacheWriteTokens += cacheWriteTokens;
    row.totalTokens += inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    row.costUSD += number(item.cost);
    outcomes[item.outcome || 'unknown'] = (outcomes[item.outcome || 'unknown'] || 0) + 1;
    if (item.userAgent) userAgents.add(item.userAgent);
  }

  return {
    ...finishMonth(getMonth(byMonth, month)),
    sessionId,
    retentionDays,
    outcomes,
    userAgents: [...userAgents],
  };
}

export async function collectAccountUsage({ dshHome = resolveDshHome(), month } = {}) {
  const apiKey = getOpenCodeApiKey(dshHome);
  if (!apiKey) throw new Error('找不到 OPENCODE_API_KEY');

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'dsh-usage-plugin/0.1.0',
    Accept: 'application/json, text/csv',
  };

  let exportRows = [];
  let exportError = null;
  try {
    const csv = await fetchText(
      'https://opencode.ai/console/api/v2/usage/export?range=90d',
      headers
    );
    exportRows = parseCsv(csv).filter((row) => row.day?.startsWith(`${month}-`));
  } catch (error) {
    exportError = error.message;
  }

  let goPeriod = null;
  try {
    const go = JSON.parse(
      await fetchText('https://opencode.ai/console/api/activity/go', headers)
    );
    const daily = Array.isArray(go.daily) ? go.daily : [];
    goPeriod = {
      startsAt: go.startsAt || null,
      requests: sum(daily.map((row) => number(row.totalRequests))),
      tokens: sum(daily.map((row) => number(row.totalTokens))),
      allowanceEquivalentUSD:
        sum(daily.map((row) => number(row.totalCostMicroCents))) / 100000000,
    };
  } catch {
    goPeriod = null;
  }

  const byMonth = new Map();
  for (const row of exportRows) {
    const provider = row.provider || 'unknown';
    const model = row.model || 'unknown';
    const item = getModel(getMonth(byMonth, month), provider, model);
    item.requests += number(row.requests);
    item.inputTokens += number(row.input_tokens);
    item.outputTokens += number(row.output_tokens);
    item.cacheReadTokens += number(row.cache_read_tokens);
    item.cacheWriteTokens += number(row.cache_write_5m_tokens) + number(row.cache_write_1h_tokens);
    item.totalTokens +=
      item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheWriteTokens;
    item.costUSD += number(row.cost_usd);
  }

  return {
    ...finishMonth(getMonth(byMonth, month)),
    exportError,
    goPeriod,
  };
}

export function listMonths(localMonths = {}, historyMonths = {}, timeZone = 'UTC') {
  const now = currentMonth(timeZone);
  return [...new Set([now, ...Object.keys(localMonths), ...Object.keys(historyMonths)])]
    .filter((value) => /^\d{4}-\d{2}$/.test(value))
    .sort()
    .reverse();
}

export function chooseDefaultMonth(months, historyMonths, localMonths, timeZone) {
  const now = currentMonth(timeZone);
  const withData = months.filter(
    (month) => historyMonths[month] || localMonths[month]
  );
  return withData[0] || now;
}

function getMonth(map, month) {
  if (!map.has(month)) map.set(month, { models: new Map() });
  return map.get(month);
}

function getModel(monthEntry, provider, model) {
  const key = `${provider}\t${model}`;
  if (!monthEntry.models.has(key)) {
    monthEntry.models.set(key, {
      provider,
      model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUSD: 0,
    });
  }
  return monthEntry.models.get(key);
}

function finishMonth(entry) {
  const models = [...entry.models.values()].sort((a, b) =>
    `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)
  );
  return { models, totals: sumItems(models) };
}

export function sumItems(items) {
  const total = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUSD: 0,
  };
  for (const item of items) {
    total.requests += number(item.requests);
    total.inputTokens += number(item.inputTokens);
    total.outputTokens += number(item.outputTokens);
    total.reasoningTokens += number(item.reasoningTokens);
    total.cacheReadTokens += number(item.cacheReadTokens);
    total.cacheWriteTokens += number(item.cacheWriteTokens);
    total.totalTokens += number(item.totalTokens);
    total.costUSD += number(item.costUSD);
  }
  return total;
}

async function fetchText(url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}${text ? `：${text.slice(0, 300)}` : ''}`);
  }
  return text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows.shift();
  return rows.map((values) =>
    Object.fromEntries(header.map((name, index) => [name, values[index] ?? '']))
  );
}

function selectSessionFiles(root) {
  const groups = new Map();
  walkFiles(root, (filePath, stat) => {
    const name = path.basename(filePath);
    const match = name.match(SESSION_FILE_RE);
    if (!match) return;
    const version = match[1] === undefined ? 0 : Number(match[1]);
    const dir = path.dirname(filePath);
    const current = groups.get(dir);
    if (
      !current ||
      version > current.version ||
      (version === current.version && stat.mtimeMs > current.mtimeMs)
    ) {
      groups.set(dir, { path: filePath, version, mtimeMs: stat.mtimeMs });
    }
  });
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function walkFiles(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.dsh-purge-backup-')) continue;
      walkFiles(full, onFile);
    } else if (entry.isFile()) {
      onFile(full, fs.statSync(full));
    }
  }
}

function decodeSessionFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (!filePath.endsWith('.zstd')) return buffer.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node.js 不支持 zstdDecompressSync');
  }
  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) throw new Error('没有找到完整 zstd frame');
  return Buffer.concat(
    frames.map((frame) => zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  ).toString('utf8');
}

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;

    let complete = false;
    while (offset < buffer.length) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function number(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function sum(values) {
  return values.reduce((acc, value) => acc + number(value), 0);
}
