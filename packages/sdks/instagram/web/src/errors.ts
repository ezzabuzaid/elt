// Instagram answered as it answers a browser that is not signed in: a
// redirect to its login page, or a web page where data was asked for.
export class InstagramLoginError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(
      `Instagram did not answer ${what} for a signed-in session: sign in to Instagram again in your browser, then sync again.`,
      options,
    );
    this.name = 'InstagramLoginError';
  }
}

// Instagram asked the client to slow down ("Please wait a few minutes
// before you try again"). It names no time to wait, so the request is not
// sent again.
export class InstagramRateLimitError extends Error {
  constructor(what: string) {
    super(
      `Instagram asked to wait before it answers ${what}. The next sync goes on from the last page this one loaded.`,
    );
    this.name = 'InstagramRateLimitError';
  }
}

// Instagram refused a query, or answered it without a field this package
// reads: its web API changed under the persisted query or the schema.
export class InstagramQueryError extends Error {
  constructor(what: string, detail: string, options?: ErrorOptions) {
    super(
      `Instagram's answer to ${what} is not what this package reads: ${detail}`,
      options,
    );
    this.name = 'InstagramQueryError';
  }
}
