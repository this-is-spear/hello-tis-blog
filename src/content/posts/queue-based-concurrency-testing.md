---
title: 분산락을 큐로 대체할 수 있을까
description: 분산락의 한계를 큐로 풀 수 있는지 직접 구현, Redis Streams, RabbitMQ 순으로 부하 테스트하고 PoC로 마무리한 기록입니다.
pubDatetime: 2024-11-25T00:00:00Z
tags:
  - Product
---

## 개요

Redisson 분산락으로 동시성을 제어하던 포인트 거래 시스템에서 두 가지 한계를 만났습니다.

1. 요청 순서를 보장하지 않습니다. 잠금 해제 신호를 받으면 대기하던 스레드들이 다시 경쟁하므로, 경쟁이 치열할수록 순서가 뒤섞입니다.
2. 임계 영역 안에서 외부 메서드를 호출하면 데드락 가능성이 생깁니다.

![두 개 작업이 동일한 잠금을 시도할 때 잠금 순서가 뒤섞이는 과정](@/assets/images/queue-based-concurrency-testing/178.png)

이 한계를 큐(생산자 소비자 패턴)로 풀 수 있는지 확인하려고 세 단계로 테스트했습니다.

1. `ReentrantLock` 기반 버퍼 큐를 직접 구현해 패턴의 동작과 한계를 확인했습니다.
2. Redis Streams로 큐를 옮겨 부하 테스트를 하다 병목을 만났고, 원인을 좁혀 검증했습니다.
3. Redisson Lock, Redis Streams + pub/sub, RabbitMQ direct-reply-to를 시나리오별로 비교했습니다.

결론부터 말하면, 경쟁이 없을 때는 분산락이 월등히 빠르고 특정 데이터에 경쟁이 몰릴 때는 큐가 안정적이었습니다. 동시성 제어는 제어 영역을 좁혀 병렬성을 확보하는 게 핵심이고, 모든 요청을 순차 처리하는 큐는 그 자체가 병목이 됩니다.

## 결과부터

시나리오별 핵심 수치입니다.

측정 기간: 2024-11
대상: 개인 프로젝트 포인트 거래 시스템
도구: k6 (VUS 최대 200), Grafana + InfluxDB

**시나리오 A — 불특정 다수 거래자 (경쟁 분산)**

| Metric         | Redisson Lock | Redis Streams + pub/sub | RabbitMQ direct-reply-to |
| -------------- | ------------: | ----------------------: | -----------------------: |
| 평균 응답 시간 |         0.40s |                   0.55s |                    2.33s |
| 최대 응답 시간 |          3.6s |                    7.6s |                    5.93s |

**시나리오 B — 특정 거래자 집중 (발급처 → B → C → 사용처 연쇄 거래)**

| Metric         | Redisson Lock | Redis Streams + pub/sub | RabbitMQ direct-reply-to |
| -------------- | ------------: | ----------------------: | -----------------------: |
| 평균 응답 시간 |         7.83s |                   3.18s |                    8.57s |
| 실패 건수      |         258건 |                     0건 |                      4건 |

경쟁이 분산되면 분산락이 빠릅니다. 경쟁이 집중되면 분산락은 실패가 쏟아지고(258건), 큐 방식은 레이턴시가 일정하게 유지됩니다.

## 1단계 : 왜 큐인가 — 생산자 소비자 패턴 직접 구현

생산자 소비자 패턴은 버퍼에 여러 생산자와 소비자가 접근해 동시 요청을 제어하는 방식입니다. 작업 처리 순서를 큐가 결정하므로 분산락의 비결정성 문제를 해소할 수 있습니다.

![여러 생산자와 소비자가 버퍼를 통해 동시 요청을 제어하는 생산자 소비자 패턴 구조](@/assets/images/queue-based-concurrency-testing/131.png)

패턴의 고전적인 이슈는 두 가지입니다. 버퍼가 가득 찼을 때 담으려는 경우, 버퍼가 비었을 때 가져가려는 경우. 둘 다 대기가 필요하고, 대기 방식은 뮤텍스(신호 대기)와 스핀락(버퍼 폴링) 중 고릅니다. 작업자가 많아질수록 스핀락의 경쟁이 치열해지므로 뮤텍스를 선택했습니다.

`ReentrantLock`의 `Condition`(`await`/`signal`)으로 버퍼 큐를 구현했습니다.

