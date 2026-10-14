import test from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../src/permissions.js';

const reporter = { id: 1, role: 'reporter', sections: [10] };
const sectionEditor = { id: 2, role: 'section-editor', sections: [10] };
const otherSectionEditor = { id: 3, role: 'section-editor', sections: [99] };
const trusted = { id: 4, role: 'trusted-publisher', sections: [10] };
const eic = { id: 5, role: 'editor-in-chief', sections: 'all' };
const admin = { id: 6, role: 'admin', sections: 'all' };

const SCHEDULABLE = ['draft', 'in_review', 'approved', 'scheduled'];
const NOT_SCHEDULABLE = ['changes_requested', 'published', 'archived'];

test('reporters can never schedule, in any status, even their own story', () => {
  for (const status of [...SCHEDULABLE, ...NOT_SCHEDULABLE]) {
    assert.equal(can(reporter, 'story.schedule', { status, categoryId: 10, isAuthor: true }), false, status);
  }
});

test('editors in scope can schedule draft, in_review, approved and scheduled stories only', () => {
  for (const u of [sectionEditor, eic, admin]) {
    for (const status of SCHEDULABLE) assert.equal(can(u, 'story.schedule', { status, categoryId: 10 }), true, `${u.role} ${status}`);
    for (const status of NOT_SCHEDULABLE) assert.equal(can(u, 'story.schedule', { status, categoryId: 10 }), false, `${u.role} ${status}`);
  }
});

test('a section editor cannot schedule outside their sections', () => {
  assert.equal(can(otherSectionEditor, 'story.schedule', { status: 'approved', categoryId: 10 }), false);
});

test('a trusted publisher can schedule only their own story in their section', () => {
  assert.equal(can(trusted, 'story.schedule', { status: 'draft', categoryId: 10, isAuthor: true }), true);
  assert.equal(can(trusted, 'story.schedule', { status: 'draft', categoryId: 10, isAuthor: false }), false);
  assert.equal(can(trusted, 'story.schedule', { status: 'draft', categoryId: 99, isAuthor: true }), false);
});

test('signed-out and unknown roles cannot schedule', () => {
  assert.equal(can(null, 'story.schedule', { status: 'approved', categoryId: 10 }), false);
  assert.equal(can({ id: 9, role: 'visitor' }, 'story.schedule', { status: 'approved', categoryId: 10 }), false);
});

test('scheduling follows the same rule as publishing for every role (minus archived)', () => {
  for (const u of [reporter, sectionEditor, otherSectionEditor, trusted, eic, admin]) {
    for (const status of SCHEDULABLE) {
      for (const isAuthor of [true, false]) {
        const ctx = { status, categoryId: 10, isAuthor };
        assert.equal(can(u, 'story.schedule', ctx), can(u, 'story.publish', ctx), `${u.role} ${status} author=${isAuthor}`);
      }
    }
  }
});
