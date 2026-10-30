# An Accept redirect that gives no Markdown is asked again as a browser asks

A server can answer a Markdown request with a redirect to another URL. When the `Vary` header of the redirect names `Accept`, the Accept header chose the redirect (RFC 9110, section 12.5.5). On 2026-10-30, linear.app answered a Markdown request for `/` with `307 Location: /index.md` and `Vary: Accept`. For each Accept header and each user agent, `/index.md` gave the HTML shell of the Linear app ("Loading…"). A browser's Accept header on `/` gave the real page. The reader stored the shell as the article of `/index.md` (backlog item 3397). The `llms.txt` of linear.app tells agents to send `Accept: text/markdown`, so the request was correct, and the server did not do what it said.

Thus a hook notes each Accept redirect. When a Markdown request had an Accept redirect and the result is not Markdown, the reader makes a browser request: it asks the original URL again with the HTML media types of the chain. It reads that answer in the usual way, so the advertised Markdown alternatives stay preferred, and the article has the URL of that answer. An Accept header is only a preference (RFC 9110, section 12.1), and a temporary redirect does not change the URL of the page (section 15.4.8).

Got gives the headers of a redirect only to a `beforeRedirect` hook. The hook marks the request in the Got `context`, and `read()` reads the mark. `negotiation` gives the Accept header and the hook together, so a caller that downloads a page and gives it to `read()` cannot send one without the other.

## Considered Options

- **Trust the redirect.** The WebFetch tool of Claude Code 2.1.314 and the `web_fetch` tool of the Gemini CLI do this (source read on 2026-10-30). On linear.app, they read the shell.
- **Ask for HTML first and use only the advertised Markdown.** Firecrawl, Crawl4AI and Jina Reader ask for HTML, so they never get the shell. But they get no Markdown from a server that only negotiates, such as Cloudflare Markdown for Agents or a Vercel rewrite.
- **Ask again after each redirect that gives no Markdown.** A redirect that does not vary on Accept sends a browser to the same place, so the second request gives the same page. In the startup-credits crawl, 25 of 27 redirects were of this type.
- **Ask again only after an Accept redirect.** This option was selected.

## Consequences

- A Markdown request that a server redirects to Markdown is read as Markdown, with no browser request. linear.app/docs does this.
- An Accept redirect that sends a browser to the same page costs one more request chain. www.notion.so/startups does this.
- A redirect whose `Vary` names only other headers, such as `Accept-Encoding`, causes no browser request.
- The fingerprint covers the answer to the browser request, so a change in the page causes an extraction also when the shell does not change.
- A server that changes its redirect by the Accept header but does not name `Accept` in `Vary` is not found. A `Vary: *` header does not cause a browser request.
