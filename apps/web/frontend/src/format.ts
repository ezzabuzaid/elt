const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const day = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

// The source keeps publication metadata as supplied, so it may not parse.
export const formatDate = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : date.format(parsed);
};

export const formatTime = (value: string | number) => {
  const parsed = new Date(value);
  return `${day.format(parsed)} · ${clock.format(parsed)}`;
};

export const shortUrl = (value: string) => {
  const url = new URL(value);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
};

export const formatClock = (epoch: number) => clock.format(epoch);

const count = new Intl.NumberFormat();
export const formatCount = (value: number) => count.format(value);

const seconds = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'second',
  unitDisplay: 'narrow',
  maximumFractionDigits: 2,
});
export const formatMilliseconds = (value: number) =>
  seconds.format(value / 1000);

const digital = new Intl.DurationFormat(undefined, {
  style: 'digital',
  hoursDisplay: 'auto',
});
export const formatElapsed = (milliseconds: number) => {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return digital.format({
    hours: Math.floor(total / 3600),
    minutes: Math.floor(total / 60) % 60,
    seconds: total % 60,
  });
};