```kotlin
private const val BUFFER_SIZE = 5

class AccountQueue {
    private val buffer = PriorityQueue<AccountingBehavior>()
    private val lock = ReentrantLock()
    private val notFull: Condition = lock.newCondition()
    private val notEmpty: Condition = lock.newCondition()

    fun produce(item: AccountingBehavior) {
        lock.lock()
        try {
            while (buffer.size == BUFFER_SIZE) {
                notFull.await()
            }
            buffer.offer(item)
            notEmpty.signal()
        } finally {
            lock.unlock()
        }
    }

    fun consume(): AccountingBehavior {
        lock.lock()
        try {
            while (buffer.isEmpty()) {
                notEmpty.await()
            }
            val item = buffer.poll()
            notFull.signal()
            return item
        } finally {
            lock.unlock()
        }
    }
}
```

이 모델의 한계는 순차 처리를 지키려면 소비자가 하나여야 한다는 점입니다. 소비자를 늘리는 순간 순서가 깨집니다.

![소비자가 두 개 이상이면 작업 순서가 보장되지 않는 상황](@/assets/images/queue-based-concurrency-testing/134.png)

그래서 순차 처리의 단위를 "전체"가 아니라 "개인"으로 좁혔습니다. 회원 ID로 버퍼를 샤딩하면 샤드 안에서는 순서를 지키면서 소비자를 늘릴 수 있습니다.

```kotlin
class ProducerConsumerService {
    private val map: Map<Long, AccountQueue> = mapOf(
        0L to AccountQueue(0L),
        1L to AccountQueue(1L),
        2L to AccountQueue(2L),
    )

    fun produce(item: AccountingBehavior) {
        val shardingKey = item.member.id % 3
        map[shardingKey]!!.produce(item)
    }
}
```

![샤딩 키로 버퍼를 나누고 샤드별 소비자를 늘린 구조](@/assets/images/queue-based-concurrency-testing/135.png)

남은 문제는 producer, buffer, consumer가 서로 붙어 있어 유연하게 스케일링할 수 없다는 점입니다. 버퍼를 외부 인프라로 빼야 했고, 그래서 Redis Streams를 테스트했습니다.

## 2단계 : Redis Streams 테스트 — 병목 발견과 원인 검증

Redis Streams는 메시지를 연결 리스트로 관리하고 소비자가 소비할 때까지 보관합니다. 인프라 복잡도를 높이지 않고 큐를 쓸 수 있어 먼저 시도했습니다. 생산자는 `stream.add()`로 메시지를 담고, 소비자는 컨슈머 그룹으로 하나씩 읽어 처리 후 `ACK`를 보냅니다.

```kotlin
fun consumeTransactionRequest() {
    val stream: RStream<String, String> = redissonClient.getStream(STREAM)
    val args = StreamReadGroupArgs.neverDelivered().count(1)
    val message = stream.readGroup(GROUP, CONSUMER, args).entries
        .stream().findFirst().orElse(null)

    if (message != null) {
        val msg = objectMapper.readValue(message.value["result"], PointTransactionMessage::class.java)
        transactionService.transaction(msg.sourceAccount, msg.targetAccount, msg.amount)
        stream.ack(GROUP, message.key)
    }
}
```

### 현상

요청이 일정량 유지되는 시점에 평균 응답 시간이 갑자기 튀었습니다.

![요청이 유지되는 구간에서 평균 응답 시간이 급증한 그래프](@/assets/images/queue-based-concurrency-testing/141.png)

이해할 수 없었던 건 측정 구간입니다. 측정 구간은 생산자가 레디스에 데이터를 담기까지인데, 담기만 하는 구간이 왜 느려지는지 알 수 없었습니다.

![측정 구간이 생산자에서 레디스까지임을 보여주는 구조도](@/assets/images/queue-based-concurrency-testing/145.png)

### 분석

그 시점의 메트릭을 모았습니다. 레디스에서는 커넥션 수가 늘고 처리량이 잠깐 감소했습니다.

![병목 시점에 레디스 커넥션 수 증가와 처리량 감소를 보여주는 그래프](@/assets/images/queue-based-concurrency-testing/142.png)

애플리케이션에서는 time-wait 상태 스레드가 증가하고 wait 상태 스레드가 줄었습니다.

![병목 시점에 time-wait 스레드 증가를 보여주는 스레드 상태 그래프](@/assets/images/queue-based-concurrency-testing/143.png)

레디스 명령어 중에서는 `XREADGROUP`이 가장 많이 호출됐고, 총 실행 시간 5.2s, 단건 최대 12.2ms였습니다.

![XREADGROUP 호출 횟수와 실행 시간 통계](@/assets/images/queue-based-concurrency-testing/144.png)

여기까지 모아 원인 후보를 두 개로 좁혔습니다.

