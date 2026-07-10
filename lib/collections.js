// Shared collection definitions for the generic HR/ERP app state (used by
// server.js for live load/save, and by scripts/migrate-to-db.js for the
// one-time JSON-file → Postgres migration). Keeping this in one place avoids
// the two from drifting out of sync.

// Every id-keyed record collection sent by getFullState(). `employees` and
// `kpiEntries` have their own dedicated tables (with history); everything
// else falls into the generic `app_collections` table in DB mode.
const ID_KEYED_LIST_FIELDS = [
  "employees", "kpiEntries", "compSessions", "compResponses", "changeRequests", "orgChartHistory",
  "coreTalentPool", "talentDevPlans", "gradeAdjustHistory",
  "tieNotifications", "lowPerfData", "approvalTemplates", "integrationLogs",
  "approvalDocs", "attendanceRecords", "payslips", "payrollAdjustments", "leaveUsagePlans", "boardPosts",
  "roomReservations", "certLog", "certRequests", "welfarePoints",
  "mandatoryTraining", "healthCheckupLog", "scheduleEvents", "expenseClaims", "overtimeRequests", "onboardingFlows", "approvalDelegations",
];
const GENERIC_LIST_FIELDS = ID_KEYED_LIST_FIELDS.filter(
  f => f !== "employees" && f !== "kpiEntries"
);
// Singleton config blobs (not lists of records) — stored as one row each in
// `app_singletons`, overwritten wholesale on save (last-write-wins).
// compGradeResults is here (not ID_KEYED_LIST_FIELDS) because it's a plain
// nested object keyed by employee id → year (compGradeResults[empId][year] =
// {grade,score,...}), not an array of {id,...} records. It used to live in
// ID_KEYED_LIST_FIELDS, which made server.js's smartMerge() run it through
// mergeArrayById() on every save-conflict merge; mergeArrayById() only
// understands arrays, so it silently coerced the whole object to `[]` and
// persisted that, permanently wiping every employee's multi-rater/competency
// grade result to disk (or DB) the moment two saves raced. Since it's now a
// SINGLETON_FIELD, smartMerge() instead runs it through mergeNestedObject()
// (see server.js), which merges per-employee/per-year keys from both sides
// instead of clobbering the whole object.
const SINGLETON_FIELDS = [
  "settings", "orgDB", "gradeSettings", "promotionSettings", "coreTalentSettings",
  "evaluatorConfig", "approvalChainSettings", "integrationSettings", "disabledTplIds",
  "compGradeResults",
  "_idCounter", "roomReservationTombstones",
];

module.exports = { ID_KEYED_LIST_FIELDS, GENERIC_LIST_FIELDS, SINGLETON_FIELDS };
