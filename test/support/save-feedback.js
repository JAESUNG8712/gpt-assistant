"use strict";
// /save 응답의 warnings.rejectedRecords는 "무엇이"(field,id,operation)뿐 아니라 "왜"(reason,level,
// message,fields)도 담는다. "무엇이 거부됐는지"만 검증하는 기존 테스트가 사유 문구 변경에
// 흔들리지 않도록 안정적인 필드만 뽑아 비교한다. 사유 자체는 api-save-feedback.test.js가 검증한다.
function brief(rows) {
  return (rows || []).map(({ field, id, operation }) => (operation ? { field, id, operation } : { field, id }));
}
module.exports = { brief };
