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
- 추가 요청: 출석 확정·현황판 조회

이 흐름으로 부하를 높이자 응답 시간이 합의한 기준을 초과했습니다.

## 문제

클라이언트와 다음 조건을 서버 장애로 판단하기로 합의했습니다.

- HTTP 5xx 응답
- 응답 시간 3초 초과

모든 API의 p99 기준은 **3초 이내**로 정했습니다.

**태스크 2개 · 태스크당 1 vCPU·4GB · DB 풀 크기 10**

![초기 HTTP 응답 시간 추이. 약 13:51 ~ 13:54의 부하 구간](@/assets/images/load-test-database-pool-sizing/probe500-pool10-response-time.png)

- 그래프: 전체 요청의 max·p95·p90·min

## 원인

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

두 요청에서 Redis 호출과 DB 처리 지연을 확인했습니다. 각 인프라 상태에 맞춰 조정할 항목을 찾기 위해 서버·Redis·DB를 나눠 분석했습니다.

### 서버 · CPU 100%

![초기 서버 CPU·메모리 사용률](@/assets/images/load-test-database-pool-sizing/server-resources.png)

- CPU 사용률: 최대 약 100%
- 메모리 사용률: 최대 약 30.5%

### Redis · 낮은 사용률에도 요청 지연

![Redis 엔진 CPU·메모리 사용률과 부하 구간. 원본 화면 기반 근사 그래프](@/assets/images/load-test-database-pool-sizing/redis-cpu-memory.png)

- 엔진 CPU 사용률: 최대 약 0.87%
- 메모리 사용률: 최대 약 3.88%

### DB · 커넥션 획득 지연

