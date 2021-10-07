Error.stackTraceLimit = Infinity;
import { promises as fsp } from "fs";
import type { BaseGraphQLContext } from "graphile-crystal";
import {
  AsyncExecutionResult,
  execute,
  ExecutionPatchResult,
  getOperationAST,
  GraphQLError,
  parse,
  subscribe,
  validate,
  validateSchema,
} from "graphql";
import { graphql } from "graphql";
import { isAsyncIterable } from "iterall";
import JSON5 from "json5";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import prettier from "prettier";

import type { PgClient, PgClientQuery, WithPgClient } from "../src";
import { makeExampleSchema, schema as optimizedSchema } from "./exampleSchema";

export const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === "1";

const deoptimizedSchema = makeExampleSchema({ deoptimize: true });

let testPool: Pool | null = null;
beforeAll(() => {
  testPool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL || "graphile_crystal",
  });
});

afterAll(() => {
  testPool.end();
  testPool = null;
});

type ClientAndRelease = {
  count: number;
  client: PgClient;
  release: () => void;
  rawPoolClient: PoolClient;
};
const clientMap = new Map<any, Promise<ClientAndRelease>>();
/**
 * Must **not** be an async function, otherwise we'll get race conditions
 */
function clientForSettings(
  pgSettings: { [key: string]: string },
  queries: PgClientQuery[],
): Promise<ClientAndRelease> {
  let clientAndReleasePromise = clientMap.get(pgSettings);
  if (clientAndReleasePromise) {
    clientAndReleasePromise.then(
      (clientAndRelease) => clientAndRelease.count++,
    );
    return clientAndReleasePromise;
  }

  clientAndReleasePromise = (async () => {
    const poolClient = await testPool.connect();
    poolClient.query("begin");

    // Set the claims
    const setCalls: string[] = [];
    const setValues: string[] = [];
    Object.entries(pgSettings).map(([key, value]) => {
      const i = setValues.push(key);
      const j = setValues.push(value);
      setCalls.push(`set_config($${i}, $${j}, true)`);
    });
    if (setCalls.length) {
      const query = `select ${setCalls.join(", ")}`;
      await poolClient.query(query, setValues);
    }

    const clientAndRelease: ClientAndRelease = {
      rawPoolClient: poolClient,
      count: 1,
      client: {
        query<TData>(opts: PgClientQuery) {
          queries.push(opts);
          const { text, values, arrayMode, name } = opts;

          return arrayMode
            ? poolClient.query<TData extends Array<any> ? TData : never>({
                text,
                values,
                name,
                rowMode: "array",
              })
            : poolClient.query<TData>({
                text,
                values,
                name,
              });
        },
        async startTransaction() {
          if (this.count <= 0) {
            throw new Error(
              "Attempted to start transaction on released client",
            );
          }
          await poolClient.query("savepoint tx");
        },
        async commitTransaction() {
          if (this.count <= 0) {
            throw new Error(
              "Attempted to commit transaction on released client",
            );
          }
          await poolClient.query("release savepoint tx");
        },
        async rollbackTransaction() {
          if (this.count <= 0) {
            throw new Error(
              "Attempted to rollback transaction on released client",
            );
          }
          await poolClient.query("rollback to savepoint tx");
        },
      },
      release() {
        this.count--;
        if (this.count < 0) {
          throw new Error("Released client too many times");
        }
      },
    };
    return clientAndRelease;
  })();
  clientMap.set(pgSettings, clientAndReleasePromise);
  return clientAndReleasePromise;
}

async function releaseClients() {
  for (const clientAndReleasePromise of clientMap.values()) {
    const clientAndRelease = await clientAndReleasePromise;
    await clientAndRelease.rawPoolClient.query(`rollback`);
    clientAndRelease.rawPoolClient.release();
    if (clientAndRelease.count !== 0) {
      throw new Error(
        `Client wasn't released right number of times (missing releases = ${clientAndRelease.count})`,
      );
    }
  }
  clientMap.clear();
}

