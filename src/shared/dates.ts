/**
 * Dentiva Pro — date and time handling.
 *
 * The product stores instants in UTC (ISO-8601) and renders them in the clinic's configured
 * IANA time zone (default `Asia/Dhaka`). "Today", day boundaries and date-only fields such as
 * date of birth are resolved in the clinic time zone, never in the machine's local zone and
 * never implicitly in UTC — otherwise an appointment booked at 23:30 Dhaka time would appear
 * on the wrong day for any machine not set to Dhaka.
 *
 * No third-party date library is used: the behaviour below is implemented directly so it is
 * identical in the UI, in PDF output and on every Windows machine.
 */

export const DEFAULT_TIME_ZONE = 'Asia/Dhaka';
export const DEFAULT_DATE_FORMAT = 'DD/MM/YYYY';

export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

const PART_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partFormatter(timeZone: string): Intl.DateTimeFormat {
  const key = timeZone;
  let cached = PART_FORMATTER_CACHE.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATTER_CACHE.set(key, cached);
  }
  return cached;
}

/** True when the IANA time zone identifier is usable by the runtime. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Decompose an instant into calendar parts in the given time zone. */
export function partsInTimeZone(instant: Date | string | number, timeZone: string): DateParts {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date value: ${String(instant)}`);
  const parts = partFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset (in minutes east of UTC) of `timeZone` at the given instant. */
export function offsetMinutesAt(instant: Date | string | number, timeZone: string): number {
  const date = instant instanceof Date ? instant : new Date(instant);
  const p = partsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Calendar date key `YYYY-MM-DD` for an instant in the clinic time zone. */
export function dateKey(instant: Date | string | number, timeZone: string): string {
  const p = partsInTimeZone(instant, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Today's calendar date key in the clinic time zone. */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return dateKey(now, timeZone);
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match as unknown as [string, string, string, string];
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/**
 * The instant of 00:00:00 local wall-clock time on `key` in `timeZone`.
 * Resolved iteratively so it stays correct across a DST transition.
 */
export function startOfDayUtc(key: string, timeZone: string): Date {
  if (!isDateKey(key)) throw new Error(`Invalid date key: ${key}`);
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMinutesAt(guess, timeZone);
    const candidate = Date.UTC(y, m - 1, d, 0, 0, 0) - offset * 60_000;
    if (candidate === guess) break;
    guess = candidate;
  }
  return new Date(guess);
}

/** The instant of 23:59:59.999 local wall-clock time on `key` in `timeZone`. */
export function endOfDayUtc(key: string, timeZone: string): Date {
  return new Date(startOfDayUtc(key, timeZone).getTime() + 86_399_999);
}

/** Half-open [start, end) UTC range covering `key` in `timeZone`. Use with `>= start AND < end`. */
export function dayRangeUtc(key: string, timeZone: string): { start: Date; end: Date } {
  const start = startOfDayUtc(key, timeZone);
  const next = new Date(start.getTime() + 86_400_000);
  return { start, end: next };
}

export function shiftDateKey(key: string, days: number): string {
  if (!isDateKey(key)) throw new Error(`Invalid date key: ${key}`);
  if (!Number.isSafeInteger(days)) throw new Error('Day shift must be a whole number');
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return dateKey(shifted, 'UTC');
}

export function dateKeyToIso(key: string): string {
  if (!isDateKey(key)) throw new Error(`Invalid date key: ${key}`);
  return `${key}T00:00:00.000Z`;
}

/** Format an instant for display in the clinic time zone. */
export function formatDate(instant: Date | string | number, timeZone: string, format: DateFormat = DEFAULT_DATE_FORMAT): string {
  const p = partsInTimeZone(instant, timeZone);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  const yyyy = String(p.year).padStart(4, '0');
  switch (format) {
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`;
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`;
    case 'DD/MM/YYYY':
    default:
      return `${dd}/${mm}/${yyyy}`;
  }
}

export function formatTime(instant: Date | string | number, timeZone: string): string {
  const p = partsInTimeZone(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function formatDateTime(instant: Date | string | number, timeZone: string, format: DateFormat = DEFAULT_DATE_FORMAT): string {
  return `${formatDate(instant, timeZone, format)} ${formatTime(instant, timeZone)}`;
}

/** Format a date-only value stored as `YYYY-MM-DD` without any time-zone shifting. */
export function formatDateOnly(key: string, format: DateFormat = DEFAULT_DATE_FORMAT): string {
  if (!isDateKey(key)) return '';
  return formatDate(`${key}T12:00:00.000Z`, 'UTC', format);
}

/** Whole years between a date-of-birth key and a reference date key. */
export function ageInYears(dobKey: string, asOfKey: string): number | null {
  if (!isDateKey(dobKey) || !isDateKey(asOfKey)) return null;
  const [by, bm, bd] = dobKey.split('-').map(Number) as [number, number, number];
  const [ay, am, ad] = asOfKey.split('-').map(Number) as [number, number, number];
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age >= 0 ? age : null;
}

export interface AgeLabel {
  years: number;
  months: number;
  text: string;
}

/** Clinical age label: "34 years" for adults, "8 months" for infants. */
export function ageLabel(dobKey: string, asOfKey: string): AgeLabel | null {
  if (!isDateKey(dobKey) || !isDateKey(asOfKey)) return null;
  const [by, bm] = dobKey.split('-').map(Number) as [number, number];
  const [ay, am, ad] = asOfKey.split('-').map(Number) as [number, number, number];
  const years = ageInYears(dobKey, asOfKey);
  if (years === null) return null;
  if (years >= 2) return { years, months: 0, text: `${years} years` };
  const totalMonths = (ay - by) * 12 + (am - bm) - (ad < Number(dobKey.split('-')[2]) ? 1 : 0);
  const months = Math.max(0, totalMonths);
  if (months >= 24) return { years, months: 0, text: `${years} years` };
  if (months >= 1) return { years: 0, months, text: `${months} month${months === 1 ? '' : 's'}` };
  return { years: 0, months: 0, text: 'Under 1 month' };
}

/** Parse `HH:MM` (24-hour) into minutes since midnight, or null when invalid. */
export function parseTimeOfDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const [, h, m] = match as unknown as [string, string, string];
  return Number(h) * 60 + Number(m);
}

/** Render minutes-since-midnight as `HH:MM`. */
export function minutesToTimeOfDay(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1439) {
    throw new Error(`Minutes since midnight out of range: ${minutes}`);
  }
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** ISO instant for a date key plus `HH:MM` wall-clock time in the clinic time zone. */
export function combineDateAndTime(key: string, time: string, timeZone: string): Date {
  const minutes = parseTimeOfDay(time);
  if (minutes === null) throw new Error(`Invalid time of day: ${time}`);
  const start = startOfDayUtc(key, timeZone);
  return new Date(start.getTime() + minutes * 60_000);
}

/** ISO-8601 UTC string for storage. */
export function toIso(instant: Date | string | number): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date value: ${String(instant)}`);
  return date.toISOString();
}

