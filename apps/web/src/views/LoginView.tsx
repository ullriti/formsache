import type { ReactElement, SyntheticEvent } from 'react';
import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OIDC_OUTCOME_PARAM,
  PASSWORD_RESET_TTL_MINUTES,
  loginRequestSchema,
  oidcOutcomeSchema,
  type OidcOutcome,
  type OidcProvider,
} from '@formsache/shared';

import { fetchOidcProviders, oidcStartUrl } from '../api/auth';
import { ApiError } from '../api/http';
import { useLogin, useRequestPasswordReset } from '../api/session';
import { ProductLockup } from '../brand/ProductLockup';

import './login-view.css';

/**
 * The one thing a failed login may say.
 *
 * "Diese E-Mail-Adresse ist unbekannt" would turn the login form into a
 * directory of who has an account — that out, and the API
 * answers the same 401 for both cases. A more helpful wording here would give
 * away exactly what the server refuses to.
 */
const CREDENTIALS_MESSAGE = 'E-Mail-Adresse oder Passwort ist falsch.';

/** Everything that is not "wrong credentials" — a 500, a proxy, no network. */
const UNAVAILABLE_MESSAGE =
  'Die Anmeldung ist zurzeit nicht möglich. Bitte versuche es später erneut.';

const INPUT_MESSAGE =
  'Bitte gib eine gültige E-Mail-Adresse und ein Passwort ein.';

/**
 * What each `?sso=` code means, in words (ADR-0012 no. 3).
 *
 * **The sentences live here, and the address carries only a code.** A message
 * taken out of the query string would be an open channel for putting arbitrary
 * wording on our own login page — a phishing surface that costs nothing to
 * close, and the reason `oidcOutcomeSchema` is an enum rather than a string.
 * Anything the server did not send, or a value somebody invented, falls through
 * to `null` and shows nothing at all.
 *
 * `abgelehnt` deliberately says nothing about *why*: “there is no invitation”
 * and “the address belongs to a local account” have to read the same, or
 * this page becomes a directory of who has an account here. `ohne-Organisation` is the
 * one case that may be specific, because the person has already proved who they
 * are — and it is the „verständliche Sackgasse" the requirement asks for instead
 * of an empty shell.
 */
const OIDC_MESSAGES: Record<Exclude<OidcOutcome, 'angemeldet'>, string> = {
  abgelehnt:
    'Die Anmeldung war nicht möglich. Für diese Adresse liegt in dieser Organisation kein Zugang vor — bitte wende dich an die Nutzerverwaltung deines Organisation.',
  'ohne-Organisation':
    'Die Anmeldung hat geklappt, dein Konto gehört aber zu keiner Organisation. Bitte wende dich an die Nutzerverwaltung deines Organisation, damit du freigeschaltet wirst.',
  fehlgeschlagen:
    'Die Anmeldung über SSO ist fehlgeschlagen. Bitte versuche es erneut.',
};

/**
 * The outcome the callback sent us back with, or `null`.
 *
 * Read from `window.location` once, at mount: the browser arrives here through
 * a full page load from the identity provider, so there is no earlier render
 * this could have been handed down from — and, since {@link forgetOidcOutcome}
 * takes the parameter out of the address a moment later, a second read would
 * find nothing.
 */
function oidcOutcome(): Exclude<OidcOutcome, 'angemeldet'> | null {
  const raw = new URLSearchParams(window.location.search).get(
    OIDC_OUTCOME_PARAM,
  );
  const parsed = oidcOutcomeSchema.safeParse(raw);
  if (!parsed.success || parsed.data === 'angemeldet') {
    return null;
  }
  return parsed.data;
}

/**
 * Removes `?sso=` from the address once it has been read.
 *
 * The code belongs to **one** arrival from the identity provider, and it stayed
 * in the address bar afterwards: a reload showed the same „die Anmeldung war
 * nicht möglich" again, over a page that had nothing to do with it, and the
 * sentence stayed in the browser's history and in anything the person copies
 * out of the URL bar. `replaceState`, not `pushState` — this is a correction of
 * the current entry, not a navigation, so the Back button keeps working.
 *
 * Unconditional: a value the server never sends renders nothing, but leaving a
 * stranger's parameter standing in our own address is exactly the invitation
 * `oidcOutcomeSchema` exists to decline.
 */
