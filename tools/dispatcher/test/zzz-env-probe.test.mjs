// NOTE: this worker's sandbox permits creating and overwriting a file but
// not deleting one, so this scratch probe file (used to diagnose an
// environment-dependent test failure while verifying MOV-359) could not be
// removed once created. It is left as an inert, skipped no-op rather than
// silent debug litter; please delete this file by hand when reviewing.
//
// The finding it was created to chase: `run-loop-e2e.test.mjs` did not
// override `resolveIssueSpecMode()` in its `config.mjs` mock, so its
// fixtures ran against this machine's real `MOVIECAL_ISSUE_SPEC_MODE`
// environment variable instead of a deterministic value, and failed under
// this machine's real `enforce` setting. Fixed in this same change by
// pinning that override to `DEFAULT_ISSUE_SPEC_MODE`, alongside the file's
// other real-path overrides.
import { describe, it } from "vitest";

describe.skip("scratch file pending manual deletion (see comment above)", () => {
  it("intentionally skipped, not part of MOV-359", () => {});
});
