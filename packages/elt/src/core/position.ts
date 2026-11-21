// A commit that a reader can read as of, as `${epoch}:${number}` names it:
// the last commit of a closed load when no other load has commits before and
// after it, so a reader there sees no part of a pass.
export type Position = { readonly epoch: string; readonly number: number };

// The store that numbers the commits of a destination, as its reasons name
// it: an engine, such as SQLite, and a noun, such as file.
export type NumberedStore = { readonly engine: string; readonly noun: string };

// The first and the last commit of one load; last is null while the load is
// open.
type LoadSpan = { readonly first: number; readonly last: number | null };

// What set min_valid last: the retention, a change of the type of a column
// that is not a widening, or a clear that forgot the rows of its table.
type ExpiredBy = 'retention' | 'type' | 'clear';

// The numbering of a store, as one snapshot reads it.
export type Numbering = {
  // Names the numbering: a store made again numbers its commits again.
  readonly epoch: string;
  // The oldest position that a reading reads exactly, as SQL Server's
  // MIN_VALID_VERSION, and what set it last.
  readonly minValid: number;
  readonly expiredBy: ExpiredBy | null;
  // The high-water mark: each number at or below it is a commit that the
  // snapshot sees, or one that rolled back.
  readonly settled: number;
  // The positions from minValid to settled, ascending.
  readonly ends: readonly number[];
};

// The numbering of a snapshot, with its positions found by a sweep line over
// the loads in order of their first commits: an end is a position when no
// load that began at or before it ends after it. An open load has no end yet,
// so it reaches past every later commit.
export function numbering({
  spans,
  ...snapshot
}: Omit<Numbering, 'ends'> & {
  readonly spans: readonly LoadSpan[];
}): Numbering {
  const reaching = spans
    .map(({ first, last }) => ({ first, last: last ?? Infinity }))
    .toSorted((left, right) => left.first - right.first);
  const ends: number[] = [];
  const pending = reaching.values();
  let span = pending.next();
  let reach = 0;
  for (const end of reaching
    .map(({ last }) => last)
    .filter((last) => last <= snapshot.settled)
    .toSorted((left, right) => left - right)) {
    for (; !span.done && span.value.first <= end; span = pending.next())
      reach = Math.max(reach, span.value.last);
    if (reach === end && end >= snapshot.minValid) ends.push(end);
  }
  return { ...snapshot, ends };
}

export function parsePosition(
  position: string,
  store: NumberedStore,
): Position {
  const groups = /^(?<epoch>[^:]+):(?<number>0|[1-9]\d*)$/.exec(
    position,
  )?.groups;
  if (groups?.epoch === undefined || groups.number === undefined)
    throw new TypeError(
      `${position} is not a position of a ${store.engine} ${store.noun}`,
    );
  return { epoch: groups.epoch, number: Number(groups.number) };
}

// Why a position is not one that the store reads exactly, or undefined when
// it is.
function expiry(
  numbered: Numbering,
  position: Position,
  store: NumberedStore,
): string | undefined {
  if (position.epoch === numbered.epoch && position.number > numbered.settled)
    return `Position ${position.epoch}:${position.number} is past the newest commit of this ${store.noun}, ${numbered.settled}`;
  return staleness(numbered, position, store);
}

// Why a position that the store once had is no longer read exactly: the
// store numbered its commits again, or its history keeps no row from before
// min_valid. A reader that knows only the epoch and min_valid, such as a
// guard inside a view, asks this.
export function staleness(
  kept: Pick<Numbering, 'epoch' | 'minValid' | 'expiredBy'>,
  { epoch, number }: Position,
  store: NumberedStore,
): string | undefined {
  const named = `${epoch}:${number}`;
  if (epoch !== kept.epoch)
    return `Position ${named} is of an earlier numbering: the commits of this ${store.noun} were numbered again since`;
  if (number >= kept.minValid) return undefined;
  switch (kept.expiredBy) {
    case 'type':
      return `Position ${named} is before commit ${kept.minValid}, which changed the type of a column to one that does not hold each earlier value: the history keeps no row that only a reading before that commit reads`;
    case 'clear':
      return `Position ${named} is before commit ${kept.minValid}, a clear that forgot the rows of its table: the history keeps no row that only a reading before it reads`;
    default:
      return `Position ${named} is older than the retention of this ${store.noun}: its history keeps no row that only a reading before commit ${kept.minValid} reads`;
  }
}

// The positions after since, ascending, or each one when since is undefined.
export function positionsAfter(
  numbered: Numbering | null,
  since: Position | undefined,
  store: NumberedStore,
): readonly string[] | { readonly expired: string } {
  if (numbered === null)
    return since === undefined ? [] : { expired: unnumbered(since, store) };
  if (since === undefined)
    return numbered.ends.map((end) => `${numbered.epoch}:${end}`);
  const expired = expiry(numbered, since, store);
  if (expired !== undefined) return { expired };
  return numbered.ends
    .filter((end) => end > since.number)
    .map((end) => `${since.epoch}:${end}`);
}

// Why a reading cannot read as of position, or undefined when it can. No
// later load can straddle a position, so one that a reader was given stays
// one; a commit that is not a position stays inside its pass, and a reading
// of it is refused. where names the store for the reader, such as the file
// attached as a schema.
export function readingExpiry(
  numbered: Numbering | null,
  position: Position,
  store: NumberedStore,
  where: string,
): string | undefined {
  if (numbered === null) return unnumbered(position, store);
  const expired = expiry(numbered, position, store);
  if (expired === undefined && !numbered.ends.includes(position.number))
    throw new TypeError(
      `${position.epoch}:${position.number} is not a position of ${where}: a reading of a commit inside a pass would show a part of that pass. Read a position that positions() lists.`,
    );
  return expired;
}

// The commit that a reading reads: the asked position, when the store reads
// it exactly, or else the newest position, with the numbering it is of.
export function readingNumber(
  numbered: Numbering | null,
  asked: Position | undefined,
  store: NumberedStore,
  where: string,
): (Numbering & { readonly number: number }) | { readonly expired: string } {
  if (asked !== undefined) {
    const expired = readingExpiry(numbered, asked, store, where);
    if (expired !== undefined) return { expired };
  }
  const number = asked?.number ?? numbered?.ends.at(-1);
  if (numbered === null || number === undefined)
    return { expired: `There is no position of ${where} yet` };
  return { ...numbered, number };
}

function unnumbered({ epoch, number }: Position, store: NumberedStore): string {
  return `Position ${epoch}:${number} is of commits this ${store.noun} does not have`;
}