function forgetOidcOutcome(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(OIDC_OUTCOME_PARAM)) {
    return;
  }
  url.searchParams.delete(OIDC_OUTCOME_PARAM);
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export interface LoginViewProps {
  /**
   * True when the session check itself failed (not a 401). The form still
   * works; the banner says why the app cannot tell whether someone is signed
   * in.
   */
  readonly sessionCheckFailed?: boolean;
}

/**
 * Login view.
 *
 * The prototype has no admin login — its `authed`/`doLogin` gate the simulated
 * fill-out view — so the form language is derived from the handoff: colour
 * stripe, panel surface, PT Serif title, accent gradient on the primary
 * button, the prototype's input optics (9 px radius, `--color-field-border`,
 * accent on focus).
 */
export function LoginView({
  sessionCheckFailed = false,
}: LoginViewProps): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inputError, setInputError] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const login = useLogin();

  /**
   * The SSO offer. A failure here is **not** an error banner: the list is a
   * convenience, the local form works without it, and the server refuses an organisation
   * that does not offer SSO regardless of what this query answered
   * (`fetchOidcProviders`). `retry: false` so a signed-out page does not keep
   * knocking.
   */
  const providers = useQuery({
    queryKey: ['auth', 'oidc-providers'],
    queryFn: fetchOidcProviders,
    retry: false,
  });
  // Held in state, because the address it came from is cleared right after —
  // see `forgetOidcOutcome`. The initialiser runs once; `useState(fn)` rather
  // than `useState(fn())` so it is not re-read on every keystroke in the form.
  const [outcome] = useState(oidcOutcome);
  useEffect(forgetOidcOutcome, []);

  // `SyntheticEvent`, not `FormEvent`: the latter is deprecated in the current
  // React types.
  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();

    // Guards against the double submit a fast second click would cause; the
    // button is disabled too, but a keyboard "Enter" does not care about that.
    if (login.isPending) {
      return;
    }

    // Client-side validation is UX only — it saves a round trip and normalises
    // the address the same way the server does. The server validates again
    // , so nothing here is a security measure.
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setInputError(true);
      return;
    }

    setInputError(false);
    login.mutate(parsed.data);
  };

  const errorMessage = inputError
    ? INPUT_MESSAGE
    : login.error === null
      ? null
      : login.error instanceof ApiError && login.error.status === 401
        ? CREDENTIALS_MESSAGE
        : UNAVAILABLE_MESSAGE;

  return (
    // `<main>`, not a `<div>`: signed out this component *is* the whole page,
    // and a page without a main landmark leaves screen-reader users without
    // the one jump target that skips the chrome. It is also what makes the
    // overflow measurement of the requirement able to measure here at all —
    // `expectNoHorizontalScroll` reads `<main>`'s content width (see the note
    // in `apps/web/src/shell/app-shell.css`), and until now the signed-out app
    // had no `<main>` for it to read.
    <main className="login">
      <div className="login__card">
        <div className="login__stripe" />
        <div className="login__body">
          {/*
            The product lockup stands where up to now the word „Formularsystem"
            stood (ADR-0019). The same place, the same job — it says which
            software this is —, only it now carries the name as a mark.

            The title below it names the same software once more in type, and
            that is deliberate: the lockup is a `<p>`, the heading is the only
            level-1 heading of this page. Without it the signed-out view would
            have no entry point a screen reader can steer to.
          */}
          <p className="login__brand">
            <ProductLockup />
          </p>
          <h1 className="login__title">Formsache</h1>
          <p className="login__subtitle">
            Anmeldung für Bearbeiterinnen und Bearbeiter. Zum Ausfüllen eines
            Formulars ist keine Anmeldung nötig.
          </p>

          {sessionCheckFailed ? (
            <p className="login__notice" role="status">
              Der Anmeldestatus konnte nicht geprüft werden. Bitte melde dich
              an.
            </p>
          ) : null}

          {outcome === null ? null : (
            <p className="login__error" role="alert" data-testid="sso-error">
              {OIDC_MESSAGES[outcome]}
            </p>
          )}

          {providers.data === undefined ? null : (
            <OidcOffer offers={providers.data} />
          )}

          {/* `noValidate`: the browser's own bubble would pre-empt the check
              below, so the same input would be rejected in two different
              visual languages depending on the browser. The `required`
              attributes stay — they are what tells assistive technology that
              a field is mandatory. */}
          <form className="login__form" noValidate onSubmit={onSubmit}>
            <div className="login__field">
              <label className="login__label" htmlFor={emailId}>
                E-Mail-Adresse
              </label>
              <input
                className="login__input"
                id={emailId}
                name="email"
                type="email"
                autoComplete="email"
                // Acceptable here and only here: the login page exists for
                // this one form, so focusing it skips a Tab for everyone and
                // steals focus from nothing.
                autoFocus
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </div>

            <div className="login__field">
              <label className="login__label" htmlFor={passwordId}>
                Passwort
              </label>
              <input
                className="login__input"
                id={passwordId}
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>

            {errorMessage === null ? null : (
              <p
                className="login__error"
                role="alert"
                data-testid="login-error"
              >
                {errorMessage}
              </p>
            )}

            <button
              className="login__submit"
              type="submit"
              disabled={login.isPending}
            >
              {login.isPending ? 'Anmeldung läuft…' : 'Anmelden'}
            </button>
          </form>

          <ForgotPassword email={email} />
        </div>
      </div>
    </main>
  );
}

