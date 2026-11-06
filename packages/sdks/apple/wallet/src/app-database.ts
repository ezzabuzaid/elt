import { AppDatabase, Store } from '@workspace/sdk-macos-app-database';

export const appDatabase = new AppDatabase(new Store('The Wallet store', ''));
