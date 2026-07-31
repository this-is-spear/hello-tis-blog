---
title: 스토리지 서비스로 배운 속도와 안정성 트레이드오프
description: 스토리지 서비스 벤치마크에서 Nginx와 Spring Boot의 역할을 분리하고 속도와 안정성 사이의 균형을 찾아간 기록입니다.
pubDatetime: 2026-04-06T02:29:13Z
tags:
  - Study
---

## 개요

LIVID 스터디에서 스토리지 서비스를 구현하고 팀 간 벤치마크로 성능을 평가했다. 우리 팀은 Nginx와 Spring Boot의 역할을 분리해 성능을 끌어올렸고, 전체 시나리오 종합 결과에서 1위를 달성했다. 다만 업로드 성공률은 76.4%에 머물러 개선 과제로 남았다.

## 결과부터

벤치마크 결과부터 공유해보겠다. 아래 수치는 스터디에서 제공한 동일 시나리오 안의 상대적인 결과다.

![LIVID 스터디 스토리지 서비스 벤치마크 종합 결과](@/assets/images/storage-service-performance-tradeoffs/benchmark-result.png)

| 시나리오      | 총 파일 수 | 성공률    | 평균 MB/s | 비고                                           |
| ------------- | ---------- | --------- | --------- | ---------------------------------------------- |
| 파일 업로드   | 1,146      | **76.4%** | 58.9      | 동시 요청 많을수록 실패율 증가, huge 전량 실패 |
| 파일 다운로드 | 876        | **100%**  | 59.5      | 에러율 0%, 해시 검증 전부 통과                 |
| 폴더 조회     | 9          | 100%      | —         |                                                |
| 파일 이동     | 575        | 100%      | —         |                                                |
| 파일 삭제     | 402        | 100%      | —         |                                                |
| 폴더 삭제     | 596        | 100%      | —         |                                                |

## 대역폭 제어로 발견한 트레이드오프

다운로드 최적화에서 핵심은 `sendfile`과 동적 속도 제어였다. `sendfile`은 커널이 파일을 네트워크 소켓으로 직접 전달하는 방식이다. Spring이 파일을 읽어 스트리밍하는 경로를 제거해서 CPU 사용량과 지연을 줄인다.

```nginx
location /files/ {
    internal;
    sendfile on;
    sendfile_max_chunk 1m;
    limit_rate_after 10m;
    limit_rate 100m;
}
```

여기서 `limit_rate`가 동적 속도 제어다. 대역폭을 제한하면 개별 요청의 최대 속도는 낮아지지만, 동시에 처리되는 요청들이 서로 대역폭을 과도하게 점유하지 않아 전체적인 성공률이 높아진다.

| 지표                           | 결과       |
| ------------------------------ | ---------- |
| 다운로드 단독 측정 처리량 평균 | 226 MB/s   |
| 처리량 최대                    | 1,110 MB/s |
| 에러율                         | **0%**     |

속도와 안정성은 트레이드오프다. 대역폭 제어를 적용하기 전까지는 이 둘이 같은 방향이라고 생각했는데, 빠르게 처리하려고 대역폭을 열어두면 동시 요청이 몰릴 때 서로 경합하면서 실패율이 올라간다. 대역폭을 제어해서 평균 속도를 낮추는 게 안정성을 얻는 방법이었다.

## 최적화 과정

### 업로드: Multipart → Nginx Direct-to-Disk

기존 Multipart 업로드에서 파일은 3단계로 버퍼링됐다. JVM을 통과하는 동안 Tomcat 커넥션이 업로드 전체 시간(300MB 파일 기준 약 30초) 동안 점유됐고, Nginx tmpfs도 512MB RAM을 소비했다.

```
클라이언트
  → Nginx (tmpfs /tmp/nginx-body에 임시 저장)
  → loopback TCP로 Spring Boot에 전송
  → Spring Boot (JVM heap 경유 → 디스크 임시 저장)
  → ATOMIC_MOVE (최종 저장)
```

`client_body_in_file_only on` 설정으로 Nginx가 파일 바이트를 JVM을 거치지 않고 디스크에 직접 기록하도록 개선했다. Spring은 메타데이터 검증과 `ATOMIC_MOVE`만 수행한다.