/**
 * Ab wie vielen Organisationen die Auswahl an die Stelle der Schaltflächen
 * tritt.
 *
 * Vier ist keine gemessene Zahl, sondern eine Abwägung zweier echter Kosten:
 * eine Schaltfläche ist **ein** Klick und zeigt alle Angebote gleichzeitig,
 * eine Auswahl ist aufklappen, suchen, wählen, bestätigen — also mindestens
 * drei. Solange die Liste auf einen Blick zu erfassen ist, gewinnt die
 * Schaltfläche; sobald sie das Anmeldeformular unter die Falz schiebt, verliert
 * sie. Dazwischen liegt die Grenze, und sie liegt näher an „wenige" als an
 * „viele", weil die Angebote hier untereinander stehen und nicht nebeneinander.
 *
 * Wer sie verschiebt, verschiebt eine Anzeigeentscheidung und sonst nichts:
 * beide Zweige führen auf dieselbe Adresse, und keiner von beiden entscheidet
 * etwas über die Anmeldung.
 */
const SSO_BUTTON_LIMIT = 4;

/**
 * Das SSO-Angebot — über dem Passwortformular, weil wer ein Organisationskonto
 * hat, es benutzt, und das lokale Formular der Rückfallweg für Personen ohne
 * eines ist.
 *
 * ## Zwei Darstellungen, ein Weg
 *
 * Bis {@link SSO_BUTTON_LIMIT} Organisationen eine Schaltfläche je
 * Organisation, darüber eine Auswahl und ein „Weiter". Das ist **ausschließlich
 * eine Anzeigeentscheidung**, und das ist der Satz, der hier stehen bleiben
 * muss: Was gewählt wird, ist der `:tenantId` der Startadresse — also genau
 * das, was die Schaltfläche auch trug. Der Server entscheidet danach
 * unverändert selbst, ob diese Organisation SSO überhaupt anbietet
 * (`oidc-login.controller.ts`), und die Anmeldung mit E-Mail und Passwort weiß
 * von dieser Auswahl nichts: Wer zu welcher Organisation gehört, ergibt sich
 * aus der Mitgliedschaft, nie aus einer Angabe der Anmeldeseite.
 *
 * Eine Auswahl auf einer Anmeldeseite lädt dazu ein, sie später als „Kontext"
 * mitzuschicken. Sie darf das nicht werden — das wäre eine Angabe des
 * Absenders an einer Stelle, die keine verträgt.
 *
 * ## Warum Anker und keine Schaltflächen mit `onClick`
 *
 * Das Ziel ist eine Serveradresse, die mit einer Weiterleitung zum
 * Identity-Provider antwortet und dabei das Transaktions-Cookie setzt. Beides
 * braucht eine echte Navigation, und ein Anker ist das, was Mittelklick,
 * Tastatur und Vorlesehilfe bereits verstehen.
 *
 * `rel="nofollow"`: die Adresse startet eine Anmeldung, in die kein Crawler
 * hineinlaufen soll. Kein `target`, also auch keine `noopener`-Frage — das
 * bleibt im selben Tab, auf unserer eigenen Herkunft.
 */
