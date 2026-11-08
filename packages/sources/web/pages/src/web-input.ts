import { z } from 'zod';

/** A URL that is not http or https, given as an input. The user chooses the inputs, so only the user can fix it. */
export class InputError extends Error {}

const schema = z
  .url({ protocol: /^https?$/ })
  .transform((href) => new URL(href).href)
  .brand<'WebInput'>();

/**
 * A starting URL of a web stream: an http or https URL in the form that the
 * URL standard gives it, so one website is one input however the host spells
 * it. Only {@link webInput} makes one, so an input list holds no other URL.
 */
export type WebInput = z.output<typeof schema>;

/** The input of an http or https URL; an {@link InputError} for any other. */
export function webInput(href: string): WebInput {
  const parsed = schema.safeParse(href);
  if (!parsed.success) {
    throw new InputError(`${href} is not an http or https URL`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * The inputs of a web stream that do not change: each URL is checked once,
 * here, and every read gets the same set.
 */
export function webInputs(
  hrefs: Iterable<string>,
): () => ReadonlySet<WebInput> {
  const inputs: ReadonlySet<WebInput> = new Set([...hrefs].map(webInput));
  return () => inputs;
}
