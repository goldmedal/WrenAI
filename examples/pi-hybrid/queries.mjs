// Closed, host-owned query plans for this reviewed synthetic fixture only.
export const COUNT_SQL = 'SELECT COUNT(*) AS value FROM orders';
export const MAX_WEEKS = 53;
const WEEK_MS = 7 * 86400000;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export function monday(value) {
  if (typeof value !== 'string' || !/^(20\d{2})-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
}
export function queryPlan(args) {
  if (exact(args, ['metric']) && args.metric === 'order_count') {
    return { kind: 'count', sql: COUNT_SQL, filters: [], limit: 1 };
  }
  if (!args || args.metric !== 'weekly_order_count') throw new Error('query_unavailable');
  let filter;
  if (exact(args, ['metric', 'start_week', 'end_week'])) {
    if (!monday(args.start_week) || !monday(args.end_week)) throw new Error('query_unavailable');
    const weeks = (Date.parse(args.end_week) - Date.parse(args.start_week)) / WEEK_MS;
    if (weeks < 1 || weeks > MAX_WEEKS) throw new Error('query_unavailable');
    // Only validated calendar dates reach these literals; no caller-supplied SQL.
    filter = `order_date >= CAST('${args.start_week}' AS DATE) AND order_date < CAST('${args.end_week}' AS DATE)`;
  } else if (!exact(args, ['metric'])) throw new Error('query_unavailable');
  return { kind: 'weekly',
    sql: `SELECT CAST(CAST(DATE_TRUNC('week', order_date) AS DATE) AS VARCHAR) AS week_start, COUNT(*) AS order_count FROM orders${filter ? ' WHERE ' + filter : ''} GROUP BY 1 ORDER BY 1`,
    filters: filter ? [filter] : [], limit: MAX_WEEKS + 1,
    period: filter ? { start_week: args.start_week, end_week: args.end_week } : null };
}
export const metricParameters = {
  type: 'object', properties: {
    metric: { type: 'string', enum: ['order_count', 'weekly_order_count'] },
    start_week: { type: 'string', description: 'Optional inclusive Monday YYYY-MM-DD in UTC; requires end_week.' },
    end_week: { type: 'string', description: 'Optional exclusive Monday YYYY-MM-DD in UTC; maximum 53 weeks.' },
  }, required: ['metric'], additionalProperties: false,
};
const count = n => Number.isSafeInteger(n) && n >= 3 && n <= 10000;
export function validWeekly(value) {
  if (!exact(value, ['kind', 'timezone', 'week_starts_on', 'period', 'rows']) || value.kind !== 'weekly_orders'
    || value.timezone !== 'UTC' || value.week_starts_on !== 'Monday' || !Array.isArray(value.rows) || value.rows.length > MAX_WEEKS) return false;
  if (value.period !== null) {
    if (!exact(value.period, ['start_week', 'end_week'])) return false;
    try { queryPlan({ metric: 'weekly_order_count', ...value.period }); } catch { return false; }
  }
  let previous, total = 0;
  for (const row of value.rows) {
    if (!exact(row, ['week_start', 'order_count']) || !monday(row.week_start) || !count(row.order_count)
      || previous && row.week_start <= previous
      || value.period && (row.week_start < value.period.start_week || row.week_start >= value.period.end_week)) return false;
    previous = row.week_start; total += row.order_count;
  }
  return total <= 10000 && (value.rows.length < 2
    || (Date.parse(value.rows.at(-1).week_start) - Date.parse(value.rows[0].week_start)) / WEEK_MS < MAX_WEEKS);
}
export function projectResult(result, plan) {
  if (!exact(result, ['columns', 'rows', 'definition']) || !Array.isArray(result.rows)) throw new Error('query_unavailable');
  if (plan.kind === 'count') {
    if (JSON.stringify(result.columns) !== '["value"]' || result.rows.length !== 1
      || !exact(result.rows[0], ['value']) || !count(result.rows[0].value)) throw new Error('query_unavailable');
    return { value: result.rows[0].value };
  }
  const value = { kind: 'weekly_orders', timezone: 'UTC', week_starts_on: 'Monday', period: plan.period, rows: result.rows };
  if (JSON.stringify(result.columns) !== '["week_start","order_count"]' || !validWeekly(value)) throw new Error('query_unavailable');
  return structuredClone(value);
}