```
변경 전: 클라이언트 → Nginx → Spring (JVM heap) → 디스크  (3단계 버퍼링)
변경 후: 클라이언트 → Nginx → 디스크  (JVM 바이패스)
```

| AS-IS: Spring Multipart                                                                                                  | TO-BE: Nginx Direct-to-Disk                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ![Spring Multipart 방식의 업로드 요청 흐름](@/assets/images/storage-service-performance-tradeoffs/upload-before.png)<br> | ![Nginx Direct-to-Disk 방식의 업로드 요청 흐름](@/assets/images/storage-service-performance-tradeoffs/upload-after.png)<br> |

| 지표           | Multipart (AS-IS) | Nginx Direct-to-Disk (TO-BE) | 변화  |
| -------------- | ----------------- | ---------------------------- | ----- |
| 응답시간 평균  | 154ms             | **43ms**                     | \-72% |
| 응답시간 p95   | 234ms             | **102ms**                    | \-56% |
| 처리량 (req/s) | 6.55              | **13.97**                    | +113% |

### 다운로드: X-Accel-Redirect → sendfile + 동적 속도 제어

다운로드는 단계적으로 개선해나갔다.

| AS-IS: Spring 직접 스트리밍                                                                                                   | TO-BE: X-Accel-Redirect + sendfile + 동적 속도 제어                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ![Spring이 파일을 직접 스트리밍하는 다운로드 흐름](@/assets/images/storage-service-performance-tradeoffs/download-before.png) | ![X-Accel-Redirect와 sendfile을 이용하는 다운로드 흐름](@/assets/images/storage-service-performance-tradeoffs/download-after.png)<br> |

**1단계: X-Accel-Redirect + sendfile (zero-copy)**

Spring이 직접 파일을 스트리밍하던 방식을 Nginx에 위임했다. `sendfile()`은 디스크에서 네트워크까지 앱 메모리를 거치지 않고 직접 전달한다.

```
변경 전: 디스크 → [커널] → [Spring 메모리] → [커널] → 네트워크  (복사 4회)
변경 후: 디스크 → [커널] → 네트워크  (복사 2회, zero-copy)
```

Spring은 인증과 `X-Accel-Redirect` 헤더 처리만 담당하고 실제 파일 전송은 Nginx가 맡는다.

**2단계: X-Accel-Limit-Rate 동적 속도 제어**

고정 대역폭 제한 대신 파일 크기에 따라 속도를 동적으로 제어했다. Spring이 `X-Accel-Limit-Rate` 헤더로 요청별 속도를 Nginx에 전달하면, Nginx가 해당 값을 요청별 `limit_rate`로 자동 적용한다.

```java
private String calculateRate(long fileSize) {
    long threshold = 100L * 1024 * 1024;
    if (fileSize < threshold) return "0";       // 무제한
    return String.valueOf(128L * 1024 * 1024);  // 128MB/s 제한
}
```

Nginx 설정 변경 없이 앱 레벨에서 파일 크기, 사용자 등급 등 비즈니스 로직에 따라 속도를 제어할 수 있다.

| 지표                   | AS-IS (limit_rate 10m) | TO-BE (동적 제어) | 개선        |
| ---------------------- | ---------------------- | ----------------- | ----------- |
| 처리량 평균            | 13.5 MB/s              | **226 MB/s**      | 16.7배      |
| 처리량 최대            | 14.0 MB/s              | **1,110 MB/s**    | 79배        |
| 다운로드 소요시간 평균 | 741ms                  | **84ms**          | 8.8배 빠름  |
| 다운로드 소요시간 p50  | 727ms                  | **55ms**          | 13.2배 빠름 |
| 에러율                 | 0%                     | 0%                | —           |

### 파일 이동: ltree 경로 기반 DB 업데이트

파일 이동은 실제 파일을 디스크에서 옮기는 대신 PostgreSQL의 `ltree` 확장을 활용해 DB에 저장된 경로 정보만 업데이트하는 방식으로 구현했다.

**ltree 원리**

`ltree`는 계층형 경로를 점(`.`)으로 구분된 레이블로 저장하는 자료구조다.

```
documents.folderA.subfolder.file1
documents.folderA.subfolder.file2
documents.folderA.file3
```

