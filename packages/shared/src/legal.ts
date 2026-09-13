import { z } from 'zod';

import { EXTERNAL_URL_MAX, safeExternalUrl } from './form-settings.ts';
import { LEGAL_LINK_LEAD, TENANT_LEGAL_TEMPLATES } from './legal-templates.ts';
import {
  conditionKeysOf,
  parseLegalText,
  resolveConditions,
  slotKeysOf,
  stripControlChars,
  safeLegalHref,
  substituteSlots,
  tableHeadLines,
  withoutOpenSlots,
  type LegalBlock,
  type LegalInline,
} from './legal-text.ts';

/**
 * **Legal texts — two origins, six pages, one mechanism**
 * (ADR-0028, `docs/legal/README.md` section 5).
 *
 * This file answers three questions and no fourth one:
 *
 * 1. **What a stored legal text looks like** — {@link legalDocumentSchema},
 *    the document that makes up a page.
 * 2. **Where which page lives** — {@link systemLegalPath},
 *    {@link tenantLegalPath}, in one place, because the server has to build the
 *    same addresses as the browser (the same reasoning that
 *    `public-urls.ts` gives for the fill-out address).
 * 3. **What a stranger gets to see** — {@link renderLegalPage}, and the
 *    answer is a tree of blocks and never a string with
 *    angle brackets (`legal-text.ts`).
 *
 * What is **not** here is the wording of the templates. That lives in
 * `legal-templates.ts` — a module that does nothing but hold text, so that
 * the mechanics can be read without the 800 lines of legalese.
 *
 * ## The one decision the data model rests on
 *
 * A legal text has **three paths** and the state lives in the column, not
 * in a heuristic over the text:
 *
 * - `mode: 'template'` — the shipped template applies, and the operator
 *   or the organisation only fills in its placeholders. The regular path: it is
 *   fast, the text stays the reviewed one, and **no placeholder can be
 *   left standing**, because it is a field and not a find in running text.
 * - `mode: 'custom'` — whoever has their own, lawyer-reviewed version
 *   writes it down. Then theirs applies.
 * - `mode: 'link'` — wer den Text **schon woanders stehen hat**, nennt seine
 *   Adresse (Review-Runde 5, Nachtrag). Die Seite verweist dann dorthin,
 *   statt denselben Text ein zweites Mal zu pflegen; zwei Fassungen desselben
 *   Impressums sind eine, die stimmt, und eine, die niemand nachzieht.
 *
 * **Alle drei Hälften werden immer behalten.** {@link LegalDocument} carries
 * `fills`, `custom` *and* `link` regardless of the mode. Whoever switches from
 * the template to their own text and back finds their entries again — the
 * alternative (clearing whichever is the other one when switching) would be
 * silent data loss at exactly the moment somebody is trying something out.
 */

// ---------------------------------------------------------------------------
// The pages and their addresses
// ---------------------------------------------------------------------------

/** The legal texts the **operator** fills in (`docs/legal/README.md` 5.2). */
export const SYSTEM_LEGAL_PAGES = ['imprint', 'privacy'] as const;
export type SystemLegalPage = (typeof SYSTEM_LEGAL_PAGES)[number];

/** The legal texts an **organisation** fills in. */
export const TENANT_LEGAL_PAGES = ['imprint', 'privacy'] as const;
export type TenantLegalPage = (typeof TENANT_LEGAL_PAGES)[number];

export const systemLegalPageSchema = z.enum(SYSTEM_LEGAL_PAGES);
export const tenantLegalPageSchema = z.enum(TENANT_LEGAL_PAGES);

/**
 * The path segment of an organisation — `/o/<kurzname>/…`.
 *
 * **The short name and expressly not the slug of a form**
 * (`docs/legal/README.md` 5.2): a slug is an access credential from the CSPRNG,
 * and a legal document at an unguessable address contradicts
 * „ständig verfügbar" and „leicht zugänglich" (§ 18 MStV, Art. 12 Abs. 1
 * DSGVO). `short_name` is already `@unique` and is the right key.
 */
export const LEGAL_ORG_SEGMENT = 'o';

/**
 * The addresses of the operator's two pages, in one place.
 *
 * ⚠️ **Englisch seit Review-Runde 4 Nr. 8** — sie hießen `impressum` und
 * `datenschutz`. Der Befund traf ausdrücklich auch diese beiden: „URL Pfade
 * enthalten deutsche Namen […]. Das widerspricht massiv der Vorgabe." Der
 * Inhalt der Seiten bleibt deutsch, ihre Adresse ist Code.
 */
const SYSTEM_LEGAL_SEGMENTS: Readonly<Record<SystemLegalPage, string>> = {
  imprint: 'imprint',
  privacy: 'privacy',
};

/** The addresses of an organisation's two pages, in one place. */
const TENANT_LEGAL_SEGMENTS: Readonly<Record<TenantLegalPage, string>> = {
  imprint: 'imprint',
  privacy: 'privacy',
};

/** The licences page — hard-coded, therefore without a document and without a key. */
export const LICENCES_PATH = '/licences';

export function systemLegalPath(page: SystemLegalPage): string {
  return `/${SYSTEM_LEGAL_SEGMENTS[page]}`;
}

export function tenantLegalPath(
  shortName: string,
  page: TenantLegalPage,
): string {
  return `/${LEGAL_ORG_SEGMENT}/${encodeURIComponent(shortName)}/${TENANT_LEGAL_SEGMENTS[page]}`;
}

/** The page behind an address segment, or `null` — for the router. */
export function systemLegalPageOf(segment: string): SystemLegalPage | null {
  return (
    SYSTEM_LEGAL_PAGES.find(
      (page) => SYSTEM_LEGAL_SEGMENTS[page] === segment,
    ) ?? null
  );
}

