import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { environments } from "@/lib/config";
import type { SqlExecutor } from "@/lib/db";
import {
  MigrationError,
  checksum,
  environmentRefusal,
  loadMigrations,
  migrate,
  migrationErrors,
  parseMigration,
  splitStatements,
} from "@/lib/migrations";
import {
  createTestDatabase,
  migrationsDirectory,
  type TestDatabase,
} from "@/tests/support/pglite";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
}, 30_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  await database.reset();
});

async function tableNames(): Promise<string[]> {
  const rows = await database.sql.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return rows.map((row) => String(row.table_name));
}

async function recorded(): Promise<{ name: string; checksum: string }[]> {
  const rows = await database.sql.query(
    "SELECT name, checksum FROM schema_migrations ORDER BY applied_at, name",
  );
  return rows.map((row) => ({
    name: String(row.name),
    checksum: String(row.checksum),
  }));
}

async function expectMigrationError(
  promise: Promise<unknown>,
  message: string,
  migration?: string,
) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(MigrationError);
  expect((error as MigrationError).message).toContain(message);
  if (migration) expect((error as MigrationError).migration).toBe(migration);
}

describe("splitStatements", () => {
  it("splits on top-level semicolons and drops empty statements", () => {
    expect(splitStatements("SELECT 1; ;\n SELECT 2;\n-- trailing\n")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("does not split inside strings, identifiers, dollar quotes or comments", () => {
    const script = [
      "INSERT INTO t VALUES ('a;b', 'it''s;', E'x\\';y')",
      'CREATE TABLE "we;ird" (a int)',
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
      "DO $$ BEGIN PERFORM 1; END $$",
      "SELECT $1::int /* a; /* nested; */ b; */ -- c;\n",
    ].join(";\n");

    expect(splitStatements(script)).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s;', E'x\\';y')",
      'CREATE TABLE "we;ird" (a int)',
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
      "DO $$ BEGIN PERFORM 1; END $$",
      "SELECT $1::int /* a; /* nested; */ b; */ -- c;",
    ]);
  });

  it("keeps a comment-only script empty", () => {
    expect(splitStatements("-- nothing\n/* here */\n")).toEqual([]);
  });

  it.each(["SELECT 'open", 'SELECT "open', "SELECT $x$ open", "/* open"])(
    "rejects an unterminated %s",
    (script) => {
      expect(() => splitStatements(script)).toThrow(
        migrationErrors.unterminated,
      );
    },
  );
});

describe("parseMigration", () => {
  it("rejects a file without statements", () => {
    expect(() => parseMigration("0001_x", "-- only a comment")).toThrow(
      migrationErrors.empty,
    );
  });

  it.each(["BEGIN", "COMMIT", "start transaction", "ROLLBACK"])(
    "rejects transaction control (%s)",
    (statement) => {
      expect(() =>
        parseMigration("0001_x", `${statement}; CREATE TABLE a (b int);`),
      ).toThrow(migrationErrors.transactionControl);
    },
  );

  it("normalises line endings before hashing", () => {
    expect(checksum("a\r\nb\r\n")).toBe(checksum("a\nb\n"));
    expect(checksum("a\nb\n")).not.toBe(checksum("a\nc\n"));
  });
});

describe("loadMigrations", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "lovvagt-migrations-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("loads .sql files sorted by name and ignores other files", () => {
    writeFileSync(join(directory, "0002_second.sql"), "SELECT 2;");
    writeFileSync(join(directory, "0001_first.sql"), "SELECT 1;");
    writeFileSync(join(directory, "README.md"), "notes");

    expect(loadMigrations(directory).map((m) => m.name)).toEqual([
      "0001_first",
      "0002_second",
    ]);
  });

  it.each(["1_first.sql", "0001-first.sql", "0001_First.sql", "0001_.sql"])(
    "rejects the file name %s",
    (file) => {
      writeFileSync(join(directory, file), "SELECT 1;");
      expect(() => loadMigrations(directory)).toThrow(
        migrationErrors.invalidFileName,
      );
    },
  );

  it("rejects two files with the same number", () => {
    writeFileSync(join(directory, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(directory, "0001_b.sql"), "SELECT 1;");
    expect(() => loadMigrations(directory)).toThrow(
      migrationErrors.duplicateNumber,
    );
  });
});

