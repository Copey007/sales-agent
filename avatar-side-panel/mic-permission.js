/**
 * Microphone permission for a Chrome side panel.
 *
 * Chrome often does not show a getUserMedia prompt from a side panel.
 * This module:
 *   1. Queries the microphone permission for the extension origin.
 *   2. If already granted, returns ok.
 *   3. If prompt/unknown, tries getUserMedia in the panel (it works when
 *      permission was already granted on any page of this extension origin).
 *   4. If that fails or the state is denied/prompt, opens the extension
 *      page `mic-permission.html` in a tab. A user gesture there can grant
 *      the permission for the whole extension origin (including the panel).
 *
 * Documented in avatar-side-panel/README.md. No extra manifest permission
 * is required: the prompt is the browser's microphone permission for
 * chrome-extension://<id>.
 */

export const MIC_PERMISSION_PAGE = 'mic-permission.html';

export async function queryMicPermission(permissions) {
  const api = permissions || (typeof navigator !== 'undefined' ? navigator.permissions : null);
  if (!api?.query) return 'unknown';
  try {
    const status = await api.query({ name: 'microphone' });
    return status?.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function tryGetUserMedia(getUserMedia) {
  const gum = getUserMedia
    || (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices));
  if (typeof gum !== 'function') throw new Error('getUserMedia_unavailable');
  const stream = await gum({ audio: true, video: false });
  try {
    stream?.getTracks?.().forEach((t) => t.stop());
  } catch { /* ignore */ }
  return true;
}

/**
 * @returns {Promise<{ ok: boolean, state: string, openedPage?: boolean }>}
 */
export async function ensureMicAccess({
  query = queryMicPermission,
  getUserMedia,
  openPermissionPage,
} = {}) {
  const state = await query();
  if (state === 'granted') return { ok: true, state };
  if (state !== 'denied') {
    try {
      await tryGetUserMedia(getUserMedia);
      return { ok: true, state: 'granted' };
    } catch {
      /* Side panels often cannot show the prompt; fall through. */
    }
  }
  let openedPage = false;
  if (typeof openPermissionPage === 'function') {
    await openPermissionPage();
    openedPage = true;
  }
  return { ok: false, state: state || 'prompt', openedPage };
}
