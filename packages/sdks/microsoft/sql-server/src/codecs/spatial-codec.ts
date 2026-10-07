import { SqlServerCodec, text } from './sql-server-codec.ts';

// geography and geometry as extended well-known text: the SRID, then every
// coordinate with its Z and M, which plain well-known text drops.
export class SpatialCodec extends SqlServerCodec<string> {
  readonly value = { kind: 'spatial' } as const;

  select(reference: string): readonly string[] {
    return [
      `'SRID=' + CONVERT(varchar(11), ${reference}.STSrid) + ';' + ${reference}.AsTextZM()`,
    ];
  }

  decode([value]: readonly unknown[]): string | null {
    return value === null ? null : text(value, 'spatial');
  }
}
