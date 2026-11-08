import { CrawlerSetting, DEFAULT_REVERSE, DEFAULT_WORKERS } from './config';

/** Escapes text for HTML, so a log line or a name cannot add markup. */
export const esc = (value: unknown): string =>
	String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

// Child output has ANSI colors, the page shows plain text
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

export const formatNumber = (value: number): string => value.toLocaleString('en-US');
const number = formatNumber;

/** A speed with at most one decimal. */
export const rateText = (value: number): string => number(Math.round(value * 10) / 10);

/** A pause in ms as a short text, for example "1m 05s". */
export const durationText = (ms: number): string => {
	const seconds = Math.ceil(ms / 1000);
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
};

/** A size in bytes as a short text, for example "12.4 MB". */
export const bytesText = (bytes: number): string => {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
};

/** Webshare counts a month as 30 days. */
export const HOURS_PER_MONTH = 24 * 30;

/** HTTP 429 answers per hour: a few are normal, about one a minute is a problem. */
export const WARN_429_PER_HOUR = 1;
export const BAD_429_PER_HOUR = 60;

export const level429 = (perHour: number): 'ok' | 'warn' | 'bad' =>
	perHour >= BAD_429_PER_HOUR ? 'bad' : perHour >= WARN_429_PER_HOUR ? 'warn' : 'ok';

/** The icons of the sprite in index.html. A test checks that each one is there. */
export const ICONS = [
	'overview', 'crawlers', 'proxies', 'traffic', 'insights', 'play', 'stop', 'restart', 'logs', 'more', 'edit', 'trash',
	'plus', 'upload', 'search', 'close', 'alert', 'check', 'info', 'pause', 'panel', 'chevron', 'sort',
] as const;
export type IconName = typeof ICONS[number];

/** An icon of the sprite. It is decoration, the button or link around it has the text or the aria-label. */
export const icon = (name: IconName, extra = ''): string =>
	`<svg class="icon${extra ? ` ${extra}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;

/**
 * A message that shows in the corner of the page and does not depend on the status block, so the next
 * live update cannot remove it. Errors stay until they are closed, the others go away alone.
 */
export const toast = (kind: 'error' | 'warn' | 'ok', message: string): string =>
	`<div id="toasts" hx-swap-oob="beforeend"><div class="toast toast-${kind}" role="${kind === 'error' ? 'alert' : 'status'}"`
	+ `${kind === 'error' ? '' : ' data-ttl="5000"'}><span>${esc(message)}</span>`
	+ '<button type="button" class="toast-close" aria-label="Dismiss">&times;</button></div></div>';

export type Tone = 'primary' | 'ok' | 'warn' | 'danger' | 'ghost';

export const button = (label: string, attrs: string, disabled = false, tone: Tone = 'ghost', iconName?: IconName): string =>
	`<button type="button" class="btn-${tone}" ${attrs}${disabled ? ' disabled' : ''}>${iconName ? icon(iconName) : ''}${esc(label)}</button>`;

/** A button with only an icon. The label is the tooltip and the name for screen readers. */
export const iconButton = (iconName: IconName, label: string, attrs: string, disabled = false, tone: Tone = 'ghost'): string =>
	`<button type="button" class="btn-icon btn-${tone}" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}${disabled ? ' disabled' : ''}>${icon(iconName)}</button>`;

/** The attributes of a request that shows the new status. The status is changed in place, so the page does not jump. */
export const postStatus = (path: string, confirm?: string): string =>
	`hx-post="${esc(path)}" hx-target="#status" hx-swap="morph"${confirm ? ` hx-confirm="${esc(confirm)}"` : ''}`;

/** A button that posts to the server and shows the new status. */
export const action = (path: string, label: string, disabled = false, confirm?: string, tone: Tone = 'ghost', iconName?: IconName): string =>
	button(label, postStatus(path, confirm), disabled, tone, iconName);

/** A running crawler is "failing" when at least this share of its latest URLs failed. */
export const FAILING_SHARE = 0.5;

/** True for a running crawler that fails most of its URLs now, for example because its proxy is blocked. */
export const isFailing = (crawler: { state: string; stats?: { failShare?: number; failedPerMin: number } }): boolean =>
	crawler.state === 'running' && !!crawler.stats && crawler.stats.failedPerMin > 0 && (crawler.stats.failShare ?? 0) >= FAILING_SHARE;

