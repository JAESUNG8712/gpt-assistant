"use strict";

function canReadTraining(actor) {
  const perms = actor?.menuPerms || {};
  return perms["training-courses"] !== false ||
    (actor?.role === "admin" && perms["training-admin"] !== false);
}
function canManageTraining(actor) {
  return actor?.role === "admin" && actor.menuPerms?.["training-admin"] !== false;
}

function enrollmentCounts(enrollments, courseId) {
  return countsByCourse(enrollments).get(String(courseId)) || { applied: 0, waitlisted: 0, completed: 0 };
}
function countsByCourse(enrollments) {
  const counts = new Map();
  for (const row of enrollments || []) {
    if (!row || row.status === "canceled") continue;
    const key = String(row.courseId);
    if (!counts.has(key)) counts.set(key, { applied: 0, waitlisted: 0, completed: 0 });
    const count = counts.get(key);
    if (["applied", "completed"].includes(row.status)) count.applied++;
    if (row.status === "waitlisted") count.waitlisted++;
    if (row.status === "completed") count.completed++;
  }
  return counts;
}

// Called inside the shared company save lock. Use saved rows plus already accepted
// rows from this request, never the caller's privacy-filtered list as the seat count.
function normalizeEnrollment(record, stored, courses, basis, actor) {
  if (stored && JSON.stringify(record) === JSON.stringify(stored)) return stored;
  let next = { ...record };
  const manager = canManageTraining(actor);
  if (!manager && !stored && next.status === "completed") return null;
  if (!manager && stored) {
    // Course/owner/completion facts are not self-service editable.
    next = { ...stored, surveyResponse: Object.hasOwn(record, "surveyResponse") ? record.surveyResponse : stored.surveyResponse,
      updatedAt: record.updatedAt || stored.updatedAt };
    if (record.status === "canceled" && stored.status !== "completed") next.status = "canceled";
  }
  const course = (courses || []).find(c => c && String(c.id) === String(next.courseId));
  if (!course) return stored || null;
  const others = (basis || []).filter(e => e && String(e.id) !== String(next.id));
  const active = next.status !== "canceled";
  if (active && others.some(e => e.status !== "canceled" && String(e.courseId) === String(next.courseId) && String(e.empId) === String(next.empId))) return stored || null;
  const alreadySeated = stored && String(stored.courseId) === String(next.courseId) && ["applied", "completed"].includes(stored.status);
  const entering = active && (!stored || stored.status === "canceled" || String(stored.courseId) !== String(next.courseId));
  if (entering && !["planned", "open"].includes(course.status)) return stored || null;
  if (!alreadySeated && ["applied", "completed"].includes(next.status)) {
    const capacity = Number(course.capacity);
    if (capacity > 0 && enrollmentCounts(others, course.id).applied >= capacity) {
      if (next.status === "completed") return stored || null;
      next.status = "waitlisted";
    }
  }
  if (!manager && !stored) next.completedAt = "";
  return next;
}

module.exports = { canReadTraining, canManageTraining, enrollmentCounts, countsByCourse, normalizeEnrollment };
