import { ChangeSignal, type Check } from './change-signal.ts';

// The database's last rowversion (@@DBTS): each insert or update of a row
// with a rowversion column moves it.
class LastRowversion extends ChangeSignal {
  async read({ session }: Check) {
    const { rowversion } = await session.version();
    return () => rowversion;
  }
}

export const lastRowversion = new LastRowversion();
