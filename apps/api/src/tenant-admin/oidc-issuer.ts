/**
 * What may serve as the discovery base of an organisation's identity provider
 * (ADR-0005).
 *
 * **Why this exists next to a schema that already says `z.url()`.** It does not
 * say what one would hope: Zod 4's `z.url()` accepts anything `new URL()`
 * accepts, and that includes `javascript:alert(1)`, `ftp://…` and
 * `https://user:pw@idp.example.org`. The first of those ends up in the tab's
 * „Issuer"-field and, the moment any view renders it as a link, in an `href` —
 * the same class of hole the Logo allow-list of the requirement closes for
 * `logo_ref`. The other two would be a login pointed at something that is not
 * an OIDC provider, with credentials in the address.
 *
 * **Two gates, like the branding colours** (the requirements, and a review before
 * them): a value is refused **on the way in** and refused again **on the way
 * out**, because the column is a plain `text` and a hand-edited row has never
 * passed gate one. The two gates check the same predicate, so the delivery test
 * cannot be red while the write test is green — each therefore gets its own
 * case, which is exactly what the requirement's ⚠️ asks for.
 *
 * Deliberately **not** in `packages/shared`: the browser has no business
 * deciding what the server will talk to, and the shared write schema already
 * carries everything a form can usefully say about the field (`z.url()`, a
 * length bound). This is the server's own, stricter answer, and it is the one
 * that decides.
 */

/**
 * Hosts a plain-`http` issuer is tolerated on — a test IdP on the developer's
 * own machine (`docs/kb/04-build-run.md`).
 *
 * Nowhere else: an `http` issuer on a routable host means the client secret and
 * the authorization code travel in clear, and „es ist ja nur die Testumgebung"
 * is how such a value reaches production. Loopback is the exception the OAuth
 * native-app guidance makes for the same reason — there is no network to listen
 * on.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * **Address ranges the server may not fetch** (a review finding).
 *
 * ## What the finding was
 *
 * An Organisation admin — not the superadmin — chooses the host that the server then
 * fetches of its own accord (`<issuer>/.well-known/openid-configuration`). That makes
 * the discovery a **server-side request of somebody else's choosing**: classic
 * SSRF. `https://169.254.169.254/` is the metadata service of every large cloud,
 * `https://10.0.0.5/` a service on the same network that nobody reaches from
 * outside.
 *
 * ## What this list can do — and what it cannot
 *
 * It excludes **address literals**. An attacker who types `10.0.0.5`
 * does not get through any more.
 *
 * ⚠️ **It does not exclude DNS rebinding.** `https://sso.example.org/` can
 * point at `169.254.169.254`, and this check cannot tell from the
 * name. Against that only a network boundary (an egress rule of the operation) or
 * an allow-list helps — that exists as {@link issuerAllowList}, and
 * `docs/kb/07-oeffentliche-pfade.md` names both as what they are: an
 * operational decision this file cannot make.
 */
const BLOCKED_IPV4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // CGNAT (RFC 6598) — in operation an internal network like any other.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Whether `hostname` is an IPv4 literal from a blocked range. */
function isBlockedIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return false;
  }
  return BLOCKED_IPV4.some((range) => range.test(hostname));
}

/**
 * Whether `hostname` is an IPv6 literal from a blocked range.
 *
 * `URL` delivers IPv6 hosts in square brackets and in lower case. Blocked
 * are loopback (`::1`), link-local (`fe80::/10`), unique-local (`fc00::/7`)
 * and the IPv4 mapping (`::ffff:10.0.0.5`) — the last because it would otherwise be the
 * convenient way around the list above.
 */
function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
    return false;
  }
  const inner = hostname.slice(1, -1).toLowerCase();
  if (inner === '::1' || inner === '::') {
    return true;
  }
  if (/^fe[89ab]/.test(inner) || /^f[cd]/.test(inner)) {
    return true;
  }
  return isBlockedIpv4(mappedIpv4(inner) ?? '');
}

/**
 * The IPv4 address behind an IPv4 mapping, or `undefined`.
 *
 * **Two spellings, and the second is the one that arrives.** `new URL()`
 * normalises `[::ffff:10.0.0.5]` to `[::ffff:a00:5]` — the check for the
 * dotted form alone was therefore without effect, and that is exactly what the
 * counter-check to this finding showed: the case was red while the block
 * already stood there.
 */