1. 레디스에 요청을 보내려고 time-wait로 대기하는 스레드가 많아졌고, 늘어난 커넥션이 처리량을 떨어뜨렸다.
2. 레디스는 단일 작업자다. 한 작업자가 생산과 소비를 같이 하는데, 소비(`XREADGROUP`) 부하가 생산을 지연시킨다.

### 검증

가설 2는 소비를 멈추면 바로 확인할 수 있습니다. 소비자를 끄고 생산만 돌리니 병목이 사라졌습니다. 소비 작업이 생산 작업을 지연시키고 있었습니다.

![소비를 중단한 뒤 병목이 사라진 응답 시간 그래프](@/assets/images/queue-based-concurrency-testing/146.png)

커넥션 증가와 처리량 감소는 병목의 원인이 아니었습니다. 소비를 멈춘 상태에서도 커넥션과 time-wait 스레드는 늘었지만 병목으로 이어지지 않았습니다.

![소비 중단 상태에서도 커넥션 수가 늘어난 그래프](@/assets/images/queue-based-concurrency-testing/147.png)

![소비 중단 상태의 스레드 상태 그래프](@/assets/images/queue-based-concurrency-testing/148.png)

오히려 응답 시간이 요동칠 때 커넥션을 늘려 상태를 안정시키는 쪽으로 동작했습니다. 요청이 줄면 기본 커넥션 수로 돌아갔습니다.

![응답 시간이 요동치는 순간 커넥션을 늘려 안정화되는 그래프](@/assets/images/queue-based-concurrency-testing/149.png)

![요청 감소 후 기본 커넥션 수로 복귀한 그래프](@/assets/images/queue-based-concurrency-testing/150.png)

### 판단

레디스는 단일 작업자 기반 순차 처리라서 리소스 대비 성능이 낮았습니다. 읽기-쓰기는 빨라도 요청이 몰리면 취약합니다. 생산과 소비를 한 작업자가 처리하는 구조 그대로는 생산자 소비자 패턴의 버퍼로 쓰기 부적합하다고 판단했습니다.

## 3단계 : 기술 비교 부하 테스트

request-reply 패턴으로 구성을 통일해 비교했습니다. producer-consumer로 동시성을 제어하고, publisher-subscriber로 처리 결과를 요청자에게 돌려줍니다.

![Redis Streams와 pub/sub을 조합한 request-reply 전체 구조](@/assets/images/queue-based-concurrency-testing/179.png)

![RabbitMQ direct-reply-to를 사용한 request-reply 전체 구조](@/assets/images/queue-based-concurrency-testing/180.png)

### 비교 전 튜닝 — 같은 조건을 만들기까지

각 방식의 성능은 구성에 따라 크게 달라져서, 본 비교 전에 구성별 차이를 먼저 측정했습니다.

**MVC vs WebFlux (Redis Streams 생산자 측)**

MVC는 요청마다 대기 스레드와 레디스 커넥션이 늘어납니다. WebFlux로 바꾸면 대기 스레드와 커넥션을 줄이고 자원을 효율적으로 분배합니다.

| Metric                   |    MVC | WebFlux |
| ------------------------ | -----: | ------: |
| 레디스 커넥션 수         |     71 |      31 |
| JVM timed-waiting 스레드 |    197 |      10 |
| 평균 응답 시간           | 5.28ms |  1.55ms |
| 최대 응답 시간           |  268ms |  62.1ms |

| MVC                                                                                                        | WebFlux                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ![MVC 구성의 k6 대시보드, 평균 5.28ms 최대 268ms](@/assets/images/queue-based-concurrency-testing/153.png) | ![WebFlux 구성의 k6 대시보드, 평균 1.55ms 최대 62.1ms](@/assets/images/queue-based-concurrency-testing/154.png) |
| ![MVC 구성의 레디스 커넥션 71개](@/assets/images/queue-based-concurrency-testing/151.png)                  | ![WebFlux 구성의 레디스 커넥션 31개](@/assets/images/queue-based-concurrency-testing/155.png)                   |
| ![MVC 구성의 timed-waiting 스레드 197개](@/assets/images/queue-based-concurrency-testing/152.png)          | ![WebFlux 구성의 timed-waiting 스레드 10개](@/assets/images/queue-based-concurrency-testing/156.png)            |

**소비자 배치 크기 1 vs 300**

소비자가 한 번에 처리하는 작업 수를 1에서 300으로 늘리면 평균 응답 시간이 7.87s에서 0.55s로, 최대 응답 시간이 10.7s에서 7.60s로 줄었습니다.

