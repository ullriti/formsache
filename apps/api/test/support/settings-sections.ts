import type { SettingsOverridden } from '@formsache/shared';

/**
 * The two extremes of the section switch, for suites that write a **form's**
 * settings.
 *
 * **All four switches travel on every write** — because a `PUT` replaces the
 * whole switch document: a key the request leaves out is a section handed back
 * to the organisation, and handing a section back *discards* its values. Two
 * frozen constants rather than an object literal per call site, so a suite
 * cannot accidentally write three of the four and measure a state the
 * application would never produce.
 *
 * **Only on the form any more**: the Formular-Standards of an organisation
 * have had no switches since review finding 10 — underneath them lies no second
 * administration, but the shipped values.
 *
 * **Four, not five**: *Verfügbarkeit* has no switch since 2026-08-14 (ADR-0011,
 * continuation; review finding 10). A form's deadline is its own and is
 * written through `values` alone.
 */

/** Every section taken over. */
export const ALL_SECTIONS: SettingsOverridden = Object.freeze({
  access: true,
  confirm: true,
  display: true,
  budget: true,
});

/** Nothing taken over — „folgt der Schicht darunter" in all four. */
export const NO_SECTIONS: SettingsOverridden = Object.freeze({
  access: false,
  confirm: false,
  display: false,
  budget: false,
});
