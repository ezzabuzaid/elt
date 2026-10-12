import type { Match } from '@workspace/eca';

import { Automation } from './automation.ts';

// An automation whose only action is to tell the user.
export abstract class NotifyAutomation<Data> extends Automation<Data> {
  abstract message(match: Match<Data>): string;

  async act(match: Match<Data>): Promise<string> {
    return this.message(match);
  }
}
