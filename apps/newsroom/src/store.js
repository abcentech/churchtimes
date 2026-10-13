/**
 * Application State Store for Church Times Newsroom
 */

import { apiAdapter } from './api/adapter.js';

class NewsroomStore {
  constructor() {
    this.users = apiAdapter.getUsers();
    this.currentUser = apiAdapter.getCurrentUser() || this.users[0];
    this.currentView = 'dashboard';
    this.activeStoryId = null;
    this.activeEventSlug = 'ncef-2026-plenary';
    this.listeners = new Set();
    this.dirtyStory = false;

    apiAdapter.subscribe(() => {
      this.currentUser = apiAdapter.getCurrentUser();
      this.notify('user_changed', this.currentUser);
    });
  }

  getCurrentUser() {
    return apiAdapter.getCurrentUser() || this.currentUser;
  }

  setCurrentUser(userId) {
    if (apiAdapter.isMockActive) {
      const user = apiAdapter.setMockUser(userId);
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
