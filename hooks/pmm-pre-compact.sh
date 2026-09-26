#!/usr/bin/env bash
# PMM pre-compact hook — blocks /compact and asks Claude to run pmm:save first
printf '{"decision":"approve","reason":"PMM reminder: remember to run pmm:save before compacting to preserve structured memory"}\n'
