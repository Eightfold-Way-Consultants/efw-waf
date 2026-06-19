# estimator-logs — moved to a global skill

This estimator log-investigation tooling now lives as a **global Claude Code skill** at
`~/.claude/skills/estimator-logs/` (invoke with `/estimator-logs`), because it's f8
infrastructure (fixed us-west-1 instance IDs, `C:\temp\EstimatorLogs`, BPTrace) that's
relevant across repos — not specific to `efw-waf`.

Moved 2026-06-19. What's there: CloudWatch + SSM error triage, per-state IIS request-log
checks, the IP-pin `foreign IP address rejected` analysis recipe, the `origin-xff-probe.sh`
deterministic viewer-IP test harness, and the BPTrace flush / `LastWriteTime`-trap notes.

If you need it version-controlled with this repo again, copy it back from the global skills dir.
