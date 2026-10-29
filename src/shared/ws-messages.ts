/**
 * The WebSocket messages between the dev server and the dev panel, for both sides: the server
 * (`src/lib/client.service.ts`, `src/lib/pp-ws-server.ts`) and the panel (`src/client/**`) import
 * them from here, so they can't drift apart. No Node or DOM imports: the panel bundle includes it.
 */

/** WebSocket path the `pp-dev next` server listens on for dev-panel messages. */
export const PP_DEV_HMR_WS_PATH = '/@pp-dev-hmr';

/** `template:sync:response` code for a sync requested while another one runs. */
export const SYNC_IN_PROGRESS_CODE = 'SYNC_IN_PROGRESS';

/** `template:sync:action-required`: the server asks the panel to confirm a step of the sync. */
export interface SyncActionRequiredPayload {
  requestId: string;
  title: string;
  content: string;
  confirmText: string;
  cancelText: string;
}

/** `template:sync:action-response`: the panel's answer to {@link SyncActionRequiredPayload}. */
export interface SyncActionResponsePayload {
  requestId: string;
  approved: boolean;
}

/** `template:sync:response`: how a sync ended. */
export type TemplateSyncResponsePayload =
  | { syncedAt: string; currentHash: string; backupFilename: string }
  | { error: string; code?: string; config?: { canSync?: boolean; [key: string]: unknown }; refresh?: boolean }
  | { cancelled: boolean; message: string };
