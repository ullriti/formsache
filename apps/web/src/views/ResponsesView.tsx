import type { ReactElement } from 'react';
import { useMemo, useRef, useState } from 'react';
import type { FormDefinition } from '@formsache/shared';
import {
  EXPORT_FORMAT_LABELS,
  RESPONSE_BULK_DELETE_MAX,
  SUBMITTED_AT_COLUMN,
  chooseColumns,
  exportFormatSchema,
  rowMatchesSearch,
} from '@formsache/shared';

import { useForm } from '../api/forms';
import { useResponseColumns } from '../api/response-columns';
import { exportUrl, useResponses } from '../api/responses';
import { useDeleteResponses } from '../api/trash';
import { ApiError } from '../api/http';
import { builderPath, DASHBOARD_PATH } from '../router/routes';
import { navigate } from '../router/use-route';
import {
  actionErrorMessage,
  TRASH_DELETE_RESPONSES_SUBJECT,
} from './api-messages';
import type { ExportScope } from './responses/ExportMenu';
import { ExportMenu } from './responses/ExportMenu';
import { ResponseDetailPanel } from './responses/ResponseDetailPanel';
import { ResponsesTable } from './responses/ResponsesTable';
import { ResponsesToolbar } from './responses/ResponsesToolbar';
import { SelectionBar } from './responses/SelectionBar';
import type { Row, SortState } from './responses/response-rows';
import { compareBy, nextSort, toRow } from './responses/response-rows';

import './responses-view.css';

/**
 * The responses view.
 *
 * Title and export at the top, then the toolbar (search, column menu), then
 * the table in its own card. This component owns the server conversation and
 * the view state; how a row renders lives in `responses/response-rows.ts` and
 * how it is drawn in the three components next to it.
 *
 * **Two ways into the trash, one right** : one
 * answer from the detail panel, and the ticked rows from the action bar
 * above the table. Both are gated on `canBuild` here — reaching this view at
 * all already proves `canViewResponses` on this form, because the whole page
 * answers its own 403 otherwise (see below) — and the server asks for the pair
 * again on both routes. Neither goes *past* the trash.
 *
 * Sorting, searching and the column menu all work on the **rendered** value —
 * the same `formatAnswerCell` the CSV export renders its cells from. That is
 * what makes "the export follows the visible view" true rather than
 * approximately true: a search for „Ja, ich komme" finds the row a reader sees,
 * not the stored option value `ja` that nobody typed and nobody sees.
 *
 * **One column here can be several in the file.**
 * An Adresse, a Matrix and a Tabelle are one entry in the field menu
 * and one folded cell in this table, and the export writes them out per part —
 * a Serienbrief needs Straße and PLZ in their own columns, and a PLZ that has
 * been cut out of a joined cell in Excel has lost its leading zero. The
 * *selection* stays whole-question on both sides (`chooseColumns` below and
 * `csvColumns` on the server), so „welche Spalten sind gewählt" still has one
 * answer.
 *
 * ## Two documents, not one
 *
 * The columns and the snapshots come from `GET /forms/:id/responses/columns`;
 * `useForm` is read for the **title** and nothing else. The draft the builder
 * edits is deliberately not a source of columns here — reading it from there
 * let an unsaved experiment change this page, and it made the answers to a
 * removed question unreachable in both the table and the file.
 */
