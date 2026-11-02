// Arc's sidebar file that this process cannot read: Arc is not installed or
// never saved a sidebar, or the system denies the file.
export class ArcSidebarUnavailableError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(
      `Arc's sidebar at ${JSON.stringify(path)} cannot be read: the file is missing, or this process has no access to it.`,
      options,
    );
    this.name = 'ArcSidebarUnavailableError';
    this.path = path;
  }
}

// A sidebar file that is not the JSON Arc writes, with the reason.
export class ArcSidebarFormatError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      `${JSON.stringify(path)} is not an Arc sidebar file: ${reason}.`,
      options,
    );
    this.name = 'ArcSidebarFormatError';
    this.path = path;
  }
}
