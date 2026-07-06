---
title: 외부 API 호출 시 커넥션 끊김 대응기 — RST, FIN, 그리고 커넥션 풀의 한계
description: Cloudflare가 idle 커넥션을 선제적으로 끊어 발생한 Connection reset by peer 에러를 커넥션 풀 설정으로 대응하며 RST와 FIN의 차이, eviction race condition, 풀 타입까지 파고든 기록입니다.
pubDatetime: 2026-04-01T00:00:00Z
tags:
  - Operations
---

### 개요

외부 API 호출 시 500 응답이 총 48건 발생했다. Connection reset by peer 에러가 원인이었고 외부 API 앞단의 Cloudflare가 idle 상태인 커넥션을 선제적으로 끊고 있었다. 그래서 Connection Pool의 idle 커넥션을 주기적으로 정리하도록 설정을 추가했다.

![외부 API 호출 500 응답 48건이 발생한 에러 로그 화면](/posts/external-api-connection-reset/fig-01.png)

클라이언트 입장에서는 첫 요청도 실패하고, 재시도도 실패한다. Cloudflare가 idle 연결을 먼저 끊기 전에 클라이언트 쪽에서 먼저 정리해야 Connection reset by peer가 사라진다.

```kotlin
@Bean
fun estoneidWebClient(): WebClient {
    val provider = ConnectionProvider.builder("풀이름")
        //...
        .maxIdleTime(Duration.ofSeconds(30))  // idle 연결 30초 후 정리
        .maxLifeTime(Duration.ofSeconds(300)) // 연결 최대 수명 5분
        .evictInBackground(Duration.ofSeconds(30)) // 백그라운드로 연결 정리
        .build()
	//...
}
```

각 설정의 역할은 다음과 같다.

- `maxIdleTime(30s)`
  - idle 상태로 30초가 지난 연결을 정리한다. 요청 시점에 풀에서 꺼낼 때 체크하여 만료된 연결은 버린다.
  - 다만, 요청이 없으면 체크 자체가 일어나지 않아 죽은 연결이 풀에 계속 남아있을 수 있다.
- `maxLifeTime(300s)`
  - 연결 생성 후 5분이 지나면 idle 여부와 무관하게 정리한다.
  - 서버 `keep-alive` 설정에 맞춰 클라이언트에서 먼저 정리한다.
- `evictInBackground(30s)`
  - 30초마다 백그라운드에서 풀을 스캔하여 maxIdleTime , maxLifeTime 동작을 실행시킨다.
  - stale connection 이 지속적으로 생성되는 문제를 개선한다.

### 딥다이브 1 : 요청에 대한 조건 분기 정리

요청이 들어왔을 때 풀에서 커넥션을 꺼내는 과정을 조건 분기로 표현하면 다음과 같다. **커넥션 풀은 소켓 상태를 능동적으로 감시하지 않는다.** RST든 FIN이든 OS 커널의 TCP 스택이 수신하지만, 애플리케이션 레벨의 풀은 소켓을 읽지 않는 한 이 사실을 모른다. 그래서 `maxIdleTime`을 통과한 연결이라도, 상대방이 이미 끊었다면 실패하게 된다.

![풀에서 커넥션을 꺼내는 과정의 조건 분기 흐름도](/posts/external-api-connection-reset/fig-02.png)

연결이 끊어진 상황에 대해서 절대적으로 대처하는 방법으로는 커넥션 풀을 사용하지 않는 방법도 있을 수 있다. `ConnectionProvider.newConnection()`을 활용하면 요청마다 새 TCP 연결을 열고 닫기 때문에, 풀에 죽은 연결이 남아있을 가능성 자체가 사라진다.

```kotlin
@Bean
fun estoneidWebClient(): WebClient {
    val httpClient = HttpClient.create()
        .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 5000)

    return WebClient.builder()
        .clientConnector(ReactorClientHttpConnector(httpClient))
        .build()
}
```

> 반면, 매번 새 연결을 생성하므로 성능은 떨어진다. 정합성이 중요하고 요청량이 적은 경우에 적합한 방법이다.

### 딥다이브 2 : Connection reset by peer 와 Connection has been closed 의 차이

상대방이 연결을 끊는 방식에 따라 발생하는 에러가 다르다. 두 에러는 로그에서 비슷해 보이지만, 원인과 대응이 다르므로 구분해보려고 한다. 두 에러 모두 **TCP 레벨(L4, Transport Layer)** 에서 발생한다. 차이는 상대방이 연결을 끊는 방식에 있다.

**Connection reset by peer — RST에 의한 강제 종료**
RST는 4-way handshake 없이 **즉시 연결을 끊는 것**이다. Cloudflare 같은 프록시가 idle timeout을 초과한 연결을 강제로 정리할 때 RST 패킷을 보낸다. OS 커널은 RST를 수신하지만, 커넥션 풀은 소켓을 능동적으로 읽지 않기 때문에 이 사실을 모른다. 해당 연결을 꺼내 요청을 보내는 순간에야 `IOException`이 발생한다.

