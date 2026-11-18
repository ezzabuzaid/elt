import { quote } from './identifier.ts';
import type { Transaction } from './postgres-load.ts';

// One privilege a role holds on a relation, or on one column of it.
type Grant = {
  readonly column: string | null;
  readonly grantee: string;
  readonly privilege: string;
  readonly grantable: boolean;
};

// Each privilege on the relation and on its columns, the owner's own
// included, as aclexplode gives them: a relation with no ACL holds its
// owner's defaults.
const grantsOf = `
  SELECT NULL::text AS "column",
    CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END AS "grantee",
    g.privilege_type AS "privilege", g.is_grantable AS "grantable"
  FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) g
  WHERE c.oid = to_regclass($1)
  UNION ALL
  SELECT a.attname::text,
    CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END,
    g.privilege_type, g.is_grantable
  FROM pg_attribute a, aclexplode(a.attacl) g
  WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`;

const key = ({ column, grantee, privilege, grantable }: Grant) =>
  JSON.stringify([column, grantee, privilege, grantable]);

// The privileges of a relation, kept so that the relation that takes its
// name, a view made again or a table swapped in, holds exactly them, as
// Snowflake's COPY GRANTS keeps them across CREATE OR REPLACE. Applying them
// is a difference, as dbt applies its grants: it revokes each privilege the
// new relation has that the old one did not, such as one that default
// privileges gave it, and grants each that it lacks.
export class Privileges {
  readonly #grants: readonly Grant[];

  private constructor(grants: readonly Grant[]) {
    this.#grants = grants;
  }

  static async of(sql: Transaction, relation: string): Promise<Privileges> {
    return new Privileges(await sql.unsafe<Grant[]>(grantsOf, [relation]));
  }

  async apply(sql: Transaction, relation: string): Promise<void> {
    const keptKeys = new Set(this.#grants.map(key));
    const held = await sql.unsafe<Grant[]>(grantsOf, [relation]);
    const heldKeys = new Set(held.map(key));
    for (const grant of held)
      if (!keptKeys.has(key(grant)))
        await sql.unsafe(statement('REVOKE', grant, relation));
    for (const grant of this.#grants)
      if (!heldKeys.has(key(grant)))
        await sql.unsafe(statement('GRANT', grant, relation));
  }
}

function statement(
  verb: 'GRANT' | 'REVOKE',
  { column, grantee, privilege, grantable }: Grant,
  relation: string,
): string {
  const on = column === null ? '' : ` (${quote(column)})`;
  const role = grantee === 'PUBLIC' ? 'PUBLIC' : quote(grantee);
  return verb === 'GRANT'
    ? `GRANT ${privilege}${on} ON ${relation} TO ${role}${grantable ? ' WITH GRANT OPTION' : ''}`
    : `REVOKE ${privilege}${on} ON ${relation} FROM ${role} CASCADE`;
}
