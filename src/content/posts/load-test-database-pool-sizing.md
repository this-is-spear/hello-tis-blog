---
title: "[26.09.11] 부하테스트로 DB 풀과 서버 CPU 조정하기"
description: DB 풀 조정과 태스크 증설에도 남은 지연을 CPU 증설 후 다시 측정했습니다.
pubDatetime: 2026-09-11T00:00:00Z
tags:
  - Scratchpad
---

## 상황

출석 챌린지의 사용 패턴을 반영해 스테이징 서버에서 부하테스트를 진행했습니다.

- 기본 흐름: 토큰 발급 → 출석 상태 조회(`today`)
- 추가 요청: 사용자 중 7%는 출석 확정, 2%는 현황판 조회

이 흐름을 k6의 iteration 하나로 구성했습니다. 목표는 2,000 iteration/s였지만, 초기 500 iteration/s에서 응답 시간이 기준을 초과했습니다.

## 문제

클라이언트와 다음 조건을 서버 장애로 판단하기로 합의했습니다.

- HTTP 5xx 응답
- 응답 시간 3초 이상

모든 API의 p99 기준은 **3초 미만**으로 정했습니다.

### ASIS

**태스크 2개 · 태스크당 1 vCPU·4GB · DB 풀 크기 10**

![초기 HTTP 응답 시간 추이. 약 13:51 ~ 13:54의 부하 구간](@/assets/images/load-test-database-pool-sizing/probe500-pool10-response-time.png)

- 부하: 500 iteration/s · 3분
- 그래프: 전체 요청의 max·p95·p90·min
- 표: API별 p99

| API                     | 초기 p99 |
| ----------------------- | -------: |
| 토큰 발급               |   20.78s |
| 출석 상태 조회(`today`) |   21.00s |
| 출석 확정               |   21.28s |
| 현황판 조회(`board`)    |   20.86s |

## 원인

초기 상태를 서버·Redis·DB로 나눠 분석했습니다.

### 서버 · CPU 100%

![초기 서버 CPU·메모리 사용률](@/assets/images/load-test-database-pool-sizing/server-resources.png)

- CPU 사용률: 최대 약 100%
- 메모리 사용률: 최대 약 30.5%

### Redis · 낮은 사용률에도 요청 지연

![Redis 엔진 CPU·메모리 사용률과 부하 구간. 원본 화면 기반 근사 그래프](@/assets/images/load-test-database-pool-sizing/redis-cpu-memory.png)

- 엔진 CPU 사용률: 최대 약 0.87%
- 메모리 사용률: 최대 약 3.88%

**출석 상태 조회(`today`)**

![초기 today 트레이스. 전체 1.09s, Redis set 205.29ms, connection 486.69ms](@/assets/images/load-test-database-pool-sizing/probe500-pool10-today-trace.png)

- 전체: 1.09초
- Redis `set`: 205.29ms
- `connection` span: 486.69ms

**현황판 조회(`board`)**

![초기 board 트레이스. 전체 698.75ms, Redis set 384.48ms, connection 289.62ms](@/assets/images/load-test-database-pool-sizing/probe500-pool10-board-trace.png)

- 전체: 698.75ms
- Redis `set`: 384.48ms
- `connection` span: 289.62ms

### DB · 커넥션 획득 지연

