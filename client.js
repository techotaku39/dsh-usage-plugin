window.__ModuleLoader__.load({
  id: '@techotaku39/dsh-usage-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;

    const API_MONTHS = '/plugins/dsh-usage/api/months';
    const API_SUMMARY = '/plugins/dsh-usage/api/summary';

    function UsageIcon({ size = 18, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.86 },
        },
        h('path', {
          d: 'M4 19V5M4 19H20M7 16V11M11 16V7M15 16V13M19 16V9',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      );
    }

    function UsagePanel() {
      const [months, setMonths] = useState([]);
      const [month, setMonth] = useState('');
      const [summary, setSummary] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [refreshNonce, setRefreshNonce] = useState(0);

      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchJson(API_MONTHS)
          .then((data) => {
            if (cancelled) return;
            const nextMonths = Array.isArray(data.months) ? data.months : [];
            setMonths(nextMonths);
            setMonth((current) => current || data.defaultMonth || nextMonths[0] || '');
          })
          .catch((err) => {
            if (!cancelled) setError(err.message);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, []);

      useEffect(() => {
        if (!month) return;
        let cancelled = false;
        setLoading(true);
        setError('');
        fetchJson(`${API_SUMMARY}?month=${encodeURIComponent(month)}`)
          .then((data) => {
            if (!cancelled) setSummary(data);
          })
          .catch((err) => {
            if (!cancelled) setError(err.message);
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [month, refreshNonce]);

      const modelRows = useMemo(() => {
        if (!summary) return [];
        if (summary.opencode?.models?.length) return summary.opencode.models;
        return summary.local?.models || [];
      }, [summary]);

      const opencode = summary?.opencode?.totals || null;
      const local = summary?.local?.totals || null;
      const account = summary?.account?.totals || null;
      const goPeriod = summary?.account?.goPeriod || null;
      const accountHasData = Boolean(account && (account.requests > 0 || account.totalTokens > 0));
      const isCurrentMonth = summary?.month === currentMonthKey(summary?.timeZone);
      const hasAnyData = Boolean(opencode || local || account);

      function exportJson() {
        if (!summary) return;
        const blob = new Blob([JSON.stringify(summary, null, 2)], {
          type: 'application/json;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `dsh-usage-${month}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
      }

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.inner },
          h(
            'header',
            { style: styles.header },
            h(
              'div',
              null,
              h('div', { style: styles.eyebrow }, 'DSH · OPENCODE GO'),
              h('h1', { style: styles.title }, '用量与额度'),
              h(
                'p',
                { style: styles.subtitle },
                '按月查看 DSH 自己的 Token、OpenCode Go 额度，以及账号总用量。'
              )
            ),
            h(
              'div',
              { style: styles.controls },
              h(
                'select',
                {
                  value: month,
                  onChange: (event) => setMonth(event.target.value),
                  style: styles.select,
                  'aria-label': '选择月份',
                },
                months.map((value) => h('option', { key: value, value }, formatMonth(value)))
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setRefreshNonce((value) => value + 1),
                  style: styles.button,
                  disabled: loading,
                },
                loading ? '刷新中…' : '刷新'
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: exportJson,
                  style: styles.buttonSecondary,
                  disabled: !summary,
                },
                '导出 JSON'
              )
            )
          ),

          error ? h('div', { style: styles.error }, error) : null,

          h(
            'div',
            { style: styles.cardGrid },
            h(MetricCard, {
              title: 'DSH · OpenCode Go',
              hint: '按 x-opencode-session 精确过滤',
              value: opencode ? formatCompact(opencode.totalTokens) : '—',
              unit: 'tokens',
              meta: opencode
                ? `${formatInt(opencode.requests)} 次请求 · ${formatUSD(opencode.costUSD)} 额度`
                : '该月请求日志已过期或暂无数据',
              accent: true,
            }),
            h(MetricCard, {
              title: 'DSH · 全部渠道',
              hint: '来自本机持久会话日志',
              value: local ? formatCompact(local.totalTokens) : '—',
              unit: 'tokens',
              meta: local
                ? `${formatInt(local.requests)} 次响应 · ${formatInt(local.outputTokens)} output`
                : '该月暂无本地用量',
            }),
            h(MetricCard, {
              title: 'OpenCode 账号总览',
              hint: '包含同一账号下其他客户端',
              value: accountHasData
                ? formatCompact(account.totalTokens)
                : isCurrentMonth && goPeriod
                  ? formatCompact(goPeriod.tokens)
                  : '—',
              unit: 'tokens',
              meta: accountHasData
                ? `${formatInt(account.requests)} 次请求 · ${formatUSD(account.costUSD)} 额度`
                : isCurrentMonth && goPeriod
                  ? `当前 Go 周期 · ${formatInt(goPeriod.requests)} 次请求 · ${formatUSD(goPeriod.allowanceEquivalentUSD)}`
                  : '账号数据暂不可用',
            })
          ),

          h(
            'section',
            { style: styles.section },
            h(
              'div',
              { style: styles.sectionHeader },
              h('h2', { style: styles.sectionTitle }, '模型明细'),
              h(
                'span',
                { style: styles.badge },
                summary?.opencode?.models?.length ? 'OpenCode 精确口径' : 'DSH 本地口径'
              )
            ),
            !hasAnyData
              ? h('div', { style: styles.empty }, '该月还没有可展示的用量数据。')
              : h(ModelTable, { rows: modelRows, exact: Boolean(summary?.opencode?.models?.length) })
          ),

          h(
            'section',
            { style: styles.section },
            h('h2', { style: styles.sectionTitle }, '数据说明'),
            h(
              'div',
              { style: styles.notes },
              h('div', null, `月份：${formatMonth(month)} · 时区：${summary?.timeZone || '—'}`),
              h('div', null, `x-opencode-session：${summary?.sessionId || '未配置'}`),
              h('div', null, `生成时间：${summary?.generatedAt ? formatDateTime(summary.generatedAt) : '—'}`),
              h(
                'div',
                null,
                'DSH · OpenCode Go 的金额是 Go 额度等价成本，不是额外现金账单；Go 套餐内实际按订阅计费。'
              ),
              h(
                'div',
                null,
                '请求日志保留约 30 天；插件会把每月结果写入本地 history.json，过期后仍可查看已归档月份。'
              ),
              summary?.errors?.length
                ? h('div', { style: styles.noteError }, `最近错误：${summary.errors.at(-1).message}`)
                : null
            )
          )
        )
      );
    }

    function MetricCard({ title, hint, value, unit, meta, accent = false }) {
      return h(
        'div',
        { style: { ...styles.card, ...(accent ? styles.cardAccent : {}) } },
        h('div', { style: styles.cardTitle }, title),
        h('div', { style: styles.cardHint }, hint),
        h(
          'div',
          { style: styles.metricRow },
          h('span', { style: styles.metric }, value),
          h('span', { style: styles.metricUnit }, unit)
        ),
        h('div', { style: styles.cardMeta }, meta)
      );
    }

    function ModelTable({ rows, exact }) {
      return h(
        'div',
        { style: styles.tableWrap },
        h(
          'table',
          { style: styles.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['Provider', 'Model', 'Requests', 'Input', 'Output', 'Cache Read', exact ? 'Cost / Allowance' : 'Total'].map(
                (label) => h('th', { key: label, style: styles.th }, label)
              )
            )
          ),
          h(
            'tbody',
            null,
            rows.map((row) =>
              h(
                'tr',
                { key: `${row.provider}/${row.model}` },
                h('td', { style: styles.td }, row.provider),
                h('td', { style: { ...styles.td, ...styles.mono } }, row.model),
                h('td', { style: styles.tdNum }, formatInt(row.requests)),
                h('td', { style: styles.tdNum }, formatInt(row.inputTokens)),
                h('td', { style: styles.tdNum }, formatInt(row.outputTokens)),
                h('td', { style: styles.tdNum }, formatInt(row.cacheReadTokens)),
                exact
                  ? h('td', { style: styles.tdNum }, formatUSD(row.costUSD))
                  : h('td', { style: styles.tdNum }, formatInt(row.totalTokens))
              )
            )
          )
        )
      );
    }

    async function fetchJson(url) {
      const response = await fetch(url, { credentials: 'same-origin' });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`接口返回非 JSON：${text.slice(0, 200)}`);
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    }

    function currentMonthKey(timeZone) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || undefined,
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(new Date());
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}`;
    }

    function formatMonth(value) {
      if (!/^\d{4}-\d{2}$/.test(value || '')) return value || '—';
      const [year, month] = value.split('-');
      return `${year} 年 ${Number(month)} 月`;
    }

    function formatInt(value) {
      return Math.round(Number(value) || 0).toLocaleString('en-US');
    }

    function formatCompact(value) {
      const number = Number(value) || 0;
      if (number < 10000) return formatInt(number);
      return new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(number);
    }

    function formatUSD(value) {
      return `$${(Number(value) || 0).toFixed(6)}`;
    }

    function formatDateTime(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    const styles = {
      root: {
        height: '100%',
        overflow: 'auto',
        background: 'var(--dsw-alias-bg-base, #fff)',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)',
      },
      inner: { maxWidth: 1180, margin: '0 auto', padding: '30px 32px 56px' },
      header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 20,
        flexWrap: 'wrap',
      },
      eyebrow: {
        fontSize: 11,
        letterSpacing: '0.14em',
        fontWeight: 700,
        color: 'var(--dsw-alias-brand-primary, #247bbf)',
        marginBottom: 8,
      },
      title: {
        margin: 0,
        fontSize: 28,
        lineHeight: 1.15,
        letterSpacing: '-0.03em',
        fontWeight: 680,
      },
      subtitle: {
        margin: '8px 0 0',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--dsw-alias-label-secondary, #666)',
      },
      controls: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      select: {
        height: 36,
        padding: '0 32px 0 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontFamily: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      button: {
        height: 36,
        padding: '0 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-brand-primary, #247bbf)',
        background: 'var(--dsw-alias-brand-primary, #247bbf)',
        color: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      buttonSecondary: {
        height: 36,
        padding: '0 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontFamily: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      error: {
        marginTop: 18,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-state-error-secondary, #e8b4b4)',
        background: 'var(--dsw-alias-state-error-tertiary, #fff3f3)',
        color: 'var(--dsw-alias-state-error-primary, #b42318)',
        fontSize: 13,
      },
      cardGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 12,
        marginTop: 24,
      },
      card: {
        minHeight: 142,
        padding: '18px 18px 16px',
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
        boxSizing: 'border-box',
      },
      cardAccent: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 40%, var(--dsw-alias-border-l1, #e5e5e5))',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #247bbf) 5%, var(--dsw-alias-bg-layer-1, #f7f7f7))',
      },
      cardTitle: { fontSize: 14, fontWeight: 650 },
      cardHint: {
        marginTop: 4,
        fontSize: 11,
        color: 'var(--dsw-alias-label-tertiary, #888)',
      },
      metricRow: { display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 18 },
      metric: {
        fontSize: 30,
        lineHeight: 1,
        fontWeight: 680,
        letterSpacing: '-0.035em',
        fontVariantNumeric: 'tabular-nums',
      },
      metricUnit: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)' },
      cardMeta: {
        marginTop: 14,
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary, #666)',
      },
      section: { marginTop: 28 },
      sectionHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 10,
      },
      sectionTitle: { margin: 0, fontSize: 15, fontWeight: 650 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 8px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2, #efefef)',
        color: 'var(--dsw-alias-label-secondary, #666)',
        fontSize: 11,
      },
      tableWrap: {
        overflow: 'auto',
        border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        borderRadius: 14,
        background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
      },
      table: { width: '100%', borderCollapse: 'collapse', minWidth: 760 },
      th: {
        padding: '10px 12px',
        textAlign: 'left',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-tertiary, #888)',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '11px 12px',
        fontSize: 12,
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
      },
      tdNum: {
        padding: '11px 12px',
        fontSize: 12,
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
      },
      mono: { fontFamily: 'var(--dsw-font-family-code, ui-monospace, monospace)' },
      empty: {
        padding: '28px 18px',
        borderRadius: 14,
        border: '1px dashed var(--dsw-alias-border-l1, #e5e5e5)',
        color: 'var(--dsw-alias-label-tertiary, #888)',
        fontSize: 13,
        textAlign: 'center',
      },
      notes: {
        display: 'grid',
        gap: 7,
        padding: '14px 16px',
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)',
        background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
        color: 'var(--dsw-alias-label-secondary, #666)',
        fontSize: 12,
        lineHeight: 1.6,
      },
      noteError: { color: 'var(--dsw-alias-state-error-primary, #b42318)' },
    };

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'dsh-usage',
              order: 90,
              label: '用量',
            },
            UsageIcon
          )
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-usage' }, UsagePanel)
        );
      },
    };
  },
});

