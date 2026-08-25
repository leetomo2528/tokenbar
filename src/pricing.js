'use strict';

/**
 * 모델별 단가 (100만 토큰당 USD).
 *
 * ⚠️ 이 값은 수시로 바뀝니다. 구독자라면 실제 결제액과 무관하며,
 * "이 정도 썼다"를 가늘하기 위한 추정치일 뿐입니다.
 * 정확한 금액이 필요하면 공식 요금표를 확인하세요.
 */
const TABLE = [
  { match: /opus/i,   input: 15.0, output: 75.0 },
  { match: /sonnet/i, input: 3.0,  output: 15.0 },
  { match: /haiku/i,  input: 0.8,  output: 4.0 },
];

const FALLBACK = { input: 3.0, output: 15.0 };

// 캐시 쓰기는 입력가의 1.25배, 캐시 읽기는 0.1배가 일반적입니다.
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

function rateFor(model) {
  if (!model) return FALLBACK;
  const hit = TABLE.find((row) => row.match.test(model));
  return hit || FALLBACK;
}

/**
 * 토큰 집계치를 USD 추정치로 변환.
 * @param {{model?: string, input: number, output: number, cacheWrite: number, cacheRead: number}} t
 * @returns {number}
 */
function estimateCost(t) {
  const r = rateFor(t.model);
  const perToken = 1e-6;
  return (
    t.input * r.input * perToken +
    t.output * r.output * perToken +
    t.cacheWrite * r.input * CACHE_WRITE_MULT * perToken +
    t.cacheRead * r.input * CACHE_READ_MULT * perToken
  );
}

module.exports = { estimateCost, rateFor };
