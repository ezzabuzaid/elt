import { appRunning } from '@workspace/sdk-apple-launch-services';

// Safari syncs history and cloud tabs from iCloud only while it runs; tab
// groups and bookmarks sync through helpers that run without it.
export function safariRunning(): Promise<boolean> {
  return appRunning('com.apple.Safari');
}
