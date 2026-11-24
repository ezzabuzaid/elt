// A setup of the database that a person must change before the destination
// can write, such as a database with no pgvector extension for a vector
// column while the destination may not create it. Its failure type is
// config, so a watch does not try it again.
export class PostgresSetupError extends Error {
  override name = 'PostgresSetupError';
}
