# unclosed-fence.md — §1.8 / B32 golden fixture (Opus H-8)
# Case: a fence opened but never closed before EOF must be a BLOCKING B32 diagnostic that points at
# the fence's OPENING line — and everything after the open fence (including what looks like a real
# title) must still be swallowed by the fence state machine (inert), not silently dropped with zero
# diagnostic (the pre-fix bug: an unclosed fence ate the rest of the file with no trace).

**2026-01-01 — before the unclosed fence** [fx:before-unclosed-fence]
body line one.

```
this fence never closes.
**2026-01-02 — looks like a title but is inside the unclosed fence** [fx:swallowed-by-unclosed-fence]
this line and everything below it must never become an entry.
