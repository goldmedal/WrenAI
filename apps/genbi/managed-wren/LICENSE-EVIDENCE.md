# Managed runtime redistribution evidence

`release-inputs.json` pins the runtime bytes. `license-inputs.json` pins the
supplemental evidence sources; it does not change or repackage those bytes.

The release collector:

- Matches every install-only CPython file/link against the exact PBS full
  distribution before using its `PYTHON.json` dependency map and license texts.
- Records bundled native libraries and exact dependency source identities.
  System framework/library links remain identified as system dependencies.
- Includes Tcl/Tk, Itcl and Thread notices from the exact Tcl/Tk source archives,
  including the platform/library notices missing from the install-only archive.
- Preserves license/NOTICE text found inside every wheel. The three historical
  wheels lacking documents receive supplements pinned to their exact wheel hash:
  Loguru's release commit, Wren's release commit/license path map, and the
  wren-core-py source distribution.
- Rejects changed hashes, a mismatched full Python build, an unaccounted bundled
  library, or a wheel without documents. Changing a supplemented wheel requires
  an explicit update to its evidence pins.

The PBS and wheel review inventories contain the full text, source identity,
member path and hash of every document. Their shared `noticesSha256` identifies
`THIRD_PARTY_NOTICES.txt`. Publish preparation validates both inventories against
the candidate before downloading any runtime asset, then writes that companion
next to the original archives/wheels. Release upload includes the companion.

The protected approval digest remains the SHA-256 of the exact concatenation:

1. `managed-wren-manifest.candidate.json`
2. `pbs-license-inventory.json`
3. `wheel-license-inventory.json`

Thus changing document text, attribution, provenance, component mappings or the
companion hash invalidates approval. Source archives and unapproved runtime
binaries are never uploaded as pre-approval workflow artifacts; only review JSON
is retained. The review JSON now includes redistribution notices for inspection.

Generate evidence with `managed-wren-release-licenses.py`, then bind the companion
with `managed-wren-release.mjs prepare-notices <review-directory>`. The collector
accepts a local hash-keyed source cache for repeatable offline verification.
`managed-wren-release.test.mjs` exercises both collectors and the actual publish
preparation command with deterministic fixture bytes and no network.

Document collection and successful validation are technical completeness checks,
not automatic license approval. A reviewed candidate still needs its explicit
protected-environment digest before public runtime publication.