/** Weekday name (short) for an instant in the clinic time zone. */
const WEEKDAY_CACHE = new Map<string, Intl.DateTimeFormat>();
export function weekdayShort(instant: Date | string | number, timeZone: string): string {
  let fmt = WEEKDAY_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
    WEEKDAY_CACHE.set(timeZone, fmt);
  }
  const date = instant instanceof Date ? instant : new Date(instant);
  return fmt.format(date);
}

/** Month name (short) for an instant in the clinic time zone. */
const MONTH_CACHE = new Map<string, Intl.DateTimeFormat>();
export function monthShort(instant: Date | string | number, timeZone: string): string {
  let fmt = MONTH_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short' });
    MONTH_CACHE.set(timeZone, fmt);
  }
  const date = instant instanceof Date ? instant : new Date(instant);
  return fmt.format(date);
}

/** Monday-based week start key for a date key. */
export function weekStartKey(key: string): string {
  if (!isDateKey(key)) throw new Error(`Invalid date key: ${key}`);
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  return shiftDateKey(key, -dow);
}

/** First day of the month for a date key. */
export function monthStartKey(key: string): string {
  if (!isDateKey(key)) throw new Error(`Invalid date key: ${key}`);
  return `${key.slice(0, 7)}-01`;
}

/** Compare two date keys chronologically. */
export function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
