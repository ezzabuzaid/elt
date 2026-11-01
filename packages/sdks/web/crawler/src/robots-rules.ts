import * as robots from 'robots-parser';

// robots-parser is CommonJS, but its types declare an ES default export
// ("masquerading as ESM"), so TypeScript types the namespace's default as the
// module. Node and bundlers give module.exports, the parser, as the default,
// and a static import lets a host bundle it.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- robots-parser 3.0.1's index.d.ts declares `export default` over `module.exports = function`
const robotsParser = robots.default as unknown as typeof robots.default.default;

/** An origin's robots.txt (RFC 9309) as the crawl obeys it for one user agent. */
export class RobotsRules {
  readonly #rules: ReturnType<typeof robotsParser>;
  readonly #agent: string;
  // Whether the group's Content-Signal lets the crawl use the site for search.
  readonly #search: boolean;

  constructor(url: string, body: string, agent: string) {
    this.#rules = robotsParser(url, body);
    this.#agent = agent;
    this.#search = contentSignals(body, agent).get('search') !== 'no';
  }

  /**
   * Whether the crawl may request the URL. The crawl indexes pages and gives
   * their links and titles, which is the "search" use, so an origin that
   * refuses search is left out whole.
   */
  allows(url: string) {
    return this.#search && this.#rules.isAllowed(url, this.#agent) !== false;
  }

  /** The Crawl-delay of the agent's group in seconds, or 0 without one. */
  crawlDelay() {
    return this.#rules.getCrawlDelay(this.#agent) ?? 0;
  }
}

// Cloudflare's Content Signals (blog.cloudflare.com/content-signals-policy):
// "Content-Signal: search=yes, ai-train=no" in a robots.txt group. robots-parser
// ignores the line, so the crawler reads it with the same grouping: the group
// that names the agent's product token, else the "*" group (RFC 9309 §2.2.1).
// A signal that a group leaves out expresses no preference.
function contentSignals(body: string, agent: string) {
  const groups = new Map<string, Map<string, string>>();
  let current: Map<string, string>[] = [];
  let naming = false;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line
      .slice(colon + 1)
      .replace(/#.*$/, '')
      .trim();
    if (key === 'user-agent') {
      if (!naming) current = [];
      naming = true;
      if (value === '') continue;
      const token = productToken(value);
      const group = groups.get(token) ?? new Map<string, string>();
      groups.set(token, group);
      current.push(group);
      continue;
    }
    naming = false;
    if (key !== 'content-signal') continue;
    for (const pair of value.split(',')) {
      const [name = '', setting = ''] = pair
        .split('=')
        .map((part) => part.trim().toLowerCase());
      if (name !== '' && (setting === 'yes' || setting === 'no'))
        for (const group of current) group.set(name, setting);
    }
  }
  return groups.get(productToken(agent)) ?? groups.get('*') ?? new Map();
}

// A user agent's product token as robots-parser matches it: "WhatIsGoingOn/0.1 (+https://…)" is "whatisgoingon".
function productToken(agent: string) {
  return agent.toLowerCase().split('/', 1)[0]?.trim() ?? '';
}