![RST 패킷에 의한 강제 종료 시 커넥션 상태 다이어그램](/posts/external-api-connection-reset/fig-03.png)

**Connection has been closed — FIN에 의한 정상 종료**
FIN은 **정상적인 종료 절차**를 밟는 것이다. 서버가 FIN을 보내면 커널이 이를 수신하고 ACK를 응답하여 소켓을 `CLOSE_WAIT` 상태로 전환한다. 그러나 커넥션 풀은 소켓을 능동적으로 읽지 않기 때문에, FIN이 도착한 건 커널이 알고 있지만 애플리케이션은 모른다. 풀이 연결을 꺼내주는 시점까지 아무도 이 사실을 확인하지 않으며, 재사용하려는 순간에야 `PrematureCloseException`이 발생한다.

![FIN 핸드셰이크 후 CLOSE_WAIT 상태로 전환되는 커넥션 상태 다이어그램](/posts/external-api-connection-reset/fig-04.png)

정리하면 다음과 같다.

| 항목               | Connection reset by peer                       | Connection has been closed                           |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| 발생 주체          | 상대방(서버/프록시)이 RST 패킷 강제 전송       | 연결이 정상 종료(FIN) 후 재사용 시도                 |
| TCP 레벨           | RST 플래그 (4-way handshake 없이 즉시 종료)    | FIN 핸드셰이크 후 CLOSE_WAIT 상태                    |
| 원인               | Cloudflare/LB의 idle timeout 초과 후 강제 종료 | 풀에서 꺼낸 연결이 이미 정상 종료(graceful close)됨  |
| Reactor Netty 예외 | `IOException: Connection reset by peer`        | `PrematureCloseException` / `ClosedChannelException` |
| 대응 방법          | 클라이언트 idle timeout을 프록시보다 짧게 설정 | 연결 유효성 검사(evict) 주기 조정                    |

### 딥다이브 3 : evictInBackground 로 인한 race condition

`evictInBackground(30s)`와 `maxIdleTime(30s)`이 동일한 값으로 설정되어, 커넥션을 획득하는 acquire 스레드와 백그라운드 eviction 스레드가 같은 커넥션을 동시에 다루는 race condition이 발생했다.

**PooledConnectionProvider의 내부 구조**
`PooledConnectionProvider`는 내부적으로 `channelPools`라는 `Map<SocketAddress, ConnectionPool>`을 관리한다. 이때 키는 DNS 해석 전의 **hostname:port(unresolved SocketAddress)** 기준이다. 같은 hostname에 대한 요청은 하나의 풀을 공유하며, DNS가 다른 IP로 변경되어도 풀 키는 동일하다. 커넥션을 획득할 때(acquire)와 백그라운드 eviction이 각각 다음과 같이 동작한다.

문제는 acquire 스레드가 커넥션을 획득한 직후, eviction 스레드가 같은 커넥션을 폐기하는 시나리오다.

![acquire 스레드와 eviction 스레드가 같은 커넥션을 동시에 다루는 race condition 시퀀스 다이어그램](/posts/external-api-connection-reset/fig-05.png)

acquire 시점에는 모든 검증을 통과했지만, 요청을 보내기 직전에 eviction 스레드가 해당 연결을 폐기해버린다.

**해결 방안 비교**

| 방안 | eviction 주기 늘리기                                          | eviction 제거                                                  |
| ---- | ------------------------------------------------------------- | -------------------------------------------------------------- |
| 설명 | eviction 스레드의 실행 빈도를 줄여 acquire와 겹칠 확률을 낮춤 | 백그라운드 eviction 스레드를 비활성화                          |
| 효과 | race condition 빈도 감소                                      | race condition 제거                                            |
| 단점 | race condition 제거 못함                                      | acquire 시점에 커넥션 교체 부하 + stale connection 발생 가능성 |

> eviction 주기를 늘리는 방안은 30s → 120s로 변경하면 경쟁 빈도가 1/4로 줄어들겠지만, 여전히 타이밍이 겹칠 가능성이 남는다.

eviction 스레드를 제거하면 race condition은 사라지지만, 부작용이 있다. acquire 시점에 커넥션을 교체하는 부하 : acquire 시점에야 idle 체크 후 버리고 새 연결을 생성하므로 약간의 latency가 추가된다.

### 딥다이브 4: 게이트웨이 커넥션 풀은 왜 ELASTIC인가

부하테스트하며 Grafana에서 커넥션 풀 상태를 확인했다. 두 가지 의문이 생겼다.

![Grafana에서 확인한 커넥션 풀 상태 대시보드](/posts/external-api-connection-reset/fig-06.png)

**왜 pending connections가 0인가?**

pending connections는 풀에 여유가 없어서 커넥션 획득을 대기하는 요청 수다. 이 값이 항상 0인 이유는 현재 커넥션 풀 타입이 **ELASTIC**(기본값)이기 때문이다. ELASTIC은 `max-connections`가 `Integer.MAX_VALUE`로 사실상 무제한이라, 풀이 부족해서 대기하는 상황 자체가 발생하지 않는다.

