---
title: "2026년 8월 2주차 회고: 『주니어 백엔드 개발자가 반드시 알아야 할 실무지식』 4장"
description: 『주니어 백엔드 개발자가 반드시 알아야 할 실무지식』 4장을 읽고, 타임아웃과 재시도 설정 기준을 AWS·Google 운영 자료로 조사해 정리한 기록입니다.
pubDatetime: 2026-08-09T00:00:00Z
tags:
  - Weekly Review
---

> 3줄 요약
>
> - 『주니어 백엔드 개발자가 반드시 알아야 할 실무지식』 4장을 읽고, 읽으면서 생긴 질문들의 답을 AWS·Google 운영 자료에서 찾았다.
> - 인사이트: 타임아웃은 다운스트림 응답 시간 백분위로 잡는다. p99로 잡는 건 정상 요청 1%를 끊겠다는 선택이다.
> - 다음 주는 『주니어 백엔드 개발자가 반드시 알아야 할 실무지식』 5장을 읽는다.

## 지난주 Try 점검

- [ ] test 환경에 `MALLOC_ARENA_MAX=2`와 jemalloc(`background_thread:true`)을 배포해, 운영급 트래픽에서 격차 추세와 응답 지연/처리량 비교하기
      → 진행 중이다.
- [x] 『주니어 백엔드 개발자가 반드시 알아야 할 실무지식』 4장 읽고 정리하기
      → 읽고 스터디 노트에 정리했다. 기억할 것만 아래에 남긴다.

## 이번 주의 공부: 『주니어 백엔드 개발자가 반드시 알아야 할 실무지식』 4장

4장은 외부 연동이 문제일 때 살펴봐야 할 것들을 다룬다. 읽고 스터디 노트에 정리했고, 기억할 내용만 남긴다.

- 타임아웃은 통신 단계에 맞춰 나눠 설정한다 — 연결까지는 connect timeout, 응답 대기는 read timeout. read timeout은 연동 서비스 상황에 맞게 조절한다.
- 재시도는 단순 조회, 연결 타임아웃, 멱등한 변경에만 한다. 횟수는 1~2번, 간격은 3초. 과한 재시도는 연동 서비스 부하를 키운다(retry storm).
- 연동 서비스가 정상이 아니면 바로 에러를 응답한다(fail-fast). 서킷 브레이커가 `Closed`-`Open`-`Half Open` 상태 전환으로 이를 구현한다.
- 외부 연동은 DB 트랜잭션 밖에서 한다
  - read timeout이 나면 외부 성공 여부를 알 수 없으므로, 주기적인 데이터 비교·보정이나 성공-확인 API로 불일치에 대비한다
  - 같은 구조의 사례를 겪었다 — 포인트 전환에서 분산락 점유 시간의 65%가 외부 API 호출이었고, 락 범위에서 외부 호출을 빼 점유 시간을 192ms에서 67ms로 줄였다([외부 API 연동의 정합성, 분산락, 그리고 테스트 전략](/posts/external-api-consistency-and-locking))
- HTTP 커넥션 풀은 크기(연동 서비스 성능 기준), 커넥션 대기 시간(1~5초), keep alive(연동 서버보다 짧게)를 설정한다.
- 연동 서비스 이중화는 비용이 배로 들므로, 기능이 서비스 핵심인지와 비용을 감당할 수 있는지부터 확인한다.

## 실무에 적용할 점

