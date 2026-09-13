# 7. `packages/shared` wird aus der Quelle konsumiert, nicht als Artefakt

- **Status:** accepted
- **Date:** 2026-07-26

## Context

ADR-0006 legt pnpm-Workspaces fest, sagt aber nichts darüber, **wie** die Apps
das interne Paket `packages/shared` einbinden. Die naheliegende Variante ist das
vorkompilierte Artefakt: `exports` zeigt auf `dist/`, gebaut wird über
`pnpm -r build` und ein `prepare`-Skript zur Installationszeit.

Sie hat drei Befunde erzeugt, die alle auf diese eine Entscheidung zurückgehen:

1. **Tests liefen gegen einen veralteten Build.** `pnpm -r test` und
   `pnpm -r lint` bauen nicht. Im Beleg wurde der Wire-Contract in `shared`
   gebrochen (`status: z.literal('never-matches')`) — sämtliche Tests in
   `apps/api` und `apps/web` blieben **grün**. Ein neu exportiertes Symbol war
   im Test schlicht `undefined`.
2. **Das Frontend-Bundle war doppelt so groß wie nötig.** CommonJS ist für den
   Bundler nicht tree-shakebar, also landete die komplette Zod-Oberfläche im
   Browser: 543,0 kB roh / 127,1 kB gzip für eine Seite mit einer Überschrift,
   gegenüber 253,8 / 76,5 mit ESM und denselben Schemas.
3. **Das `prepare`-Skript war eine Krücke**, die den ersten Punkt halb verdeckte
   und bei einem reinen Produktions-Install bricht, weil dort kein `tsc` liegt —
   was den geplanten schlanken Laufzeit-Images (`pnpm deploy`) im Weg steht.

Punkt 1 ist der schwerwiegende. `CONTRIBUTING.md` erklärt die Zod-Schemas in
`packages/shared` zur **Wahrheit** für Client und Server und verlangt für
jede Rechte- und Isolationsregel einen Test, der den unerlaubten Zugriff
scheitern sieht. Ein Testaufbau, der gegen kompilierten Altstand läuft, würde
eine Tenant-Isolation „belegen", die im Quellcode
längst nicht mehr existiert. Ein grüner Test wäre dann kein Nachweis, sondern
ein Trugschluss — und zwar ausgerechnet an der Sicherheitsgrenze.

## Decision

Interne Workspace-Pakete werden im **Entwicklungs- und Testpfad aus der Quelle**
konsumiert; kompilierte Artefakte bleiben dem **Node-Laufzeitpfad** vorbehalten.

Umgesetzt über bedingte `exports` in `packages/shared/package.json`: eine
`development`-Condition zeigt auf `./src/index.ts`, die übrigen Conditions auf
den gebauten Output. Die Typen laufen über `paths` im tsconfig.

Die Konsumenten aktivieren die Condition **gezielt nur im Dev- und Testpfad**:
in der Vitest-Konfiguration von `apps/api` und in `apps/web` nur für
`command === 'serve'`. `vite build` behält bewusst die Standard-Auflösung und
nimmt damit den Artefaktpfad — so wird genau der Weg gebaut und im E2E-Lauf
geprüft, der später auch in Produktion läuft.

Der Build erzeugt **beides**: ESM für den Browser (tree-shakebar) und CommonJS
für NestJS. Das `prepare`-Skript entfällt ersatzlos.

## Consequences

- **Tests messen den Quellcode.** Eine Änderung an `shared` wirkt sofort auf
  Tests und Lint beider Apps; ein gebrochener Contract wird rot, statt
  unbemerkt zu bleiben. Der Nachweis dafür ist ein Negativtest: den Contract
  absichtlich brechen und die Tests scheitern sehen — nicht bloß „grün" melden.
- **Kleineres Bundle**, und der Effekt wächst mit dem Paket: bedingte Logik,
  Vererbungs-Merge und Export-Formatierung liegen in `shared`, also
  auch rein serverseitige Anteile, die sonst mit in den Browser gingen. Die
  Zielgruppe füllt zum Teil mobil aus — das ist ein Produktmerkmal, keine
  Kosmetik.
- **Zwei Auflösungswege**, die auseinanderlaufen können: was in der Quelle
  funktioniert, muss nicht im gebauten Artefakt funktionieren. Gegenmaßnahme:
  der E2E-Lauf und der Docker-Build benutzen den Artefaktpfad, prüfen ihn also
  bei jedem CI-Lauf mit.
- **Jeder neue Konsument muss die Condition setzen.** Wer ein Paket einbindet,
  ohne `resolve.conditions` zu ergänzen, bekommt stillschweigend wieder den
  Artefaktpfad — mit genau dem Problem von oben. Gehört in die Checkliste, wenn
  in einem späteren Meilenstein ein weiteres internes Paket entsteht.
- **Kein `prepare` mehr**, damit ist der Weg zu `pnpm deploy --prod` und einem
  schlanken, non-root Laufzeit-Image frei.

## Referenzen

- [ADR-0006](0006-pnpm-workspaces.md) — pnpm-Workspaces als Grundlage.
- `CONTRIBUTING.md` — Zod-Schemas in `packages/shared` als
  Wahrheit; Testregeln.