| 처리 작업 수 1                                                                                         | 처리 작업 수 300                                                                                         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| ![배치 크기 1의 부하 테스트 결과, 평균 7.87s](@/assets/images/queue-based-concurrency-testing/161.png) | ![배치 크기 300의 부하 테스트 결과, 평균 0.55s](@/assets/images/queue-based-concurrency-testing/162.png) |

**pub/sub 응답 채널 전략**

채널 하나를 공유하면 커넥션 수는 유지되지만 모든 subscriber에게 메시지를 뿌려야 하고, 요청마다 채널을 만들면 커넥션을 열고 닫는 비용이 듭니다. 요청당 채널 생성 방식이 빨랐습니다. 평균 응답 시간이 7.49s에서 0.55s로, 최대 응답 시간이 20.1s에서 7.6s로 줄었습니다. pub/sub 커넥션은 1개에서 35개로 늘고 일반 커넥션은 60개에서 34개로 줄었습니다.

| 하나의 채널 공유                                                                                          | 요청당 채널 생성                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| ![공유 채널 구성의 부하 테스트 결과, 평균 7.49s](@/assets/images/queue-based-concurrency-testing/157.png) | ![요청당 채널 구성의 부하 테스트 결과, 평균 0.55s](@/assets/images/queue-based-concurrency-testing/159.png) |
| ![공유 채널 구성의 레디스 커넥션 분포](@/assets/images/queue-based-concurrency-testing/158.png)           | ![요청당 채널 구성의 레디스 커넥션 분포](@/assets/images/queue-based-concurrency-testing/160.png)           |

**RabbitMQ Sync vs Async Template**

`AsyncRabbitTemplate`은 `CompletableFuture`로 블로킹을 줄입니다. 평균 응답 시간이 2.37s에서 2.33s로, 최대 응답 시간이 9.16s에서 5.93s로 줄었습니다.

| Sync Rabbit Template                                                                                   | Async Rabbit Template                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| ![Sync Template 부하 테스트 결과, 평균 2.37s](@/assets/images/queue-based-concurrency-testing/169.png) | ![Async Template 부하 테스트 결과, 평균 2.33s](@/assets/images/queue-based-concurrency-testing/171.png) |
| ![Sync Template 스레드 상태 그래프](@/assets/images/queue-based-concurrency-testing/170.png)           | ![Async Template 스레드 상태 그래프](@/assets/images/queue-based-concurrency-testing/172.png)           |

### 시나리오 A : 불특정 다수 거래자

큐 방식은 모든 요청을 순차 처리하므로 병렬 처리가 불가능합니다. 분산락은 제어 영역이 계좌 두 개로 좁아 연관 없는 요청을 병렬로 처리합니다. 그래서 경쟁이 분산되면 분산락이 빠릅니다.

| Redisson Lock                                                                                              | Redis Streams + pub/sub                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ![분산락의 시나리오 A 결과, 평균 0.40s 최대 3.6s](@/assets/images/queue-based-concurrency-testing/167.png) | ![Redis Streams의 시나리오 A 결과, 평균 0.55s 최대 7.6s](@/assets/images/queue-based-concurrency-testing/168.png) |

RabbitMQ도 순차 처리라는 한계는 같습니다. 평균 2.33s로 분산락을 따라가지 못했습니다.

![RabbitMQ의 시나리오 A 결과, 평균 2.33s 최대 5.93s](@/assets/images/queue-based-concurrency-testing/173.png)

### 시나리오 B : 특정 거래자 집중

(발급처 → B), (B → C), (C → 사용처) 순으로 거래해 특정 계좌에 경쟁을 집중시켰습니다. 잔액 계산 레이턴시가 누적되고 특정 데이터 접근 경쟁이 치열해집니다.

분산락은 동시성 제어 영역을 좁혀 레이턴시를 줄이는 방법이라 특정 데이터 경쟁에 취약했습니다. 실패가 258건 발생했습니다. Redis Streams 방식은 모든 요청을 순차 처리하므로 경쟁이 집중돼도 실패 0건에 평균 응답도 절반 이하로 유지했습니다.

| Redisson Lock                                                                                               | Redis Streams + pub/sub                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ![분산락의 시나리오 B 결과, 평균 7.83s 실패 258건](@/assets/images/queue-based-concurrency-testing/163.png) | ![Redis Streams의 시나리오 B 결과, 평균 3.18s 실패 0건](@/assets/images/queue-based-concurrency-testing/165.png) |
| ![분산락의 시나리오 B 상세 메트릭](@/assets/images/queue-based-concurrency-testing/164.png)                 | ![Redis Streams의 시나리오 B 상세 메트릭](@/assets/images/queue-based-concurrency-testing/166.png)               |