export function tenantLegalPageOf(segment: string): TenantLegalPage | null {
  return (
    TENANT_LEGAL_PAGES.find(
      (page) => TENANT_LEGAL_SEGMENTS[page] === segment,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * How long the value of a placeholder may become.
 *
 * Generous, because one of them is a list of recipients and one is
 * a postal address with line breaks — and tight enough that nobody types the
 * whole declaration into one field. Whoever wants that has the second path
 * (`mode: 'custom'`), and that is the right answer to it.
 */
export const LEGAL_FILL_MAX = 2_000;

/**
 * How long an own legal text may become — the proposal from
 * `docs/legal/README.md` 5.6 no. 1, adopted unchanged.
 *
 * An upper bound and not a gut feeling: the column is `text`, and
 * 20 000 characters are about eight pages of running text — more than any of
 * the nine templates in `docs/legal/vorlagen/`.
 *
 * **The sum of one write is bounded on the other side, not here**
 * (ADR-0028 no. 7, decided on 2026-08-20). One write carries the whole
 * document — three pages for the installation, two for an organisation — and
 * whoever fills *every* field up to {@link LEGAL_FILL_MAX} **and** additionally
 * exhausts every own text is arithmetically past the general body limit of
 * 100 KiB. The answer to that was not a smaller number here, which would have
 * cut into the honest case; the two legal-text writes read a larger body than
 * every other route (`app-setup.ts`, `LEGAL_WRITE_BODY_LIMITS`), sized from
 * exactly this constant and {@link LEGAL_FILL_MAX}.
 *
 * ⚠️ **Whoever raises one of the two raises that limit with it**, or the write
 * that fits by the field limits dies at the parser again.
 * `apps/api/test/legal/legal-body-limit.spec.ts` recomputes the worst case
 * from the templates and turns red first.
 */
export const LEGAL_TEXT_MAX = 20_000;

/**
 * Wie lang die Adresse eines Verweises werden darf (`mode: 'link'`).
 *
 * **Dieselbe Zahl wie beim Weiterleitungsziel eines Formulars, und zwar
 * dieselbe** — nicht eine zweite mit demselben Wert (Befund des Reviews).
 * `form-settings.ts` exportiert sie aus demselben Grund, aus dem es
 * {@link safeExternalUrl} exportiert: eine Regel, die an zwei Orten steht, ist
 * eine, die an einem von beiden veraltet.
 *
 * Der eigene Name bleibt, weil die Aufrufer hier von einem *Rechtstext-Verweis*
 * reden und nicht von einer Weiterleitung — ein Alias kostet nichts und sagt,
 * worum es an dieser Stelle geht.
 */
export const LEGAL_LINK_MAX = EXTERNAL_URL_MAX;

/** How a placeholder key is written. */
const slotKeySchema = z.string().regex(/^[A-Z0-9_]{1,80}$/u);
/** How a condition key is written. */
const conditionKeySchema = z.string().regex(/^[a-z0-9-]{1,60}$/u);

/**
 * A foreign value on its way into the column — **the first of the two gates**.
 *
 * Trimmed and stripped of control characters, with the same reasoning that
 * ADR-0026 gives for the single-line values: what never reaches the column
 * cannot appear in any future output. The line break stays
 * **allowed** here — unlike there — because a postal address would not be
 * writable without it; everything invisible falls away anyway
 * ({@link stripControlChars}).
 */
const legalValueSchema = z
  .string()
  .max(LEGAL_FILL_MAX)
  .transform((raw) => stripControlChars(raw).trim());

/**
 * A stored legal text — **one** document per page.
 *
 * `strictObject`, because a field the server does not know has no business in a
 * legal-text document: the page holds the whole document
 * and sends it back in full, so there is nothing that would have to
 * travel along silently.
 */
/**
 * **Die Adresse, unter der der Rechtstext woanders steht** — für
 * `mode: 'link'` (Review-Runde 5, Nachtrag).
 *
 * Hier steht nur, was für **jeden** Modus gilt: getrimmt und nicht länger als
 * {@link LEGAL_LINK_MAX}. Ob sie eine brauchbare Adresse ist, fragt
 * {@link legalDocumentSchema} — und zwar nur, wenn dieser Modus gewählt ist.
 *
 * ## Warum die Prüfung nicht an diesem Feld hängt
 *
 * Ein Befund des Reviews, und er beschreibt eine Sackgasse: die drei Hälften
 * eines Dokuments reisen **immer** mit (das ist die Zusage „ein Moduswechsel
 * verliert nichts"). Hinge die Prüfung am Feld, blockierte eine halb getippte
 * Adresse — `musterverein.example/impressum` ohne Schema, der häufigste
 * Tippfehler — das Speichern auch dann, wenn längst die Vorlage gewählt ist.
 * Und das Feld, das der 400 benennt, ist in diesem Modus **nicht gezeichnet**:
 * die Meldung „Bitte die markierten Felder prüfen" stünde da, und markiert wäre
 * nichts. Genau der Zustand, gegen den ADR-0028 Nr. 9 geschrieben ist.
 *
 * ## Und warum hier nicht normalisiert wird
 *
 * Gespeichert wird, was jemand getippt hat; `safeExternalUrl` läuft beim
 * **Ausliefern** ({@link renderLegalPage}). Das hält die Spalte an der
 * Obergrenze oben — `new URL().href` prozentkodiert, und aus einem
 * Gedankenstrich würden neun Zeichen — und es zeigt im Eingabefeld die Adresse,
 * die dort eingetragen wurde, statt einer umgeschriebenen.
 */
const legalLinkSchema = z
  .string()
  .max(LEGAL_LINK_MAX)
  .transform((raw) => raw.trim());

export const legalDocumentSchema = z.strictObject({
  /**
   * ⚠️ **`'link'` seit Review-Runde 5** — und ein gespeichertes Dokument von
   * vorher bleibt lesbar: der Wert kommt hinzu, keiner fällt weg, und
   * {@link link} trägt eine Vorgabe. Ein neues **Pflicht**feld hätte jedes
   * bestehende Dokument am `strictObject` scheitern lassen, und
   * `parseStoredSystemLegalPages` hätte daraus „nichts hinterlegt" gemacht —
   * Impressum und Datenschutzerklärung wären mit einem Schlag weg gewesen.
   */
  mode: z.enum(['template', 'custom', 'link']),
  /**
   * The filled-in placeholders of the template.
   *
   * An open map and not a fixed shape: which placeholders exist
   * is decided by the **template** in `legal-templates.ts`, and a schema that
   * enumerated them would be the second truth about it — exactly the duplication that
   * would drift apart at the next sentence added to the template. A key that
   * no template knows is simply not read when rendering.
   */
  fills: z.record(slotKeySchema, legalValueSchema),
  /**
   * The answered conditional blocks (`⟪WENN:…⟫` of the templates).
   *
   * If an answer is missing, the block counts as **not** fulfilled — a section
   * that nobody has decided on is a claim that nobody
   * has made.
   */
  conditions: z.record(conditionKeySchema, z.boolean()),
  /**
   * The own text, for `mode: 'custom'`.
   *
   * **Plain text**, with the same treatment as any placeholder value and without
   * any markup language in the column. What becomes structure out of it
   * is decided solely by `parseLegalText` when delivering.
   */
  custom: z.string().max(LEGAL_TEXT_MAX).transform(stripControlChars),
  /**
   * Die Adresse für `mode: 'link'` — leer, solange keine hinterlegt ist.
   *
   * `.default('')`, damit ein Dokument aus der Zeit vor diesem Modus weiter
   * parst (siehe {@link mode}).
   */
  link: legalLinkSchema.default(''),
});

/**
 * **Dasselbe Dokument auf dem Weg hinein** — mit der einen Prüfung, die nur
 * beim Schreiben gelten darf.
 *
 * Zwei Schemata und nicht eines, und der Unterschied ist die Richtung:
 * {@link legalDocumentSchema} liest, was in der Spalte **steht**, und ist
 * nachsichtig — eine von Hand geschriebene Zeile mit unbrauchbarem Verweis darf
 * nicht das ganze Dokument unlesbar machen und damit Impressum *und*
 * Datenschutzerklärung auf „nichts hinterlegt" setzen (die Begründung steht an
 * {@link parseStoredSystemLegalPages}; der Renderer fängt den Verweis ohnehin
 * ab). Dieses hier prüft, was jemand **schreiben** will, und weist es mit einem
 * Feldpfad zurück.
 *
 * **Die Adresse wird geprüft, wenn sie gilt** — und nur dann.
 *
 * Am Dokument und nicht am Feld, aus dem Grund, der an {@link legalLinkSchema}
 * ausgeschrieben steht: ein halb getippter Verweis darf das Speichern einer
 * ausgefüllten Vorlage nicht blockieren, und ein 400 muss ein Feld benennen,
 * das die Karte gerade zeichnet.
 *
 * **Leer bleibt erlaubt**, auch in diesem Modus: wer ihn wählt und noch nichts
 * einträgt, bekommt eine Seite, die wahrheitsgemäß „nichts hinterlegt" sagt,
 * und einen offenen Punkt in der Verwaltung — kein Formular, das ihn festhält
 * (dieselbe Entscheidung wie überall sonst hier, ADR-0022 §1).
 *
 * `http`/`https` und nichts sonst: die Adresse landet in einem `href` auf einer
 * Seite, die Fremde öffnen. Dieselbe Prüfung wie beim Weiterleitungsziel eines
 * Formulars, und dieselbe Begründung.
 */
export const legalDocumentWriteSchema = legalDocumentSchema.check((ctx) => {
  const document = ctx.value;
  if (document.mode !== 'link' || document.link === '') {
    return;
  }
  if (safeExternalUrl(document.link) === null) {
    ctx.issues.push({
      code: 'custom',
      input: document.link,
      path: ['link'],
      message: 'Nur http- oder https-Adressen sind erlaubt.',
    });
  }
});
export type LegalDocument = z.infer<typeof legalDocumentSchema>;

/** A document in which nothing is stored — the state of every fresh row. */
export const EMPTY_LEGAL_DOCUMENT: LegalDocument = {
  mode: 'template',
  fills: {},
  conditions: {},
  custom: '',
  link: '',
};

/**
 * Die Seiten einer Ebene als ein Dokument — **mit dem Dokumentschema, das zur
 * Richtung passt**.
 *
 * Der Aufrufer entscheidet, ob gelesen oder geschrieben wird
 * ({@link legalDocumentWriteSchema} sagt, warum das zwei verschiedene Antworten
 * sind). Ein Vorgabewert steht hier ausdrücklich nicht: die nachsichtige
 * Fassung wäre die bequeme, und sie auf einem Schreibweg zu vergessen hieße,
 * eine Prüfung stillschweigend zu verlieren.
 */
function pagesSchema<Key extends string>(
  keys: readonly Key[],
  document: z.ZodType<LegalDocument>,
): z.ZodType<Readonly<Record<Key, LegalDocument>>> {
  const shape = Object.fromEntries(keys.map((key) => [key, document]));
  return z.strictObject(shape) as unknown as z.ZodType<
    Readonly<Record<Key, LegalDocument>>
  >;
}

export const systemLegalPagesSchema = pagesSchema(
  SYSTEM_LEGAL_PAGES,
  legalDocumentSchema,
);
export type SystemLegalPages = Readonly<Record<SystemLegalPage, LegalDocument>>;

export const tenantLegalPagesSchema = pagesSchema(
  TENANT_LEGAL_PAGES,
  legalDocumentSchema,
);
export type TenantLegalPages = Readonly<Record<TenantLegalPage, LegalDocument>>;

export const EMPTY_SYSTEM_LEGAL_PAGES: SystemLegalPages = {
  imprint: EMPTY_LEGAL_DOCUMENT,
  privacy: EMPTY_LEGAL_DOCUMENT,
};

export const EMPTY_TENANT_LEGAL_PAGES: TenantLegalPages = {
  imprint: EMPTY_LEGAL_DOCUMENT,
  privacy: EMPTY_LEGAL_DOCUMENT,
};

/**
 * What is in the column, read in such a way that an unreadable row does
 * **not** take the pages down.
 *
 * If the document fails to parse, „nichts hinterlegt" applies — and the public
 * page then says exactly that, truthfully. The alternative would be a 500 on
 * a page that has to be *ständig verfügbar* (§ 18 MStV); an imprint
 * that is unreachable because of a broken JSONB is the most expensive
 * conceivable failure of this feature.
 */
export function parseStoredSystemLegalPages(source: unknown): SystemLegalPages {
  const parsed = systemLegalPagesSchema.safeParse(source);
  return parsed.success ? parsed.data : EMPTY_SYSTEM_LEGAL_PAGES;
}

export function parseStoredTenantLegalPages(source: unknown): TenantLegalPages {
  const parsed = tenantLegalPagesSchema.safeParse(source);
  return parsed.success ? parsed.data : EMPTY_TENANT_LEGAL_PAGES;
}

// ---------------------------------------------------------------------------
// The write paths
// ---------------------------------------------------------------------------

/**
 * A write onto the legal texts — **full replacement and optimistic
 * lock**, as with mail, AI and the templates.
 *
 * `lock` is this block's own counter (`legal_revision`) and **never**
 * `updatedAt`: that one moves on every write to the same row and is
 * truncated to milliseconds — two writes within the same millisecond
 * would compare equal, and the second would silently overwrite the first. Exactly
 * the reasoning that `system-settings.ts` gives for `mail_revision`.
 */
export const updateSystemLegalRequestSchema = z.strictObject({
  // Die **schreibende** Fassung: hier wird ein unbrauchbarer Verweis
  // zurückgewiesen, statt beim Lesen nachsichtig durchzugehen
  // ({@link legalDocumentWriteSchema}).
  pages: pagesSchema(SYSTEM_LEGAL_PAGES, legalDocumentWriteSchema),
  lock: z.number().int().positive(),
});
export type UpdateSystemLegalRequest = z.infer<
  typeof updateSystemLegalRequestSchema
>;

export const updateTenantLegalRequestSchema = z.strictObject({
  pages: pagesSchema(TENANT_LEGAL_PAGES, legalDocumentWriteSchema),
  lock: z.number().int().positive(),
});
export type UpdateTenantLegalRequest = z.infer<
  typeof updateTenantLegalRequestSchema
>;

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/** A placeholder, the way the interface offers it as a **field**. */
export interface LegalSlot {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  /** Whether the field is multi-line — postal addresses, lists, table rows. */
  readonly multiline?: boolean;
  /**
   * **Was ungefähr hineingehört** — als Platzhalter im leeren Feld
   * (Review-Runde 4 Nr. 5).
   *
   * Der Befund nannte drei Felder namentlich („Wesentliches der Vereinbarung
   * nach Art. 26 DSGVO!", „Zentrale Anlaufstelle nach Art. 26 Abs. 1",
   * „Rechtsgrundlage für die Konten") und schloss: *„Am besten mal überall
   * Standardtexte oder Platzhalter rein damit man weiß was da grob rein
   * soll."* Er trifft einen echten Unterschied: {@link hint} erklärt die
   * **Rechtsfrage**, dieses Feld zeigt die **Antwortform**. „Art. 26 Abs. 2
   * verlangt, dass das Wesentliche der Vereinbarung zur Verfügung gestellt
   * wird" sagt niemandem, ob dort ein Satz, eine Liste oder eine Adresse
   * hingehört.
   *
   * Ein Platzhalter und **kein Vorbelegen**: was im Feld steht, hat jemand
   * geschrieben und verantwortet es. Ein vorbelegter Rechtstext, den niemand
   * gelesen hat, wäre die stille Variante einer Falschangabe.
   */
  readonly example?: string;
  /**
   * Ein **übernehmbarer Standardtext** — mit einem Knopf daneben.
   *
   * Für die Felder, bei denen die übliche Antwort tatsächlich für fast jeden
   * Betreiber stimmt und nur bestätigt werden muss. Sie steht ebenfalls als
   * Platzhalter im leeren Feld ({@link example} entfällt dann), und der Knopf
   * schreibt sie hinein — ein Klick, nach dem der Text im Feld steht und
   * gelesen, geändert oder wieder gelöscht werden kann.
   *
   * ⚠️ **Nicht dasselbe wie ein vorbelegtes Feld.** Der Unterschied ist
   * genau eine bewusste Handlung: solange niemand den Knopf gedrückt hat, ist
   * das Feld leer, die Seite unvollständig und der Betreiber nicht der Autor
   * eines Satzes, den er nie gesehen hat.
   */
  readonly suggestion?: string;
  /**
   * **Freiwillig** — das Feld darf leer bleiben, ohne dass die Seite
   * „unvollständig" heißt (Review-Runde 5, Nachtrag).
   *
   * Der Befund: *„Rechtstexte offen Hinweis sollte nur bei den wichtigen
   * Punkten angezeigt werden. Die Telefonnummer ist ja optional dachte ich."*
   * Sie ist es — § 5 Abs. 1 Nr. 2 DDG verlangt „Angaben, die eine schnelle
   * elektronische Kontaktaufnahme ermöglichen, **einschließlich** der Adresse
   * der elektronischen Post"; der EuGH (C-298/07) hat ausdrücklich entschieden,
   * dass eine Telefonnummer nicht dazugehört, solange ein zweiter schneller Weg
   * offensteht. Der {@link hint} an diesem Feld sagte das längst, und die Ampel
   * zählte es trotzdem mit.
   *
   * ⚠️ **Sparsam vergeben, und nie aus Bequemlichkeit.** Was hier steht, ist
   * eine Aussage über die Rechtslage und keine über den Aufwand: ein
   * `optional`, das eine Pflichtangabe zur Kür macht, verwandelt die eine
   * Warnung, die es gibt, in eine, die nichts mehr bedeutet. Ob ein ganzer
   * **Abschnitt** zutrifft, ist die andere Frage und wird weiter über
   * `⟪WENN:…⟫` entschieden ({@link LegalCondition}).
   *
   * Sichtbar bleibt das Feld in jedem Fall — mit dem Wort „optional" daneben
   * (`LegalPageEditor`).
   */
  readonly optional?: boolean;
  /**
   * **Der fachliche Abschnitt, in dem dieses Feld steht**
   * (Review-Runde 4 Nr. 7).
   *
   * Der Befund: *„Mailserver und Backup Felder haben falsche Reihenfolge und
   * werden vermischt."* Er stimmte. Die Feldliste folgte der Reihenfolge des
   * **Textes**, und der springt zu Recht zwischen den Themen: der Mailversand
   * steht in Abschnitt 6, die Sicherungen in 7, der Maildienstleister wieder
   * in der Empfängertabelle in 9. Wer das Formular ausfüllt, liest den Text
   * aber nicht mit — für ihn standen „Mailserver oder Maildienstleister",
   * „Aufbewahrung der Sicherungen", „Name des Maildienstleisters"
   * durcheinander.
   *
   * {@link groupedSlots} sammelt die Felder danach ein. Die Reihenfolge der
   * Abschnitte ist die ihres **ersten** Feldes in der Liste; innerhalb eines
   * Abschnitts bleibt die Listenreihenfolge. Ein Feld ohne Abschnitt steht in
   * einer namenlosen ersten Gruppe — das ist der Normalfall für eine Vorlage
   * mit sechs Feldern, bei der Überschriften mehr Aufwand als Auskunft wären.
   */
  readonly group?: string;
}

/** Ein Abschnitt der Feldliste — siehe {@link groupedSlots}. */
export interface LegalSlotGroup {
  /** Die Überschrift, oder `null` für die Felder ohne Abschnitt. */
  readonly title: string | null;
  readonly slots: readonly LegalSlot[];
}

/**
 * Die sichtbaren Felder, nach {@link LegalSlot.group} eingesammelt
 * (Review-Runde 4 Nr. 7).
 *
 * Eingesammelt und **nicht** sortiert: die Reihenfolge der Abschnitte ist die
 * ihres ersten Feldes, die Reihenfolge innerhalb eines Abschnitts die der
 * Liste. Eine eigene Sortierung wäre eine dritte Reihenfolge neben der Vorlage
 * und dem Text, und die dritte ist die, an die niemand denkt, wenn ein Feld
 * dazukommt.
 *
 * Die namenlose Gruppe steht immer vorn, auch wenn ihr erstes Feld hinter
 * einem benannten Abschnitt stünde: Felder ohne Überschrift **hinter**
 * Überschriften zu setzen, ordnete sie optisch dem Abschnitt darüber zu, zu
 * dem sie nicht gehören.
 */
export function groupedSlots(
  slots: readonly LegalSlot[],
): readonly LegalSlotGroup[] {
  const ungrouped: LegalSlot[] = [];
  const named = new Map<string, LegalSlot[]>();
  for (const slot of slots) {
    if (slot.group === undefined) {
      ungrouped.push(slot);
      continue;
    }
    const bucket = named.get(slot.group);
    if (bucket === undefined) {
      named.set(slot.group, [slot]);
    } else {
      bucket.push(slot);
    }
  }
  return [
    ...(ungrouped.length === 0
      ? []
      : [{ title: null, slots: ungrouped } as const]),
    ...[...named].map(([title, grouped]) => ({ title, slots: grouped })),
  ];
}

/**
 * A conditional block of the template, and **who answers it**.
 *
 * `auto` is the answer to the question whether `⟪NUR WENN …⟫` can be resolved
 * from the configuration. Mostly it cannot: „nur wenn juristische Person",
 * „nur wenn eingetragen", „nur wenn öffentliche Stelle" are facts about
 * the operator that no setting of this application knows — guessing them
 * would be an invented statement. Where the application **does** know, it neither guesses
 * nor asks: `auto: 'ai'` reads the actual state of the
 * AI configuration, because an operator who switches the AI off and leaves the
 * paragraph standing would otherwise describe a processing that does not take place.
 *
 * `auto: 'redirect'` is the same sentence one level down (ADR-0028 no. 5): the
 * redirect after submitting is a **setting of the form**
 * (`redirectEnabled` / `redirectUrl`), and on a form the answer is not only
 * „ob" but „wohin". Asking for it would be a field whose answer the
 * application already holds — and one that goes stale the day somebody
 * changes the target. Note the level: for the legal texts of an
 * *organisation* the same question has no single answer, because several forms
 * have several targets, and there it stays a question to a human.
 */
export interface LegalCondition {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly auto?: 'ai' | 'ai-off' | 'redirect';
}

/** A shipped template — text, fields, conditions, empty version. */
export interface LegalTemplate {
  readonly key: string;
  /** The heading of the page — the empty version carries it too. */
  readonly title: string;
  /** A sentence that stands above the editor in the interface. */
  readonly purpose: string;
  /** The part the operator or the organisation is responsible for. */
  readonly body: string;
  /**
   * The part that is **hard-coded** — or `null`.
   *
   * It exists for exactly the privacy notice of an organisation
   * (template 04, parts B and C): it describes the behaviour of the software, is
   * the same for every organisation and verifiable, and an organisation that
   * could change it could claim something untrue about a piece of software
   * that it does not control. It is shown **even when the upper
   * part is empty** — because it is true, regardless of whether anybody has
   * entered anything.
   */
  readonly fixed: string | null;
  /** What the page says as long as nothing is stored (section 5.4). */
  readonly emptyBody: string;
  readonly slots: readonly LegalSlot[];
  readonly conditions: readonly LegalCondition[];
}

/**
 * Placeholders that **the application** knows and nobody types.
 *
 * They carry the prefix `APP_` and therefore appear in no field list:
 * the address of the own privacy page, the name of the organisation from
 * `tenant.name`, the name of the operator from the imprint of the installation.
 * Having them entered by hand would mean having to keep the same statement
 * true in two places — and the second one is the one that drifts.
 */
export const APP_SLOT_PREFIX = 'APP_';

export function isAppSlot(key: string): boolean {
  return key.startsWith(APP_SLOT_PREFIX);
}

// ---------------------------------------------------------------------------
// Delivering
// ---------------------------------------------------------------------------

/** What the application knows about itself when it renders a page. */
export interface LegalRenderContext {
  /** `tenant.name`, or `null` on a page of the installation. */
  readonly organisationName: string | null;
  /** `tenant.short_name`, for the addresses of the organisation pages. */
  readonly organisationShortName: string | null;
  /**
   * The name of the operator, as it stands in the imprint of the installation.
   *
   * **Read from the document, not from a second column.** ADR-0019
   * separates software and installation; introducing an own „Name der Installation"
   * would mean maintaining the same statement twice — and whoever changes the
   * operator in the imprint does not then change it along.
   */
  readonly operatorName: string | null;
  /** Whether the AI feature of this installation is actually set up. */
  readonly aiActive: boolean;
  /**
   * Where this form sends a participant after submitting — or `null`
   * (ADR-0028 no. 5).
   *
   * **Only the privacy notice of a *form* reads it**, and only there does it
   * have a single answer: it is `effectiveRedirect(settings)?.url`, one
   * setting of one form. Every other page passes `null`, and that is not an
   * omission but the statement that the question has no single answer at that
   * level.
   *
   * **It passes the same gate as a redirect that a browser follows.** Whoever
   * fills this field takes the value from `effectiveRedirect()` and never
   * from `settings.redirectUrl`: the second is a plain string that an
   * unsaved draft may carry, the first is the one place that refuses anything
   * but `http`/`https`. Rendering has a second gate behind it — a target that
   * got past this one still has to pass `safeLegalHref` before it
   * becomes a link — but a value that never reaches the text cannot be
   * misread by either.
   */
  readonly redirectTarget: string | null;
}

/** How finished a page is — the one question that three places ask. */
export type LegalPageStatus =
  /** Nothing stored. The page says so and names what it truthfully knows. */
  | 'empty'
  /** Stored, but with open placeholders — **not** ready to publish. */
  | 'incomplete'
  | 'ready';

/**
 * The same state on the wire — **one** enum, not three.
 *
 * It travels in two places with all three values: on a public
 * legal-text page ({@link publicLegalPageSchema}) and in the preview before
 * publishing (`publishPreviewSchema` in `forms.ts`). Two written-out
 * enums would be two places where a fourth state gets
 * forgotten.
 *
 * {@link publicFormPrivacyNoticeSchema} does **not** use it, and that is
 * deliberate: there `empty` does not exist at all — an empty notice does not travel,
 * it becomes `null`. Forming a subset via `.exclude()` would mean pinning the
 * exception onto the rule; the two values are written out there,
 * with their reasoning next to them.
 */
export const legalPageStatusSchema: z.ZodType<LegalPageStatus> = z.enum([
  'empty',
  'incomplete',
  'ready',
]);

/**
 * **Für wen gerendert wird** — die eine Frage, die über die offenen Angaben
 * entscheidet (Review-Runde 5 Nr. 1).
 *
 * Der Befund war: *„unvollständige Angaben sollten nicht in der öffentlichen
 * Ansicht angezeigt werden. Das sieht nicht gut aus."* Er lässt sich nicht mit
 * einem Schalter an der Ansicht erledigen, denn gerendert wird auf dem Server
 * (ADR-0028): was der Browser bekommt, sind Blöcke, und was nicht darin steht,
 * kann keine Ansicht mehr zeigen. Also entscheidet es der Renderer, und weil er
 * es entscheidet, muss jeder Aufrufer sagen, für wen er ruft — darum ein
 * **Pflichtargument** ohne Vorgabe. Vier Aufrufstellen gibt es, und eine
 * stillschweigende Vorgabe wäre die fünfte, die es falsch macht.
 *
 * ⚠️ **Es ist keine Rechteentscheidung.** Beide Zielgruppen sehen denselben
 * Text; der Unterschied ist allein, ob eine **nicht ausgefüllte** Stelle
 * benannt wird. Nichts hier verbirgt Daten — es verbirgt deren Abwesenheit vor
 * Leuten, die sie nicht beheben können.
 */
export type LegalAudience =
  /**
   * Die veröffentlichte Seite, der Datenschutzhinweis eines Formulars, die
   * Fußzeile — kurz: was Fremde aufrufen. Zeilen mit einer offenen Angabe
   * entfallen ({@link withoutGapLines}), und der Warnhinweis darüber entfällt
   * mit ihnen: die Seite sagt weniger und nichts Falsches.
   */
  | 'public'
  /**
   * Die Vorschau im Editor. Hier sind die Lücken der **Sinn** der Ansicht: sie
   * zeigen benannt, was noch hineingehört, und sie stehen an der einzigen
   * Stelle, an der jemand sie schließen kann.
   */
  | 'editor';

export interface RenderedLegalPage {
  readonly title: string;
  readonly status: LegalPageStatus;
  readonly blocks: readonly LegalBlock[];
  /** The labels of the open placeholders — for the warning at the top. */
  readonly missing: readonly string[];
}

/**
 * The redirect target of this form, trimmed — **one** reading, used twice.
 *
 * {@link appFacts} puts it into the sentence and {@link activeConditions}
 * decides from it whether the sentence stands at all. Two readings of one
 * field would be the way to a paragraph that announces a redirect and then
 * names a gap where its address belongs.
 */
function redirectTargetOf(context: LegalRenderContext): string {
  return (context.redirectTarget ?? '').trim();
}

/** The values the application substitutes itself (see {@link APP_SLOT_PREFIX}). */
function appFacts(context: LegalRenderContext): Record<string, string> {
  const shortName = context.organisationShortName;
  return {
    APP_NAME_DER_ORGANISATION: context.organisationName ?? '',
    APP_NAME_DES_BETREIBERS: context.operatorName ?? '',
    APP_ADRESSE_IMPRESSUM: systemLegalPath('imprint'),
    APP_ADRESSE_DATENSCHUTZ: systemLegalPath('privacy'),
    APP_ADRESSE_LIZENZEN: LICENCES_PATH,
    APP_ADRESSE_ORG_IMPRESSUM:
      shortName === null ? '' : tenantLegalPath(shortName, 'imprint'),
    APP_ADRESSE_ORG_DATENSCHUTZ:
      shortName === null ? '' : tenantLegalPath(shortName, 'privacy'),
    APP_ZIELADRESSE_DER_WEITERLEITUNG: redirectTargetOf(context),
  };
}

/** The labels of all placeholders of a template, for the gap display. */
function slotLabels(template: LegalTemplate): Record<string, string> {
  const labels: Record<string, string> = {
    APP_NAME_DER_ORGANISATION: 'Name der Organisation',
    APP_NAME_DES_BETREIBERS: 'Name des Betreibers',
    APP_ADRESSE_ORG_IMPRESSUM: 'Adresse der Anbieterangaben',
    APP_ADRESSE_ORG_DATENSCHUTZ: 'Adresse der Datenschutzhinweise',
    APP_ZIELADRESSE_DER_WEITERLEITUNG: 'Zieladresse der Weiterleitung',
  };
  for (const slot of template.slots) {
    labels[slot.key] = slot.label;
  }
  return labels;
}

/**
 * Which conditions apply — the answered ones and the derived ones.
 *
 * The derived ones override the answered ones and not the other way round:
 * whoever switches the AI off should not keep the paragraph about it just
 * because they ticked the box half a year ago.
 */
function activeConditions(
  template: LegalTemplate,
  document: LegalDocument,
  context: LegalRenderContext,
): Record<string, boolean> {
  const answers: Record<string, boolean> = { ...document.conditions };
  for (const condition of template.conditions) {
    if (condition.auto === 'ai') {
      answers[condition.key] = context.aiActive;
    }
    if (condition.auto === 'ai-off') {
      answers[condition.key] = !context.aiActive;
    }
    /**
     * **The block stands exactly when there is an address to name.**
     *
     * Derived from the very value the block quotes and not from a second
     * flag: a section that announces a redirect and then shows a gap where
     * the target belongs would be the one state this must not be able to
     * reach.
     */
    if (condition.auto === 'redirect') {
      answers[condition.key] = redirectTargetOf(context) !== '';
    }
  }
  return answers;
}

/**
 * **The one path from a stored document onto a screen.**
 *
 * The server calls it and sends blocks; the browser never gets the
 * document and never the template, but the result. That is the same
 * split that `availabilityOf()` draws for the availability of a form:
 * the judgement is the server's, and the client only displays it.
 *
 * The gain is not convenience but a promise that one can
 * check: **a `[[PLATZHALTER]]` never leaves this function**. It becomes a
 * value or a named gap, and both are visible.
 */
export function renderLegalPage(
  template: LegalTemplate,
  document: LegalDocument,
  context: LegalRenderContext,
  audience: LegalAudience,
): RenderedLegalPage {
  const run: LegalRenderRun = {
    template,
    document,
    context,
    audience,
    facts: appFacts(context),
    labels: slotLabels(template),
  };
  const fixedBlocks =
    template.fixed === null
      ? []
      : shown(run, renderPart(template.fixed, run).blocks);

  if (document.mode === 'link') {
    /*
      **Ein Verweis statt eines Textes** (Review-Runde 5, Nachtrag).

      **Hier wird die Adresse geprüft und normalisiert**, nicht beim Speichern:
      in der Spalte steht, was jemand getippt hat ({@link legalLinkSchema}). Der
      Schreibweg hat sie zwar schon einmal gefragt
      ({@link legalDocumentWriteSchema}) — aber die Spalte ist ein `text`, und
      eine von Hand geschriebene Zeile hat diesen Weg nie gesehen. Fällt die
      Adresse durch, ist die Seite `empty` und sagt wahrheitsgemäß, dass nichts
      hinterlegt ist; eine Seite mit einem toten Verweis wäre die schlechtere
      Antwort.

      **Kein Weiterleiten, sondern ein Link** (Entscheidung des Betreibers,
      2026-09-07). Drei der fünf Vorlagen tragen einen festen Teil, den nur
      diese Anwendung sagen kann — Auftragsverarbeitung, keine Cookies,
      Speicherorte, Löschfristen. Eine Weiterleitung würde ihn wegwerfen, und
      zwar genau bei den beiden Seiten, die Ausfüllende am ehesten lesen. Also
      eine Regel für alle fünf: der Verweis steht oben, der feste Teil darunter.
    */
    /*
      **Zwei Schranken, nicht eine.** `safeExternalUrl` beantwortet „darf ein
      Browser da hin?" (`http`/`https`), `safeLegalHref` beantwortet dieselbe
      Frage noch einmal für alles, was in diesem Modul ein `href` wird — zwei
      Umsetzungen derselben Regel, und die zweite ist die, an der jeder Link
      dieser Seite vorbeimuss. Fällt eine von beiden durch, ist die Seite
      `empty` und sagt wahrheitsgemäß, dass nichts hinterlegt ist; ein toter
      Verweis wäre die schlechtere Antwort.
    */
    const href = safeLegalHref(safeExternalUrl(document.link) ?? '');
    if (href === null) {
      return emptyPage(run, fixedBlocks);
    }
    return {
      title: template.title,
      status: 'ready',
      blocks: [
        ...shown(run, parseLegalText(LEGAL_LINK_LEAD)),
        /*
          **Der Absatz wird gebaut und nicht geschrieben** (Befund des Reviews).

          Hier stand `parseLegalText(\`[${'$'}{target}](${'$'}{target})\`)` — die Adresse
          als Auszeichnung zusammengesetzt und sofort wieder geparst. Das
          zerfällt an Zeichen, die in Adressen alltäglich sind: bei
          `https://a.example/a)b` endet die Klammer den Link, und die Seite
          verwies auf `https://a.example/a` — eine **andere** Adresse, während
          die Karte „Vollständig" sagte. Ein `](` im Pfad konnte das Ziel sogar
          ganz austauschen.

          Ein Block ist kein Text: gebaut gibt es keine Auszeichnung, in die
          etwas hineinlaufen könnte. Die Adresse ist dabei ihre eigene
          Beschriftung — wer klickt, soll vorher sehen, wohin er geht —, und
          jetzt hält dieser Satz auch, was er zusagt.
        */
        { kind: 'paragraph', runs: [{ kind: 'link', href, label: href }] },
        ...fixedBlocks,
      ],
      missing: [],
    };
  }

  if (document.mode === 'custom') {
    const own = document.custom.trim();
    if (own === '') {
      return emptyPage(run, fixedBlocks);
    }
    /**
     * **An own text with `[[…]]` in it is not finished**, even if
     * nobody need have copied it from our template. Exactly the case
     * that the brief names: a text with a leftover placeholder
     * that somebody publishes unchecked is worse than an empty
     * field. It therefore counts as unfinished instead of silently
     * counting as finished.
     *
     * Der Zustand hängt am **ganzen** Text und nicht an dem, was übrig
     * bleibt (Review-Runde 5 Nr. 1): öffentlich entfällt die Zeile mit dem
     * Platzhalter, aber `incomplete` bleibt `incomplete` — sonst wäre die Seite
     * für die Verwaltung fertig, weil sie sich selbst zurechtgeschnitten hat.
     */
    const status: LegalPageStatus = /\[\[[A-Z0-9_]+\]\]/u.test(own)
      ? 'incomplete'
      : 'ready';
    /*
      `{}` als Wertevorrat, und das ist die ganze Aussage über einen eigenen
      Text: dort hat niemand einen Platzhalter ersetzt, also ist jeder offen und
      die Regel fällt auf „die Zeile geht" zusammen ({@link withoutOpenSlots}).
    */
    const blocks = shown(
      run,
      parseLegalText(audience === 'public' ? withoutOpenSlots(own, {}) : own),
    );
    return blocks.length === 0
      ? // Ein eigener Text, von dem öffentlich nichts übrig bleibt: dann ist
        // „nichts hinterlegt" die wahre Aussage, und `emptyBody` ist der Text,
        // der sie führt. Ohne diesen Zweig stünde eine Seite mit Titel und
        // ohne Inhalt da (nur `renderFormPrivacyNotice` liest den Zustand
        // `empty`, und für einen Hinweis, von dem nichts bleibt, ist genau das
        // richtig: er reist gar nicht mit).
        emptyPage(run, fixedBlocks)
      : {
          title: template.title,
          status,
          blocks: [...blocks, ...fixedBlocks],
          missing: [],
        };
  }

  const filled = template.slots.some(
    (slot) => (document.fills[slot.key] ?? '').trim() !== '',
  );
  if (!filled) {
    return emptyPage(run, fixedBlocks);
  }

  const rendered = renderPart(template.body, run);
  const body = shown(run, rendered.blocks);
  if (body.length === 0) {
    // Wie oben, nur aus der Vorlage heraus: bei den ausgelieferten Vorlagen
    // unerreichbar (ihr Rumpf trägt Zeilen ohne jeden Platzhalter), aber eine
    // Vorlage ist Text und kann sich ändern.
    return emptyPage(run, fixedBlocks);
  }
  return {
    title: template.title,
    /**
     * ⚠️ **Aus `missing`, nicht aus den Blöcken.** Öffentlich sind die Zeilen
     * mit den offenen Angaben schon heraus, und wer den Zustand dort ablesen
     * wollte, bekäme „fertig" für eine Seite, die es nicht ist.
     */
    status: rendered.missing.length === 0 ? 'ready' : 'incomplete',
    blocks: [...body, ...fixedBlocks],
    missing: rendered.missing.map((key) => run.labels[key] ?? key),
  };
}

/**
 * **Überschriften ohne Abschnitt, weggenommen** — nur für `'public'`
 * (Review-Runde 5 Nr. 1, Befund des Reviews).
 *
 * Der Ausgangsbefund war „das sieht nicht gut aus", und eine Überschrift
 * *Kontakt*, unter der nach dem Weglassen nichts mehr steht, ist derselbe
 * Befund an einer neuen Stelle: die Zeilen unter ihr sind entfallen, sie selbst
 * trägt keinen Platzhalter und bliebe stehen.
 *
 * **Von hinten nach vorn**, damit Ketten mitgehen: fällt die `###` weg, kann die
 * `##` darüber dadurch selbst zur letzten ihres Abschnitts werden. Die
 * Bedingung ist „gefolgt von einer Überschrift gleichen oder höheren Rangs oder
 * vom Ende" — eine `##` mit einer `###` darunter ist kein leerer Abschnitt,
 * sondern ein Rahmen.
 *
 * ⚠️ **Je Text und nicht über die Fuge hinweg.** Rumpf und fester Teil einer
 * Vorlage gehen einzeln durch diese Stufe; eine Überschrift am Ende des Rumpfes,
 * der unmittelbar eine Überschrift des festen Teils folgt, bleibt also stehen.
 * Bei den ausgelieferten Vorlagen tritt das nicht ein (der Rumpf endet in
 * Prosa), und die Alternative wäre eine Aufräumstufe, die zwei Texte
 * zusammenschneidet, ohne einen von beiden zu kennen.
 */
function withoutEmptySections(
  blocks: readonly LegalBlock[],
): readonly LegalBlock[] {
  const kept = [...blocks];
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const block = kept[index];
    if (block?.kind !== 'heading') {
      continue;
    }
    const next = kept[index + 1];
    if (
      next === undefined ||
      (next.kind === 'heading' && next.level <= block.level)
    ) {
      kept.splice(index, 1);
    }
  }
  return kept;
}

/**
 * Ein gerenderter Text, für die Zielgruppe zurechtgemacht — die eine Stelle, an
 * der {@link withoutEmptySections} hängt, damit keiner der drei Rückgabewege sie
 * vergisst.
 */
function shown(
  run: LegalRenderRun,
  blocks: readonly LegalBlock[],
): readonly LegalBlock[] {
  return run.audience === 'public' ? withoutEmptySections(blocks) : blocks;
}

/**
 * Was ein Rendervorgang durchgehend mit sich führt.
 *
 * Ein Bündel statt sieben Argumenten durch drei Funktionen, seit die
 * Zielgruppe dazugekommen ist ({@link LegalAudience}): `facts` und `labels`
 * werden einmal je Seite berechnet und von jedem Teil gelesen, und eine
 * Aufrufkette mit sieben Stellen ist die, in der zwei davon vertauscht werden.
 */
interface LegalRenderRun {
  readonly template: LegalTemplate;
  readonly document: LegalDocument;
  readonly context: LegalRenderContext;
  readonly audience: LegalAudience;
  /** Die Werte, die die Anwendung selbst setzt ({@link appFacts}). */
  readonly facts: Record<string, string>;
  /** Die Beschriftungen aller Platzhalter ({@link slotLabels}). */
  readonly labels: Record<string, string>;
}

function renderPart(
  part: string,
  run: LegalRenderRun,
): {
  readonly blocks: readonly LegalBlock[];
  readonly missing: readonly string[];
} {
  const resolved = resolveConditions(
    part,
    activeConditions(run.template, run.document, run.context),
  );
  const values = { ...run.document.fills, ...run.facts };
  /*
    **Zweimal ersetzt, und beide Male für etwas anderes** (Review-Runde 5 Nr. 1).

    Der erste Durchgang ist die Wahrheit über die *Seite*: er benennt jede offene
    Angabe, und daraus wird `missing` — und damit der Zustand. Er läuft über den
    **ganzen** Text, auch über die Zeilen, die öffentlich entfallen; eine Seite,
    die sich durch das Weglassen selbst fertigmachte, wäre der eine Zustand, den
    das hier nicht erreichen darf.

    Der zweite ist die Ausgabe für Fremde: `withoutOpenSlots` nimmt die offenen
    Angaben **vor** der Ersetzung heraus, weil nur dort noch zu sehen ist, welche
    Stelle welchem Feld gehörte. Was danach ersetzt wird, hat keine Lücke mehr —
    kein Sentinel, kein `[[…]]`, nichts, was ein Parser noch als Lücke lesen
    könnte.
  */
  const substituted = substituteSlots(resolved, values, run.labels);
  const shown =
    run.audience === 'public'
      ? substituteSlots(withoutOpenSlots(resolved, values), values, run.labels)
      : substituted;
  return {
    blocks: parseLegalText(shown.text),
    /**
     * **A gap that the application itself leaves open does not count against
     * this page.** If the name of the operator is missing, that is an open point
     * of the *installation* and not of the organisation whose notice
     * quotes it — it cannot close it. The gap stays visible
     * nonetheless.
     *
     * **Und ein freiwilliges Feld zählt ebenso wenig** (Review-Runde 5,
     * Nachtrag — {@link isOptionalSlot}): die Telefonnummer fehlt, die Seite
     * ist trotzdem fertig. Sie steht deshalb auch in keiner Aufzählung
     * fehlender Angaben; in der Vorschau des Editors bleibt sie als benannte
     * Lücke sichtbar, denn dort ist sie ein Angebot und kein Vorwurf.
     */
    missing: substituted.missing.filter(
      (key) => !isAppSlot(key) && !isOptionalSlot(run.template, key),
    ),
  };
}

function emptyPage(
  run: LegalRenderRun,
  fixedBlocks: readonly LegalBlock[],
): RenderedLegalPage {
  /*
    **Auch der Ersatztext geht durch dieselbe Regel** (Review-Runde 5 Nr. 1,
    Befund des Reviews). Er trägt nur `APP_`-Werte, und die stehen fast immer —
    aber „fast immer" ist keine Zusicherung: wäre einer davon leer, stünde auf
    einer öffentlichen Seite „⟨Angabe fehlt: Name der Organisation⟩", und die
    Zusage „in einer öffentlichen Nutzlast entsteht keine Lücke" wäre eine
    Behauptung über den Normalfall statt über die Bauart. Eine Zeile.
  */
  const body =
    run.audience === 'public'
      ? withoutOpenSlots(run.template.emptyBody, run.facts)
      : run.template.emptyBody;
  const substituted = substituteSlots(body, run.facts, run.labels);
  return {
    title: run.template.title,
    status: 'empty',
    blocks: [...shown(run, parseLegalText(substituted.text)), ...fixedBlocks],
    missing: [],
  };
}

/**
 * The state of a page **without** rendering it — for the list of open
 * points and the hint when publishing.
 *
 * The same answer as {@link renderLegalPage}, only without the blocks: the
 * interface asks it in five places, and building a whole legal text five times
 * over to colour a traffic light would be work for nothing.
 *
 * ⚠️ **A derived value is not an open placeholder** (ADR-0028 no. 5). Nothing
 * an `APP_` slot carries can turn this light red: {@link isAppSlot} keeps
 * those out of `open` below, exactly as {@link renderPart} keeps them out of
 * `missing`. A form without a redirect must not become `incomplete` for
 * lacking an address that nothing asks it for — and one *with* a redirect must
 * not become `incomplete` either, because the application fills that slot
 * itself.
 */
export function legalPageStatus(
  template: LegalTemplate,
  document: LegalDocument,
  context: LegalRenderContext,
): LegalPageStatus {
  if (document.mode === 'link') {
    // Ein Verweis ist fertig oder gar nicht da — es gibt nichts, was halb
    // ausgefüllt sein könnte.
    return safeExternalUrl(document.link) === null ? 'empty' : 'ready';
  }
  if (document.mode === 'custom') {
    const own = document.custom.trim();
    if (own === '') {
      return 'empty';
    }
    return /\[\[[A-Z0-9_]+\]\]/u.test(own) ? 'incomplete' : 'ready';
  }
  const filled = template.slots.some(
    (slot) => (document.fills[slot.key] ?? '').trim() !== '',
  );
  if (!filled) {
    return 'empty';
  }
  const resolved = resolveConditions(
    template.body,
    activeConditions(template, document, context),
  );
  const open = slotKeysOf(resolved).filter(
    (key) =>
      !isAppSlot(key) &&
      !isOptionalSlot(template, key) &&
      (document.fills[key] ?? '').trim() === '',
  );
  return open.length === 0 ? 'ready' : 'incomplete';
}

/**
 * Ob ein Feld **freiwillig** ist — und damit eine Seite nicht unfertig macht
 * (Review-Runde 5, Nachtrag).
 *
 * Der Befund war: *„Rechtstexte offen Hinweis sollte nur bei den wichtigen
 * Punkten angezeigt werden. Die Telefonnummer ist ja optional dachte ich."* Er
 * trifft zu, und die Vorlage sagte es an der Telefonnummer bereits selbst
 * („Nicht zwingend, wenn ein zweiter schneller Kommunikationsweg besteht") —
 * nur zählte die Ampel trotzdem mit. Eine Seite, die wegen eines freiwilligen
 * Feldes „unvollständig" heißt, macht aus einer richtigen Warnung eine, die man
 * wegklickt.
 *
 * ⚠️ **Es ist keine dritte Art von Bedingung.** Ob ein ganzer *Abschnitt*
 * zutrifft, entscheidet weiterhin ein `⟪WENN:…⟫`-Block, und ein nicht
 * ausgewählter Block nimmt seine Felder ohnehin mit ({@link visibleSlots}).
 * {@link LegalSlot.optional} ist die andere Frage: der Abschnitt gilt, das Feld
 * darin ist trotzdem freiwillig.
 *
 * Ein unbekannter Schlüssel ist **nicht** freiwillig: Platzhalter ohne Feld
 * kann es nicht geben ({@link templateDefects} macht sie zum Vorlagenfehler),
 * und im Zweifel ist „zählt mit" die Richtung, in der nichts stillschweigend
 * durchrutscht.
 */
function isOptionalSlot(template: LegalTemplate, key: string): boolean {
  return template.slots.find((slot) => slot.key === key)?.optional === true;
}

/**
 * **The narrow render context in which the two organisation pages are
 * judged** — one place, because it is one judgement.
 *
 * Not a parameter, and that is a statement about the templates rather than a
 * convenience: {@link legalPageStatus} reads the context in exactly one
 * spot, {@link activeConditions}, and only for the derived `⟪WENN:ki⟫`
 * block. `TENANT_IMPRINT` carries no derived condition at all, and the `ki`
 * block of `TENANT_PRIVACY` stands in its `fixed` part — which
 * `legalPageStatus` never reads, it resolves `template.body`. The three
 * names reach nothing either: they fill `APP_` slots, and {@link isAppSlot}
 * keeps those out of the open ones. A context handed in here would be a knob
 * with nothing behind it, and an invitation to a second judgement about the
 * same two documents.
 *
 * `redirectTarget: null` reads the same way and is the sharper case, because
 * it is the one somebody could mistake for a gap (ADR-0028 no. 5): these are
 * the pages of an *organisation*, which has no single redirect target, and the
 * `⟪WENN:weiterleitung⟫` block of `TENANT_PRIVACY` names none — it is answered
 * by a human and stands in the `fixed` part, which this judgement never reads.
 */
const TENANT_LEGAL_CONTEXT: LegalRenderContext = {
  organisationName: null,
  organisationShortName: null,
  operatorName: null,
  aiActive: false,
  redirectTarget: null,
};

/**
 * How bad each verdict is — `0` is the worst.
 *
 * A `Record` over the type and not a list: a fourth state cannot be added
 * without being ranked here, and the compiler is what says so.
 */
const LEGAL_STATUS_RANK: Readonly<Record<LegalPageStatus, number>> = {
  empty: 0,
  incomplete: 1,
  ready: 2,
};

/**
 * **Which pages of an organisation are not ready** — in the order of
 * {@link TENANT_LEGAL_PAGES}.
 *
 * For the two places that may *name* what is missing, and both of them may
 * because they already hold the documents: the list of open items of an
 * organisation (`views/tenant-setup/open-items.ts`) and the second stage of
 * the notice before publishing (`views/builder/use-open-legal-page-names.ts`).
 * Both sit behind `can_manage_settings`, the guard on `GET /tenant/legal`.
 */
export function openTenantLegalPages(
  pages: TenantLegalPages,
): readonly TenantLegalPage[] {
  return TENANT_LEGAL_PAGES.filter(
    (page) =>
      legalPageStatus(
        TENANT_LEGAL_TEMPLATES[page],
        pages[page],
        TENANT_LEGAL_CONTEXT,
      ) !== 'ready',
  );
}

/**
 * Both legal-text pages of an organisation as **one** traffic light — the
 * worse of the two wins.
 *
 * ⚠️ **The fold is the point, not a convenience.** The reasoning stands in
 * full at the field this feeds, `organisationLegal` on
 * `publishPreviewSchema`; the short form: `GET /tenant/legal` demands
 * `can_manage_settings`, the publish preview stands behind `can_build`, and
 * „welche der beiden Seiten" would already be the first step of the detour
 * around that guard.
 *
 * **That is why this is not `openTenantLegalPages(pages).length`**, although
 * the two would agree on every input. The caller that may only learn *that*
 * something is missing must not have a list of pages within reach at its own
 * call site — the moment it does, a later hand adds `.map(…)` to it and no
 * test notices. Worst state wins for the same reason and not for brevity: a
 * count, or a second light, would already say which of the two is which.
 */
export function tenantLegalStatus(pages: TenantLegalPages): LegalPageStatus {
  return TENANT_LEGAL_PAGES.map((page) =>
    legalPageStatus(
      TENANT_LEGAL_TEMPLATES[page],
      pages[page],
      TENANT_LEGAL_CONTEXT,
    ),
  ).reduce<LegalPageStatus>(
    (worst, status) =>
      LEGAL_STATUS_RANK[status] < LEGAL_STATUS_RANK[worst] ? status : worst,
    'ready',
  );
}

/**
 * **Which fields the interface has to offer right now** — and none beside them.
 *
 * That is the difference between a form with 32 input fields and
 * one with seven: a placeholder that stands in a **deselected** block
 * is not an open statement, and asking for it anyway would mean asking a natural
 * person for their register court. It is the same question that
 * {@link legalPageStatus} asks for „unfertig", and it therefore lives here,
 * so that display and judgement cannot drift apart.
 *
 * **The fixed part counts along, although today it changes nothing.** It has
 * conditional blocks of its own (the redirect after submitting), and a field
 * standing in one of them would belong in this list like any other. Since
 * ADR-0028 no. 5 none does: the last one, the address of the redirect, became
 * a derived `APP_` value, and those are no fields. Reading `fixed` here anyway
 * is the cheaper half of the bargain — the day a fixed block carries a field
 * again, it appears; leaving it out would make it silently unreachable.
 */
export function visibleSlots(
  template: LegalTemplate,
  document: LegalDocument,
  context: LegalRenderContext,
): readonly LegalSlot[] {
  const resolved = resolveConditions(
    `${template.body}\n${template.fixed ?? ''}`,
    activeConditions(template, document, context),
  );
  const keys = new Set(slotKeysOf(resolved));
  return template.slots.filter((slot) => keys.has(slot.key));
}

/**
 * The conditions that **a human** decides on.
 *
 * Everything without {@link LegalCondition.auto}. The derived ones are missing here
 * on purpose: offering them as a checkbox that gets overwritten on
 * save would be a control that lies — the same class of defect as a
 * disabled button that looks like a feature.
 */
export function editableConditions(
  template: LegalTemplate,
): readonly LegalCondition[] {
  return template.conditions.filter(
    (condition) => condition.auto === undefined,
  );
}

/**
 * Checks that every template describes exactly the fields and conditions that
 * its text uses — this module's version of the „single source" guard.
 *
 * Exported because a test calls it and not because the application would
 * need it: a template containing a `[[NEUER_PLATZHALTER]]` that no
 * field list knows is a field that nobody can fill in — and the page
 * would then permanently show a gap that no interface can close.
 */
export function templateDefects(template: LegalTemplate): readonly string[] {
  const defects: string[] = [];
  const declaredSlots = new Set(template.slots.map((slot) => slot.key));
  const declaredConditions = new Set(
    template.conditions.map((condition) => condition.key),
  );
  const text = `${template.body}\n${template.fixed ?? ''}\n${template.emptyBody}`;

  for (const key of slotKeysOf(text)) {
    if (!isAppSlot(key) && !declaredSlots.has(key)) {
      defects.push(`${template.key}: Platzhalter [[${key}]] hat kein Feld.`);
    }
  }
  for (const slot of template.slots) {
    if (!slotKeysOf(text).includes(slot.key)) {
      defects.push(`${template.key}: Feld ${slot.key} steht in keinem Text.`);
    }
  }
  for (const key of conditionKeysOf(text)) {
    if (!declaredConditions.has(key)) {
      defects.push(`${template.key}: Bedingung ${key} ist nicht beschrieben.`);
    }
  }
  for (const condition of template.conditions) {
    if (!conditionKeysOf(text).includes(condition.key)) {
      defects.push(
        `${template.key}: Bedingung ${condition.key} steht in keinem Text.`,
      );
    }
  }
  /*
    **Ein Platzhalter in der Kopfzeile einer Tabelle** (Review-Runde 5 Nr. 1).

    Seit die öffentliche Ansicht die Zeile mit einer offenen Angabe streicht
    ({@link withoutGapLines}), ist die Kopfzeile die eine Zeile, deren Wegfall
    die Tabelle zerlegt: die Trennzeile `|---|---|` bliebe ohne Kopf stehen und
    würde als Absatz gelesen. Keine der ausgelieferten Vorlagen tut das — die
    Platzhalter stehen in den Datenzeilen —, und damit das eine Eigenschaft und
    keine Gewohnheit ist, ist es hier ein benannter Vorlagenfehler.
  */
  for (const head of tableHeadLines(text)) {
    for (const key of slotKeysOf(head)) {
      defects.push(
        `${template.key}: Platzhalter [[${key}]] steht in einer Tabellenkopfzeile.`,
      );
    }
  }
  return defects;
}

// ---------------------------------------------------------------------------
// The wire to the public page
// ---------------------------------------------------------------------------

const legalInlineSchema: z.ZodType<LegalInline> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('strong'), text: z.string() }),
  z.object({
    kind: z.literal('link'),
    href: z.string(),
    label: z.string(),
  }),
  z.object({ kind: z.literal('gap'), label: z.string() }),
]);

