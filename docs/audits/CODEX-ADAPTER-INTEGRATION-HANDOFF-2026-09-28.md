# Codex adapter integration handoff (2026-09-28, Miami)

Codex integration only; this does not mark the broader AxMem project complete.
The isolated adapter suite passed 34/34, and the session-level PreCompact fix
passed independent targeted review. A real CLI manual compaction completed;
its captured test receipt and journal remained present afterward. Delivery of
the post-compaction SessionStart reminder and desktop compaction/recovery have
not been confirmed end to end. Pending local receipts remain unreviewed; their
count is not a count of unfinished development tasks. Captured prompts may also
come from automated agent sessions and must not be assumed to be user rulings.

This handoff includes only README.md, wire.sh (comment correction only),
install-hooks.cjs, raw-receipts.cjs, and test-raw.cjs in this directory. Existing
AxMem work and earlier commits are outside this integration's acceptance scope.
The next project session owns further AxMem changes; do not run concurrent
writers in the same checkout. Raw receipt contents and local account settings
are not included in this commit.
