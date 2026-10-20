// A stand-in `wren-context-loader` for route tests: `<project> -o <snapshot> --catalog-out <catalog>`.
// FAKE_LOADER_DECLARED is a comma-separated list of declared default rule ids the catalog announces (unset: the catalog declares none).
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
writeFileSync(after("-o"), JSON.stringify({ context_version: 2, parseable: true }));
const declared = process.env.FAKE_LOADER_DECLARED?.split(",").filter(Boolean) ?? [];
writeFileSync(after("--catalog-out"), JSON.stringify(declared.length ? { catalog_version: 1, declared_defaults: declared } : { catalog_version: 1 }));
