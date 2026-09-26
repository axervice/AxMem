// Vendored from: domenic/path-is-inside, lib/path-is-inside.js
// Source:  https://github.com/domenic/path-is-inside/blob/1.0.2/lib/path-is-inside.js
// Version: 1.0.2 (npm dist-tags @2016-09-10; shasum 365417dede44430d1c11af61027facf074bdfc53)
// License: WTFPL OR MIT (dual) — full text in ./path-is-inside.LICENSE
//
// Vendored verbatim (2026-09-17, fab 盲攻 HIGH-2 + Opus 复现, the maintainer 铁律「基建先抄开源再优化」):
// used by pmm-core.cjs's isUnderCanonical() — the shared "is this file path inside the canonical
// memory directory" check that pmm-trigger-write-gate.cjs and pmm-entry-length-watch.sh both call,
// replacing two independently hand-rolled prefix-string checks that had already diverged (one too
// strict and bypassable via `\\?\` device-namespace prefixes / doubled slashes / an embedded `.`
// segment inside the canonical prefix, one accidentally not bypassed by those same three shapes only
// because it used a loose substring match with a different blind spot of its own). DO NOT modify the
// code below — if it needs to change, pull a newer upstream version and update this header instead.
"use strict";

var path = require("path");

module.exports = function (thePath, potentialParent) {
    // For inside-directory checking, we want to allow trailing slashes, so normalize.
    thePath = stripTrailingSep(thePath);
    potentialParent = stripTrailingSep(potentialParent);

    // Node treats only Windows as case-insensitive in its path module; we follow those conventions.
    if (process.platform === "win32") {
        thePath = thePath.toLowerCase();
        potentialParent = potentialParent.toLowerCase();
    }

    return thePath.lastIndexOf(potentialParent, 0) === 0 &&
		(
			thePath[potentialParent.length] === path.sep ||
			thePath[potentialParent.length] === undefined
		);
};

function stripTrailingSep(thePath) {
    if (thePath[thePath.length - 1] === path.sep) {
        return thePath.slice(0, -1);
    }
    return thePath;
}
