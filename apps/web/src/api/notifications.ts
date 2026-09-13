import {
  parseNotificationList,
  notificationSchema,
  type Notification,
  type NotificationCreate,
  type NotificationListResponse,
  type NotificationTemplate,
  type NotificationUpdate,
  type ReplyToLevel,
} from '@formsache/shared';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson, requestVoid } from './http';

/**
 * Server state of the notifications of one form — TanStack
 * Query only (`CONTRIBUTING.md`).
 *
 * The *editor* state — the row being written, before it is saved — is local to
 * `NotificationsView`, exactly as the unsaved settings document is local to
 * `SettingsView`. The two never write into each other: a cached notification is
 * what the server last confirmed, and a draft is what somebody is typing, and
 * the moment those share a variable the save button can no longer tell whether
 * there is anything to save.
 *
 * Every answer is parsed through the shared contract. `notificationSchema` is
 * strict, so a payload that grew a field this client does not know is a loud
 * failure at load time rather than a silently ignored value in a mail.
 */

export function notificationsQueryKey(formId: string): readonly string[] {
  return ['notifications', formId];
}

/**
 * The whole list payload — rows **and** the templates the installation offers.
 *
 * One cache entry for both, selected apart by the two hooks below. The
 * templates are an installation-wide setting and travel
 * with this response; a second query key would fetch the same body twice and
 * let the two halves of one answer expire at different moments.
 */
function listQuery(formId: string): {
  readonly queryKey: readonly string[];
  readonly queryFn: () => Promise<NotificationListResponse>;
} {
  return {
    queryKey: notificationsQueryKey(formId),
    queryFn: async () =>
      parseNotificationList(
        await requestJson(
          `/forms/${encodeURIComponent(formId)}/notifications`,
          { method: 'GET' },
        ),
      ),
  };
}

/**
 * Every notification of one form, as the list on the left shows them.
 *
 * `enabled` since the requirement, exactly like `useFormSettings`: the
 * Testmodus renders for `canBuild`, this route requires `canManageFormSettings`,
 * and a request that can only answer 403 is one the view has to explain away
 * afterwards instead of never making.
 */
export function useNotifications(
  formId: string,
  enabled = true,
): UseQueryResult<Notification[]> {
  return useQuery({
    ...listQuery(formId),
    enabled,
    select: (data) => data.notifications,
  });
}

/**
 * The two **inherited** levels of the reply address — organisation, then system
 * (the requirement).
 *
 * From the same answer as the rows and the templates, for the same reason:
 * a second query key would fetch the same body a second time and would let the
 * halves of one moment become differently old.
 *
 * The editor puts its topmost level — the **draft value** — in front of them
 * itself and calls `effectiveReplyTo` from `@formsache/shared`. That is why the levels come
 * raw and not as a finished result: a finished result could be reckoned with
 * the draft only by the precedence rule standing here a second
 * time.
 */
export function useInheritedReplyTo(
  formId: string,
): UseQueryResult<readonly ReplyToLevel[]> {
  return useQuery({
    ...listQuery(formId),
    select: (data) => data.inheritedReplyTo,
  });
}

/**
 * The templates the editor may start from.
 *
 * **Not a constant any more.** They used to be `NOTIFICATION_TEMPLATES` in
 * `@formsache/shared`, read straight by the editor; the superadmin edits
 * them and what the picker offers has to be what was written. The shipped texts
 * survive as the *floor* the server falls back to, read at one place on the
 * server and nowhere here.
 */
export function useNotificationTemplates(
  formId: string,
): UseQueryResult<NotificationTemplate[]> {
  return useQuery({
    ...listQuery(formId),
    select: (data) => data.templates,
  });
}

export interface CreateNotificationVariables {
  readonly formId: string;
  readonly input: NotificationCreate;
}

/**
 * Creates one notification.
 *
 * `retry: false` on all three writers below: a 422 („keine Frage liefert eine
 * Adresse") is a verdict, not a hiccup, and repeating the same body would only
 * produce the same refusal — or, for the create, a second notification the
 * editor never asked for.
 */
export function useCreateNotification(): UseMutationResult<
  Notification,
  Error,
  CreateNotificationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({ formId, input }: CreateNotificationVariables) =>
      notificationSchema.parse(
        await requestJson(
          `/forms/${encodeURIComponent(formId)}/notifications`,
          {
            method: 'POST',
            body: input,
          },
        ),
      ),
    onSuccess: async (_created, { formId }) => {
      await queryClient.invalidateQueries({
        queryKey: notificationsQueryKey(formId),
      });
    },
  });
}

export interface UpdateNotificationVariables {
  readonly formId: string;
  readonly notificationId: string;
  readonly input: NotificationUpdate;
}

/** Replaces one notification as a whole (`PUT`, not a field-by-field patch). */
export function useUpdateNotification(): UseMutationResult<
  Notification,
  Error,
  UpdateNotificationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({
      formId,
      notificationId,
      input,
    }: UpdateNotificationVariables) =>
      notificationSchema.parse(
        await requestJson(
          `/forms/${encodeURIComponent(formId)}/notifications/${encodeURIComponent(notificationId)}`,
          {
            method: 'PUT',
            body: input,
          },
        ),
      ),
    onSuccess: async (_saved, { formId }) => {
      await queryClient.invalidateQueries({
        queryKey: notificationsQueryKey(formId),
      });
    },
  });
}

export interface DeleteNotificationVariables {
  readonly formId: string;
  readonly notificationId: string;
}

/**
 * Deletes one notification (204, no body).
 *
 * The mail log is deliberately **not** invalidated: a deleted notification
 * leaves its log rows behind (`SetNull` on `mail_log.notification_id`), so
 * nothing about the log changed — and refetching it here would ask for a
 * resource this page's permissions do not cover (the log needs
 * `can_view_responses` on top).
 */
export function useDeleteNotification(): UseMutationResult<
  void,
  Error,
  DeleteNotificationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    retry: false,
    mutationFn: async ({
      formId,
      notificationId,
    }: DeleteNotificationVariables) =>
      requestVoid(
        `/forms/${encodeURIComponent(formId)}/notifications/${encodeURIComponent(notificationId)}`,
        {
          method: 'DELETE',
        },
      ),
    onSuccess: async (_void, { formId }) => {
      await queryClient.invalidateQueries({
        queryKey: notificationsQueryKey(formId),
      });
    },
  });
}