| 타입               | max-connections 기본값         | 동작                                 |
| ------------------ | ------------------------------ | ------------------------------------ |
| **ELASTIC** (기본) | `Integer.MAX_VALUE`            | 필요할 때마다 커넥션 생성, 제한 없음 |
| FIXED              | JVM이 인식하는 CPU 코어 수 × 2 | 최대 개수 제한, 초과 시 대기         |

각 타입별 우려사항은 다음과 같다.

|               | ELASTIC                                                   | FIXED                                                                            |
| ------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **우려사항**  | downstream 장애 시 커넥션이 무한히 생성될 수 있다         | 특정 downstream이 느려지면 커넥션을 독점하여 다른 downstream까지 병목이 전파된다 |
| **예시**      | support:8091 장애 → 커넥션 수만 개 생성 → **메모리 고갈** | support:8091 응답 느림 → 500개 중 400개 점유 → ea-api:443은 100개만 사용 가능    |
| **완화 방법** | FIXED로 전환하거나 `max-connections` 상한 설정            | `forRemoteHost()`로 remote address별 개별 제한 설정                              |

현재 환경에서는 ELASTIC 기본값을 유지하되, 메트릭 모니터링으로 커넥션 증가 추이를 관찰하고 있다.

**evictInBackground 없이 커넥션은 어떻게 정리되는가?**

딥다이브 3에서 race condition 방지를 위해 `evictInBackground`를 제거했다. 그런데 메트릭을 보면 idle 커넥션이 무한히 쌓이지 않고 정리되고 있었다. 백그라운드 eviction이 없어도 **acquire 시점에 idle time 체크하면서** 활성 커넥션을 획득하기 위해 루프를 돌기 때문이다.

한 번의 acquire에서 여러 개의 idle 초과 커넥션을 연쇄적으로 폐기한다. 그래프에서 idle 커넥션이 줄어든 이유는 실제 사용자 트래픽(support:8091로 프록시되는 요청)이 들어오면서 acquire 시점에 idle 시간과 max lifetime에 의해 커넥션이 정리된 것으로 예상된다.

> idle connection 수 만큼을 루프를 도는 만큼 레이턴시가 발생할 수 있음을 유의해야 한다.

**모니터링 결과**

모니터링했을 때, idle connection이 70 → 19개 까지 정리하면서 응답시간이 10ms → 18ms 상승하는 현상도 확인됐다. 커넥션 정리가 연쇄적으로 발생하면서 응답시간이 상승한 것으로 확인된다.

![idle connection 정리에 따른 응답시간 상승을 보여주는 모니터링 그래프](/posts/external-api-connection-reset/fig-07.png)

> 이 때, 초록색 점선은 reqeust 비율이며, 유지되고 있다. 따라서 request 비율이 상승해서 발생하는 지연 현상은 아니라고 판단했다.

### 마무리하며

최근 외부 API 앞단에 Cloudflare를 도입하는 서비스가 늘어나고 있다. Cloudflare뿐 아니라 AWS ALB, GCP Cloud Load Balancing 등 프록시를 거치는 구조가 일반적이 되면서, 외부 통신 시 커넥션이 끊어지는 상황은 더 이상 예외가 아니라 기본적으로 대비해야 할 문제가 됐다. 이번 경험을 통해 알게 된 점을 정리한다.

- **외부 프록시의 idle timeout을 반드시 파악해야 한다.** 프록시마다 idle timeout 정책이 다르고, 클라이언트의 `maxIdleTime`이 프록시보다 길면 `Connection reset by peer`가 발생한다. 프록시의 timeout 값은 공식 문서를 확인하거나, tcpdump/Wireshark로 RST 타이밍을 측정하여 파악할 수 있다.
- **커넥션 풀 설정만으로는 완벽하지 않다.** `maxIdleTime`, `evictInBackground`, `maxLifeTime`을 모두 설정해도 타이밍에 따라 경쟁 조건이 남는다. 커넥션 풀은 소켓 상태를 능동적으로 감시하지 않고 시간 메타데이터만 보기 때문에, 커널이 RST나 FIN을 수신하더라도 풀은 이를 모른다. 정합성이 중요하고 요청량이 적다면, 매번 새 연결을 생성하는 `ConnectionProvider.newConnection()`도 현실적인 대안이다.
- **커넥션 풀의 내부 동작을 이해해야 한다.** `evictInBackground`는 stale connection을 방지하기 위한 설정이지만, acquire 스레드와의 경쟁을 일으킬 수 있다. 설정의 의도뿐 아니라 내부 동작 원리를 파악해야 부작용을 예방할 수 있다.
- **외부 통신은 끊어질 수 있다는 전제로 설계해야 한다.** 프록시 구조가 일반화된 이상, 커넥션이 끊어지는 것은 장애가 아니라 정상적인 동작의 일부다. 커넥션 풀 설정으로 예방하고, retry로 복구하며, 에러 로그를 구분하여 빠르게 원인을 추적하는 것까지가 외부 통신의 기본 대응이라고 생각한다.
