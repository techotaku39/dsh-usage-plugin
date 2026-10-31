import fs from 'node:fs';
import path from 'node:path';
import {
  chooseDefaultMonth,
  collectAccountUsage,
  collectLocalUsage,
  collectOpenCodeRequestLog,
  currentMonth,
  findDshOpenCodeSessionId,
  listMonths,
  previousMonth,
  resolveDshHome,
  resolveTimeZone,
} from './lib/usage-data.js';

export const name = 'dsh-usage-plugin';
export const inject = ['webServer'];

const ROUTE_MONTHS = '/plugins/dsh-usage/api/months';
const ROUTE_SUMMARY = '/plugins/dsh-usage/api/summary';

export function apply(ctx, config = {}) {
  const dshHome = resolveDshHome();
  const timeZone = resolveTimeZone(config);
  const dataDir =
    process.env.DSH_USAGE_PLUGIN_DATA_DIR ||
    config.dataDir ||
    path.join(dshHome, 'usage-plugin');
  const historyPath = path.join(dataDir, 'history.json');
  const sessionId = config.sessionId || findDshOpenCodeSessionId(dshHome);
  const refreshHours = clamp(Number(config.refreshHours || 6), 1, 24);

  fs.mkdirSync(dataDir, { recursive: true });
  let history = loadHistory(historyPath);
  let localCache = null;
  let localCacheAt = 0;
  let refreshPromise = null;

  const errors = [];
  const rememberError = (message) => {
    errors.push({ at: new Date().toISOString(), message });
    while (errors.length > 20) errors.shift();
    console.error(`[dsh-usage] ${message}`);
  };

  async function refreshLocal(force = false) {
    if (!force && localCache && Date.now() - localCacheAt < 60_000) return localCache;
    const result = collectLocalUsage({ dshHome, timeZone });
    localCache = result;
    localCacheAt = Date.now();
    for (const [month, value] of Object.entries(result.months)) {
      const entry = history.months[month] || {};
      history.months[month] = {
        ...entry,
        local: value,
        updatedAt: new Date().toISOString(),
      };
    }
    saveHistory(historyPath, history);
    return result;
  }

  async function refreshMonth(month, { includeAccount = true } = {}) {
    const entry = history.months[month] || {};
    const patch = { updatedAt: new Date().toISOString() };

    if (!entry.local) {
      try {
        const local = await collectLocalUsage({ dshHome, timeZone, month });
        patch.local = local.months[month] || emptySummary();
      } catch (error) {
        rememberError(`本地日志读取失败：${error.message}`);
      }
    }

    if (sessionId) {
      try {
        patch.opencode = await collectOpenCodeRequestLog({
          dshHome,
          timeZone,
          month,
          sessionId,
        });
      } catch (error) {
        rememberError(`OpenCode 请求日志读取失败：${error.message}`);
      }
    }

    if (includeAccount) {
      try {
        patch.account = await collectAccountUsage({ dshHome, month });
      } catch (error) {
        rememberError(`OpenCode 账号用量读取失败：${error.message}`);
      }
    }

    history.months[month] = { ...entry, ...patch };
    saveHistory(historyPath, history);
    return history.months[month];
  }

  async function refreshRecent(force = false) {
    await refreshLocal(force);
    const now = currentMonth(timeZone);
    const prev = previousMonth(now);
    await Promise.all([
      refreshMonth(now, { includeAccount: true }).catch((error) => rememberError(error.message)),
      refreshMonth(prev, { includeAccount: true }).catch((error) => rememberError(error.message)),
    ]);
  }

  async function ensureRefresh(force = false) {
    if (!refreshPromise) {
      refreshPromise = refreshRecent(force).finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  function summaryFor(month) {
    const entry = history.months[month] || {};
    return {
      month,
      timeZone,
      sessionId: sessionId || null,
      generatedAt: new Date().toISOString(),
      local: entry.local || null,
      opencode: entry.opencode || null,
      account: entry.account || null,
      errors: errors.slice(),
    };
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE_MONTHS,
        handler: async (req, res) => {
          if (!allowRequest(req, res)) return;
          try {
            await ensureRefresh(false);
            const local = localCache?.months || {};
            const months = listMonths(local, history.months, timeZone);
            const defaultMonth = chooseDefaultMonth(
              months,
              history.months,
              local,
              timeZone
            );
            writeJson(res, 200, {
              months,
              defaultMonth,
              timeZone,
              sessionId: sessionId || null,
            });
          } catch (error) {
            writeJson(res, 500, { error: error.message });
          }
        },
      });
      return dispose;
    }, 'dsh-usage: months route');

    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE_SUMMARY,
        handler: async (req, res) => {
          if (!allowRequest(req, res)) return;
          try {
            const url = new URL(req.url || '/', 'http://localhost');
            const month = url.searchParams.get('month') || currentMonth(timeZone);
            if (!/^\d{4}-\d{2}$/.test(month)) {
              writeJson(res, 400, { error: 'month 必须是 YYYY-MM' });
              return;
            }
            await ensureRefresh(false);
            const entry = history.months[month];
            if (!entry || (!entry.local && !entry.opencode && !entry.account)) {
              await refreshMonth(month, { includeAccount: true });
            }
            writeJson(res, 200, summaryFor(month));
          } catch (error) {
            writeJson(res, 500, { error: error.message });
          }
        },
      });
      return dispose;
    }, 'dsh-usage: summary route');

    webCtx.effect(() => {
      const timer = setInterval(() => {
        ensureRefresh(true).catch((error) => rememberError(error.message));
      }, refreshHours * 60 * 60 * 1000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'dsh-usage: refresh timer');
  });

  Promise.resolve()
    .then(() => ensureRefresh(false))
    .catch((error) => rememberError(error.message));
}

function allowRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== req.headers.host) {
        writeJson(res, 403, { error: 'Cross-origin request rejected' });
        return false;
      }
    } catch {
      writeJson(res, 403, { error: 'Invalid origin' });
      return false;
    }
  }
  return true;
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function loadHistory(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.months) {
      return { version: 1, months: {}, ...parsed };
    }
  } catch {
    // 首次运行或文件损坏时从空历史开始。
  }
  return { version: 1, months: {}, updatedAt: null };
}

function saveHistory(filePath, history) {
  history.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8');
}

function emptySummary() {
  return {
    models: [],
    totals: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUSD: 0,
    },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
