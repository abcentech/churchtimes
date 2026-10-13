/**
 * Application State Store for Church Times Newsroom
 */

import { apiAdapter } from './api/adapter.js';

class NewsroomStore {
  constructor() {
    this.users = apiAdapter.getUsers();
    this.currentUser = this.users[0]; // Default: Gbenga Osinaike (Reporter)
    this.currentView = 'dashboard';
    this.activeStoryId = null;
    this.activeEventSlug = 'ncef-2026-plenary';
    this.listeners = new Set();
    this.dirtyStory = false;
  }

  getCurrentUser() {
    return this.currentUser;
  }

  setCurrentUser(userId) {
    const user = this.users.find(u => u.id === userId);
    if (user) {
      this.currentUser = user;
      this.notify('user_changed', this.currentUser);
    }
  }

  getCurrentView() {
    return this.currentView;
  }

  setCurrentView(view, payload = {}) {
    this.currentView = view;
    if (payload.storyId !== undefined) {
      this.activeStoryId = payload.storyId;
    }
    if (payload.eventSlug !== undefined) {
      this.activeEventSlug = payload.eventSlug;
    }
    this.notify('view_changed', { view, payload });
  }

  getActiveStoryId() {
    return this.activeStoryId;
  }

  setActiveStoryId(id) {
    this.activeStoryId = id;
  }

  setDirtyStory(isDirty) {
    this.dirtyStory = isDirty;
    this.notify('dirty_changed', isDirty);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, data) {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch (err) {
        console.error('Store listener error', err);
      }
    }
  }
}

export const store = new NewsroomStore();
