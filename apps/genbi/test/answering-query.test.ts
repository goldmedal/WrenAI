import { describe, expect, it } from "vitest";
import { namedAnswerSql, selectAnsweringCandidate, sqlKey } from "../harness/render/answering-query.js";

const CORRECT = "SELECT COUNT(*) AS n FROM orders";
const STRAY = "SELECT COUNT(*) AS n FROM orders WHERE status = 'completed'";
const seeds = [{ columns: ["n"], rows: [[99]], sql: CORRECT }, { columns: ["n"], rows: [[67]], sql: STRAY }];

describe("selecting the answering query among several successful ones", () => {
  it("prefers the query the terminal value names over the last table", () => {
    expect(selectAnsweringCandidate(seeds, { columns: ["n"], rows: [[99]], definition: { sql: CORRECT } })).toBe(seeds[0]);
    expect(selectAnsweringCandidate(seeds, JSON.parse(JSON.stringify({ sql: `${CORRECT} ;` })))).toBe(seeds[0]);
  });
  it("returns nothing for a named query that never ran, and the last table for an unnamed value", () => {
    expect(selectAnsweringCandidate(seeds, { definition: { sql: "SELECT 1" } })).toBeUndefined();
    expect(selectAnsweringCandidate(seeds, "prose answer")).toBe(seeds[1]);
    expect(selectAnsweringCandidate(seeds, undefined)).toBe(seeds[1]);
    expect(selectAnsweringCandidate([], "prose")).toBeUndefined();
  });
  it("reads the SQL only from definition.sql or a top-level sql string", () => {
    expect(namedAnswerSql({ definition: { sql: " " } })).toBeUndefined();
    expect(namedAnswerSql({ definition: { sql: CORRECT }, sql: STRAY })).toBe(CORRECT);
    expect(namedAnswerSql([{ definition: { sql: CORRECT } }])).toBeUndefined();
    expect(sqlKey("SELECT  1\n  FROM t ;")).toBe("SELECT 1 FROM t");
  });
});
