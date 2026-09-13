/**
 * The one answer for a form the caller may not see.
 *
 * The same for „es gibt dieses Formular nicht", „es gehört einer anderen Organisation",
 * „es liegt im Papierkorb" **and**, since the requirement, „der Zugriff auf
 * dieses Formular ist Ihnen entzogen". 403 on any of them would confirm that
 * the id exists, and form ids travel — in URLs, in mails, in exports.
 *
 * It lives in `common/` rather than next to the service that used to own it
 * because the fourth link of the guard chain answers with it too
 * (`tenancy/form-permission.guard.ts`), and the two answers have to be
 * **byte-identical**: the whole point of the revocation 404 is that it cannot be
 * told apart from an unknown id. Two constants with the same text today are two
 * constants that differ after the first rewording, and the test comparing status
 * *and* body would then be the only thing left saying so — which is exactly the
 * lesson learned before (only the status code differed and the suite stayed green).
 *
 * `forms.service.ts` re-exports it, so the callers that have always imported it
 * from there keep working.
 */
export const FORM_NOT_FOUND_MESSAGE = 'Formular nicht gefunden.';
