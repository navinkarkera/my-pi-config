---
name: test-consolidation
description: Consolidates an existing test suite into fewer user-behavior integration journeys while preserving behavior, security, transaction, and error-path coverage. Also trims framework-default, library-format and branch-added tests that prove nothing about the application. Use when the user asks to reduce, merge, trim, deduplicate, or redesign existing tests; replace overlapping unit tests with API/database end-to-end or journey tests; or refactor test files without changing production code.
---

# Test Consolidation

Refactor an existing suite into fewer, stronger journeys. This is not TDD:
production code and tests already exist; the goal is coverage-preserving redesign,
not red-green feature development.

## Boundary

- Name the exact files/suites in scope. Legacy, unrelated, or untouched tests stay out.
- Never change production code. If a test reveals a production bug, stop and report it.
- No full-suite run, commit, or push without explicit permission.

## Workflow

1. **Inventory.** List modules/classes/test counts and the production path each covers. Trace the real call chain (entry point -> validation -> service -> ORM/DB) before classifying.
2. **Classify** every group:
   - *User journey*: user-visible outcome through real internal layers.
   - *Focused complicated unit*: complex pure logic, security policy/allowlists, transaction/concurrency failures, external adapters, DB constraints/schema/collations.
   - *Redundant implementation detail*: mock-call counts, private helpers, per-layer duplicates, single-assertion smoke tests.
   Run the framework-default pass below in this step, before asking for approval.
3. **Get approval before edits.** Confirm: scope boundary; integration boundary (what is real vs faked); which external systems to mock; assertion strictness; DB/CI policy (which backends run, whether backend-only tests may skip); consolidation aggressiveness (target count).
4. **Coverage ledger.** For every assertion/contract to be removed, record its replacement journey, retained unit, or an explicit user-approved drop. No unmapped deletions.
5. **Build first.** Add journeys before deleting duplicates. Reuse fixtures/helpers; add one only when it sharpens a journey.
6. **Delete.** Remove only duplicates now covered by a journey or explicitly approved for drop.
7. **Coverage-gap review.** Re-read each deleted test against the ledger. Confirm security, atomicity, and error paths survive. Verify no vacuous tests.

## Framework-default pass

For each candidate test ask: *what application regression would this catch if the
dependency works correctly?* If you can’t name one, flag the test for trimming or removal.

Flag for trimming or a drop:
- Dependency behavior: ordinary ORM save/reload round-trips, field-length `full_clean` that only exercises a declared `max_length`, exact generic library output (PEM header, UUID version, `kty`), default permission enumeration, default SQL collation, or a query compared against the backend itself.
- Metadata that restates an outcome another test already proves: field, index or FK introspection duplicated by a real constraint error or by the migration suite.
- Trivial display implementation (`__str__` text) that no caller relies on.
- Branch scope: diff merge-base..worktree, and flag tests this branch added for behavior that is unchanged legacy or a proposal since reverted. Never auto-remove unrelated pre-existing tests; list them for a decision.
- Stacked PRs: record the exact parent SHA and review the exclusive diff against it. Keep parent-owned tests as-is unless the change deliberately alters their app contract, and during a restack do not restore tests a predecessor removed.

Trim mixed tests to the application contract rather than discarding them:
- signing-key lifecycle (material persists, kid reused, JWK rebuilt) vs library formatting (PEM header, UUID version, `kty`);
- legacy permissions and group assignments surviving a migration vs Django's generated CRUD permission list.

Keep delegated-but-app-owned contracts: security and privacy defaults, ownership, constraints, transaction and replay behavior, external adapters, deliberate compatibility shims.

A small drop still goes through step 3 approval and step 4's ledger as an intentional drop; it needs no separate policy.

## Journey rules

- One journey per user outcome, not per endpoint or branch. Split giant journeys by outcome or use named subtests for independent phases.
- Drive real internal layers. Mock only externally owned systems (third-party APIs, platform registries, clocks, queues); never mock the code under test.
- Use concrete values; assert positive and negative outcomes; assert forbidden secrets/fields are absent.
- Prefer user-visible subset assertions plus explicit forbidden data over brittle whole-payload equality. Assert exact values only where they are the contract.
- Keep the run small: fewer tests, same user-visible and security guarantees.

## Verify and report

- Run only the approved focused modules unless the user allows the full suite.
- Run the repository's CI quality target and `git diff --check` before declaring readiness. If scope or environment permits only scoped lint, report exactly what ran and say the CI quality gate was not run.
- Report passed vs skipped and note environment/backend limits (e.g. SQLite skips real-DB collation checks).
- Report the final ledger outcome and any unmapped or intentionally dropped coverage.
- Report the before/after test count and the net test line change. Never lengthen a journey just to lower a count; justify any growth.

## Example

Before: 20 API tests, 15 validator tests, 10 service tests; the same empty-key rule and error assertion duplicated at three layers.

After: 6 API journeys (create, auth matrix, update, atomic rejection, external-boundary check, real-DB constraint), one retained validator unit for merged-state logic, one retained transaction-rollback unit. The three empty-key tests become one `POST /resource` journey asserting 400 and no row.

Result: 45 -> 8 tests; same contracts, each mapped in the ledger.