- **일관성 중요도에 따른 API 연동 설계**
  - 판단 기준: 이 연동이 틀어졌을 때 돈이나 데이터가 틀어지는가
  - 중요하지 않은 연동(알림 발송, 통계 전송): 타임아웃과 제한된 재시도면 충분하다
  - 중요한 연동(결제, 포인트 차감): 세 층을 설계 단계부터 갖춘다 — 멱등키([Stripe의 `Idempotency-Key`](https://docs.stripe.com/api/idempotent_requests) 방식), 성공-확인 API, 주기적인 비교·보정 배치
  - 겪은 사례
    - [설계 노트: 포인트 차감과 결제 사이의 정합성 다루기](/posts/point-payment-deduction-consistency-design)에서 다룬 문제와 같은 구조다
    - 보상 조치의 한계는 [포인트 전환 사례](/posts/external-api-consistency-and-locking)에서 겪었다 — 전환된 포인트가 먼저 사용되면 되돌릴 수 없어서, 가장 되돌리기 어려운 조치를 마지막에 실행하도록 순서를 바꿨다
- **동시성 정도에 따른 동시성 제어**
  - 같은 행을 동시에 수정하는 빈도가 드물면 낙관적 락(JPA `@Version`, 충돌 시 재시도), 잦으면 비관적 락(`SELECT ... FOR UPDATE`)
  - 6장에서 본격적으로 다루니 그때 기준까지 정리한다
- **Spring Boot 4 이후의 HTTP 연동 라이브러리** — 기본값에 맡기면 HTTP 커넥션 풀을 제어할 수 없다.
  - `RestClient`의 request factory 기본값은 classpath 순서로 정해진다: Apache HttpClient → Jetty → JDK HttpClient → `SimpleClientHttpRequestFactory`(HttpURLConnection) ([공식 레퍼런스](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html))
  - 기본 의존성만 있는 스프링 부트 앱은 Apache도 Jetty도 없으므로 JDK HttpClient가 잡힌다. `RestTemplate`은 Simple이 기본이다
  - `SimpleClientHttpRequestFactory`: 관리되는 커넥션 풀이 없다
  - JDK HttpClient: 내부에서 커넥션을 재사용하지만 풀 크기·대기 시간을 설정하는 API가 없다(시스템 프로퍼티로 일부만 조절)
  - 4장의 세 설정(풀 크기, 커넥션 대기 시간, keep alive)을 조절하려면 Apache HttpClient(`PoolingHttpClientConnectionManager`)나 Jetty를 의존성에 넣고 명시해야 한다. 외부 연동이 중요한 서비스라면 기본값에 맡기지 않는다

## 더 알아볼 것 / 질문

읽으면서 생긴 질문들이다. 답도 직접 찾아봤다.

- **read timeout, 가이드라인이 없으면 p95나 p99 기준으로 잡아도 되나** — [AWS Builders' Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter)가 같은 방식을 쓴다.
  - 허용할 false timeout 비율(정상인데 타임아웃으로 끊기는 비율)을 먼저 정하고, 다운스트림 응답 시간의 해당 백분위를 타임아웃으로 잡는다 — 0.1% 허용이면 p99.9
  - p99로 잡는 건 정상 요청 1%를 끊겠다는 선택이다
  - 주의점 세 가지
    - 응답 시간이 고른 서비스(p99.9가 p50에 가까움)는 백분위 그대로 잡으면 작은 지연 증가에도 타임아웃이 쏟아진다 — 여유분을 더한다
    - 인터넷 구간을 지나는 호출은 최악 네트워크 지연을 반영한다
    - 타임아웃이 DNS 조회·TLS 핸드셰이크를 포함하는지 확인한다 — 새 커넥션의 TLS 수립 시간이 타이머에 포함돼 20ms 타임아웃이 배포 직후에만 터진 사례가 실려 있다
- **Apache HttpClient의 socket timeout과 OkHttp의 call timeout은 뭐가 다른가** — 재는 구간이 다르다.
  - socket timeout(HttpClient 5의 `responseTimeout`): 패킷과 패킷 사이의 최대 무응답 시간이다. 패킷이 조금씩이라도 계속 오면 전체 응답이 아무리 오래 걸려도 타임아웃이 나지 않는다
  - OkHttp의 `callTimeout`: DNS 조회부터 연결, 요청 전송, 서버 처리, 응답 본문 읽기까지 전체 시간을 한 번에 제한한다. 기본값이 0(무제한)이라 직접 설정해야 한다. connect·read·write timeout은 각각 기본 10초다

  ![HTTP 호출을 풀 대기부터 응답 읽기까지 가로 타임라인으로 그린 도식. socket timeout은 응답 패킷 사이 간격마다 0부터 다시 재서 패킷이 이어지는 한 전체 시간에 제한이 없고, call timeout은 DNS 조회부터 응답 본문 끝까지 전체를 한 번에 잰다](@/assets/images/2026-august-week2-review/socket-timeout-vs-call-timeout.svg)

  - 응답이 큰 API나 스트리밍은 read/socket timeout만으로는 전체 시간에 상한이 없다. "이 호출은 총 N초 안에 끝나야 한다"는 요구가 있으면 call timeout처럼 전체를 재는 타임아웃이 필요하다
  - HttpClient 5의 `connectionRequestTimeout`은 풀에서 커넥션을 가져올 때까지의 대기 시간이다 — 본문의 "커넥션 풀 대기 1~5초"가 이 설정이다

- **재시도 횟수와 간격을 정하는 정량적인 기준** — 책의 "1~2번, 3초"에 업계 기준을 붙였다.
  - [Google SRE 책](https://sre.google/sre-book/handling-overload/): 요청당 최대 3회 시도 + 클라이언트 단위 retry budget. 전체 요청 대비 재시도 비율이 10%를 넘으면 재시도하지 않는다. 요청당 3회 제한만으로는 과부하 시 부하가 최대 3배까지 커지는데, budget을 얹으면 1.1배로 억제됐다는 실측이 실려 있다.
  - AWS: 고정 간격 대신 [지수 백오프 + 지터](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)를 쓴다. 간격을 매번 늘리되(capped exponential backoff) 무작위 지연을 더해, 실패한 클라이언트들이 같은 시각에 다시 몰리지 않게 한다.
  - [resilience4j Retry](https://resilience4j.readme.io/docs/retry) 기본값: 최대 3회 시도(최초 호출 포함), 간격 500ms.
- **retry storm은 언제 생기고 어떻게 대비하나**
  - 발생 조건 세 가지
    - 계층마다 독립 재시도: 5계층 호출 스택에서 계층마다 3회씩 재시도하면 최하단에는 3^5 = 243배 부하가 간다
    - 너무 짧은 타임아웃: 정상 응답까지 실패로 판정해 전부 재시도로 돌린다
    - 지터 없는 백오프: 실패한 요청들이 같은 시각에 다시 몰린다
  - 대비 네 가지
    - 재시도는 호출 스택의 한 지점에서만 한다
    - 재시도 총량을 제한한다
    - 지수 백오프에 지터를 더한다
    - 재시도 비율(재시도 수/전체 요청 수)을 지표로 모니터링한다
  - 재시도 총량을 제한하는 수단은 자료마다 다르다 — 목표는 셋이 같고 수단이 다르다
    - 책 4장: 서킷 브레이커
    - AWS: token bucket — AWS SDK에 2016년부터 내장. 열림/닫힘에 따라 시스템 동작이 두 갈래로 갈리는 서킷 브레이커는 테스트가 어렵다며 유보적이다
    - Google: retry budget

## 다음 주 Try

- [ ] 『주니어 백엔드 개발자가 반드시 알아야 할 실무지식』 5장 읽고 정리하기
