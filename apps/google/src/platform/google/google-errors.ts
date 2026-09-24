// What a failed Google call throws (GaxiosError), as observed live: for
// example a 429 with { error: { code, message: "Quota exceeded for
// sc-domain:limerence.sh.", errors: [{ reason: "rateLimitExceeded" }],
// status: "RESOURCE_EXHAUSTED" } }.
export type GoogleError = {
  readonly message?: string;
  readonly status?: number;
  readonly response?: {
    readonly status?: number;
    readonly headers?: Headers;
    readonly data?: {
      readonly error?: {
        readonly message?: string;
        readonly status?: string;
        readonly errors?: readonly { readonly reason?: string }[];
      };
    };
  };
};

export function statusOf(error: unknown): number | undefined {
  const failure = error as GoogleError | undefined;
  return failure?.status ?? failure?.response?.status;
}

export function reasonsOf(error: unknown): string[] {
  return (
    (error as GoogleError | undefined)?.response?.data?.error?.errors?.map(
      (entry) => entry.reason ?? '',
    ) ?? []
  );
}

// A 403 that means the request itself is misconfigured (API disabled, a scope
// missing from the grant) rather than that this user may not read the file.
export function isConfigurationError(error: unknown): boolean {
  const failure = error as GoogleError | undefined;
  return /accessNotConfigured|SERVICE_DISABLED|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(
    `${JSON.stringify(failure?.response?.data ?? '')} ${failure?.message ?? ''}`,
  );
}

// Google's own explanation of a failed call, falling back to the error text.
export function messageOf(error: unknown): string {
  const failure = error as GoogleError | undefined;
  return (
    failure?.response?.data?.error?.message || failure?.message || String(error)
  );
}
