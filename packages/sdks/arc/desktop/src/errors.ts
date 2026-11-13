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
