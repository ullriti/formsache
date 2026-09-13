#!/usr/bin/env bash
#
# audit-report.sh — `pnpm audit` as a **report**, against a committed
# baseline (review finding, 2026-08-12).
#
# ## Why a report and not a gate
#
# Blocking, it would have been red on the day it came into being: eight
# advisories stood open, and five of them hung on **development tooling** —
# Prisma CLI, ESLint, Vite —, which no production server ever runs. A gate that
# is red at once gets switched off and not read; this repository has already
# been through exactly that once (the secret scan of the `publish` job,
# 2026-08-12).
#
# ## Why a baseline nevertheless
#
# A step that outputs the same lines on every run is invisible after the
# third week. The baseline turns „n advisories" into the
# only question that counts: **has one been added?** Only for that does
# this script write a `::warning`.
#
# ## What it does *not* do
#
# It does not judge exploitability. `.github/audit-baseline.json` says how
# many advisories were known on the day they were taken in — not that they are
# harmless. **Fixed** they are elsewhere: since 2026-08-12 Dependabot raises the
# versions (ADR-0018), and the state thereby fell from eight to one. Why the
# one remains stands in ADR-0018 §4 — one sentence per advisory, and the
# yardstick is the reachability of the place, not the score of the vendor.
#
# Usage:
#   scripts/audit-report.sh              # report; return 0, unless the run measures nothing
#   scripts/audit-report.sh --update     # set the baseline to the current state
#
# Return: 0 = measured (also with new advisories — that is a warning),
#         1 = **could not measure** (no network, broken output). The
#         difference is the point: „no advisories" and „not measured"
#         must not look the same.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BASELINE="$ROOT/.github/audit-baseline.json"

note() { printf '==> %s\n' "$1"; }

raw="$(pnpm audit --json 2>/dev/null)"
# ⚠️ **The case that looks quietly green.** Without a network `pnpm audit`
# answers with an error and empty stdout — and a script that turns that into
# „0 advisories" reports safety where there was no measurement.
if [ -z "$raw" ]; then
  echo "::error::pnpm audit lieferte keine Ausgabe — es wurde nichts gemessen" >&2
  exit 1
fi

summary="$(printf '%s' "$raw" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    let report;
    try {
      report = JSON.parse(input);
    } catch {
      process.stderr.write("pnpm audit lieferte kein JSON\n");
      process.exit(1);
    }
    const counts = report?.metadata?.vulnerabilities;
    if (counts === undefined) {
      process.stderr.write("die Ausgabe trägt keine metadata.vulnerabilities\n");
      process.exit(1);
    }
    const advisories = Object.values(report.advisories ?? {});
    const lines = advisories
      .map((entry) => {
        const paths = (entry.findings ?? [])
          .flatMap((finding) => finding.paths ?? [])
          .slice(0, 1);
        return `${entry.severity}\t${entry.module_name}\t${paths[0] ?? "?"}`;
      })
      .sort();
    process.stdout.write(
      JSON.stringify({ counts, total: advisories.length, lines }),
    );
  });
')"
if [ -z "$summary" ]; then
  echo "::error::die Ausgabe von pnpm audit ließ sich nicht auswerten — nicht gemessen" >&2
  exit 1
fi

total="$(printf '%s' "$summary" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).total')"
counts="$(printf '%s' "$summary" | node -pe '
  const c = JSON.parse(require("fs").readFileSync(0,"utf8")).counts;
  ["critical","high","moderate","low","info"].map((k) => `${k}: ${c[k] ?? 0}`).join(" · ")
')"

if [ "${1:-}" = '--update' ]; then
  printf '%s' "$summary" | node -e '
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      const now = JSON.parse(input);
      process.stdout.write(
        JSON.stringify(
          {
            _kommentar:
              "Die Grundlinie für scripts/audit-report.sh. Sie sagt, wie viele " +
              "Meldungen bekannt waren, als sie zuletzt gesetzt wurde — nicht, " +
              "dass sie harmlos sind. Warum eine hier stehenbleibt, steht je " +
              "Meldung in docs/architecture/0018-abhaengigkeitspflege.md §4. " +
              "Neu Hinzugekommenes meldet die CI als " +
              "Warnung. Auffrischen mit: scripts/audit-report.sh --update",
            _gesetzt_am: process.env.AUDIT_BASELINE_DATE ?? "unbekannt",
            total: now.total,
            counts: now.counts,
            lines: now.lines,
          },
          null,
          2,
        ) + "\n",
      );
    });
  ' >"$BASELINE"
  note "Grundlinie gesetzt: $total Meldungen ($counts)"
  exit 0
fi

note "pnpm audit: $total Meldungen — $counts"

if [ ! -f "$BASELINE" ]; then
  echo "::warning::keine Grundlinie unter .github/audit-baseline.json — jede Meldung ist damit „neu\"" >&2
  printf '%s' "$summary" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).lines.join("\n")'
  exit 0
fi

# The comparison runs over the **lines** (severity · package · path), not over
# the number: eight against eight can mean two different sets.
neu="$(printf '%s' "$summary" | node -e '
  const fs = require("fs");
  let input = "";
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    const now = JSON.parse(input);
    const base = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const known = new Set(base.lines ?? []);
    process.stdout.write(now.lines.filter((l) => !known.has(l)).join("\n"));
  });
' "$BASELINE")"

if [ -n "$neu" ]; then
  echo "::warning::neue Meldungen seit der Grundlinie:"
  printf '%s\n' "$neu"
  printf '\n**Neu seit der Grundlinie:**\n\n```\n%s\n```\n' "$neu" \
    >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
else
  note 'nichts Neues seit der Grundlinie'
fi

printf '### pnpm audit\n\n%s Meldungen — %s\n' "$total" "$counts" \
  >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 0
