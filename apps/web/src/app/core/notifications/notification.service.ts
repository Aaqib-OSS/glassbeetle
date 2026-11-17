import { Injectable, inject, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { describeApiError, toApiError } from '../api/api-error';

/** Where the bell at the foot of the rail keeps its setting. */
const MUTED_KEY = 'glassbeetle.notifications.muted';

/**
 * Transient feedback for completed actions and failed requests.
 *
 * Errors stay on screen noticeably longer than confirmations and carry a
 * dismiss action: a failure the user misses leaves them believing a write
 * succeeded, whereas a missed "Saved" costs nothing.
 *
 * That asymmetry is also why muting only silences confirmations. Turning the
 * bell off is a request for quiet, not for failures to go unreported.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly snackBar = inject(MatSnackBar);

  private readonly _muted = signal(readMuted());

  /** Whether confirmations are silenced. */
  readonly muted = this._muted.asReadonly();

  toggleMuted(): void {
    const next = !this._muted();
    this._muted.set(next);

    try {
      localStorage.setItem(MUTED_KEY, next ? '1' : '0');
    } catch {
      // Storage can be unavailable in a locked-down webview; the bell then
      // simply forgets its setting between launches.
    }
  }

  success(message: string): void {
    if (this._muted()) {
      return;
    }

    this.snackBar.open(message, undefined, { duration: 3000 });
  }

  /** Reports a failed request, preferring the API's validation details. */
  error(error: unknown, fallback = 'The request failed.'): void {
    const apiError = toApiError(error);
    const message = describeApiError(apiError) || fallback;

    this.snackBar.open(message, 'Dismiss', {
      duration: 8000,
      panelClass: 'gb-snackbar--error',
    });
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}
