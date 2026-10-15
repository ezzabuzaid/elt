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
  const data: GoogleErrorBody | undefined = error.response?.data;
  return data;
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