/** The flag of a country code as an emoji, or an empty text for a missing or bad code. */
export const flagOf = (code?: string): string =>
	code && /^[A-Za-z]{2}$/.test(code)
		? String.fromCodePoint(...[...code.toUpperCase()].map(letter => 0x1f1e6 + letter.charCodeAt(0) - 65))
		: '';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** The English name of a country code, for example "United States". The code itself when the name is not known. */
export const countryName = (code: string): string => {
	try {
		return regionNames.of(code.toUpperCase()) ?? code;
	} catch {
		return code;
	}
};

/**
 * True when a crawler needs a look: it failed, fails most of its URLs, has a proxy warning
 * or gets too many HTTP 429 answers. The "Problems" filter of the table uses it.
 */
export const hasProblem = (crawler: { state: string; stats?: { failShare?: number; failedPerMin: number; http429PerHour: number; warning?: unknown } }): boolean =>
	crawler.state === 'failed'
	|| isFailing(crawler)
	|| (crawler.state === 'running' && !!crawler.stats && crawler.stats.http429PerHour >= BAD_429_PER_HOUR)
	|| !!crawler.stats?.warning;

export const isActive = (state: string): boolean => state === 'starting' || state === 'running' || state === 'stopping';

/** A state as a small colored badge with its name. */
export const stateBadge = (state: string): string => `<span class="state state-${esc(state)}">${esc(state)}</span>`;

/** A state as a colored dot. The name is the tooltip. */
export const stateDot = (state: string): string =>
	`<span class="dot state-${esc(state)}" title="${esc(state)}" role="img" aria-label="${esc(state)}"></span>`;

/** The text of a piece of HTML without its tags, for a tooltip. */
const plainText = (html: string): string => html.replace(/<[^>]*>/g, '');

export interface KpiOptions {
	/** The time window of the number, for example "avg 5 min". It shows next to the label. */
	window?: string;
	/** What the number means. It is the tooltip of the card. */
	hint?: string;
}

/**
 * A KPI card. With a link the whole card opens that page. The sub line wraps to two lines,
 * and the tooltip has all of it, so the meaning is not cut off.
 */
export const kpi = (label: string, value: string, sub: string, tone: string, spark = '', href = '', options: KpiOptions = {}): string => {
	const window = options.window ? `<span class="kpi-window">${esc(options.window)}</span>` : '';
	const body = `<span class="kpi-label">${esc(label)}${window}</span><span class="kpi-value">${esc(value)}</span>`
		+ `<span class="kpi-sub" title="${esc(plainText(sub))}">${sub}</span>${spark}`;
	const title = options.hint ? ` title="${esc(options.hint)}"` : '';
	return href
		? `<a class="kpi kpi-${tone} kpi-link" href="${esc(href)}"${title}>${body}</a>`
		: `<div class="kpi kpi-${tone}"${title}>${body}</div>`;
};

const SPARK_W = 100;
const SPARK_H = 30;

const sparkPoints = (values: number[], max: number, height: number, width: number, min = 0): string =>
	values.map((value, i) => {
		const x = values.length > 1 ? (i / (values.length - 1)) * width : 0;
		const y = height - 1 - ((Math.max(value, min) - min) / (max - min)) * (height - 2);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	}).join(' ');

/**
 * A tiny line chart as inline SVG. It uses attributes and classes only, because the page CSP has no inline styles.
 * Without values it draws a flat line of the same size, so the cell does not change its height.
 */
