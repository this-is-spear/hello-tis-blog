---
title: "[26.09.11] 부하테스트로 DB 커넥션 풀 크기 산정하기"
description: 풀 크기 10에서 API p99가 20초를 넘어 서버·Redis·DB 지표를 분석하고 튜닝 기준을 정했습니다.
pubDatetime: 2026-09-11T00:00:00Z
tags:
  - Scratchpad
---

## 상황

출석 챌린지의 사용 패턴을 반영해 스테이징 서버에서 부하테스트를 진행했습니다.

- 기본 흐름: 토큰 발급 → 출석 상태 조회(`today`)
- 추가 요청: 사용자 중 7%는 출석 확정, 2%는 현황판 조회

이 흐름을 k6의 iteration 하나로 구성했습니다. 목표 부하는 2,000 iteration/s였지만, 1차 테스트의 500 iteration/s에서 API p99가 3초를 초과했습니다.

## 문제

클라이언트와 다음 조건을 서버 장애로 판단하기로 합의했습니다.

- HTTP 5xx 응답
- 응답 시간 3초 이상

이에 따라 모든 API의 p99 기준을 **3초 미만**으로 정했습니다.

### ASIS

**1차 부하테스트: 풀 크기 10 · 500 iteration/s · 3분**

![1차 부하테스트의 HTTP 응답 시간 추이와 약 13:51 ~ 13:54의 부하 구간](@/assets/images/load-test-database-pool-sizing/probe500-pool10-response-time.png)

- 부하 구간: 약 13:51 ~ 13:54
- 그래프: 전체 요청의 max·p95·p90·min
- 표: API별 p99

| API                     | 풀 크기 10 p99 |
| ----------------------- | -------------: |
| 토큰 발급               |         20.78s |
| 출석 상태 조회(`today`) |         21.00s |
| 출석 확정               |         21.28s |
| 현황판 조회(`board`)    |         20.86s |

## 원인

다음 인프라의 지표를 분석해 튜닝 항목을 정했습니다.

- 서버
- Redis
- DB

### 서버

![1차 부하테스트의 서버 CPU·메모리 사용률](@/assets/images/load-test-database-pool-sizing/server-resources.png)

- CPU 사용률: 약 100%까지 상승
- 메모리 사용률: 최대 약 30.5%

![1차 부하테스트의 커넥션 획득 시간 p99](@/assets/images/load-test-database-pool-sizing/connection-acquire.png)

- HikariPool-1 획득 시간 p99: 표시 구간 최대 1.25초
- HikariPool-2 획득 시간 p99: 표시 구간 최대 1.36초

**출석 상태 조회(`today`)**

![13:53:43.494의 today 트레이스. 전체 1.09s, Redis set 205.29ms, connection 486.69ms](@/assets/images/load-test-database-pool-sizing/probe500-pool10-today-trace.png)

- 전체: 1.09초
- Redis `set`: 205.29ms
- `connection` span: 486.69ms

**현황판 조회(`board`)**

![13:53:46.780의 board 트레이스. 전체 698.75ms, Redis set 384.48ms, connection 289.62ms](@/assets/images/load-test-database-pool-sizing/probe500-pool10-board-trace.png)

- 전체: 698.75ms
- Redis `set`: 384.48ms
- `connection` span: 289.62ms

### Redis

![Redis 엔진 CPU·메모리 사용률과 부하 구간(약 13:51 ~ 13:54). 원본 화면 기반 근사 그래프](@/assets/images/load-test-database-pool-sizing/redis-cpu-memory.png)

- 엔진 CPU 사용률: 최대 약 0.87%
- 메모리 사용률: 최대 약 3.88%

### DB

[HikariCP 기본값](https://github.com/brettwooldridge/HikariCP#frequently-used)으로 테스트했습니다.

- 최대 풀 크기: Master·Replica 각각 10개
- 커넥션 획득 타임아웃: 30초

`connection` span에는 SELECT 실행 시간도 포함됩니다. 획득 시간은 HikariCP의 acquire 지표를 사용했습니다.

#### DB CPU 사용률

사전 측정값입니다.

- 테스트 시간: 16:49 ~ 17:01
- CPU 사용률 상승 구간: 약 16:45 ~ 17:10
- 출처: 스테이징 서버 그래프. `약`은 화면에서 읽은 근사값
- 미확인 정보: 측정일, DB 인스턴스 클래스, 현황판 RPS

| 대상    | 주요 요청                       | 평시 CPU 사용률 | 피크 CPU 사용률 |
| ------- | ------------------------------- | --------------: | --------------: |
| Replica | `today` 약 200 RPS, 현황판 조회 |         약 4.0% |         약 7.8% |
| Master  | 출석 확정 약 10 ~ 15 RPS        |         약 4.0% |        약 5.87% |

RPS는 초당 요청 수입니다. Replica CPU 증가분은 `(7.8 − 4.0) / 200 × 100 = 1.9%p/100 RPS`입니다.

같은 DB·데이터에서 CPU 사용률이 RPS에 비례한다고 가정한 추정값입니다.

- `today` 2,000 RPS: CPU 사용률 약 42%
- `today` 3,000 RPS: CPU 사용률 약 61%

추정에는 현황판 부하와 테스트 전후 변동도 포함됩니다. 풀 크기 비교에는 CPU 추정값 대신 실측 획득 시간 p99를 사용합니다.

## 해결

### 풀 크기만 변경해 비교합니다

풀 크기 10을 기준으로 Replica부터 조정할 계획입니다.

| 구분         | 고정 조건                                               | 변경할 항목         |
| ------------ | ------------------------------------------------------- | ------------------- |
| 부하 발생기  | EC2, 500 iteration/s, 3분, 초기 VU 1,000개·최대 5,000개 | 없음                |
| 애플리케이션 | 인스턴스 수, 코드, 타임아웃, 커넥션 수명                | 대상 풀의 최대 크기 |
| DB           | 데이터 규모, 인스턴스 클래스                            | 없음                |

튜닝 순서와 기준입니다.

- 2차 계획: Master 10개 유지, Replica 20개로 변경
- Replica 30 → 40개 검토 조건: 획득 시간 p99·미시작 iteration 감소, 쿼리 p99·HTTP 실패율 증가 없음
- Master 조정: 쓰기 요청의 획득 시간 p99를 측정한 뒤 결정
- 증설 중단 조건: 처리량 증가 없이 쿼리 p99 증가

DB별 커넥션 예산에는 모든 애플리케이션 인스턴스와 배치·관리 접속을 합산합니다. [HikariCP 풀 크기 가이드](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)를 참고했습니다.

## 결과

### TOBE

| API                     | 풀 변경 후 p99 |
| ----------------------- | -------------: |
| 토큰 발급               |                |
| 출석 상태 조회(`today`) |                |
| 출석 확정               |                |
| 현황판 조회(`board`)    |                |

- 튜닝 효과: 응답 시간, 처리량, HTTP 실패율, 미시작 iteration 비교
- 원인 검증: 커넥션 획득 시간, 서버·DB CPU 사용률, 쿼리 p99, Redis 명령 처리 시간 확인
- 부하 확대 조건: 모든 API p99 < 3초, HTTP 실패율 < 0.1%, 미시작 iteration 0건
- 부하 확대 순서: 500 → 1,000 → 2,000 iteration/s
- 운영 사양 확정: 운영 데이터 규모와 사용자별 7일 이상 이력을 반영해 재검증
