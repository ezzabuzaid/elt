import connectors from './connectors.ts';

for (const { run } of connectors) {
  try {
    await run();
  } catch {
    process.exitCode = 1;
  }
}
