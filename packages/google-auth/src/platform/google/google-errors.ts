import { GaxiosError } from 'gaxios';

export { GaxiosError };

// The body of a failed Google call, as observed live: for example a 429 with
// { error: { code, message: "Quota exceeded for sc-domain:limerence.sh.",
// errors: [{ reason: "rateLimitExceeded" }], status: "RESOURCE_EXHAUSTED" } },
// or, from an API on the newer error model (AIP-193), the reason in an
// ErrorInfo detail: { error: { details: [{ "@type":
// "type.googleapis.com/google.rpc.ErrorInfo", reason: "DISALLOWED_OAUTH_SCOPES",
// metadata: {...} }] } } (Google Health, 2026-10-15).
export type GoogleErrorBody = {
  readonly error?: {
    readonly message?: string;
    readonly status?: string;
    readonly errors?: readonly { readonly reason?: string }[];
    readonly details?: readonly { readonly reason?: string }[];
  };
};

function bodyOf(error: unknown): GoogleErrorBody | undefined {
  if (!(error instanceof GaxiosError)) return undefined;
  // gaxios parses the body of a failed request, except for a streamed one: it
  // reads that body as text and keeps the text only as the message of the
  // error (gaxios.js `_request`, `extractAPIErrorFromResponse`).
  // `response.data` is then undefined on node-fetch and the same text on
  // Node's fetch.
  if (error.config.responseType === 'stream') return parsed(error.message);
  const data: GoogleErrorBody | undefined = error.response?.data;
  return data;
}

// A refusal from in front of the API, such as a proxy's 503, is not JSON: it
// has no reasons, and its text stays the message.
function parsed(text: string): GoogleErrorBody | undefined {
  try {
    const body: GoogleErrorBody | undefined = JSON.parse(text);
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function statusOf(error: unknown): number | undefined {
  return error instanceof GaxiosError ? error.status : undefined;
}

// Every reason the error names, in the legacy `errors` list and in ErrorInfo
// details alike.
export function reasonsOf(error: unknown): string[] {
  const body = bodyOf(error)?.error;
  return [...(body?.errors ?? []), ...(body?.details ?? [])].flatMap(
    (entry) => entry.reason ?? [],
  );
}

// Google's own explanation of a failed call, falling back to the error text.
export function messageOf(error: unknown): string {
  return (
    bodyOf(error)?.error?.message ||
    (Error.isError(error) && error.message) ||
    String(error)
  );
}
