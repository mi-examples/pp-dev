/**
 * Global Authentication Provider
 *
 * This provider manages the global authentication state across the application.
 * It provides a centralized way to track and manage authentication status.
 *
 * The state is the original user's page-data login, one per process: it is not per host or per saved
 * user (those are tracked by the user registry and `session-users.ts`). pp-dev itself uses
 * `getState`, `setRedirected`, `updateState` and `reset`; the rest stays because the package exports
 * the provider.
 */
import { createLogger } from './logger.js';

export interface AuthState {
  isAuthenticated: boolean;
  isRedirected: boolean;
  lastChecked: number;
}

class AuthProvider {
  private state: AuthState = {
    isAuthenticated: false,
    isRedirected: false,
    lastChecked: 0,
  };

  private listeners: Set<(state: AuthState) => void> = new Set();

  /**
   * Get the current authentication state
   */
  getState(): AuthState {
    return { ...this.state };
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.state.isAuthenticated;
  }

  /**
   * Check if user has been redirected
   */
  isRedirected(): boolean {
    return this.state.isRedirected;
  }

  /**
   * Set authentication status
   */
  setAuthenticated(authenticated: boolean): void {
    this.state.isAuthenticated = authenticated;
    this.state.lastChecked = Date.now();
    this.notifyListeners();
  }

  /**
   * Set redirect status
   */
  setRedirected(redirected: boolean): void {
    this.state.isRedirected = redirected;
    this.notifyListeners();
  }

  /**
   * Update both authentication and redirect status
   */
  updateState(updates: Partial<Pick<AuthState, 'isAuthenticated' | 'isRedirected'>>): void {
    if (updates.isAuthenticated !== undefined) {
      this.state.isAuthenticated = updates.isAuthenticated;
    }

    if (updates.isRedirected !== undefined) {
      this.state.isRedirected = updates.isRedirected;
    }

    this.state.lastChecked = Date.now();
    this.notifyListeners();
  }

  /**
   * Reset authentication state
   */
  reset(): void {
    this.state = {
      isAuthenticated: false,
      isRedirected: false,
      lastChecked: 0,
    };
    this.notifyListeners();
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of state changes
   */
  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      try {
        listener(this.getState());
      } catch (error) {
        // Through pp-dev's logger, like the rest of its output (level, format, the Vite logger).
        createLogger().error(
          `Error in auth state listener: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    });
  }
}

// Create and export a singleton instance
export const authProvider = new AuthProvider();

// Export the class for testing purposes
export { AuthProvider };