export const sparkline = (values: number[] | undefined, tone: string, label: string, fit = false): string => {
	if (!values || values.length < 2) {
		return `<svg class="spark spark-${tone} spark-empty" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: no data">`
			+ `<polyline class="line" fill="none" points="0,${SPARK_H - 1} ${SPARK_W},${SPARK_H - 1}"/></svg>`;
	}
	// `fit`: the scale runs from the lowest to the highest value, so a slow change of a big number is visible.
	// Rates start at zero, so a flat line near zero is not drawn as a big change.
	const low = fit ? Math.min(...values) : 0;
	const high = fit ? Math.max(...values) : Math.max(...values, 1);
	const max = high > low ? high : low + 1;
	const points = sparkPoints(values, max, SPARK_H, SPARK_W, low);
	return `<svg class="spark spark-${tone}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
		+ `<title>${esc(label)}</title>`
		+ `<polygon class="area" points="0,${SPARK_H} ${points} ${SPARK_W},${SPARK_H}"/>`
		+ `<polyline class="line" fill="none" points="${points}"/></svg>`;
};

export interface ChartLine {
	label: string;
	tone: string;
	values: number[];
}

export interface ChartOptions {
	/** Writes a value, for example as bytes. Numbers by default. */
	format?: (value: number) => string;
	/** The text after the peak, "per minute" by default. */
	unit?: string;
}

const CHART_W = 600;
const CHART_H = 120;

/**
 * A line chart: one line for each value, a shared scale, three grid lines. Each minute has an invisible column
 * with a tooltip, so a hover shows the numbers of that minute.
 */
export const trendChart = (lines: ChartLine[], minutes: number, title = 'Requests and URLs per minute', options: ChartOptions = {}): string => {
	const format = options.format ?? number;
	const unit = options.unit ?? 'per minute';
	const max = Math.max(...lines.flatMap(line => line.values), 1);
	const grid = [0.25, 0.5, 0.75].map(part => {
		const y = (CHART_H * part).toFixed(1);
		return `<line class="grid" x1="0" y1="${y}" x2="${CHART_W}" y2="${y}"/>`;
	}).join('');
	const drawn = lines.map(line => {
		const points = sparkPoints(line.values, max, CHART_H, CHART_W);
		return `<polygon class="area chart-${line.tone}" points="0,${CHART_H} ${points} ${CHART_W},${CHART_H}"/>`
			+ `<polyline class="line chart-${line.tone}" fill="none" points="${points}"/>`;
	}).join('');
	const count = Math.max(...lines.map(line => line.values.length), 0);
	const step = count > 1 ? CHART_W / (count - 1) : CHART_W;
	const hover = Array.from({ length: count }, (_, i) => {
		const ago = count - 1 - i;
		const when = ago === 0 ? 'this minute' : `${ago} min ago`;
		const text = lines.map(line => `${line.label}: ${format(line.values[i] ?? 0)}`).join(', ');
		const x = Math.max(i * step - step / 2, 0);
		return `<rect class="hit" x="${x.toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${CHART_H}"><title>${esc(`${when}: ${text}`)}</title></rect>`;
	}).join('');
	const legend = lines.map(line =>
		`<span class="legend"><i class="swatch chart-${line.tone}"></i>${esc(line.label)}, now <b>${esc(format(line.values[line.values.length - 1] ?? 0))}</b></span>`).join('');
	return `<div class="chart-legend">${legend}<span class="meta">peak ${esc(format(max))} ${esc(unit)}</span></div>
	<div class="chart-box"><span class="chart-max meta" aria-hidden="true">${esc(format(max))}</span><span class="chart-mid meta" aria-hidden="true">${esc(format(max / 2))}</span>
	<svg class="chart" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}, last ${minutes} minutes">${grid}${drawn}${hover}</svg></div>
	<div class="chart-axis meta"><span>${minutes} min ago</span><span>now</span></div>`;
};

/**
 * Columns of one minute each, with the parts stacked: for example saved and failed URLs. The height is the sum,
 * so the chart shows where the work went, not only how much of it there was.
 */
export const stackedBars = (parts: ChartLine[], minutes: number, title: string): string => {
	const count = Math.max(...parts.map(part => part.values.length), 0);
	const totals = Array.from({ length: count }, (_, i) => parts.reduce((sum, part) => sum + (part.values[i] ?? 0), 0));
	const max = Math.max(...totals, 1);
	const slot = BARS_W / Math.max(count, 1);
	const columns = Array.from({ length: count }, (_, i) => {
		let bottom = BARS_H;
		return parts.map(part => {
			const height = ((part.values[i] ?? 0) / max) * BARS_H;
			bottom -= height;
			return height > 0 ? `<rect class="col chart-${part.tone}" x="${(i * slot + slot * 0.1).toFixed(1)}" y="${bottom.toFixed(1)}" width="${(slot * 0.8).toFixed(1)}" height="${height.toFixed(1)}"/>` : '';
		}).join('');
	}).join('');
	const hover = Array.from({ length: count }, (_, i) => {
		const ago = count - 1 - i;
		const text = parts.map(part => `${part.label}: ${number(part.values[i] ?? 0)}`).join(', ');
		return `<rect class="hit" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${BARS_H}"><title>${esc(`${ago === 0 ? 'this minute' : `${ago} min ago`}: ${text}`)}</title></rect>`;
	}).join('');
	const legend = parts.map(part =>
		`<span class="legend"><i class="swatch chart-${part.tone}"></i>${esc(part.label)}, now <b>${esc(number(part.values[part.values.length - 1] ?? 0))}</b></span>`).join('');
	return `<div class="chart-legend">${legend}<span class="meta">peak ${esc(number(max))} per minute, saved and failed stacked</span></div>
	<div class="chart-box"><span class="chart-max meta" aria-hidden="true">${esc(number(max))}</span><span class="chart-mid meta" aria-hidden="true">${esc(number(Math.round(max / 2)))}</span>
	<svg class="chart bars-stacked" viewBox="0 0 ${BARS_W} ${BARS_H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}, last ${minutes} minutes">${columns}${hover}</svg></div>
	<div class="chart-axis meta"><span>${minutes} min ago</span><span>now</span></div>`;
};