RabbitMQ는 실패를 4건으로 줄였지만 평균 응답은 8.57s로 오히려 분산락보다 느렸습니다. 응답을 전달하는 채널 수가 200으로 제한돼 메시지가 일정량을 넘으면 병목이 생겼기 때문입니다. 채널 수를 조정하면 개선 여지가 있습니다.

| RabbitMQ direct-reply-to 결과                                                                               | RabbitMQ direct-reply-to 상세                                                                 |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ![RabbitMQ의 시나리오 B 결과, 평균 8.57s 실패 4건](@/assets/images/queue-based-concurrency-testing/174.png) | ![RabbitMQ의 시나리오 B 상세 메트릭](@/assets/images/queue-based-concurrency-testing/175.png) |

### 예상과 달랐던 것 — 순서 보장 이슈가 재현되지 않은 이유

분산락에서 잠금 순서 이슈가 재현될 줄 알았는데 발생하지 않았습니다. Redisson Lock은 `AsyncSemaphore` 내부의 `ConcurrentLinkedQueue`에 대기 작업을 쌓아 순차적으로 구독시키기 때문에, 단일 인스턴스에서는 순서가 보장됩니다.

```java
public final class AsyncSemaphore {
    private final Queue<CompletableFuture<Void>> listeners = new ConcurrentLinkedQueue<>();

    public CompletableFuture<Void> acquire() {
        CompletableFuture<Void> future = new CompletableFuture<>();
        listeners.add(future);
        tryForkAndRun();
        return future;
    }
}
```

순서 미보장을 확인하려면 멀티 인스턴스로 테스트해야 했습니다. 단일 인스턴스로만 확인해서 의도한 결과가 나오지 않았습니다.

## 가정 : 큐를 늘려 스케일아웃한다면