function mappedIpv4(inner: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(inner);
  if (dotted?.[1] !== undefined) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
  if (hex?.[1] === undefined || hex[2] === undefined) {
    return undefined;
  }
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * The operation's allow-list, from `OIDC_ISSUER_ALLOWLIST`.
 *
 * Empty means "every public host" — the default, because an application that
 * is hosting-agnostic cannot know the sign-in services of its Organisations.
 * Whoever sets it gets the stricter answer: only these hosts
 * and their subdomains.
 */
export function issuerAllowList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

function allowedByList(
  hostname: string,
  allowList: readonly string[],
): boolean {
  if (allowList.length === 0) {
    return true;
  }
  const host = hostname.toLowerCase();
  return allowList.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
}

/**
 * The stored issuer, or `null` if it may not be used.
 *
 * `null` rather than a thrown error, because both callers want a *decision*:
 * the write path turns it into a 400 naming the field, the read path into „not
 * configured" — **fail closed**, so an organisation whose row was hand-edited to
 * something unusable offers no SSO rather than offering a broken one.
 *
 * The returned string is the value that gets stored and shown. It differs from
 * the input in exactly one way: **trailing slashes are removed**, so that
 * `<issuer>/.well-known/openid-configuration` is plain concatenation for
 * the login route and cannot produce `//.well-known`. That is the same normalising
 * `apiEnvSchema` does for `PUBLIC_BASE_URL`, and for the same reason — one
 * place thinks about the slash instead of every call site.
 */
export function acceptableIssuer(
  raw: string,
  /**
   * The operation's allow-list (a review finding), empty = every
   * public host. Empty as the default value, so that every existing caller
   * measures unchanged; the two gates pass it through.
   */
  allowList: readonly string[] = [],
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.username !== '' || url.password !== '') {
    return null;
  }
  // A discovery base is a base, not a request: a query or a fragment would be
  // carried into every `.well-known` fetch this organisation ever makes.
  if (url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.hostname === '') {
    return null;
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return null;
    }
  } else if (url.protocol !== 'https:') {
    return null;
  } else if (
    // **Only on the `https` branch** (a review finding): the `http` branch
    // above *is* the loopback exception for development, and checking it
    // here a second time would take it away again.
    isBlockedIpv4(url.hostname) ||
    isBlockedIpv6(url.hostname) ||
    LOOPBACK_HOSTS.has(url.hostname) ||
    !allowedByList(url.hostname, allowList)
  ) {
    return null;
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * **Der Wert, mit dem eine Einladung gestempelt werden muss** — genau der, gegen
 * den die Anmeldung später vergleicht (Review-Runde 5 Nr. 3).
 *
 * ## Der Fehler, den es schließt
 *
 * Eine SSO-Einladung ist eine `user`-Zeile mit dem Issuer der einladenden
 * Organisation, und eingelöst wird sie nur gegen **denselben** Wert
 * (`auth/oidc/oidc-identity.service.ts`). Die Anmeldung liest ihn dabei nicht
 * roh aus der Spalte, sondern durch {@link acceptableIssuer}
 * (`OidcConfigService.signIn` → `token.issuer`) — die Stempelstellen lasen
 * bislang die Spalte **roh**. Gleich waren beide nur, solange jeder Schreiber
 * der Spalte durch `checkedIssuer` gegangen ist.
 *
 * Jeder andere Schreiber — eine SQL-Reparatur von Hand, ein älterer Stand, ein
 * künftiger Seed — hinterlässt einen unnormalisierten Wert
 * (`…/realms/hv/` mit Schluss-Schrägstrich), und dann stempelt die Anwendung
 * einen Wert, den keine Anmeldung je trifft: die eingeladene Person kommt nicht
 * herein, und im Log steht „the invitation was stamped with a different issuer"
 * über eine Einladung, die nie eine Chance hatte.
 *
 * **Eine Normalisierung, zwei Leser.** Diese Funktion ist die Stelle, an der
 * Stempel und Vergleich dieselbe Rechnung benutzen; sie steht neben
 * {@link acceptableIssuer}, weil sie nichts anderes ist als deren Ergebnis.
 *
 * ## Ohne Allow-List, und das ist Absicht
 *
 * Die Betriebs-Allow-List entscheidet, **ob** eine Organisation SSO anbieten
 * darf, nicht **wie** ihr Issuer geschrieben wird. Wäre der Host nicht erlaubt,
 * liefert `signIn` gar keinen Anmeldeweg (`null`, fail closed) und es gibt
 * nichts einzulösen — ein Stempel wäre dann so oder so ohne Wirkung. Ihn hier
 * von der Umgebung abhängig zu machen, hieße dagegen: dieselbe Einladung trägt
 * je nach `OIDC_ISSUER_ALLOWLIST` einen anderen Wert.
 *
 * `null` heißt „damit darf nicht gestempelt werden" — kein Issuer hinterlegt
 * oder ein Wert, den auch die Anmeldung verweigern würde. Die Aufrufer machen
 * daraus eine Absage und keinen Stempel: eine Zeile mit unbrauchbarem Stempel
 * wäre eine Einladung, die niemand einlösen kann, und sie hielte die
 * installationsweit eindeutige Adresse besetzt, während sie wartet.
 */
export function issuerStamp(raw: string | null): string | null {
  return raw === null ? null : acceptableIssuer(raw);
}
