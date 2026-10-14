/**
 * Minimal view-state store for the newsroom SPA. User/session state lives in the API adapter (server user object);
 * nothing here is persisted.
 */

class NewsroomStore {
  constructor() {
    this.currentView = 'dashboard';
    this.activeStoryId = null;
    this.listeners = new Set();
  }

  getCurrentView() { return this.currentView; }

  setCurrentView(view, payload = {}) {
    this.currentView = view;
    this.activeStoryId = payload.storyId !== undefined ? payload.storyId : this.activeStoryId;
    this.notify('view_changed', { view, payload });
  }

  getActiveStoryId() { return this.activeStoryId; }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, data) {
    for (const listener of this.listeners) {
      try { listener(event, data); } catch (err) { console.error('Store listener error', err); }
    }
  }
}

export const store = new NewsroomStore();
