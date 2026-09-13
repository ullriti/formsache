# 10. Eigenes Routing über die History-API statt einer Router-Bibliothek

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Ursprünglich hatte die Anwendung **eine** Ansicht hinter der Anmeldung. Mit dem
Builder kommen mehrere hinzu, und mit dem öffentlichen Ausfüllen
eine Adresse, die per Link in einer E-Mail erreicht wird.

Der Prototyp löst das über eine zentrale Zustandsvariable `view`
(Handoff, *Informationsarchitektur*).
Das genügt für einen Prototyp und für diese Anwendung nicht:

- Ein **veröffentlichtes Formular** wird über einen Link geteilt. Eine
  Zustandsvariable hat keine Adresse.
- Der **Builder wird zwischen Bearbeitern weitergegeben** und mit einem
  Lesezeichen versehen.
- Der **Zurück-Knopf** muss in beiden Fällen tun, was er soll. Genau das ist
  der Punkt, an dem eine `view`-Variable von einem Detail zu einem Fehler wird.

Also echte URLs. Offen war nur, womit.

**React Router** ist die naheliegende Wahl und bringt verschachtelte Layouts,
Data-Loader, Actions, `<Outlet>`, Fehler-Boundaries je Route und routenweises
Code-Splitting mit. Das braucht hier nichts davon: vier Adressen, keine
Verschachtelung, und das Laden von Daten liegt bereits bei TanStack Query — ein
zweiter Lademechanismus daneben wäre eine Quelle von Uneinigkeit, keine
Erleichterung.

`CONTRIBUTING.md` verlangt für jede neue Abhängigkeit eine Begründung und nennt
ausdrücklich die Standardbibliothek als erste Wahl. Das Projekt hat diese
Abwägung mehrfach so entschieden: eigene schlanke Komponentenbibliothek statt
UI-Framework (ADR-0002), eigenes Pointer-Drag-&-Drop statt HTML5-DnD,
Cookie-Serialisierung von Hand statt `cookie-parser`.

## Decision

Das Routing wird **selbst geschrieben**, auf der History-API:

- [`router/routes.ts`](../../apps/web/src/router/routes.ts) — die Routentabelle
  als **reine Funktion** `parseRoute(pathname)` plus je eine Funktion, die einen
  Pfad *baut* (`builderPath`, `publicFormPath`). Eine URL wird damit an genau
  einer Stelle geschrieben und an genau einer gelesen.
- [`router/use-route.ts`](../../apps/web/src/router/use-route.ts) — ein Hook auf
  `useSyncExternalStore`. Die Browser-History *ist* ein externer Speicher, und
  das ist die dafür vorgesehene Form. Der erste Render kennt damit bereits die
  richtige Route; ein Effekt würde eine Bilddauer lang das Dashboard zeigen,
  bevor er auf den Builder umschaltet — sichtbar genau bei dem
  Lesezeichen-Aufruf, für den das Routing überhaupt existiert.

- **Ein Navigationsblocker.** Eine Ansicht mit ungespeicherter Arbeit meldet
  sich mit `blockNavigation(fn)` an; `navigate()` fragt vor jedem Wechsel und
  bricht bei Veto ab. `navigate(path, { force: true })` ist der eine Weg daran
  vorbei, den die Ansicht selbst nimmt, nachdem sie gefragt hat.

  Er sitzt **im Router und nicht in der Navigationsleiste**, weil `navigate()`
  die einzige Tür ist, durch die alle Wege gehen — Formular-Reiter,
  Kopfnavigation, Mobil-Sheet. Eine Sperre je Aufrufer wäre eine Liste, die beim
  nächsten Eintrag unvollständig ist. Der Zurück-Knopf des Browsers geht nicht
  durch `navigate()`; ihn deckt ein einzelner, ref-gezählter `popstate`-Zuhörer
  ab, der bei Veto die Adresse per `pushState` zurückdreht.

Der Umfang ist rund hundert Zeilen. Wenn verschachtelte Routen oder Loader
einmal die Form des Problems sind, ist dieses Modul klein genug, um es
wegzuwerfen.

## Consequences

**Gut:**

- Keine Abhängigkeit, kein zusätzliches Bündelgewicht, keine zweite
  Lade-Abstraktion neben TanStack Query.
- Die Routentabelle ist **ohne DOM testbar** — `routes.test.ts` prüft jede
  Adresse als reine Funktion.
- `pushState` benachrichtigt keine Zuhörer (`popstate` gehört dem Browser).
  `navigate()` tut es deshalb selbst; das ist der klassische Fehler eines
  handgeschriebenen Routers und steht im Code an der Stelle, an der er
  passieren würde.

**Zu tragen:**

- Verschachtelte Layouts, Routen-Guards und Code-Splitting je Route gibt es
  nicht. Sollten sie gebraucht werden, ist der Wechsel auf eine Bibliothek ein
  eigener Schritt — und kein schwerer, weil alle Pfade schon über zwei
  Funktionen laufen.
- Der Server muss unbekannte Pfade auf `index.html` zurückfallen lassen. Der
  nginx-Frontdoor tut das bereits (`try_files … /index.html`), `vite preview`
  ebenfalls; ein anderer Betriebsweg muss es mitbringen.
- **Interne Links sind heute Buttons**, keine `<a>`. Für den Builder ist das
  vertretbar (er ist eine Aktion aus dem Dashboard heraus), für die
  öffentliche Formular-Adresse nicht — dort gehört ein echter Anker
  hin, damit „Link in neuem Tab öffnen" funktioniert. `useLinkHandler` ist
  dafür bereits vorhanden.
