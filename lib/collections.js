// Shared collection definitions for the generic HR/ERP app state (used by
// server.js for live load/save, and by scripts/migrate-to-db.js for the
// one-time JSON-file → Postgres migration). Keeping this in one place avoids
// the two from drifting out of sync.

// Every id-keyed record collection sent by getFullState(). `employees` and
// `kpiEntries` have their own dedicated tables (with history); everything
// else falls into the generic `app_collections` table in DB mode.
const ID_KEYED_LIST_FIELDS = [
  "employees", "kpiEntries", "changeRequests", "orgChartHistory",
  "coreTalentPool", "talentDevPlans", "compGradeResults", "gradeAdjustHistory",
  "tieNotifications", "lowPerfData", "approvalTemplates", "integrationLogs",
  "approvalDocs", "attendanceRecords", "payslips", "payrollAdjustments", "leaveUsagePlans", "boardPosts",
  "roomReservations", "certLog", "certRequests", "welfarePoints",
  "mandatoryTraining", "healthCheckupLog", "scheduleEvents", "expenseClaims", "overtimeRequests", "onboardingFlows",
];
const GENERIC_LIST_FIELDS = ID_KEYED_LIST_FIELDS.filter(
  f => f !== "employees" && f !== "kpiEntries"
);
// Singleton config blobs (not lists of records) — stored as one row each in
// `app_singletons`, overwritten wholesale on save (last-write-wins).
const SINGLETON_FIELDS = [
  "settings", "orgDB", "gradeSettings", "promotionSettings", "coreTalentSettings",
  "evaluatorConfig", "approvalChainSettings", "integrationSettings", "disabledTplIds",
  "_idCounter", "roomReservationTombstones",
];

module.exports = { ID_KEYED_LIST_FIELDS, GENERIC_LIST_FIELDS, SINGLETON_FIELDS };