export function ResponsesView({
  formId,
  canBuild,
  canExport,
}: {
  readonly formId: string;
  /**
   * `can_build` of the **active** membership — gates „Zum Builder".
   */
  readonly canBuild: boolean;
  /**
   * `can_export` of the **active** membership. `GET …/export.csv` requires it
   * and answers 403 without it; it used to be offered regardless,
   * so the download simply failed.
   *
   * Both flags are display only. The guards decide again on every request
   * (`CONTRIBUTING.md`) — nothing here is a security boundary, and removing it
   * would make the application leakier by exactly nothing.
   */
  readonly canExport: boolean;
}): ReactElement {
  const form = useForm(formId);
  const responses = useResponses(formId);
  const columnSet = useResponseColumns(formId);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>({
    key: SUBMITTED_AT_COLUMN,
    direction: -1,
  });
  const [visible, setVisible] = useState<string[] | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  /**
   * Where focus goes when the row that opened the detail panel is gone by
   * the time the panel closes — a delete removes it, and
   * `useFocusTrap`'s own `fallbackRef` is exactly the mechanism built for a
   * trigger that cannot take focus back. `tabIndex={-1}` on the `<h1>` below
   * is what lets it.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  /**
   * **„Alle Spalten" is the preselection of the export**  — decided on 2026-08-06 and the user-visible half of that decision.
   *
   * It used to be `'visible'`, „because that is what the requirement promised".
   * That requirement is about the *rows* and the *stated* selection and is untouched: the search
   * still filters, and a reader who picks „Angezeigte Spalten" still gets
   * exactly what is on screen. What changed is which of the two is pre-ticked,
   * and the reason is that the two surfaces answer different questions — three
   * columns on screen are a statement about space, a downloaded file is a
   * statement about data. An acceptance run measured the cost: ten column-bearing
   * questions, three of them in the untouched file, and nothing on the surface
   * said so.
   *
   * The server agrees by construction rather than by coincidence: it answers a
   * request without `columns` with `pickDefaultColumns(…, 'export')`, the same
   * function this view calls with `'table'` for `shown` above.
   */
  const [exportScope, setExportScope] = useState<ExportScope>('all');

  /**
   * **The tick marks of the Mehrfachauswahl**  — *marks*, not
   * the selection.
   *
   * What the bar counts and what „Löschen" sends is `selectedRows` below: this
   * set intersected with the rows that are actually **rendered**. The
   * distinction is the whole of the evidence and it is deliberately structural
   * rather than a matter of housekeeping — a set that had to be pruned on every
   * search keystroke would be correct exactly as long as nobody forgets a
   * pruning step, and the direction of that mistake is the expensive one:
   * deleting answers nobody has seen.
   */
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [isConfirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkError, setBulkError] = useState<string | undefined>(undefined);
  const deleteResponses = useDeleteResponses();

  /**
   * Every column that was ever published, active ones first — the field menu
   * chooses from these.
   *
   * The order is the server's (`responseColumns` in `form-history.ts`) and is
   * left exactly as it arrives: today's form in its document order, then the
   * retired questions in the order they were retired. Re-sorting here would be
   * a second opinion about a rule that already has one.
   */
  const columns = useMemo(
    () => columnSet.data?.columns ?? [],
    [columnSet.data],
  );

  /**
   * The published snapshots, by version number — the source every row is
   * rendered against.
   */
  const definitions = useMemo(() => {
    const byVersion = new Map<number, FormDefinition>();
    for (const snapshot of columnSet.data?.versions ?? []) {
      byVersion.set(snapshot.version, snapshot.definition);
    }
    return byVersion;
  }, [columnSet.data]);

  /**
   * The visible columns: what the reader chose, or the default view of the
   * handoff — the first three questions plus the timestamp.
   *
   * `chooseColumns` comes from `@formsache/shared` and the export applies the very
   * same function to the very same list on the other side of the wire. This
   * view used to spell the rule out a second time, in its own words, which is
   * how the table and the file came to disagree about what „die Standardsicht"
   * is. It also carries `retired` through the selection untouched, so a
   * retired column stays marked once it is chosen.
   *
   * `'table'` is the one argument that separates this from the export since Konzept
   * no. 80 : three questions here, all of them there. Everything
   * else about the default — which questions are eligible, in which order, where
   * the timestamp goes — is still decided once, in one function.
   */
  const shown = useMemo(
    () => chooseColumns(columns, visible ?? undefined, 'table'),
    [columns, visible],
  );

  const shownKeys = useMemo(
    () => new Set(shown.map((column) => column.key)),
    [shown],
  );

  /** The keys the server reports as no longer asked — for the marking. */
  const retiredKeys = useMemo(
    () =>
      new Set(
        columns.filter((column) => column.retired).map((column) => column.key),
      ),
    [columns],
  );

  const rows = useMemo(
    () =>
      (responses.data ?? []).map((response) =>
        toRow(response, definitions.get(response.formVersion)),
      ),
    [responses.data, definitions],
  );

  /**
   * The columns the file will carry.
   *
   * `'all'` is the preselection since Konzept no. 80 and sends the whole union,
   * retired and hidden columns included; `'visible'` sends exactly what the
   * table shows, which is the requirement unchanged.
   *
   * **How „alle" is said on the wire:** by naming every key. The absent
   * `columns` parameter *also* means „alle" since no. 80, and using that
   * instead was considered and rejected: the radio beside it says „Alle Spalten
   * (11)", and a URL that states nothing would deliver whatever the server's
   * preselection happens to be on the day somebody revisits it. Enumerating
   * makes the address say what the label promises.
   *
   * ⚠️ **The ceiling that comes with it**, stated rather than discovered, and
   * **now on the default path**: a key is a UUID, so a column costs 39
   * characters of query string (36 plus the encoded comma). nginx caps a request
   * line at `large_client_header_buffers`, 8 KiB by default and not overridden
   * in `apps/web/docker/default.conf.template`, which puts the limit around
   * **200 columns** — past that the front door answers 414 and the download
   * simply fails. Ordinary forms are far below it (`formDefinitionSchema` would
   * permit far more: 200 questions per page, 100 pages, and the union
   * accumulates retired ones on top), and the field menu could already build
   * that URL before no. 80 — but a form wide enough to hit it now fails
   * **without anybody choosing anything**. Raising it properly means a token the
   * server understands (`columns=*`), which is an API change and not this
   * file's; it is carried as an open point rather than half-built here.
   */
  const exportColumnKeys = useMemo(
    () => (exportScope === 'all' ? columns : shown).map((column) => column.key),
    [exportScope, columns, shown],
  );

  /**
   * The formats the menu offers — CSV, Excel, HTML.
   *
   * **Built from the list, not spelled out** (`exportFormatSchema`, and the
   * label from `EXPORT_FORMAT_LABELS`): the formats the menu offers are then by
   * construction the formats the route answers to, and the name on the entry is
   * the one the format calls itself. A hand-written array here would be the
   * second list — and its way of failing is quiet in one direction (a format
   * built and never offered) and loud in the wrong place in the other (a menu
   * entry whose click ends in „Unbekanntes Exportformat").
   *
   * ⚠️ **The scope and the search are folded into every address**, above the
   * loop. That is Konzept no. 22 in code: the column question is asked once, and no
   * format can answer it — or the row question — differently from its
   * neighbours, because none of them builds its own URL.
   */
  const exportFormats = useMemo(
    () =>
      exportFormatSchema.options.map((format) => ({
        id: format,
        label: EXPORT_FORMAT_LABELS[format],
        href: exportUrl(formId, format, {
          columns: exportColumnKeys,
          search,
        }),
      })),
    [formId, exportColumnKeys, search],
  );

  const filtered = useMemo(() => {
    // The same predicate the export applies server-side (`rowMatchesSearch`),
    // over the same rendered cells — otherwise the file and the table disagree
    // about which rows the search term picked.
    const matching = rows.filter((row) => rowMatchesSearch(row.cells, search));
    return [...matching].sort(compareBy(sort.key, sort.direction));
  }, [rows, search, sort]);

  /**
   * **The selection, as opposed to the tick marks** — the rendered rows that
   * are ticked, in the order they are drawn.
   *
   * Everything downstream reads this: the bar's counter, „alle" (which sets the
   * marks to exactly these) and the delete. A row that a search has taken off
   * the screen is therefore not selected, no matter what the set below still
   * remembers — which is why clearing the search brings a selection back
   * instead of losing it, and why nothing offscreen can ever be deleted.
   */
  const selectedRows = useMemo(
    () => filtered.filter((row) => ticked.has(row.id)),
    [filtered, ticked],
  );

  const clearSelection = (): void => {
    setTicked(new Set());
    setConfirmingBulk(false);
    setBulkError(undefined);
  };

  /**
   * **The Obergrenze, before it becomes a status code** .
   *
   * `RESPONSE_BULK_DELETE_MAX` is a shared constant, and until this check it
   * was read on one side of the wire only. What the other side did with an
   * oversized selection was a dead end in both directions:
   *
   * - over the limit the server answers **400**, and `actionErrorMessage` turns
   *   every 400 into „Bitte die markierten Felder prüfen." — a sentence about
   *   fields, on a surface that has none and no way forward except unticking
   *   rows by hand;
   * - the responses list has no page size yet, so „alle" is one click
   *   over *every* answer of a form. Past roughly 2600 ids the body outgrows
   *   `JSON_BODY_LIMIT_BYTES` (100 KiB) and the front door answers **413**,
   *   which `actionErrorMessage` reports as „bitte erneut versuchen" — advice
   *   to repeat the one thing that is certain to fail again.
   *
   * Refusing here is therefore not a second validation (the server validates
   * regardless, `CONTRIBUTING.md`) but the only place that can say **what to do**:
   * how many are selected, how many fit, and that the search narrows the
   * selection. Nothing is sent, so neither refusal can be reached from this
   * view any more.
   */
  const onConfirmBulkDelete = (): void => {
    const responseIds = selectedRows.map((row) => row.id);
    if (responseIds.length > RESPONSE_BULK_DELETE_MAX) {
      setConfirmingBulk(false);
      setBulkError(
        `${String(responseIds.length)} Antworten sind ausgewählt, auf einmal löschen lassen sich höchstens ${String(
          RESPONSE_BULK_DELETE_MAX,
        )}. Bitte die Auswahl über die Suche eingrenzen und in mehreren Schritten löschen.`,
      );
      return;
    }

    deleteResponses.mutate(
      { formId, responseIds },
      {
        onSuccess: () => {
          clearSelection();
        },
        onError: (error) => {
          // Closes the confirmation rather than leaving it open next to the
          // error — both are `role="alert"`, and two of those at once is the
          // shape `ResponseDetailPanel` and `TrashView` already avoid. The
          // selection **stays**: the call was all-or-nothing, so the rows are
          // still there and pressing again is the honest next step.
          setConfirmingBulk(false);
          setBulkError(
            actionErrorMessage(error, TRASH_DELETE_RESPONSES_SUBJECT),
          );
        },
      },
    );
  };

  if (form.isPending || responses.isPending || columnSet.isPending) {
    return (
      <div className="responses">
        <p className="responses__state" role="status">
          Antworten werden geladen…
        </p>
      </div>
    );
  }

  if (
    form.data === undefined ||
    responses.data === undefined ||
    columnSet.data === undefined
  ) {
    // Both answer-facing routes require `canViewResponses`, so either of them
    // is the one that names a missing permission — „konnte nicht geladen
    // werden" would send someone reloading a page that will never load.
    const forbidden = [responses.error, columnSet.error].some(
      (error) => error instanceof ApiError && error.status === 403,
    );
    return (
      <div className="responses">
        <p className="responses__state" role="alert">
          {forbidden
            ? 'Diese Rolle darf die Antworten dieses Formulars nicht sehen.'
            : 'Die Antworten konnten nicht geladen werden.'}{' '}
          <button
            type="button"
            className="responses__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Zurück zum Dashboard
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="responses">
      <div className="responses__head">
        {/*
          One heading, two weights: „Antworten" carries the page, the form
          title behind it is context. Splitting them into a heading and a
          separate subline would have read the same on screen and differently
          to a screen reader, which announces the heading alone.
        */}
        <h1 className="responses__title" ref={headingRef} tabIndex={-1}>
          Antworten ·{' '}
          <span className="responses__title-form">{form.data.title}</span>
        </h1>

        <div className="responses__actions">
          {/*
            „Zum Builder" is the same door as the subheader's „Bearbeiten", and
            it is **hidden** without `canBuild` for the same reason `FormNav`
            hides that entry: it is navigation, and a link into an editor that
            cannot save is worse than no link. The sentence that would explain
            it belongs on the dashboard, where the missing right is first felt.
          */}
          {canBuild ? (
            <button
              type="button"
              className="responses__button"
              onClick={() => {
                navigate(builderPath(formId));
              }}
            >
              Zum Builder
            </button>
          ) : null}

          {/*
            The export, on the other hand, is **explained**.
            Getting the answers out is why most people open this page, so its
            silent disappearance is the classic „ist das kaputt?" moment — and
            unlike the builder there is no second place where the reason could
            be read. One line, in the row where the button was, naming the right
            as the group editor names it („Export") so it can be asked for.
          */}
          {canExport ? (
            <ExportMenu
              scope={exportScope}
              onScopeChange={setExportScope}
              visibleColumns={shown.length}
              allColumns={columns.length}
              totalRows={rows.length}
              matchingRows={filtered.length}
              isFiltered={search.trim() !== ''}
              formats={exportFormats}
            />
          ) : (
            <p className="responses__no-export" role="status">
              Export ist der Rolle „Export" vorbehalten – dieser Zugang darf die
              Antworten ansehen, aber nicht herunterladen.
            </p>
          )}
        </div>
      </div>

      <ResponsesToolbar
        search={search}
        onSearchChange={setSearch}
        count={filtered.length}
        isFiltered={search.trim() !== ''}
        columns={columns}
        shownKeys={shownKeys}
        onToggleColumn={(key, checked) => {
          const current = new Set(shownKeys);
          if (checked) {
            current.add(key);
          } else {
            current.delete(key);
          }
          setVisible([...current]);
        }}
      />

      {/*
        Above the table, as the handoff draws it — and only while something is
        selected. `selectedRows` and not `ticked`: the counter is a statement
        about what is on screen.
      */}
      {selectedRows.length === 0 ? null : (
        <SelectionBar
          count={selectedRows.length}
          isConfirming={isConfirmingBulk}
          isPending={deleteResponses.isPending}
          error={bulkError}
          onClear={clearSelection}
          onDeleteRequested={() => {
            setBulkError(undefined);
            setConfirmingBulk(true);
          }}
          onConfirmDelete={onConfirmBulkDelete}
          onCancelDelete={() => {
            setConfirmingBulk(false);
          }}
        />
      )}

      {filtered.length === 0 ? (
        <p className="responses__empty">
          {rows.length === 0
            ? 'Für dieses Formular gibt es noch keine Antworten.'
            : 'Keine Antwort passt zur Suche.'}
        </p>
      ) : (
        <ResponsesTable
          caption={`Antworten zu ${form.data.title}`}
          columns={shown}
          rows={filtered}
          sort={sort}
          onSort={(key) => {
            setSort((current) => nextSort(current, key));
          }}
          onOpen={setDetail}
          selection={
            // Hidden, not disabled, without `canBuild` — the only bulk action
            // is „Löschen", and the route behind it needs the pair
            // `canViewResponses` + `canBuild`. Reaching this
            // branch already proves the first half, exactly as it does for the
            // detail panel's own delete.
            canBuild
              ? {
                  selected: ticked,
                  onToggleRow: (id, checked) => {
                    setBulkError(undefined);
                    setTicked((current) => {
                      const next = new Set(current);
                      if (checked) {
                        next.add(id);
                      } else {
                        next.delete(id);
                      }
                      return next;
                    });
                  },
                  onToggleAll: (checked) => {
                    setBulkError(undefined);
                    // Exactly the rendered rows — never `rows`, which is the
                    // unfiltered set.
                    setTicked(
                      checked
                        ? new Set(filtered.map((row) => row.id))
                        : new Set(),
                    );
                  },
                }
              : undefined
          }
        />
      )}

      {detail === null ? null : (
        <ResponseDetailPanel
          row={detail}
          retiredKeys={retiredKeys}
          formId={formId}
          // `canBuild` alone: reaching this branch already proves
          // `canViewResponses` on this form (`form.isError`/`responses.isError`
          // above would have shown the 403 otherwise), so the pair required to
          // delete a single answer is complete without a second prop.
          canDelete={canBuild}
          fallbackRef={headingRef}
          onClose={() => {
            setDetail(null);
          }}
        />
      )}
    </div>
  );
}
