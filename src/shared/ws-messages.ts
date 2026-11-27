/**
 * The WebSocket messages between the dev server and the dev panel, for both sides: the server
 * (`src/lib/client.service.ts`, `src/lib/pp-ws-server.ts`) and the panel (`src/client/**`) import
 * them from here, so they can't drift apart. No Node or DOM imports: the panel bundle includes it.
 */

/** WebSocket path the `pp-dev next` server listens on for dev-panel messages. */
export const PP_DEV_HMR_WS_PATH = '/@pp-dev-hmr';

/**
 * A dev-panel message on the wire, in Vite's custom-event shape: the panel's `import.meta.hot` shim
 * (`src/client/hot-context.ts`) and the `pp-dev next` server (`src/lib/pp-ws-server.ts`) both speak it.
 */
export type CustomMessage = { type: 'custom'; event: string; data?: unknown };

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

/**
 * Switching the MI environment from the dev panel (PP-4840 phase 4):
 * - `env:switch` (panel → server): restart in `name`;
 * - `env:switching` (server → every tab): the restart begins, reload once the server works with `name`;
 * - `env:switch:failed` (server → every tab): it didn't happen, the running server stays.
 */
export interface EnvSwitchPayload {
  name: string;
}

export interface EnvSwitchFailedPayload {
  name: string;
  error: string;
}

/** `GET /@api/environment`: the environment the dev server works with, and what the panel offers. */
export interface EnvironmentResponse {
  current: string;
  environments: { name: string; hasUrl: boolean; protected: boolean }[];
  /** Whether the server can restart in another one (not under plain `vite` with the plugin). */
  canSwitch?: boolean;
}

/** `template:sync:response`: how a sync ended. */
export type TemplateSyncResponsePayload =
  | { syncedAt: string; backupFilename: string }
  | { error: string; code?: string; config?: { canSync?: boolean; [key: string]: unknown }; refresh?: boolean }
  | { cancelled: boolean; message: string };