`<@` 연산자로 특정 경로의 하위 항목을 모두 조회할 수 있고, `subpath()`로 경로의 일부를 잘라낼 수 있다. 이 두 가지를 조합하면 폴더 이동을 단일 쿼리로 처리할 수 있다.

**이동 쿼리 예시**

`documents.folderA`를 `documents.folderB`로 이동할 때:

```sql
UPDATE files
SET path = 'documents.folderB' || subpath(path, nlevel('documents.folderA'))
WHERE path <@ 'documents.folderA';
```

실행 결과:

| 변경 전                             | 변경 후                             |
| ----------------------------------- | ----------------------------------- |
| `documents.folderA.subfolder.file1` | `documents.folderB.subfolder.file1` |
| `documents.folderA.subfolder.file2` | `documents.folderB.subfolder.file2` |
| `documents.folderA.file3`           | `documents.folderB.file3`           |

파일 수와 무관하게 단일 쿼리로 처리되기 때문에 10~68ms로 빠르게 완료됐다. 디스크 I/O 없이 경로 컬럼만 업데이트하므로 파일이 많아도 성능이 일정하다.

## DB 커넥션 풀 고갈

부하 테스트 중 예상치 못한 에러가 발생했다.

```
HikariPool-1 - Connection is not available, request timed out after 5001ms
(total=20, active=20, idle=0, waiting=312)
```

DB 커넥션 20개가 전부 점유된 상태에서 312개의 요청이 대기하다 타임아웃이 났다. 스택 트레이스를 보면 두 가지 단서가 있었다.

```
at java.base/java.lang.VirtualThread.run(Unknown Source)
```

Spring Boot가 Virtual Thread로 동작 중이었다. 스레드 이름도 `at-handler-1025`, `at-handler-1019`로 1000번대였다.

기존 Tomcat 스레드 풀(기본 200개) 방식에서는 스레드 수 자체가 자연스러운 backpressure 역할을 했다. 스레드가 200개면 동시에 DB 커넥션을 요청하는 것도 최대 200개였다.

Virtual Thread를 활성화하면 기존 플랫폼 스레드 풀의 크기가 더는 동일한 backpressure 역할을 하지 않는다. Nginx에서 동시 요청 1000개가 전달되면 Spring이 이를 수용하고, 요청들이 동시에 HikariPool에 커넥션을 요구할 수 있다.

```
Nginx (1000개 동시 요청)
        ↓
Spring (Virtual Thread: 사실상 무제한 수용)
        ↓ 전부 DB 접근 시도
HikariPool (커넥션 20개) ← 312개 대기 → 5초 타임아웃
```

커넥션 풀 사이즈를 단순히 늘리는 건 부하를 DB 서버로 옮기는 것일 뿐이다. 근본적으로는 요청이 DB까지 오기 전에 제어가 필요하다.

- **Nginx upstream 동시 연결 제한**: `max_conns`로 upstream으로 전달되는 동시 연결 수를 제어
- **애플리케이션 레벨 Semaphore**: DB 접근 전 진입 가능한 요청 수를 제한

Virtual Thread 환경에서는 기존의 스레드 수 기반 backpressure가 사라지기 때문에, 명시적으로 제어 포인트를 설계해야 한다는 것을 체감했다.

## 마무리

대역폭 제어를 적용하면서 속도와 안정성이 트레이드오프 관계임을 직접 경험했다. 빠르게 처리하려고 제한을 풀면 동시 요청이 몰릴 때 경합이 생기고, 제어를 걸면 평균 속도는 낮아지지만 완료율이 올라간다. 어떤 시스템이든 "빠른 것"과 "완료되는 것" 중 무엇을 우선할지 먼저 정하는 게 중요하다는 걸 깨달았다.

**Virtual Thread는 생산성을 크게 높이지만, 기존 방식의 자연스러운 backpressure가 사라진다는 점은 놓치기 쉬운 함정이었다.** 편리함 뒤에 숨겨진 위험을 인지하고 있어야 한다. DB 커넥션 풀 이슈는 아직 해결하지 못했지만, 원인을 파악한 것만으로도 다음 단계를 알 수 있게 됐다.
