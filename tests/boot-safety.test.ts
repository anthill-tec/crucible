// CR-CRU-001 §S5 — Boot safety (Store.open + corrupt-db recovery)
import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store.ts";

function freshTmpDir(): string {
  // NEVER inside the repo — a fresh OS tmpdir per test.
  return fs.mkdtempSync(path.join(os.tmpdir(), "crucible-test-"));
}

describe("Store.open — static factory", () => {
  test("normal path: opens/creates a db, equivalent to the constructor", () => {
    const dir = freshTmpDir();
    const dbPath = path.join(dir, "crucible.db");

    const store = Store.open(dbPath);

    expect(fs.existsSync(dbPath)).toBe(true);

    const key = crypto.randomUUID();
    store.addProject({ key, name: "x", type: "backend", sutRoot: "/tmp" });
    const project = store.getProject(key);

    expect(project).not.toBeNull();
    expect(project?.name).toBe("x");
    expect(project?.key).toBe(key);
  });
});

describe("Store.open — corrupt-db recovery (§S5 AC)", () => {
  test("garbage file at db path: open succeeds, a sibling *.corrupt-<epoch> file exists, fresh store is empty and usable", () => {
    const dir = freshTmpDir();
    const dbPath = path.join(dir, "crucible.db");
    fs.writeFileSync(dbPath, "this is not sqlite");

    const store = Store.open(dbPath);

    // Boot must never fail because of a bad file.
    expect(store.listProjects().length).toBe(0);

    const siblings = fs.readdirSync(dir);
    const corruptSibling = siblings.find((f) => /\.corrupt-\d+$/.test(f));
    expect(corruptSibling).toBeDefined();

    // Fresh store is usable.
    const key = crypto.randomUUID();
    store.addProject({ key, name: "recovered", type: "backend", sutRoot: "/tmp" });
    const project = store.getProject(key);
    expect(project?.name).toBe("recovered");
  });
});