async function resetSequences() {
  await testPool.query(
    await fsp.readFile(`${__dirname}/sequence_reset.sql`, "utf8"),
  );
}

afterEach(releaseClients);

export async function runTestQuery(
  source: string,
  variableValues?: { [key: string]: any },
  options: {
    callback?: (
      client: PoolClient | null,
      payloads: Omit<AsyncExecutionResult, "hasNext">[],
    ) => Promise<void>;
    deoptimize?: boolean;
  } = Object.create(null),
): Promise<{
  payloads?: Array<{
    data?: { [key: string]: any };
    errors?: readonly GraphQLError[];
  }>;
  data?: { [key: string]: any };
  errors?: readonly GraphQLError[];
  queries: PgClientQuery[];
}> {
  // Do not allow queries to run in parallel during these tests, we need
  // reproducibility (and we don't want to mess with the transactions, see
  // releaseClients below).
  await releaseClients();
  await resetSequences();

  const queries: PgClientQuery[] = [];
  const schema = options.deoptimize ? deoptimizedSchema : optimizedSchema;
  let latestClient: PoolClient | null = null;
  const withPgClient: WithPgClient = async (_pgSettings, callback) => {
    const o = await clientForSettings(_pgSettings, queries);
    latestClient = o.rawPoolClient;
    try {
      return await callback(o.client);
    } finally {
      o.release();
    }
  };
  const contextValue: BaseGraphQLContext = {
    pgSettings: {},
    withPgClient,
  };

  const schemaValidationErrors = validateSchema(schema);
  if (schemaValidationErrors.length > 0) {
    throw new Error(
      `Invalid schema: ${schemaValidationErrors
        .map((e) => String(e))
        .join(",")}`,
    );
  }

  const document = parse(source);

  const operationAST = getOperationAST(document, undefined);
  const operationType = operationAST.operation;

  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    throw new Error(
      `Invalid operation document: ${validationErrors
        .map((e) => String(e))
        .join(",")}`,
    );
  }

  const result =
    operationType === "subscription"
      ? await subscribe({
          schema,
          document,
          variableValues,
          contextValue,
          rootValue: null,
        })
      : await execute({
          schema,
          document,
          variableValues,
          contextValue,
          rootValue: null,
        });

  if (isAsyncIterable(result)) {
    let errors: GraphQLError[] | undefined = undefined;
    // hasNext changes based on payload order; remove it.
    const originalPayloads: Omit<AsyncExecutionResult, "hasNext">[] = [];

    // Start collecting the payloads
    const promise = (async () => {
      for await (const entry of result) {
        const { hasNext, ...rest } = entry;
        if (Object.keys(rest).length > 0 || hasNext) {
          // Do not add the trailing `{hasNext: false}` entry to the snapshot
          originalPayloads.push(rest);
        }
        if (entry.errors) {
          if (!errors) {
            errors = [];
          }
          errors.push(...entry.errors);
        }
      }
    })();

    // In parallel to collecting the payloads, run the callback
    if (options.callback) {
      await options.callback(latestClient, originalPayloads);
    }

    if (operationType === "subscription") {
      const iterator = result[Symbol.asyncIterator]();
      // Terminate the subscription
      iterator.return?.();
    }

    // Now wait for all payloads to have been collected
    await promise;

    // Now we're going to reorder the payloads so that they're always in a
    // consistent order for the snapshots.
    const sortPayloads = (
      payload1: ExecutionPatchResult,
      payload2: ExecutionPatchResult,
    ) => {
      const ONE_AFTER_TWO = 1;
      const ONE_BEFORE_TWO = -1;
      if (!payload1.path) {
        return 0;
      }
      if (!payload2.path) {
        return 0;
      }

      // Make it so we can assume payload1 has the longer (or equal) path
      if (payload2.path.length > payload1.path.length) {
        return -sortPayloads(payload2, payload1);
      }

      for (let i = 0, l = payload1.path.length; i < l; i++) {
        let key1 = payload1.path[i];
        let key2 = payload2.path[i];
        if (key2 === undefined) {
          return ONE_AFTER_TWO;
        }
        if (key1 === key2) {
          /* continue */
        } else if (typeof key1 === "number" && typeof key2 === "number") {
          const res = key1 - key2;
          if (res !== 0) {
            return res;
          }
        } else if (typeof key1 === "string" && typeof key2 === "string") {
          const res = key1.localeCompare(key2);
          if (res !== 0) {
            return res;
          }
        } else {
          throw new Error("Type mismatch");
        }
      }
      // We should do canonical JSON... but whatever.
      return JSON.stringify(payload1).localeCompare(JSON.stringify(payload2));
    };
    const payloads = [
      originalPayloads[0],
      ...originalPayloads.slice(1).sort(sortPayloads),
    ];

    return { payloads, errors, queries };
  } else {
    if (options.callback) {
      throw new Error(
        "Callback is only appropriate when operation returns an async iterable",
      );
    }
    const { data, errors } = result;
    if (errors) {
      console.error(errors[0].originalError || errors[0]);
    }
    return { data, errors, queries };
  }
}

