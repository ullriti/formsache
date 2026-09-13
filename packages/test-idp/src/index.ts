/**
 * `@formsache/test-idp` — **the one** OpenID provider of this test suite.
 *
 * ## Why this package exists at all (way 2)
 *
 * The provider used to lie in `apps/api/test/auth/fake-idp.ts`. `apps/api` is
 * `"type": "commonjs"`, `e2e/` runs in the ESM root project — an
 * `import { startFakeIdp } from '../apps/api/test/auth/fake-idp'` failed there
 * with `SyntaxError: Named export 'startFakeIdp' not found`. That is why the
 * SSO **sign-in procedure** had never been driven through the interface.
 *
 * The implementation plan lists eight ways. Chosen is **way 2**, the own
 * workspace package, and that for a reason the other seven do not fulfil:
 * afterwards there is **one** file that both consumers find over their
 * respective normal resolution path — `apps/api`'s Vitest over
 * `exports.default`, `e2e/`'s Playwright over the same line. No second build
 * target (way 5), no ESM island in a CJS package that Vitest and Playwright
 * treat differently (way 4), no weaker typing (way 6), no CJS toolchain
 * conversion of NestJS (way 3).
 *
 * **Way 8 — a second provider in the repo — is ruled out**, and that is the
 * actual promise of this package: one protocol, written once. The browser path
 * below is therefore no second implementation but a second *user interface* on
 * the same code (see `issueCode`).
 *
 * ## Why without a build step
 *
 * The package has no `build` script and delivers its source. It is pure test
 * infrastructure: none of it ever goes into a runtime artefact (the API build
 * compiles `src/` only), and a `dist/` would be exactly the drift between
 * source and artefact that makes way 5 of the list expensive. Both consumers
 * transform TypeScript themselves anyway.
 *
 * ## What this provider does **not** prove
 *
 * It is a loopback `http` server without TLS and speaks the parts of OpenID
 * Connect this application uses. It therefore proves **no Keycloak
 * peculiarity** — not its discovery document, not its scope handling, not its
 * claim names (`preferred_username`, `groups`, mapped attributes) — and **no
 * TLS statement** (certificate chain, `requireTLS`, HSTS). The connection to
 * the association's Keycloak stays a separate, named remainder; green here
 * means "our side of the protocol is right", not "it runs against the
 * association's IdP".
 */
export {
  startFakeIdp,
  type FakeIdentity,
  type FakeIdp,
  type FakeIdpOptions,
  type TokenDeviation,
} from './fake-idp.ts';