function OidcOffer({
  offers,
}: {
  readonly offers: readonly OidcProvider[];
}): ReactElement | null {
  const chooserId = useId();
  const [chosen, setChosen] = useState('');

  // **Während des Renderns abgeleitet, nicht in einem `useEffect` nachgezogen.**
  // Die Liste trifft asynchron ein, ein Anfangswert aus `useState` könnte sie
  // also gar nicht kennen; und eine Organisation kann zwischen zwei Abfragen
  // verschwinden (SSO abgeschaltet, Organisation gelöscht). Beide Fälle enden
  // hier auf demselben Rückfall statt auf einer Auswahl, die auf nichts zeigt —
  // ohne zweiten Renderdurchlauf und ohne einen Moment, in dem der Anker eine
  // Adresse trägt, die es nicht mehr gibt.
  //
  const selected =
    offers.find((offer) => offer.tenantId === chosen) ?? offers[0];

  // **„Keine Organisation bietet SSO an" wird hier entschieden und nur hier.**
  // Der Aufrufer prüfte das früher ein zweites Mal, und zwei Stellen für
  // dieselbe Frage sind eine Stelle zu viel — zumal `noUncheckedIndexedAccess`
  // ohnehin recht behält: dass `offers` nicht leer ist, war eine Zusage des
  // Aufrufers, die der Typ nicht kannte und die ein dritter Aufrufer nicht
  // hätte einhalten müssen. Jetzt trägt die Bedingung, die den Wert braucht,
  // auch seine Prüfung.
  if (selected === undefined) {
    return null;
  }

  return (
    <div className="login__sso">
      {offers.length <= SSO_BUTTON_LIMIT ? (
        offers.map((offer) => (
          <a
            key={offer.tenantId}
            className="login__sso-button"
            href={oidcStartUrl(offer.tenantId)}
            rel="nofollow"
          >
            {/*
              **Der Organisationsname, und er ist der wichtigere der beiden
              Texte** — deshalb steht er oben und trägt das Gewicht.

              Er reist seit jeher im `OidcProvider` mit und wurde hier nicht
              gerendert; das ging gut, solange eine Installation eine
              Organisation mit SSO hatte. Es geht nicht mehr gut, sobald sie
              mehrere hat: `oidcButtonLabel` ist optional und fällt auf
              `DEFAULT_OIDC_BUTTON_LABEL` zurück — auf *denselben Satz* für jede
              Organisation, die keine eigene Beschriftung gepflegt hat.

              Der Name statt `shortName`: der Kurzname ist ein Handle für
              Adressen und Tabellen, der Name ist, wie die Organisation sich
              nennt. Wer hier sucht, sucht den Namen.
            */}
            <span className="login__sso-tenant">{offer.name}</span>
            {/*
              **Ein echtes Leerzeichen, kein Layout-Abstand.** Der zugängliche
              Name eines Ankers wird aus seinen Textknoten aneinandergehängt,
              ohne Rücksicht darauf, dass die beiden Spans optisch in zwei
              Zeilen stehen: ohne dieses Zeichen liest eine Vorlesehilfe
              „Ortsgruppe MusterstadtMit Organisationskonto anmelden" am Stück.
              Im Flex-Container ist es folgenlos — reiner Leerraum zwischen
              Flex-Kindern erzeugt kein anonymes Element.
            */}{' '}
            {/*
              Die Beschriftung ist die *Handlung*, nicht die Kennung — und
              bleibt deshalb unverändert die des Servers. Der Rückfall auf die
              Vorgabe wird weiterhin **einmal** angewendet, dort
              (`oidc-login.service.ts`); hier eine zweite Formulierung zu
              erfinden wäre genau die Dopplung, die `DEFAULT_OIDC_BUTTON_LABEL`
              vermeidet.
            */}
            <span className="login__sso-action">{offer.buttonLabel}</span>
          </a>
        ))
      ) : (
        <>
          <div className="login__field">
            <label className="login__label" htmlFor={chooserId}>
              Organisation
            </label>
            {/*
              Ein natives `<select>` und keine selbstgebaute Combobox: es ist
              auf dem Telefon der Auswahldialog des Systems, am Rechner mit der
              Tastatur bedienbar und mit Vorlesehilfen erprobt — alles, was ein
              Eigenbau erst wieder herstellen müsste. Tippen zum Filtern kann es
              nicht; das wird ab einigen Dutzend Organisationen zum Thema und
              ist dann eine eigene Entscheidung, keine Fußnote hier.
            */}
            <select
              className="login__input"
              id={chooserId}
              value={selected.tenantId}
              onChange={(event) => {
                setChosen(event.target.value);
              }}
            >
              {offers.map((offer) => (
                <option key={offer.tenantId} value={offer.tenantId}>
                  {offer.name}
                </option>
              ))}
            </select>
          </div>
          {/*
            **Vorbelegt mit der ersten Organisation**, damit dieser Anker zu
            jedem Zeitpunkt ein gültiger Anker ist: fokussierbar, mittelklickbar
            und für eine Vorlesehilfe ein Link. Die Alternative — eine
            „bitte wählen"-Option und ein Anker ohne `href` — wäre genau das
            nicht: ein Anker ohne `href` ist kein Link, liegt nicht in der
            Tabreihenfolge, und wer sich mit der Tastatur bewegt, fände an
            dieser Stelle nichts vor.

            Die Fehlbedienung, die das zulässt, ist folgenlos: Wer ohne
            Hinsehen auf „Weiter" klickt, landet beim Identity-Provider einer
            fremden Organisation, meldet sich dort nicht an und geht zurück.
            Die Liste ist serverseitig stabil nach `shortName` sortiert, die
            Vorbelegung springt also nicht zwischen zwei Abfragen.
          */}
          <a
            className="login__sso-button"
            href={oidcStartUrl(selected.tenantId)}
            rel="nofollow"
          >
            {selected.buttonLabel}
          </a>
        </>
      )}
      <p className="login__sso-divider">oder mit E-Mail und Passwort</p>
    </div>
  );
}

