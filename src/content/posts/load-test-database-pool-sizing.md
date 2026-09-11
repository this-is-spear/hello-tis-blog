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

#### 추가 측정

![서버 CPU·메모리 추가 측정. 15:50 ~ 16:20 구간의 근사 그래프](@/assets/images/load-test-database-pool-sizing/ecs-scale-out-server-resources.png)

- CPU 사용률: 표시 구간 최대 약 100%
- 메모리 사용률: 표시 구간 최대 약 24.24%

#### 2차

![2차 서버 CPU·메모리 사용률. 최대 CPU 약 98.9%, 메모리 약 24.24%](@/assets/images/load-test-database-pool-sizing/probe500-pool40-server-resources.png)

- CPU 사용률: 최대 약 98.9%
- 메모리 사용률: 최대 약 24.24%

#### 추가 트레이스 · 16:05:21

![16:05:21.684의 today 트레이스](@/assets/images/load-test-database-pool-sizing/today-trace-160521.png)

- 전체: 1.83초
- Redis `set`: 999.58ms
- `connection` span: 574.43ms
- SELECT: 101.66ms · 96.08ms · 122.79ms

#### 1차

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

#### 2차 커넥션

![2차 커넥션 획득 시간 p99. 표시 구간 최대 Master 691ms, Replica 383ms](@/assets/images/load-test-database-pool-sizing/probe500-pool40-connection-acquire.png)

- Master: 획득 p99 최대 691ms · 점유 p99 최대 1.26초
- Replica: 획득 p99 최대 383ms · 점유 p99 최대 504ms

최댓값은 화면 표시 구간 기준입니다.

#### 1차 설정

1차는 [HikariCP 기본값](https://github.com/brettwooldridge/HikariCP#frequently-used)으로 테스트했습니다.

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

### 2차 · 풀 변경

- 테스트 태그: `probe500-pool40`
- 목표 부하·시간: 500 iteration/s · 3분
- VU: 초기 1,000개 · 최대 5,000개
- ECS 태스크: 2개

Master·Replica별 풀 크기와 커넥션 획득 타임아웃은 실제 적용값을 확인한 뒤 기록합니다.

### 3차 · ECS 증설

- 태스크 수: 2 → 4개
- 태스크당 사양: 1 vCPU · 메모리 4GB
- 테스트 태그·목표 부하·시간·VU 설정: 2차와 동일

### 4차 · ECS 태스크·CPU 증설

- 태스크 수: 4 → 8개
- 태스크당 CPU: 1 → 2 vCPU
- 태스크당 메모리: 4GB 유지
- 테스트 태그·목표 부하·시간·VU 설정: 2차와 동일

### 트러블슈팅 · Too many connections

튜닝 중 `Too many connections`가 발생해 `processlist`를 IP별로 집계했습니다. `host`는 `IP:포트`이므로 포트를 제외해야 같은 IP의 커넥션을 합산할 수 있었습니다.

- 전체 커넥션: 161개 중 `Sleep` 160개
- 10개 IP: 각각 15개, 총 150개 모두 `Sleep`
- 해당 IP별 최대 유휴 시간: 198 ~ 273초

[`Sleep`은 유휴 상태](https://dev.mysql.com/doc/refman/8.0/en/sys-processlist.html)입니다. 종료된 태스크의 커넥션인지는 태스크 IP와 대조해야 합니다.

후속 확인·조치입니다.

- IP 대조: 실행 중·종료 중인 ECS 태스크와 커넥션 IP 비교
- 정리: 종료된 태스크의 잔존 커넥션을 확인한 뒤 [`mysql.rds_kill`](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.MySQL.CommonDBATasks.End.html)로 종료
- 만료 설정: 세션의 `wait_timeout` 확인
- 커넥션 상한: DB별 `max_connections`와 배포 중 태스크·풀·다른 클라이언트의 합계 비교

## 결과

### TOBE

| API                     | 2차 · ECS 2개 p99 | 3차 · ECS 4개 p99 | 4차 · ECS 8개 p99 |
| ----------------------- | ----------------: | ----------------: | ----------------: |
| 토큰 발급               |            28.28s |            18.78s |             1.90s |
| 출석 상태 조회(`today`) |            28.54s |            19.26s |             2.19s |
| 출석 확정               |            28.41s |            19.43s |             2.57s |
| 현황판 조회(`board`)    |            28.29s |            18.96s |             2.08s |

1차 → 2차 → 3차 → 4차 비교입니다.

- 완료 iteration: 28,885 → 66,558 → 76,963 → 89,962건
- 미시작 iteration: 61,116 → 23,443 → 13,038 → 38건
- HTTP 실패: 436 / 60,374 → 0 / 139,068 → 0 / 160,803 → 0 / 188,029건
- HTTP 응답 시간 평균: 15.06초 → 3.56초 → 5.34초 → 217.27ms
- HTTP 응답 시간 p50: 15.88초 → 379.87ms → 1.7초 → 5.47ms

완료 건수는 종료 대기까지 포함한 로그 합계입니다. 2·4차는 3분, 3차는 3분 16.9초에 종료됐습니다.

4차 기준 확인입니다.

- API p99: 모두 3초 미만
- HTTP 최대 응답 시간: 10.74초
- k6 실패 표시: 스크립트에 남은 200ms·300ms 기준 초과

### 다음 측정

- 미시작 iteration: 발생 시각·VU 사용량
- 태스크별: CPU 사용률·요청 수·트래픽 분배
- CPU: 부하 구간의 CPU 프로파일·GC 시간
- Tomcat: 사용 중 스레드 수·스레드 상한·커넥션 수
- DB 풀: 태스크별 풀 크기·획득 타임아웃·전체 커넥션 상한