const legalRunsSchema = z.array(legalInlineSchema);

export const legalBlockSchema: z.ZodType<LegalBlock> = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3)]),
      runs: legalRunsSchema,
    }),
    z.object({ kind: z.literal('paragraph'), runs: legalRunsSchema }),
    z.object({ kind: z.literal('list'), items: z.array(legalRunsSchema) }),
    z.object({
      kind: z.literal('table'),
      head: z.array(legalRunsSchema),
      rows: z.array(z.array(legalRunsSchema)),
    }),
  ],
);

/**
 * What a public legal-text page delivers.
 *
 * `owner` is the half that the footer already carries and the page
 * has to repeat: an imprint without the statement **whose** imprint it
 * is would, with two legal layers on top of each other, be exactly the mix-up that
 * `docs/legal/README.md` 5.3 wants to prevent.
 *
 * ⚠️ **Ohne `status` und ohne `missing`** — seit Review-Runde 5 Nr. 1. Beide
 * trugen den Warnhinweis „Diese Angaben sind unvollständig. Es fehlt: …", und
 * beide sind aus derselben Leitung genommen worden, aus der auch die Lücken
 * selbst verschwunden sind ({@link LegalAudience}): was ein Fremder nicht
 * anzeigen soll, soll er auch nicht bekommen. Die Zusicherung ist damit
 * bauartbedingt und nicht eine Bedingung in einer Ansicht, die jemand
 * wieder einbauen könnte.
 *
 * Für den Zustand gibt es weiterhin genau einen Ort, und es ist der richtige:
 * die Verwaltung ({@link legalPageStatus} — Ampel an der Karte, offene Punkte,
 * Hinweis beim Veröffentlichen).
 */