describe("migrate", () => {
  const first = parseMigration("0001_first", "CREATE TABLE a (id int);");
  const second = parseMigration(
    "0002_second",
    "CREATE TABLE b (id int); INSERT INTO a VALUES (1);",
  );

  it("applies migrations in order and records each one", async () => {
    const seen: string[] = [];
    const result = await migrate(database.sql, [second, first], {
      onApplied: (name) => seen.push(name),
    });

    expect(result).toEqual({
      applied: ["0001_first", "0002_second"],
      alreadyApplied: 0,
    });
    expect(seen).toEqual(["0001_first", "0002_second"]);
    expect(await recorded()).toEqual([
      { name: "0001_first", checksum: first.checksum },
      { name: "0002_second", checksum: second.checksum },
    ]);
    expect(await tableNames()).toEqual(["a", "b", "schema_migrations"]);
  });

  it("applies nothing on a second run", async () => {
    await migrate(database.sql, [first, second]);
    const before = await recorded();

    expect(await migrate(database.sql, [first, second])).toEqual({
      applied: [],
      alreadyApplied: 2,
    });
    expect(await recorded()).toEqual(before);
    expect(await database.sql.query("SELECT id FROM a")).toEqual([{ id: 1 }]);
  });

  it("applies only the pending migrations", async () => {
    await migrate(database.sql, [first]);

    expect(await migrate(database.sql, [first, second])).toEqual({
      applied: ["0002_second"],
      alreadyApplied: 1,
    });
  });

  it("fails on a changed checksum and applies nothing", async () => {
    await migrate(database.sql, [first]);
    const changed = parseMigration(
      "0001_first",
      "CREATE TABLE a (id int, extra text);",
    );

    await expectMigrationError(
      migrate(database.sql, [changed, second]),
      migrationErrors.checksumMismatch,
      "0001_first",
    );
    expect(await tableNames()).toEqual(["a", "schema_migrations"]);
  });

  it("fails when an applied migration's file is gone", async () => {
    await migrate(database.sql, [first]);

    await expectMigrationError(
      migrate(database.sql, [second]),
      migrationErrors.missingFile,
      "0001_first",
    );
  });

  it("fails when a pending migration sorts before an applied one", async () => {
    const standalone = parseMigration(
      "0002_second",
      "CREATE TABLE b (id int);",
    );
    await migrate(database.sql, [standalone]);

    await expectMigrationError(
      migrate(database.sql, [first, standalone]),
      migrationErrors.outOfOrder,
      "0001_first",
    );
    expect(await tableNames()).toEqual(["b", "schema_migrations"]);
  });

  it("rolls back a failing migration together with its record", async () => {
    const broken = parseMigration(
      "0002_broken",
      "CREATE TABLE b (id int); SELECT no_such_column FROM a;",
    );

    const error = await migrate(database.sql, [first, broken]).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({
      migration: "0002_broken",
      sqlState: "42703",
      message: `${migrationErrors.failed} (migration 0002_broken, SQLSTATE 42703)`,
    });
    // The driver's message names the column; it must not be passed on.
    expect((error as Error).message).not.toContain("no_such_column");
    expect(await recorded()).toEqual([
      { name: "0001_first", checksum: first.checksum },
    ]);
    expect(await tableNames()).toEqual(["a", "schema_migrations"]);
  });

  it("does not pass on a driver message from the bookkeeping queries", async () => {
    const leaky: SqlExecutor = {
      query: () =>
        Promise.reject(
          Object.assign(new Error("connect postgres://user:secret@host/db"), {
            code: "",
          }),
        ),
      transaction: () => Promise.reject(new Error("unused")),
    };

    const error = await migrate(leaky, [first]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toBe(migrationErrors.bookkeeping);
  });
});

describe("0001_initial", () => {
  const odaTables = [
    "periode",
    "sag",
    "sagstrin",
    "afstemning",
    "stemme",
    "aktoer",
    "sag_aktoer",
    "dokument",
    "sag_dokument",
    "fil",
    "emneord",
    "emneord_sag",
  ];
  const lovvagtTables = ["tracked_sag", "fil_blob", "blob_op", "ingest_run"];

  beforeEach(async () => {
    await migrate(database.sql, loadMigrations(migrationsDirectory));
  });

  it("creates every table named in spec 002", async () => {
    expect(await tableNames()).toEqual(
      [...odaTables, ...lovvagtTables, "schema_migrations"].sort(),
    );
  });

  it("gives every ODA table an integer id key, raw jsonb and opdateringsdato", async () => {
    const rows = await database.sql.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.column_name IN ('id', 'raw', 'opdateringsdato')`,
    );
    const columns = new Map(
      rows.map((row) => [
        `${String(row.table_name)}.${String(row.column_name)}`,
        `${String(row.data_type)} ${String(row.is_nullable)}`,
      ]),
    );
    for (const table of odaTables) {
      expect(columns.get(`${table}.id`)).toBe("integer NO");
      expect(columns.get(`${table}.raw`)).toBe("jsonb NO");
      expect(columns.get(`${table}.opdateringsdato`)).toBe(
        "timestamp with time zone NO",
      );
    }

    const keys = await database.sql.query(
      `SELECT tc.table_name, string_agg(kcu.column_name, ',') AS columns
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
        WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
        GROUP BY tc.table_name`,
    );
    const primaryKeys = new Map(
      keys.map((row) => [String(row.table_name), String(row.columns)]),
    );
    for (const table of odaTables) expect(primaryKeys.get(table)).toBe("id");
  });

  it("uses snake_case ASCII names only", async () => {
    const rows = await database.sql.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    for (const row of rows) {
      expect(String(row.table_name)).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(String(row.column_name)).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("allows only one running ingest_run lease", async () => {
    const insert =
      "INSERT INTO ingest_run (status, lease_expires_at) VALUES ($1, now() + interval '5 minutes')";
    await database.sql.query(insert, ["running"]);
    await database.sql.query(insert, ["completed"]);

    await expect(database.sql.query(insert, ["running"])).rejects.toMatchObject(
      { code: "23505" },
    );
  });

  it("stores and returns a raw record unchanged", async () => {
    const raw = {
      id: 101687,
      titel: "Forslag til lov om æ, ø og å",
      nested: [1],
    };
    await database.sql.query(
      `INSERT INTO sag (id, typeid, statusid, periodeid, opdateringsdato, raw)
       VALUES ($1, 3, 11, 163, $2, $3)`,
      [raw.id, "2025-06-04T12:00:00+02:00", JSON.stringify(raw)],
    );

    expect(
      await database.sql.query("SELECT raw FROM sag WHERE id = $1", [raw.id]),
    ).toEqual([{ raw }]);
  });
});

describe("environmentRefusal", () => {
  it("allows development without a flag", () => {
    expect(environmentRefusal("development", [])).toBeUndefined();
  });

  it.each(["preview", "production"] as const)(
    "refuses %s without a flag",
    (environment) => {
      expect(environmentRefusal(environment, [])).toBe(
        `refusing to migrate the ${environment} database without --environment=${environment}`,
      );
    },
  );

  it.each(environments)("allows %s with a matching flag", (environment) => {
    expect(
      environmentRefusal(environment, [`--environment=${environment}`]),
    ).toBeUndefined();
  });

  it.each([
    ["development", "production"],
    ["development", "preview"],
    ["preview", "production"],
    ["production", "preview"],
    ["production", "development"],
  ] as const)("refuses %s with a flag naming %s", (actual, flag) => {
    expect(environmentRefusal(actual, [`--environment=${flag}`])).toBe(
      `--environment=${flag} does not match the actual environment (${actual})`,
    );
  });

  it.each([[["--environment=staging"]], [["--environment="]]])(
    "refuses an unknown environment name %j",
    (args) => {
      expect(environmentRefusal("production", args)).toBe(
        "--environment must be production, preview or development",
      );
    },
  );

  it.each([
    [["--env=production"]],
    [["production"]],
    [["--environment=production", "--environment=production"]],
  ])("refuses other arguments %j", (args) => {
    expect(environmentRefusal("production", args)).toMatch(/^usage:/);
  });
});
