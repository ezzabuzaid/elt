import { SqlServerCodec } from './sql-server-codec.ts';

export class BooleanCodec extends SqlServerCodec<boolean> {
  readonly value = { kind: 'boolean' } as const;

  select(reference: string): readonly string[] {
    return [reference];
  }

  decode([value]: readonly unknown[]): boolean | null {
    if (value === null) return null;
    if (typeof value !== 'boolean')
      throw new TypeError(`SQL Server returned a ${typeof value} for bit`);
    return value;
  }

  override cast(parameter: string): string {
    return `CAST(${parameter} AS bit)`;
  }

  override position(value: boolean): string {
    return value ? '1' : '0';
  }
}