export const publicLegalPageSchema = z.object({
  title: z.string(),
  owner: z.object({
    kind: z.enum(['installation', 'organisation']),
    name: z.string().nullable(),
  }),
  blocks: z.array(legalBlockSchema),
});
export type PublicLegalPage = z.infer<typeof publicLegalPageSchema>;

/**
 * The privacy notice **of a form**, the way a participating person
 * gets to see it (ADR-0028 no. 4, `docs/legal/README.md` 5.2).
 *
 * The same blocks as a whole legal-text page and **no** delivery type
 * of its own: what travels here has the same parser, the same
 * allowlist and the same renderer behind it as the imprint. The
 * difference from {@link publicLegalPageSchema} is what is **missing** — no
 * `owner`, because the notice stands below the label of the organisation that
 * the footer carries anyway.
 *
 * **Der Zustand reist nicht mit**, und hier ist er gar nicht mehr
 * ausdrückbar: „nichts hinterlegt" heißt `null` statt eines Objekts
 * ({@link renderFormPrivacyNotice}), und „unvollständig" ist seit Review-Runde
 * 5 Nr. 1 nichts, was ein Ausfüllender sehen soll — dieselbe Entscheidung wie
 * bei {@link publicLegalPageSchema}, aus demselben Grund.
 *
 * Ein Formular ohne eigenen Hinweis bekommt **keinen** Ersatztext, sondern
 * nichts: die allgemeinen Datenschutzhinweise der Organisation sind einen Link
 * entfernt und können für dieses Formular genügen. Eine Zeile „für dieses
 * Formular ist nichts hinterlegt" wäre ein Fehlalarm bei genau der
 * Organisation, bei der nichts fehlt (ADR-0022 Nr. 5: „eine Zeile, die überall
 * steht, wird überall überlesen").
 */
