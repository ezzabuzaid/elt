import { GaxiosError } from 'gaxios';

export { GaxiosError };

// The body of a failed Google call, as observed live: for example a 429 with
// { error: { code, message: "Quota exceeded for sc-domain:limerence.sh.",
// errors: [{ reason: "rateLimitExceeded" }], status: "RESOURCE_EXHAUSTED" } }.
export type GoogleErrorBody = {
  readonly error?: {
    readonly message?: string;
    readonly status?: string;
    readonly errors?: readonly { readonly reason?: string }[];
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

export function reasonsOf(error: unknown): string[] {
  return bodyOf(error)?.error?.errors?.map((entry) => entry.reason ?? '') ?? [];
}

// Google's own explanation of a failed call, falling back to the error text.
export function messageOf(error: unknown): string {
  return (
    bodyOf(error)?.error?.message ||
    (Error.isError(error) && error.message) ||
    String(error)
  );
}
