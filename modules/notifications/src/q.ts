import type { QueryResultRow } from "pg";

/** The one method both a consumer's PoolClient and the API's tenant transaction offer. */
export interface Q {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- mirrors pg: callers name the row type
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
}
