import { type Thing, first, isThing } from './structured-data.ts';

/** What a product costs at the time the page was downloaded. */
export type Price = {
  /** The price to pay, as a decimal string with '.' as its point, such as "12.000" for JOD. */
  readonly amount: string;
  /** The ISO 4217 code, such as JOD; null when the page gives none. */
  readonly currency: string | null;
  /** The price before a sale, only when it is higher than amount. */
  readonly regular: string | null;
  /** The lowest and highest price of an AggregateOffer; amount is the lowest. */
  readonly range: { readonly low: string; readonly high: string } | null;
};

/** The price of an object's offers, with the availability and the condition of the offer that gives it. */
export type Offered = {
  readonly price: Price | null;
  readonly availability: string | null;
  readonly itemCondition: string | null;
};

// The price types that mark a price before a sale: Google's StrikethroughPrice
// and ListPrice, and schema.org's RegularPrice, MSRP and SRP.
const struck = new Set([
  'StrikethroughPrice',
  'ListPrice',
  'RegularPrice',
  'MSRP',
  'SRP',
]);

// schema.org's ItemAvailability values of an offer that a buyer can order now.
const orderable = new Set([
  'InStock',
  'InStoreOnly',
  'LimitedAvailability',
  'OnlineOnly',
]);

/** The schema.org name of a value, without the https://schema.org/, http://schema.org/ or schema: that a page can give it. */
export function bareName(value: string | null) {
  return value?.replace(/^(?:https?:\/\/schema\.org\/|schema:)/i, '') || null;
}

/** The first text of a value: a string, a number or a microdata value. */
export function text(value: unknown): string | null {
  const one = first(value);
  if (typeof one === 'string') return one.trim() || null;
  if (typeof one === 'number' && Number.isFinite(one)) return String(one);
  return null;
}

/**
 * A price as a decimal string, as schema.org asks: '.' is the point, a comma
 * is a thousands separator, a currency symbol or code is not part of it, and
 * Arabic-Indic digits are digits. JOD's "12.000" keeps its three decimals.
 * Null for a value that is not one price.
 */
export function decimal(value: unknown): string | null {
  const one = first(value);
  const written =
    typeof one === 'number'
      ? String(one)
      : typeof one === 'string'
        ? one
        : null;
  if (written === null) return null;
  const digits = written
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[,\s]/g, '');
  return /^\D*?(\d+(?:\.\d+)?)\D*$/.exec(digits)?.[1] ?? null;
}

// Google shows only a price greater than zero; zero is "price on request".
function positive(value: unknown) {
  const amount = decimal(value);
  return amount !== null && Number(amount) > 0 ? amount : null;
}

/**
 * The price of an object's offers, as Google's merchant listings read it:
 * offers.price before priceSpecification, the active specification (no
 * priceType, or SalePrice, no validForMemberTier, valid at `at`), the struck
 * specification as the regular price when it is higher, an AggregateOffer's
 * lowPrice and range, and of several offers the lowest that a buyer can order,
 * in the currency of the first.
 */
export function offered(
  thing: Thing,
  resolve: (value: unknown) => unknown,
  at: number,
): Offered {
  const offers = [thing.offers]
    .flat()
    .map(resolve)
    .filter(isThing)
    .flatMap((offer) => {
      const nested = [offer.offers].flat().map(resolve).filter(isThing);
      return nested.length > 0 ? nested : [offer];
    });
  const candidates = offers.map((offer) => ({
    ...priceOf(offer, resolve, at),
    availability: bareName(text(offer.availability)),
    itemCondition: bareName(text(offer.itemCondition)),
  }));
  const priced = candidates.filter((candidate) => candidate.price !== null);
  const leading = priced[0];
  if (leading === undefined)
    return {
      price: null,
      availability: candidates[0]?.availability ?? null,
      itemCondition: candidates[0]?.itemCondition ?? null,
    };
  const sameCurrency = priced.filter(
    (candidate) => candidate.price?.currency === leading.price?.currency,
  );
  const orderableOnes = sameCurrency.filter(
    (candidate) =>
      candidate.availability === null || orderable.has(candidate.availability),
  );
  return cheapest(orderableOnes.length > 0 ? orderableOnes : sameCurrency);
}

/** Of several priced candidates, the one with the lowest amount. */
export function cheapest<Candidate extends { readonly price: Price | null }>(
  candidates: readonly Candidate[],
): Candidate {
  return candidates.reduce((low, candidate) =>
    Number(candidate.price?.amount) < Number(low.price?.amount)
      ? candidate
      : low,
  );
}

function priceOf(
  offer: Thing,
  resolve: (value: unknown) => unknown,
  at: number,
): { readonly price: Price | null } {
  const type = bareName(text([offer['@type']].flat()));
  if (type === 'AggregateOffer') {
    const low = positive(offer.lowPrice) ?? positive(offer.price);
    const high = positive(offer.highPrice);
    return {
      price:
        low === null
          ? null
          : {
              amount: low,
              currency: text(offer.priceCurrency),
              regular: null,
              range: high === null ? null : { low, high },
            },
    };
  }
  const specifications = [offer.priceSpecification]
    .flat()
    .map(resolve)
    .filter(isThing)
    .filter((specification) => !('validForMemberTier' in specification));
  const active = specifications.find((specification) => {
    const priceType = bareName(text(specification.priceType));
    return (
      (priceType === null || priceType === 'SalePrice') &&
      valid(specification, at) &&
      positive(specification.price) !== null
    );
  });
  const amount = positive(offer.price) ?? positive(active?.price);
  if (amount === null) return { price: null };
  const regular = specifications
    .filter((specification) =>
      struck.has(bareName(text(specification.priceType)) ?? ''),
    )
    .map((specification) => positive(specification.price))
    .find((value) => value !== null && Number(value) > Number(amount));
  return {
    price: {
      amount,
      currency:
        text(offer.priceCurrency) ??
        text(active?.priceCurrency) ??
        text(specifications[0]?.priceCurrency),
      regular: regular ?? null,
      range: null,
    },
  };
}

// A specification holds from its validFrom to its validThrough; a date that
// Date cannot read bounds nothing.
function valid(specification: Thing, at: number) {
  const from = Date.parse(text(specification.validFrom) ?? '');
  const through = Date.parse(text(specification.validThrough) ?? '');
  return !(from > at) && !(through < at);
}