[HikariCP 기본값](https://github.com/brettwooldridge/HikariCP#frequently-used)으로 시작했습니다.

- 최대 풀 크기: Master·Replica 각각 10개
- 커넥션 획득 타임아웃: 30초

![초기 커넥션 획득 시간 p99](@/assets/images/load-test-database-pool-sizing/connection-acquire.png)

- HikariPool-1 획득 p99: 표시 구간 최대 1.25초
- HikariPool-2 획득 p99: 표시 구간 최대 1.36초

`connection` span에는 SELECT 실행 시간도 포함됩니다. 획득 시간은 HikariCP의 acquire 지표로 확인했습니다.

DB CPU 사전 측정값은 다음과 같았습니다. 측정일·인스턴스 클래스는 미확인이므로 풀 조정에는 획득 시간을 사용했습니다.

| 대상    | 주요 요청                | 평시 CPU | 피크 CPU |
| ------- | ------------------------ | -------: | -------: |
| Replica | `today` 약 200 RPS       |  약 4.0% |  약 7.8% |
| Master  | 출석 확정 약 10 ~ 15 RPS |  약 4.0% | 약 5.87% |

## 해결

모든 비교는 **500 iteration/s·3분**으로 진행했습니다. 완료 건수는 종료 대기를 포함한 합계입니다.

### 1차 개선 · DB 풀 조정

**판단 이유**

요청 지연 중 DB 커넥션 획득 대기를 확인했습니다. 먼저 풀을 조정해 획득 대기가 줄어드는지 확인하기로 했습니다.

**변경 사항**

DB 풀을 조정하고, 태스크는 1 vCPU·4GB, 2개를 유지했습니다.

**측정 결과**

API p99는 여전히 3초를 초과했습니다. 커넥션 지표와 함께 서버 CPU·Redis 호출을 확인했습니다.

![DB 풀 조정 후 커넥션 획득 시간 p99](@/assets/images/load-test-database-pool-sizing/probe500-pool40-connection-acquire.png)

- Master: 획득 p99 최대 691ms · 점유 p99 최대 1.26초
- Replica: 획득 p99 최대 383ms · 점유 p99 최대 504ms
- 최댓값: 화면 표시 구간 기준

![DB 풀 조정 후 서버 CPU·메모리 사용률](@/assets/images/load-test-database-pool-sizing/probe500-pool40-server-resources.png)

- CPU 사용률: 최대 약 98.9%
- 메모리 사용률: 최대 약 24.24%

![16:05:21.684의 today 트레이스](@/assets/images/load-test-database-pool-sizing/today-trace-160521.png)

- 전체: 1.83초
- Redis `set`: 999.58ms
- `connection` span: 574.43ms
- SELECT: 101.66ms · 96.08ms · 122.79ms

### 2차 개선 · 태스크 증설

**판단 이유**

DB 풀 조정 후에도 서버 CPU가 98.9%까지 상승했습니다. 태스크를 늘려 CPU 부하를 분산하기로 했습니다.

**변경 사항**

태스크를 **2 → 4개**로 늘렸습니다. 태스크당 1 vCPU·4GB는 유지했습니다.

**측정 결과**

- 완료 iteration: 66,558 → 76,963건
- 미시작 iteration: 23,443 → 13,038건
- API p99: 3초 초과

![태스크 증설 전후 서버 CPU·메모리 사용률. 15:50 ~ 16:20의 근사 그래프](@/assets/images/load-test-database-pool-sizing/ecs-scale-out-server-resources.png)

- CPU 사용률: 표시 구간 최대 약 100%
- 메모리 사용률: 표시 구간 최대 약 24.24%

태스크 증설로 완료 건수는 늘었지만, API p99는 기준을 초과했습니다. 증설 후 Redis 지연은 해당 단계의 트레이스로 별도 확인해야 합니다.

### 3차 개선 · CPU 증설

**판단 이유**

태스크 증설만으로 응답 시간 기준을 충족하지 못했습니다. 앞선 Redis 지연과 서버 CPU 사용률을 근거로 **로직의 CPU·스레드 점유가 Lettuce 이벤트 루프 실행을 지연시킨다는 가설**을 세웠습니다.

[Lettuce는 이벤트 루프로 I/O를 처리](https://redis.github.io/lettuce/advanced-usage/client-resources/)하므로, 태스크당 CPU를 늘려 변화를 확인하기로 했습니다.

**변경 사항**

- CPU: 태스크당 1 → 2 vCPU
- 태스크: 4 → 8개, 이후 5개로 축소해 재측정
- 메모리: 태스크당 4GB 유지

**측정 결과**

**태스크 8개**

![CPU 증설·태스크 8개에서의 HTTP 응답 시간 추이](@/assets/images/load-test-database-pool-sizing/probe500-ecs8-response-time.png)

- API p99: 모두 3초 미만
- 최대 응답 시간: 10.74초
- 미시작 iteration: 38건

**태스크 5개**

최대 응답 시간도 3초 미만이었고, Redis 호출 지연도 줄었습니다. 전체 테스트 통계는 TOBE에 정리했습니다.

![17:10:00.266의 today 트레이스. 전체 310.68ms, Redis set 8.11ms, connection 302.21ms](@/assets/images/load-test-database-pool-sizing/today-trace-171000.png)

- 전체: 310.68ms
- Redis `set`: 8.11ms
- `connection` span: 302.21ms

트레이스는 단일 요청 비교입니다. CPU·태스크 수·배포 상태가 함께 달라졌으므로 스레드 점유 가설은 별도 검증합니다.

### 트러블슈팅 · Too many connections

튜닝 중 `Too many connections`가 발생해 `processlist`를 IP별로 집계했습니다. `host`는 `IP:포트`이므로 포트를 제외해 합산했습니다.

- 전체 커넥션: 161개 중 `Sleep` 160개
- 10개 IP: 각각 15개, 총 150개 모두 `Sleep`
- 해당 IP별 최대 유휴 시간: 198 ~ 273초

[`Sleep`은 유휴 상태](https://dev.mysql.com/doc/refman/8.0/en/sys-processlist.html)입니다. 종료된 태스크의 커넥션인지는 태스크 IP와 대조해야 합니다.

후속 확인·조치입니다.

- IP 대조: 실행 중·종료 중인 태스크와 커넥션 IP 비교
- 정리: 종료된 태스크의 잔존 커넥션을 확인한 뒤 [`mysql.rds_kill`](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.MySQL.CommonDBATasks.End.html)로 종료
- 만료 설정: 세션의 `wait_timeout` 확인
- 커넥션 상한: DB별 `max_connections`와 배포 중 태스크·풀·다른 클라이언트의 합계 비교

## 결과

### TOBE

**최종 구성: 태스크 5개 · 태스크당 2 vCPU·4GB**

![최종 구성의 HTTP 응답 시간 추이. max·p95·p90·min](@/assets/images/load-test-database-pool-sizing/probe500-ecs5-response-time.png)

그래프는 전체 요청의 max·p95·p90·min, 표는 API별 p99입니다. 앞선 그래프와 축 범위는 다릅니다.

| API                     | DB 풀 조정 | 태스크 증설 | CPU 증설·8개 | 최종·5개 |
| ----------------------- | ---------: | ----------: | -----------: | -------: |
| 토큰 발급               |     28.28s |      18.78s |        1.90s |  20.43ms |
| 출석 상태 조회(`today`) |     28.54s |      19.26s |        2.19s |   80.8ms |
| 출석 확정               |     28.41s |      19.43s |        2.57s |   55.9ms |
| 현황판 조회(`board`)    |     28.29s |      18.96s |        2.08s |  33.53ms |

- 완료 iteration: 90,001건 · 약 500 iteration/s
- HTTP 실패: 0 / 188,078건
- 최대 응답 시간: 603.41ms
- 미시작 iteration: 로그 미표기

**500 iteration/s에서는 모든 요청이 3초 미만이었고, k6의 200ms·300ms p99 기준도 통과했습니다.** 목표인 2,000 iteration/s는 다음 측정으로 남았습니다.

### 튜닝 기준

- 서버 CPU 부족: 태스크당 풀을 줄여 DB 커넥션 여유를 확보하고 스케일 아웃합니다.
- 서버 CPU 여유·커넥션 획득 대기 발생: DB 처리 여유를 확인하고 풀을 늘려 스케일 아웃을 최소화합니다.

DB별 커넥션 상한에는 배포 중 태스크와 다른 클라이언트도 포함합니다. [풀 크기는 부하테스트로 검증](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)하고, 동일 부하의 API p99·처리량으로 비교합니다.

### 남은 검증

- 재현성: 배포 완료·태스크 수 고정 후 동일 워밍업·DB 풀 조건에서 재측정
- 목표 부하: 2,000 iteration/s
- 스레드 점유 가설: CPU 프로파일·throttling·GC·Lettuce 이벤트 루프 지연
- DB 풀: 태스크별 적용값·획득 타임아웃·전체 커넥션 상한

배포 구간 화면에서는 CPU 최대 약 101.91%, 메모리 최대 약 23.93%였습니다. 최종 부하 구간(17:08 ~ 17:11) 전체는 포함하지 않아 태스크별 지표를 다시 수집합니다.
