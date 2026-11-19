// Minimal chainable stand-in for the supabase-js admin client (tests only).
// Supports: from(t).select().eq().order().range(), .in(), .insert(), .update().in()
export function fakeAdmin(tables: Record<string, any[]>) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  function from(table: string) {
    let rows = [...(tables[table] || [])];
    let op = 'select'; let payload: any = null;
    const q: any = {
      select() { return q; },
      eq(col: string, v: unknown) { rows = rows.filter((r) => r[col] === v); return q; },
      in(col: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[col])); return q; },
      order(col: string) { rows.sort((a, b) => String(a[col]).localeCompare(String(b[col]))); return q; },
      range(a: number, b: number) { rows = rows.slice(a, b + 1); return q; },
      insert(p: any) { op = 'insert'; payload = p; (tables[table] ||= []).push(...(Array.isArray(p) ? p : [p])); return q; },
      update(p: any) { op = 'update'; payload = p; return q; },
      then(res: any, rej: any) {
        if (op === 'update') rows.forEach((r) => Object.assign(r, payload));
        calls.push({ table, op, args: [payload] });
        return Promise.resolve({ data: op === 'select' ? rows : null, error: null }).then(res, rej);
      },
    };
    return q;
  }
  return { from, calls, tables };
}
