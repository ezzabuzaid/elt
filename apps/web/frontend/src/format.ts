const time = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const formatTime = (value: string) => time.format(new Date(value));

export const shortUrl = (value: string) => {
  const url = new URL(value);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
};