/**
 * **„Passwort vergessen"** (ADR-0020) — below the login form, expandable.
 *
 * ## Why the answer is always the same
 *
 * The server answers every request with a 204 and without a body, whether the
 * address exists or not. This view **must** not make anything else of that: a
 * “we have written to you” against a “we do not know this address” would be
 * exactly the directory of the installation that the route avoids. The sentence
 * below is therefore deliberately written in the conditional — „falls es ein
 * Konto gibt" — and stands there the same after every submission.
 *
 * ## Why the address is taken over from the login form
 *
 * Whoever has forgotten their password has usually just tried unsuccessfully: the
 * address is then already up there. Taking it over saves the second typing and
 * the second opportunity for a typo that nobody notices, because the answer is
 * always the same anyway.
 */
function ForgotPassword({ email }: { readonly email: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState(email);
  const [sent, setSent] = useState(false);
  const requestReset = useRequestPasswordReset();

  if (!open) {
    return (
      <button
        type="button"
        className="login__link"
        onClick={() => {
          setAddress(email);
          setOpen(true);
        }}
      >
        Passwort vergessen?
      </button>
    );
  }

  return (
    <div className="login__field">
      <label className="login__label" htmlFor="login-reset-email">
        E-Mail-Adresse für den Rücksetz-Link
      </label>
      <input
        className="login__input"
        id="login-reset-email"
        type="email"
        autoComplete="email"
        value={address}
        onChange={(event) => {
          setAddress(event.target.value);
          setSent(false);
        }}
      />
      <button
        type="button"
        className="login__submit"
        disabled={requestReset.isPending || address.trim() === ''}
        onClick={() => {
          requestReset.mutate(address.trim(), {
            // **`onError` sets “sent” as well.** An error branch that looked
            // different would again be a difference from which something could
            // be read off — and the only errors this route knows are network
            // and rate limiting, not “this address does not exist”.
            onSettled: () => {
              setSent(true);
            },
          });
        }}
      >
        {requestReset.isPending ? 'Wird gesendet…' : 'Link anfordern'}
      </button>
      {sent ? (
        <p className="login__notice" role="status">
          Falls es zu dieser Adresse ein Konto mit Passwort gibt, ist ein Link
          unterwegs. Er gilt {String(PASSWORD_RESET_TTL_MINUTES)} Minuten.
        </p>
      ) : null}
    </div>
  );
}
