import { describe, expect, it } from "vitest";
import { readYamlScalarField } from "../harness/setup/yaml-scalar.js";

describe("readYamlScalarField", () => {
  it.each([
    ["data_source: duckdb", "duckdb"],
    ["data_source: duckdb  # change to your datasource type", "duckdb"],
    ["data_source: duckdb # c", "duckdb"],
    ['data_source: "duckdb"', "duckdb"],
    ["data_source: 'duckdb'", "duckdb"],
    ['data_source: "duckdb"  # comment', "duckdb"],
    ["data_source: 'duckdb' # comment", "duckdb"],
    ['data_source: "a#b"', "a#b"],
    ["data_source: 'a#b'", "a#b"],
    ['data_source: "a #b"  # real comment', "a #b"],
    ["data_source: a#b", "a#b"],
    ["data_source: a#b # c", "a#b"],
  ])("%s -> %s", (line, expected) => {
    expect(readYamlScalarField(`name: x\n${line}\nother: y\n`, "data_source")).toBe(expected);
  });

  it.each([
    "data_source:",
    "data_source:   ",
    "data_source:  # not set yet",
    "data_source: # c",
    'data_source: ""',
  ])("reads %j as empty/absent", (line) => {
    expect(readYamlScalarField(`${line}\n`, "data_source") ?? "").toBe("");
  });

  it("returns undefined when the field is missing", () => {
    expect(readYamlScalarField("name: x\n", "data_source")).toBeUndefined();
  });

  it("does not match an indented or prefixed key", () => {
    expect(readYamlScalarField("  data_source: a\nx_data_source: b\n", "data_source")).toBeUndefined();
  });
});