export const publicFormPrivacyNoticeSchema = z.object({
  title: z.string(),
  blocks: z.array(legalBlockSchema),
});
export type PublicFormPrivacyNotice = z.infer<
  typeof publicFormPrivacyNoticeSchema
>;

/**
 * What is in the column `form.privacy_notice`, read in such a way that an
 * unreadable row does not take the **form** down.
 *
 * The same direction as {@link parseStoredTenantLegalPages} and for an even
 * sharper reason: what would hang on it here is not a legal-text page but the
 * public fill-out path. A form that can no longer be opened because of a
 * broken JSONB would be the most expensive conceivable failure of this
 * feature — and „nichts hinterlegt" is the statement that is true then.
 */
export function parseStoredFormPrivacyNotice(source: unknown): LegalDocument {
  if (source === null || source === undefined) {
    return EMPTY_LEGAL_DOCUMENT;
  }
  const parsed = legalDocumentSchema.safeParse(source);
  return parsed.success ? parsed.data : EMPTY_LEGAL_DOCUMENT;
}

/**
 * **The one path from the stored form notice onto a screen** —
 * or `null` if there is none.
 *
 * `null` and not an empty block: the public view should then show *nothing*,
 * and the decision about that belongs here and not into each of the
 * three payloads that carry the notice. Whoever made it there would make it
 * three times — and differently the fourth time.
 *
 * Ein **unvollständiger** Hinweis reist weiter mit, aber ohne seine Lücken: die
 * Zielgruppe steht hier fest auf `'public'`, denn dieser Weg hat gar keinen
 * anderen Abnehmer als die Ausfüllseite (Review-Runde 5 Nr. 1). Bleibt dabei
 * von einem eigenen Text nichts übrig, wird aus ihm `empty` und damit `null` —
 * das ist derselbe Satz wie oben und nicht ein zweiter: ein Hinweis, von dem
 * nichts zu zeigen ist, wird nicht als leere Überschrift gezeigt.
 */
export function renderFormPrivacyNotice(
  template: LegalTemplate,
  document: LegalDocument,
  context: LegalRenderContext,
): PublicFormPrivacyNotice | null {
  const rendered = renderLegalPage(template, document, context, 'public');
  if (rendered.status === 'empty') {
    return null;
  }
  return { title: rendered.title, blocks: [...rendered.blocks] };
}

/**
 * What the footer has to know about the **installation**, and nothing else.
 *
 * An own, tiny public request instead of a field on every
 * fill-out response: the footer stands below six different views with
 * five different payloads, and writing the field into all five contracts
 * would be the same decision five times. The name is public by
 * definition — it stands in the imprint.
 */
export const publicLegalFooterSchema = z.object({
  installationName: z.string().nullable(),
});
export type PublicLegalFooter = z.infer<typeof publicLegalFooterSchema>;
