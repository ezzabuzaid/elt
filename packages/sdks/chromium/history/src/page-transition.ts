// How a visit began, as ui/base/page_transition_types.h of Chromium names it:
// a core type in the low byte, and qualifier bits above it.
export const transitionTypes = [
  'link',
  'typed',
  'auto_bookmark',
  'auto_subframe',
  'manual_subframe',
  'generated',
  'auto_toplevel',
  'form_submit',
  'reload',
  'keyword',
  'keyword_generated',
] as const;

export type TransitionType = (typeof transitionTypes)[number];

const qualifiers = [
  ['blocked', 0x0080_0000],
  ['forward_back', 0x0100_0000],
  ['from_address_bar', 0x0200_0000],
  ['home_page', 0x0400_0000],
  ['from_api', 0x0800_0000],
  ['chain_start', 0x1000_0000],
  ['chain_end', 0x2000_0000],
  ['client_redirect', 0x4000_0000],
  ['server_redirect', 0x8000_0000],
] as const;

export type TransitionQualifier = (typeof qualifiers)[number][0];

export const transitionQualifierNames: readonly TransitionQualifier[] =
  qualifiers.map(([name]) => name);

// History stores the bits as a signed 32-bit integer, so a server redirect
// reads as a negative number.
export function transitionType(transition: number): TransitionType | null {
  return transitionTypes[(transition >>> 0) & 0xff] ?? null;
}

export function transitionQualifiers(
  transition: number,
): TransitionQualifier[] {
  const bits = transition >>> 0;
  return qualifiers.flatMap(([name, bit]) =>
    (bits & bit) >>> 0 === bit ? [name] : [],
  );
}