export interface MonthCount {
	/** `YYYY-MM`. */
	month: string;
	count: number;
}

/** The months from the first to the last one, each one once. A month without rows has zero, so the time scale has no gaps. */
export const fillMonths = (months: MonthCount[]): MonthCount[] => {
	if (months.length === 0) {
		return [];
	}
	const counts = new Map(months.map(entry => [entry.month, entry.count]));
	const sorted = [...counts.keys()].sort();
	const [firstYear, firstMonth] = sorted[0].split('-').map(Number);
	const [lastYear, lastMonth] = sorted[sorted.length - 1].split('-').map(Number);
	const filled: MonthCount[] = [];
	for (let index = firstYear * 12 + firstMonth - 1; index <= lastYear * 12 + lastMonth - 1; index++) {
		const month = `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
		filled.push({ month, count: counts.get(month) ?? 0 });
	}
	return filled;
};

/** A count and its share of the total: `1,234 (12.3%)`. Without a total there is no share. */
export const countWithShare = (count: number, total: number): string =>
	total > 0 ? `${number(count)} (${(Math.round((count / total) * 1000) / 10).toFixed(1)}%)` : number(count);

const BARS_W = 600;
const BARS_H = 120;
/** The most month names under the chart. More would overlap. */
const MAX_MONTH_LABELS = 6;

/**
 * A column chart of the rows per month. X is the month, Y is the count; the labels of Y also show the share of the total.
 * It is inline SVG with attributes and classes only, because the page CSP has no inline styles. Each month has an
 * invisible column with a tooltip, so a small bar can be hovered too.
 */
export const monthlyBars = (months: MonthCount[], total: number, tone: string, title: string): string => {
	const filled = fillMonths(months);
	const max = Math.max(...filled.map(entry => entry.count), 1);
	const slot = BARS_W / filled.length;
	const grid = [0.25, 0.5, 0.75].map(part => {
		const y = (BARS_H * part).toFixed(1);
		return `<line class="grid" x1="0" y1="${y}" x2="${BARS_W}" y2="${y}"/>`;
	}).join('');
	const columns = filled.map((entry, i) => {
		const height = (entry.count / max) * BARS_H;
		return `<rect class="col" x="${(i * slot + slot * 0.1).toFixed(1)}" y="${(BARS_H - height).toFixed(1)}" width="${(slot * 0.8).toFixed(1)}" height="${height.toFixed(1)}"/>`;
	}).join('');
	const hover = filled.map((entry, i) =>
		`<rect class="hit" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${BARS_H}"><title>${esc(`${entry.month}: ${countWithShare(entry.count, total)}`)}</title></rect>`).join('');
	const labelCount = Math.min(filled.length, MAX_MONTH_LABELS);
	const labels = Array.from({ length: labelCount }, (_, i) =>
		`<span>${esc(filled[labelCount === 1 ? 0 : Math.round((i / (labelCount - 1)) * (filled.length - 1))].month)}</span>`).join('');
	const ticks = [max, max / 2, 0].map(value => `<span>${esc(countWithShare(Math.round(value), total))}</span>`).join('');
	return `<div class="bars-box"><div class="bars-y meta" aria-hidden="true">${ticks}</div>
	<svg class="bars chart-${tone}" viewBox="0 0 ${BARS_W} ${BARS_H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}, ${filled.length} months from ${esc(filled[0].month)} to ${esc(filled[filled.length - 1].month)}">${grid}${columns}${hover}</svg></div>
	<div class="bars-x meta">${labels}</div>`;
};

/** Adds series of the same length, a missing one counts as zeros. */
export const sumSeries = (all: Array<number[] | undefined>, length: number): number[] => {
	const total = new Array<number>(length).fill(0);
	for (const values of all) {
		values?.forEach((value, i) => total[i] += value);
	}
	return total;
};

/** A share bar as inline SVG, 0-100. */
export const shareBar = (percent: number, tone: string, label: string): string => {
	const width = Math.min(Math.max(percent, 0), 100);
	return `<svg class="bar bar-${tone}" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
		+ `<rect class="bar-bg" width="100" height="8"/><rect class="bar-fill" width="${width.toFixed(1)}" height="8"/></svg>`;
};

/** A short text for the proxy column. It never has a user name or a password. */
/** The country of each pool proxy by its host:port key. */
export type Countries = ReadonlyMap<string, string>;

/** The flag and the name of a country code, for example "🇩🇪 Germany". Empty for no code. */
export const countryLabel = (code?: string): string => code ? `${flagOf(code)} ${countryName(code)}`.trim() : '';

/** The countries of a pool, by host:port. Entries without a country are left out. */
export const countriesOf = (pool: ReadonlyArray<{ host: string; port: number; countryCode?: string }>): Countries => {
	const countries = new Map<string, string>();
	for (const entry of pool) {
		if (entry.countryCode) {
			countries.set(`${entry.host}:${entry.port}`, entry.countryCode);
		}
	}
	return countries;
};

export const proxyText = (setting: CrawlerSetting, countries?: Countries): string => {
	const { proxy } = setting;
	switch (proxy.kind) {
		case 'none':
			return 'local IP';
		case 'url':
			try {
				return `proxy ${new URL(proxy.url).host}`;
			} catch {
				return 'proxy';
			}
		case 'webshare':
			return `webshare ${proxy.entry.host}:${proxy.entry.port}`;
		case 'webshare-list':
			return proxy.id !== undefined ? `webshare list, id ${proxy.id}` : `webshare list, #${proxy.index}`;
		case 'pool':
			return `pool ${proxy.key}${countries?.get(proxy.key) ? ` · ${countryLabel(countries.get(proxy.key))}` : ''}`;
	}
};

