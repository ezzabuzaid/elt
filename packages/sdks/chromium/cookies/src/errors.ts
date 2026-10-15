// The login keychain did not give the password a browser encrypts its
// cookies with: the user denied access, or the browser never stored it.
export class SafeStorageUnavailableError extends Error {
  readonly browser: string;

  constructor(browser: string, service: string, options?: ErrorOptions) {
    super(
      `${service} could not be read from the login keychain. Allow access when macOS asks for "${service}", then sync again.`,
      options,
    );
    this.name = 'SafeStorageUnavailableError';
    this.browser = browser;
  }
}

// A cookie that did not decrypt to the value its browser stored, such as
// one encrypted with a different key.
export class CookieDecryptionError extends Error {
  constructor(
    browser: string,
    host: string,
    name: string,
    options?: ErrorOptions,
  ) {
    super(
      `${browser}'s ${name} cookie for ${host} could not be decrypted with its Safe Storage key`,
      options,
    );
    this.name = 'CookieDecryptionError';
  }
}

// No browser profile holds the cookie that signs in to the site.
export class BrowserSessionNotFoundError extends Error {
  constructor(host: string, cookie: string, checked: readonly string[]) {
    super(
      `No browser profile holds an unexpired ${cookie} cookie for ${host}. Sign in to ${host} in ${checked.length === 0 ? 'Dia, Google Chrome, Arc, Microsoft Edge or Brave' : checked.join(', ')}, then sync again.`,
    );
    this.name = 'BrowserSessionNotFoundError';
  }
}