PoC 코드는 큐 하나를 전제합니다. 큐를 늘리는 순간 어디가 깨지는지, PoC 구현체인 [hello-concurrent-control](https://github.com/this-is-spear/hello-concurrent-control) 저장소를 코드 수준에서 짚어봅니다. 구현은 브랜치별로 나뉘어 있습니다 — [distributed-lock](https://github.com/this-is-spear/hello-concurrent-control/tree/distributed-lock), [redis-streams](https://github.com/this-is-spear/hello-concurrent-control/tree/redis-streams), [rabbitmq](https://github.com/this-is-spear/hello-concurrent-control/tree/rabbitmq). 특히 rabbitmq 브랜치에는 큐 세 개로 샤딩하는 코드가 이미 들어 있어서, 스케일아웃했을 때 생길 문제를 미리 보여주는 표본이 됩니다.

### 라우팅 키 : target으로 나눴는데 잔액 검증은 source에서 한다

rabbitmq 브랜치는 해시로 큐를 고르고, 라우팅 키로 `targetAccount`를 사용합니다.

```kotlin file="config/ShardedMessageService.kt (rabbitmq 브랜치)"
fun sendWithConsistentHashing(key: String, message: PointRequestMessage): CompletableFuture<PointResponseMessage> {
    val queueParameterising = queues.filter { !it.name.startsWith("reply-") }
    val shardIndex = abs(key.hashCode() % queueParameterising.size)
    val queueName = queueParameterising[shardIndex].name
    return asyncRabbitTemplate.convertSendAndReceive(queueName, message)
}
```

```kotlin file="application/internal/SendAndReplyService.kt (rabbitmq 브랜치)"
return Mono.fromFuture {
    shardedMessageService.sendWithConsistentHashing(targetAccount.toString(), requestMessage)
}
```

그런데 소비자가 실행하는 잔액 검증은 `sourceAccount` 기준입니다.

```kotlin file="application/internal/TransactionService.kt"
@Transactional
fun transaction(sourceAccount: AccountSequence, targetAccount: AccountSequence, amount: Point) {
    val pointHistories = aggregateHistoryService.findAccountHistories(sourceAccount)
    if (pointHistories.balance < amount) {
        throw IllegalArgumentException(/* 잔액 부족 */)
    }
    pointTransactionRepository.save(PointTransaction(sourceAccount, targetAccount, amount))
}
```

같은 source 계좌가 서로 다른 target으로 두 건을 보내면 두 메시지는 서로 다른 큐로 갈라지고, 서로 다른 소비자가 동시에 잔액을 읽습니다. 조회와 저장 사이에 락이 없으므로 잔액 100으로 100짜리 거래 두 건이 모두 통과할 수 있습니다. 큐로 직렬화하려던 목적이 라우팅 키 선택 하나로 무너집니다.

거래가 계좌 두 개에 걸치는 한, 어느 한쪽 기준의 라우팅으로는 절반만 지켜집니다. 대응은 세 가지입니다.

1. source 기준으로 라우팅을 바꾸고, target 쪽 갱신은 원자적 연산과 불변식 검증으로 방어한다. 이 코드처럼 target 잔액을 검증하지 않는 정책이라면 가장 싸다.
2. 거래를 출금 메시지(source 큐)와 입금 메시지(target 큐) 2단계로 쪼갠다. 각 단계는 자기 계좌의 큐에서 순차 처리되지만, 중간 실패를 되돌릴 보상 경로가 필요해진다.
3. 두 계좌의 샤드를 모두 잡는다. 본문에서 "구현이 어렵다"고 한 그 방식이고, 샤드 간 데드락 회피까지 필요해서 실익 대비 복잡도가 가장 크다.

### 큐 개수 : 상수로 박힌 큐와 모듈러 해싱의 재배치

큐는 빈으로 하드코딩되어 있습니다. 늘리려면 코드 수정과 재배포가 필요합니다.

```kotlin file="config/internal/RabbitmqConfiguration.kt (rabbitmq 브랜치)"
@Bean
fun queue1(): Queue = Queue("queue-1")

@Bean
fun queue2(): Queue = Queue("queue-2")

@Bean
fun queue3(): Queue = Queue("queue-3")
```

더 큰 문제는 해싱입니다. 메서드 이름은 `sendWithConsistentHashing`이지만 구현은 `hashCode % size` 모듈러 해싱이라, 큐를 3개에서 4개로 늘리면 대부분 키의 담당 큐가 바뀝니다. 바뀌는 순간 같은 계좌의 메시지가 옛 큐(잔여분)와 새 큐(신규분)에 동시에 존재하고, 두 소비자가 이를 병렬로 처리하면서 순서가 깨집니다. 위 잔액 경쟁이 큐 개수를 바꿀 때마다 재현되는 셈입니다.

대응은 재배치를 없애는 게 아니라 재배치 순간을 통제하는 것입니다.

- 옛 큐를 드레인(소비 완료)한 뒤 새 매핑으로 전환한다. 전환 중 생산을 잠시 막거나 버퍼링해야 한다.
- 물리 큐보다 많은 논리 버킷(예: 64개)을 처음부터 만들고, 버킷과 큐의 매핑만 옮긴다. 이동 대상 버킷만 드레인하면 되므로 영향 범위가 준다.
- 해시 링(진짜 consistent hashing)을 쓰면 이동하는 키의 비율 자체를 1/N로 줄일 수 있다.

참고로 이 브랜치에는 `shard-exchange`(fanout)에 라우팅 키를 바인딩하는 설정도 있는데, fanout은 라우팅 키를 무시하므로 의미가 없고 실제 발송은 기본 익스체인지로 큐에 직행합니다. 만약 fanout을 실제로 탔다면 모든 샤드에 메시지가 복제되어 거래가 중복 실행됐을 것입니다. 죽은 설정도 스케일아웃 전에는 정리 대상입니다.

### 소비자 : 리스너 하나가 큐 세 개를 전부 소비한다

큐를 셋으로 나눴지만 소비자는 리스너 하나입니다.

```kotlin file="application/internal/ReceiveAndRequestService.kt (rabbitmq 브랜치)"
@RabbitListener(queues = ["queue-1", "queue-2", "queue-3"])
@SendTo("reply-queue")
fun subscribe(pointRequestMessage: PointRequestMessage): PointResponseMessage {
```

기본 설정에서 이 리스너는 컨테이너 하나, 스레드 하나로 세 큐를 순회 소비합니다. 샤딩을 했는데 병렬성은 1 그대로라 스케일아웃 효과가 없습니다. 그렇다고 컨테이너의 `concurrency`를 올리면 같은 큐의 메시지가 여러 스레드에 분배되어 이번에는 큐 안의 순서가 깨집니다. 순서를 지키면서 병렬성을 얻으려면 큐당 컨테이너 1개, 동시성 1로 묶어야 합니다. 즉 "큐 수 = 소비 스레드 수 = 순차 처리 단위 수"가 함께 움직여야 하고, 이 대응이 코드에 없으면 큐만 늘어나고 처리량은 그대로입니다.

redis-streams 브랜치는 소비자 쪽 전제가 더 강합니다.

```kotlin file="transaction/request/ConsumerService.kt (redis-streams 브랜치)"
const val CONSUMER = "point-transaction-consumer"
const val GROUP = "point-transaction-group"
const val STREAM = "point-transaction"
```

스트림도 소비자 이름도 상수입니다. 인스턴스를 두 개 띄우면 둘 다 같은 소비자 이름으로 접속해 레디스 입장에서는 한 명의 소비자가 되고, pending 목록(PEL)의 소유가 뒤섞입니다. 게다가 `neverDelivered`만 읽고 pending 메시지를 회수(`XAUTOCLAIM`)하는 코드가 없어서, 처리 중 인스턴스가 죽으면 그 메시지는 영원히 pending에 남습니다. 요청자는 5초 타임아웃으로 끝나지만 메시지는 유실됩니다. 스케일아웃 이전에 인스턴스 교체(배포)만으로도 밟을 수 있는 지뢰입니다.

### 응답 경로 : 인스턴스를 늘리면 응답이 엉뚱한 곳에 도착한다

rabbitmq 브랜치는 응답 큐 하나를 모든 요청이 공유합니다.

```kotlin file="config/internal/RabbitmqConfiguration.kt (rabbitmq 브랜치)"
fun rabbitTemplate(/* ... */) = RabbitTemplate(connectionFactory).apply {
    setReplyAddress(replyQueue.name) // "reply-queue" 고정
    setUseDirectReplyToContainer(false)
}
```

단일 인스턴스에서는 문제없지만, 인스턴스를 N개로 늘리면 N개의 응답 컨테이너가 같은 `reply-queue`를 라운드로빈으로 소비합니다. A 인스턴스가 보낸 요청의 응답을 B 인스턴스가 집어가면 B에는 대응되는 correlation이 없으므로 응답은 버려지고 A의 요청자는 타임아웃됩니다. 인스턴스별 전용(익명) 응답 큐를 만들거나 direct reply-to로 돌아가야 하는데, direct reply-to는 본문에서 채널 200개 제한으로 병목이 확인된 방식이라 채널 수 설정이 함께 따라와야 합니다.

redis-streams 브랜치는 트랜잭션마다 토픽을 만들어 구독하는 방식이라 어느 인스턴스가 응답을 받을지가 구독 주체로 자연히 결정됩니다. 인스턴스 수와 무관하게 동작하는 대신, 본문 튜닝에서 확인했듯 커넥션 수가 요청량에 비례해 늘어나는 비용을 냅니다.

### 멱등성 : transactionId는 만들지만 아무도 저장하지 않는다

스케일아웃은 재전달과 중복 소비를 전제로 해야 합니다. 그런데 두 브랜치 모두 중복을 판별할 근거가 소비 시점에 없습니다. redis-streams 브랜치는 메시지에 `transactionId`를 담지만, 소비자는 응답에만 쓰고 저장 시점에는 버립니다.

```kotlin
// 메시지에는 있다
class PointTransactionMessage(/* ... */, val transactionId: PointTransactionId)

// 저장에는 없다
pointTransactionRepository.save(PointTransaction(sourceAccount, targetAccount, amount))
```

`transactionId`를 거래 테이블에 unique 제약으로 저장하면, 같은 메시지가 두 번 소비돼도 두 번째 insert가 실패하면서 중복이 막힙니다. 재료는 이미 메시지에 있으므로 가장 싸게 갖출 수 있는 안전장치입니다. 참고로 소비자가 `ack`를 `finally`에서 호출하고 있어 예외가 나도 메시지는 지워집니다. 지금은 실패 응답을 요청자에게 돌려주니 성립하지만, 재시도를 도입하는 순간 ack 위치부터 다시 설계해야 합니다.

### 병목의 정체 : 큐가 아니라 DB 적재가 오래 걸린다

여기까지 라우팅, 재배치, 소비자, 응답, 멱등성을 갖췄다고 가정해도 마지막 관문이 남습니다. 소비자의 처리 시간을 뜯어보면 오래 걸리는 건 동시성 제어(큐 대기)가 아니라 DB 작업입니다.

```kotlin file="application/internal/TransactionService.kt"
@Transactional
fun transaction(sourceAccount: AccountSequence, targetAccount: AccountSequence, amount: Point) {
    // 거래마다 이력을 집계해 잔액을 계산하고
    val pointHistories = aggregateHistoryService.findAccountHistories(sourceAccount)
    if (pointHistories.balance < amount) { /* ... */ }
    // 거래를 적재한다
    pointTransactionRepository.save(PointTransaction(sourceAccount, targetAccount, amount))
}
```

시나리오 B에서 레이턴시가 늘어난 원인도 특정 계좌의 이력이 쌓이면서 잔액 계산과 적재가 느려진 것이지, 큐가 느려진 게 아닙니다. 그래서 큐 샤드를 10개로 늘려 소비자를 10명 만들어도, 10명이 같은 DB 하나에 쓰는 한 쓰기 처리량의 한계는 그대로입니다. 큐 스케일아웃은 병목을 없애는 게 아니라 병목 앞까지의 도로만 넓히는 셈입니다.

우회로는 쓰기 자체를 분산하는 것, 즉 DB 샤딩입니다. 이때 설계의 핵심은 **큐 샤드 키와 DB 샤드 키를 같은 키(계좌)로 정렬시키는 것**입니다. 계좌 A의 메시지가 항상 큐 1로 가고 큐 1의 소비자가 항상 샤드 DB 1에만 쓴다면, 소비자끼리 같은 데이터를 두고 경쟁할 일이 없어 쓰기 처리량이 샤드 수만큼 늘어납니다. 반대로 두 키가 어긋나면 소비자 하나가 여러 샤드에 걸쳐 쓰면서 분산의 이득이 사라집니다.

물론 라우팅 키에서 만난 "계좌 두 개" 문제가 DB에도 똑같이 따라옵니다. source와 target이 서로 다른 샤드에 있으면 한 트랜잭션으로 묶을 수 없으므로, 출금 메시지와 입금 메시지를 나누는 2단계 분리(사가)가 여기서도 같은 답이 됩니다. 잔액 계산도 이력 전체 집계 대신 스냅샷 + 증분 방식으로 바꿔야 이력 누적에 따른 레이턴시 증가를 끊을 수 있습니다.

### 정리 : 스케일아웃 전에 갖춰야 할 여섯 가지

| 항목         | 현재 코드                            | 필요한 대응                             |
| ------------ | ------------------------------------ | --------------------------------------- |
| 라우팅 키    | target 기준, 잔액 검증은 source 기준 | 순서 보장 단위와 라우팅 키를 일치시킨다 |
| 큐 개수 변경 | 하드코딩 + 모듈러 해싱               | 논리 버킷 또는 드레인 후 전환           |
| 소비자 배치  | 리스너 하나가 전체 큐 소비           | 큐당 컨테이너 1개, 동시성 1             |
| 응답 경로    | 공유 reply-queue                     | 인스턴스별 전용 큐 또는 direct reply-to |
| 멱등성       | transactionId 미저장, 실패해도 ack   | unique 제약 + ack 위치 재설계           |
| 쓰기 병목    | 소비자 전원이 단일 DB에 적재         | 큐 샤드 키와 정렬된 DB 샤딩             |

이 중 라우팅과 재배치, 소비자 배치는 카프카로 바꾸면 브로커가 대신해줍니다. 파티션 키가 라우팅을, 컨슈머 그룹 리밸런싱이 배치를 맡습니다. 대신 request-reply 왕복이 카프카에는 부자연스러워서 응답 경로를 재설계(응답용 경량 채널 병행 또는 API 비동기 전환)해야 하고, 멱등성은 어디로 가든 애플리케이션 몫으로 남습니다. 그리고 쓰기 병목은 어떤 브로커를 골라도 해결되지 않습니다. DB가 하나인 한 큐는 대기열의 위치만 옮길 뿐입니다.

## 마무리하며

이 실험은 PoC로 그쳤습니다. 특정 데이터 경쟁에서 실패 258건을 0건으로 줄였지만, 그 구간 하나를 위해 전체 요청의 레이턴시와 인프라 복잡도를 떠안을 이유가 없었습니다. 대신 판단 기준이 남았습니다.

- 동시성 제어의 주안점은 제어 영역을 좁혀 병렬성을 높이는 것입니다. 전 요청 순차 처리는 시스템 성능이 곧 한계가 됩니다.
- 병목은 동시성 제어가 아니라 DB 적재였습니다. 제어 수단(락이냐 큐냐)을 바꾸는 것보다 쓰기를 분산하는 것(큐 샤드 키와 정렬된 DB 샤딩)이 다음 수순입니다.
- 큐 전환의 장점: 특정 데이터에 경쟁이 몰려도 레이턴시가 일정합니다. 임계 영역 안 외부 메서드 호출 위험이 사라집니다.
- 큐 전환의 단점: 경쟁이 없으면 분산락이 월등히 빠릅니다. 계좌 두 개 단위로 순차 처리를 좁히면 두 장점을 모두 챙길 수 있지만 구현이 어렵습니다.
- 메시지 브로커를 도입하면 실패 지점이 늘어납니다. 메시지 미전송, 전송 후 미처리, 처리 후 응답 유실, 응답 타임아웃 각각에 재확인 또는 롤백 경로가 필요합니다.
