import { Automation } from './automation.ts';

// An automation whose only action is to tell the user.
export abstract class NotifyAutomation<Data> extends Automation<Data> {
  abstract message(match: Data): string;

  async act(match: Data): Promise<string> {
    return this.message(match);
  }
}
