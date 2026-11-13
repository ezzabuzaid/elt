// A privacy grant of macOS that opens a store, or the data of a framework.
export type Grant = 'full-disk-access' | 'contacts' | 'calendars' | 'reminders';

const PANES: Record<Grant, string> = {
  'full-disk-access': 'Full Disk Access',
  contacts: 'Contacts or › Full Disk Access',
  calendars: 'Calendars',
  reminders: 'Reminders',
};

// macOS charges the access of a process to its responsible program: the app
// that started it, or the program itself when launchd did. Only the host
// knows which one it is, so its entry point installs the name once, as System
// Settings lists it; each remedy written after that names it.
class MacOSAccess {
  #program = 'the program that runs this process';

  install({ program }: { readonly program: string }): void {
    this.#program = program;
  }

  // What the user turns on so that this process gets the grant.
  remedy(grant: Grant): string {
    return `Turn on ${this.#program} in System Settings › Privacy & Security › ${PANES[grant]}.`;
  }
}

export const macOSAccess = new MacOSAccess();