[HikariCP 기본값](https://github.com/brettwooldridge/HikariCP#frequently-used)으로 시작했습니다.

- 최대 풀 크기: Master·Replica 각각 10개
- 커넥션 획득 타임아웃: 30초

![초기 커넥션 획득 시간 p99](@/assets/images/load-test-database-pool-sizing/connection-acquire-master-replica.png)

- Master 획득 p99: 표시 구간 최대 1.25초
- Replica 획득 p99: 표시 구간 최대 1.36초

`connection` span에는 SELECT 실행 시간도 포함됩니다. 획득 시간은 HikariCP의 acquire 지표로 확인했습니다.

DB CPU 사전 측정값은 다음과 같았습니다. 측정일·인스턴스 클래스는 미확인이므로 풀 조정에는 획득 시간을 사용했습니다.

| 대상    | 주요 요청                | 평시 CPU | 피크 CPU |
| ------- | ------------------------ | -------: | -------: |
| Replica | `today` 약 200 RPS       |  약 4.0% |  약 7.8% |
| Master  | 출석 확정 약 10 ~ 15 RPS |  약 4.0% | 약 5.87% |

## 해결

부하 조건을 고정해 변경 전후를 비교했습니다.

### 1차 개선 · DB 풀 조정

**판단 이유**

요청 지연 중 DB 커넥션 획득 대기를 확인했습니다. 먼저 풀을 조정해 획득 대기가 줄어드는지 확인하기로 했습니다.

**변경 사항**

DB 풀을 조정하고, 태스크는 1 vCPU·4GB, 2개를 유지했습니다.

**측정 결과**

커넥션 획득 대기는 줄었지만, 비교 트레이스의 SELECT 실행 평균은 증가했습니다. API 지연도 남아 서버 CPU·Redis 호출을 확인하고 태스크 증설로 이어갔습니다.

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

- 먼저 태스크를 2 → 4개로 늘리고, 태스크당 1 vCPU·4GB를 유지했습니다.
- 이후 태스크를 4 → 8개로 늘리면서 CPU도 1 → 2 vCPU로 증설했습니다.

**측정 결과**

**태스크 4개**

- CPU 사용률: 표시 구간 최대 약 100%
- 메모리 사용률: 표시 구간 최대 약 24.24%
- API p99: 3초 초과

처리량은 늘었지만 지연이 남았습니다. **서버 CPU 경합이 Lettuce 이벤트 루프 실행을 지연시킨다는 가설**을 세우고 CPU 증설을 함께 적용했습니다.

**Lettuce 실행 흐름**

공식 구현의 일반 명령 처리 흐름을 단순화한 의사 코드입니다.

```java
// 호출 스레드: 비동기 명령 제출
RedisFuture<String> future = async.set(key, value);
// 동기 API라면 응답 완료 또는 타임아웃까지 대기
return awaitOrCancel(future, timeout);

// Netty 이벤트 루프: 명령 전송 → Redis 응답 수신
onResponse(buffer) {
    decode(buffer, command); // 응답 해석
    command.complete();     // Future 완료 → 호출 스레드 대기 해제
}
```

동기 호출은 [`FutureSyncInvocationHandler`](https://github.com/redis/lettuce/blob/main/src/main/java/io/lettuce/core/FutureSyncInvocationHandler.java), 응답 처리는 [`CommandHandler`](https://github.com/redis/lettuce/blob/main/src/main/java/io/lettuce/core/protocol/CommandHandler.java) 구현을 참고했습니다.

- 동기 대기: 호출 스레드가 결과를 기다립니다. 대기 자체가 CPU를 계속 소비하지는 않습니다.
- 이벤트 루프: 응답을 해석하고 Future를 완료합니다. 여기서 실행되는 콜백이 블로킹하면 다른 I/O도 지연됩니다. [Lettuce 공식 문서](https://redis.github.io/lettuce/user-guide/async-api/#consuming-futures)
- CPU 증설: 이벤트 루프가 CPU를 배정받기까지의 대기를 줄일 수 있다고 판단했습니다. 실제 경합 여부는 CPU 프로파일로 확인해야 합니다.

**태스크 8개 · 태스크당 2 vCPU·4GB**

![CPU 증설·태스크 8개에서의 HTTP 응답 시간 추이](@/assets/images/load-test-database-pool-sizing/probe500-ecs8-response-time.png)

- API p99: 모두 3초 미만
- 최대 응답 시간: 10.74초

### 3차 개선 · 태스크당 CPU 증설

**판단 이유**

CPU를 증설한 구성에서 p99 기준을 충족했습니다. 태스크를 줄여도 응답 시간 기준을 유지하는지 확인하기로 했습니다.

**변경 사항**

태스크당 2 vCPU·4GB를 유지하고, 태스크를 8 → 5개로 줄였습니다.

**측정 결과**

**최종 구성: 태스크 5개 · 태스크당 2 vCPU·4GB**

![최종 구성의 HTTP 응답 시간 추이. max·p95·p90·min](@/assets/images/load-test-database-pool-sizing/probe500-ecs5-response-time.png)

그래프는 전체 요청의 max·p95·p90·min입니다. 앞선 그래프와 축 범위는 다릅니다.

- 최대 응답 시간: 603.41ms

검증한 부하에서는 응답 시간 기준을 충족했습니다. 더 높은 부하는 다음 측정으로 남겼습니다.

![17:10:00.266의 today 트레이스. 전체 310.68ms, Redis set 8.11ms, connection 302.21ms](@/assets/images/load-test-database-pool-sizing/today-trace-171000.png)

- 전체: 310.68ms
- Redis `set`: 8.11ms
- `connection` span: 302.21ms

CPU 증설 전보다 비교 트레이스의 Redis 호출 지연도 줄었습니다. CPU·태스크 수·배포 상태가 함께 달라졌으므로 스레드 점유 가설은 별도 검증합니다.

### 트러블슈팅 · Too many connections

#### 롤링 배포 중 커넥션 여유 확보

태스크 수를 늘렸다 줄이는 과정에서 커넥션이 부족해 `Too many connections`가 발생했습니다. 기존 태스크를 강제로 종료하고 커넥션 여유를 확보한 뒤 교체하기도 했습니다.

현재 롤링 배포는 신규 태스크를 먼저 늘린 뒤 기존 태스크를 종료합니다. 신규·기존 태스크가 공존하는 동안 DB 커넥션도 증가해 교체가 막힐 수 있습니다. [ECS 롤링 배포](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html)

**풀 크기는 평상시 태스크 수가 아닌 배포 중 최대 태스크 수를 기준으로 산정해야 한다는 점을 배웠습니다.** DB별로 태스크당 풀 상한을 곱하고, 다른 클라이언트와 잔존 커넥션을 위한 여유도 확보해야 합니다.

#### 비정상 종료 후 커넥션 회수

정상 종료에서는 [`HikariDataSource.close()`](https://github.com/brettwooldridge/HikariCP/wiki/FAQ#q-how-do-i-properly-shutdown-the-hikaricp-datasource)가 호출되면 풀이 커넥션을 정리합니다. 이 과정에서 비정상 종료까지 고려해야 한다는 생각이 들었습니다.

비정상 종료·네트워크 단절로 DB가 연결 종료를 감지하지 못하면 커넥션이 남을 수 있습니다. 잔존 커넥션으로 [`max_connections`에 도달하면 새 태스크도 커넥션을 확보하지 못합니다](https://dev.mysql.com/doc/refman/8.0/en/too-many-connections.html).

**정상 종료의 풀 정리와 비정상 종료 후 커넥션 회수를 함께 대비해야 한다는 점을 배웠습니다.** 종료 유예 시간, 유휴 커넥션 만료 설정, 장애 시 회수 시간을 확인해야 합니다.

## 결과

### 튜닝 기준

- 서버 CPU 부족: 태스크당 풀을 줄여 DB 커넥션 여유를 확보하고 스케일 아웃합니다.
- 서버 CPU 여유·커넥션 획득 대기 발생: DB 처리 여유를 확인하고 풀을 늘려 스케일 아웃을 최소화합니다.

DB별 커넥션 상한에는 배포 중 태스크와 다른 클라이언트도 포함합니다. [풀 크기는 부하테스트로 검증](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)하고, 동일 부하의 API p99·처리량으로 비교합니다.

### ASIS·TOBE 비교

**DB 풀 조정 전후**

| 개선       | 항목                             | ASIS    | TOBE     |
| ---------- | -------------------------------- | ------- | -------- |
| DB 풀 조정 | Master 획득 p99 · 구간 최대      | 1.25초  | 691ms    |
| DB 풀 조정 | Replica 획득 p99 · 구간 최대     | 1.36초  | 383ms    |
| DB 풀 조정 | SELECT 실행 평균 · 조회 트레이스 | 24.75ms | 106.84ms |

획득 시간은 p99의 구간 최댓값입니다. 실행 평균은 조정 전후 `today` 트레이스에서 각각 SELECT 세 건의 시간을 평균한 값입니다.

**API p99 · 초기 → 최종 구성**

ASIS는 1 vCPU·태스크 2개·DB 풀 10, TOBE는 2 vCPU·태스크 5개 구성입니다. 최종 구성의 API p99는 모두 **3초 이내**였습니다.

| API                     | ASIS p99 | TOBE p99 | 감소(약) |
| ----------------------- | -------- | -------- | -------- |
| 토큰 발급               | 20.78초  | 20.43ms  | 20.76초  |
| 출석 상태 조회(`today`) | 21.00초  | 80.8ms   | 20.92초  |
| 출석 확정               | 21.28초  | 55.9ms   | 21.22초  |
| 현황판 조회(`board`)    | 20.86초  | 33.53ms  | 20.83초  |
