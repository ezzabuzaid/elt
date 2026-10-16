import type { ApplePlugin } from './apple-plugin.ts';
import { when } from './connector-page.ts';
import type { MonitorStatus } from './monitors.ts';
import type { MonitorRow } from './page/contract.ts';

// Each monitor's row, by name, with the status line its page shows: whether
// it watches and when it last sent, why it failed, or why it waits.
export async function monitorRows(plugin: ApplePlugin): Promise<MonitorRow[]> {
  const now = new Date();
  return (await plugin.monitors.status()).map((monitor) => ({
    name: monitor.name,
    title: monitor.title,
    description: monitor.description,
    instruction: monitor.instruction,
    chat:
      monitor.state === 'watching'
        ? `codex://threads/${encodeURIComponent(monitor.thread)}`
        : null,
    status: status(monitor, now),
  }));
}

function status(monitor: MonitorStatus, now: Date): MonitorRow['status'] {
  switch (monitor.state) {
    case 'inactive':
      return { state: 'inactive', text: 'Not active: set it up from a chat.' };
    case 'broken':
      return { state: 'failed', text: monitor.error };
    case 'watching':
      if (monitor.failure !== null)
        return { state: 'failed', text: monitor.failure };
      return {
        state: 'watching',
        text:
          monitor.ranAt === null
            ? 'Watching · has not run yet.'
            : `Watching · ran ${when(monitor.ranAt, now)}.`,
      };
  }
}