async function snapshot(actual: string, filePath: string) {
  let expected: string | null = null;
  try {
    expected = await fsp.readFile(filePath, "utf8");
  } catch (e) {
    /* noop */
  }
  if (expected == null || UPDATE_SNAPSHOTS) {
    if (expected !== actual) {
      console.warn(`Updated snapshot in '${filePath}'`);
      await fsp.writeFile(filePath, actual);
    }
  } else {
    expect(actual).toEqual(expected);
  }
}

const sqlSnapshotAliases = new Map();
let sqlSnapshotAliasCount = 0;

beforeEach(() => {
  sqlSnapshotAliases.clear();
  sqlSnapshotAliasCount = 0;
});

function makeSQLSnapshotSafe(sql: string): string {
  return sql.replace(/__cursor_[0-9]+__/g, (t) => {
    const substitute = sqlSnapshotAliases.get(t);
    if (substitute != null) {
      return substitute;
    } else {
      const sub = `__SNAPSHOT_CURSOR_${sqlSnapshotAliasCount++}__`;
      sqlSnapshotAliases.set(t, sub);
      return sub;
    }
  });
}

export const assertSnapshotsMatch = async (
  only: "sql" | "result",
  props: {
    result: ReturnType<typeof runTestQuery>;
    document: string;
    path: string;
    config: any;
    ext?: string;
  },
): Promise<void> => {
  const { path, result, ext } = props;
  const basePath = path.replace(/\.test\.graphql$/, "");
  if (basePath === path) {
    throw new Error(`Failed to trim .test.graphql from '${path}'`);
  }

  const { data, payloads, queries } = await result;

  if (only === "result") {
    const resultFileName = basePath + (ext || "") + ".json5";
    const formattedData = prettier.format(JSON5.stringify(payloads || data), {
      parser: "json5",
      printWidth: 120,
    });
    await snapshot(formattedData, resultFileName);
  } else if (only === "sql") {
    const sqlFileName = basePath + (ext || "") + ".sql";
    const formattedQueries = queries
      .map((q) => makeSQLSnapshotSafe(q.text))
      .join("\n\n");
    await snapshot(formattedQueries, sqlFileName);
  } else {
    throw new Error(
      `Unexpected argument to assertSnapshotsMatch; expected result|sql, received '${only}'`,
    );
  }
};

export const assertResultsMatch = async (
  result1: ReturnType<typeof runTestQuery>,
  result2: ReturnType<typeof runTestQuery>,
): Promise<void> => {
  const { data: data1 } = await result1;
  const { data: data2 } = await result2;
  expect(data2).toEqual(data1);
};
