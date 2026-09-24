# fence-aware.md — §1.4 fence state machine golden fixture
# Case: fenced `## Index` heading and fenced `**20...**` title-looking line must be INVISIBLE to the
# grammar (no B9, no new entry, no B8); a real title right after the fence must still parse; a
# backtick-span containing `[[tag]]` inside prose must not be taken as a link.

**2026-01-01 — before the fence** [fx:before-fence]
body line one.
```
## Index
this is inside a fence and must not be treated as a real H2 Index heading (no B9 here)
**2026-01-02 — fake title inside fence** [fx:fake-inside-fence]
this whole block, including the line above, is inert to the parser
```
after-fence prose line, still part of [fx:before-fence]'s body since the fence didn't end the block.
A backtick span with a fake link inside: `see [[fx:not-a-real-link]] here` must not become a link.
But an unquoted real link here IS a link: [[fx:before-fence]].

**2026-01-02 — after the fence** [fx:after-fence]
this is a normal second entry, parsed normally.

~~~
## Index
tilde-fenced Index heading, also inert.
~~~

**2026-01-03 — after tilde fence** [fx:after-tilde-fence]
normal third entry.
