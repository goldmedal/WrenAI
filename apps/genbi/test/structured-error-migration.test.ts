import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Store } from "../server/db.js";
import { getAskSessionData, streamTurn, type TurnDeps } from "../server/turn.js";

it("migrates legacy error-code-null rows idempotently without changing three persisted turns or their answer", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "structured-error-migration-"));
  const file = path.join(root, "state.sqlite"); let store = new Store(file);
  try {
    const session = store.createSession("Orders");
    for (const id of ["answer", "failure", "retry"]) {
      store.createTurn({ id, sessionId: session.id, question: id, composedInput: null });
      store.resolveTurn(id, { backend: id === "answer" ? "openshell" : null, resultKind: id === "answer" ? "answer" : "error", answerSummary: id === "answer" ? "7" : null, traceJson: "[]", errorMessage: id === "answer" ? null : "Structured runtime failed." });
    }
    store.insertEvent({ sessionId: session.id, turnId: "answer", kind: "answer", payload: { id: "verified", kind: "answer", answer: { form: "text", text: "7", verified: true, dataAnswer: true } } });
    const before = ["answer", "failure", "retry"].map(id => store.getTurn(id)); const events = store.listEventsForSession(session.id);
    store.close(); const db = new DatabaseSync(file); db.exec("ALTER TABLE turns DROP COLUMN error_code"); db.close();
    for (let launch = 0; launch < 2; launch++) {
      store = new Store(file);
      expect(["answer", "failure", "retry"].map(id => store.getTurn(id))).toEqual(before);
      expect(store.listEventsForSession(session.id)).toEqual(events);
      expect(getAskSessionData(store, session.id)).toMatchObject({ error: { kind: "runtime", code: "runtime.failed", message: "Structured runtime failed." } });
      const replay: unknown[] = [];
      const deps: TurnDeps = { store, route: async () => { throw Error("replay must not execute"); }, baseRouteOptions: { authChoice: { mode: "subscription", provider: "claude" }, profileSource: "fixture", userProject: "fixture" } };
      await streamTurn(deps, session.id, "retry", async frame => { replay.push(frame); });
      expect(replay).toEqual([{ event: "error", data: { kind: "runtime", code: "runtime.failed", message: "Structured runtime failed." } }]);
      store.close();
    }
  } finally { try { store.close(); } catch {} rmSync(root, { recursive: true, force: true }); }
});
