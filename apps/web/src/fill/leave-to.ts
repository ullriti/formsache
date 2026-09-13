/**
 * Leaves the application for an external address.
 *
 * A one-line module of its own, for two reasons. It is a **full page load**,
 * not a route change — `router/use-route.ts` pushes history entries inside this
 * app and must not be reached for here. And it is the single point at which a
 * configured value becomes a navigation, which is what makes „only `http` and
 * `https` ever get this far" a statement about one call site rather than about
 * a whole view.
 *
 * The caller is responsible for having put the URL through `safeExternalUrl`
 * (`@formsache/shared`); `submitResponseResponseSchema` does that for every target
 * that arrives from the server.
 */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
