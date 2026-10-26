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

export const formatTime = (value: string) => {
  const parsed = new Date(value);
  return `${day.format(parsed)} · ${clock.format(parsed)}`;
};

export const shortUrl = (value: string) => {
  const url = new URL(value);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
};