/** The settings of a crawler that differ from the defaults. Type and proxy are always there. */
export const settingsText = (setting: CrawlerSetting): string => {
	const parts: string[] = [setting.type];
	if (setting.reverse !== DEFAULT_REVERSE) {
		parts.push('reverse');
	}
	if (setting.workers !== DEFAULT_WORKERS) {
		parts.push(`${setting.workers} workers`);
	}
	const { minDelayMs, maxDelayMs } = setting;
	if (minDelayMs !== undefined && maxDelayMs !== undefined) {
		parts.push(`delay ${minDelayMs}-${maxDelayMs} ms`);
	} else if (minDelayMs !== undefined) {
		parts.push(`min delay ${minDelayMs} ms`);
	} else if (maxDelayMs !== undefined) {
		parts.push(`max delay ${maxDelayMs} ms`);
	}
	if (setting.idleMs !== undefined) {
		parts.push(setting.idleMs === 0 ? 'exits when no URLs' : `waits ${setting.idleMs} ms when no URLs`);
	}
	return parts.join(', ');
};

/** The link that opens the detail drawer of a crawler. */
export const detailAttrs = (name: string): string =>
	`hx-get="/fragments/crawler-detail?name=${esc(encodeURIComponent(name))}" hx-target="#detail" hx-swap="innerHTML"`;

/** The link that opens the log drawer. */
export const logsAttrs = (source: string): string =>
	`hx-get="/fragments/logs?source=${esc(encodeURIComponent(source))}" hx-target="#logs" hx-swap="innerHTML"`;
