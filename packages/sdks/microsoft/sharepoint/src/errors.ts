import { z } from 'zod';

// The body of every Graph error (Microsoft Graph error responses).
const graphErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * Graph refused a request. `code` is Graph's error code, such as
 * `accessDenied` or `invalidRequest`, when the body names one.
 */
export class GraphError extends Error {
  override readonly name = 'GraphError';
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  static async of(response: Response): Promise<GraphError> {
    const body = graphErrorBody.safeParse(
      await response.json().catch(() => undefined),
    );
    const code = body.success ? body.data.error.code : undefined;
    const said = body.success ? `: ${body.data.error.message}` : '';
    return new GraphError(
      response.status,
      code,
      `Graph answered ${response.status} ${code ?? response.statusText} to GET ${new URL(response.url).pathname}${said}`,
    );
  }
}

/**
 * Graph refused the token of the app (401) or its access (403). A
 * Sites.Selected app reads only the sites that an administrator granted to
 * it, and Graph answers 403 for each other site.
 */
export class SharePointAccessError extends Error {
  override readonly name = 'SharePointAccessError';
  /** The site URL, site ID or drive that the call named. */
  readonly resource: string;

  constructor(resource: string, options: { cause: GraphError }) {
    super(
      `SharePoint refused access to ${resource} with ${options.cause.status}. The app needs a Sites.Selected read grant on the site.`,
      options,
    );
    this.resource = resource;
  }
}

/** No site is at the URL: Graph answered 404. */
export class SharePointSiteNotFoundError extends Error {
  override readonly name = 'SharePointSiteNotFoundError';
  readonly url: string;

  constructor(url: string, options: { cause: GraphError }) {
    super(`No SharePoint site is at ${url}.`, options);
    this.url = url;
  }
}

/**
 * Graph no longer serves the changes after a delta link: it answered 410
 * Gone. Read the collection again from the start, with no link.
 */
export class DeltaExpiredError extends Error {
  override readonly name = 'DeltaExpiredError';

  constructor(options: { cause: GraphError }) {
    super(
      'Graph no longer serves the changes after this delta link. Read the collection again from the start.',
      options,
    );
  }
}
