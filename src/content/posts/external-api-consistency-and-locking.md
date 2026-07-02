---
title: 외부 API 연동의 정합성, 분산락, 그리고 테스트 전략
description: 포인트 전환 시스템을 개선하며 겪은 정합성, 보상 트랜잭션, 분산락 점유 시간 문제와 해결 과정을 정리한 기록입니다.
pubDatetime: 2025-09-01T00:00:00Z
tags:
  - Product
---

외부 API와 연동하는 시스템을 개발하다 보면 예상치 못한 문제들을 만나게 됩니다. 이번 포인트 전환 시스템 개선 과정에서 겪은 세 가지 주요 문제와 해결 과정을 공유합니다.

### 안건 1 : 외부 API 호출은 성공, 그런데 포인트는 차감되지 않았다?

#### 문제 1 : 검증 오류로 발생한 정합성 오류
고객 포인트가 외부 시스템으로 전환되었지만, 차감되지 않는 문제가 발생했습니다. 최근 차감 기능을 응집시키면서 실행 순서가 바뀌면서 오류가 발생하기 시작했습니다.

| ASIS                                 | TOBE (문제 상황)                         |
| ------------------------------------ | ------------------------------------ |
| ![ASIS 포인트 전환 흐름도](/posts/external-api-consistency-and-locking/fig-01.png) | ![TOBE 문제 상황의 포인트 전환 흐름도](/posts/external-api-consistency-and-locking/fig-02.png) |

실제로는 아래처럼 외부 시스템과 불일치 상태 시나리오가 발생했습니다:

1. 외부 API 호출  ✅
2. 잔액 검증 (실패) ❌
3. 잔액 부족 예외 발생 ❌

#### 원인 및 해결 1 : 테스트는 녹색이었는데, 왜?

**ASIS**
테스트는 예외가 발생한 사실만 확인했을 뿐, 리팩토링 이후 부작용을 검증하지 않았습니다.
```kotlin
@Test  
fun `현재 포인트보다 큰 포인트 전환 요청이면 실패한다`() {
    every { 제휴사포인트_서비스.전환요청(/* ... */) } returns apiResult
	
    assertThrows(교환예외::class.java) {  
        제휴사포인트_유스케이스.포인트전환(/* ... */)  
    } 
}
```

**TOBE**
핫픽스하면서 외부 API 호출 여부를 판단하는 검증 로직도 함께 추가하게 됐습니다.
```kotlin
@Test  
fun `현재 포인트보다 큰 포인트 전환 요청이면 실패한다`() {
    every { 제휴사포인트_서비스.전환요청(/* ... */) } returns apiResult
	
    assertThrows(교환예외::class.java) {  
        제휴사포인트_유스케이스.포인트전환(/* ... */)  
    } 
    
    // ✅ 예외 발생 후 호출되지 않아야 할 서비스들을 명시적으로 검증  
    assertAll(   
        { verify { 제휴사전환이력.전환이력요청(/*...*/) wasNot Called } },  
        { verify { 제휴사전환이력.전환이력완료(/*...*/) wasNot Called } },  
        { verify { 제휴사전환이력.전환이력실패(/*...*/) wasNot Called } },  
        { verify { 제휴사포인트_서비스.전환요청(/*...*/) wasNot Called } },  
        { verify { 포인트서비스.포인트차감(/*...*/) wasNot Called } },  
    )
}
```

#### 결과1 : 일어나지 말아야 할 일을 체크하기.
테스트의 침묵은 정상 동작을 의미하지 않습니다. 명시적으로 검증하지 않은 곳은 언제든 문제가 발생할 수 있습니다. 이번 경험을 통해 일어나야 할 일과 일어나지 말아야 할 일을 체크해야 함을 경험하게 됐습니다.

- 무엇이 일어났는가 (예외 발생, 반환값 확인)
- 무엇이 일어나지 말아야 하는가 (외부 API 미호출)

위 상황에 맞게 상태 검증을 할지 행위 검증을 할지 결정할 필요성을 알게 됐습니다.

#### 딥다이브1 : 행위 검증 여부를 판단하자.
이번 일을 계기로 변화하는 코드에서도 안정적으로 개발하는 방법에 대해서 고려하게 됐습니다. 우려되는 건 **작성된 테스트가 잘 관리가 될지** 또는 **유사한 문제가 발생하진 않을지** 걱정되서 어떤 고민을 하면 더 좋을지 분석해보기로 했습니다.

- 알게된 사실 : 테스트가 통과한다고 시스템이 정상인 것은 아니다
- 공부한 내용
	- **테스트 더블을 사용할 때, 상태 검증(state verification) 또는 행위 검증(behavior verification)이 빠져선 안된다.**
	- **실행 순서가 중요한 경우 Mockito InOrder 등을 활용해 명시적으로 검증해야 한다.**
	- **실행 흐름 파악도 좋지만, 불변식(invariant)을 검증하는 일이 효과적이다.**

**딥다이브 1 : 상태 검증과 행위 검증**

- [상태 검증(state verification)](http://xunitpatterns.com/State%20Verification.html) : SUT의 최종 상태만 중요하고 그 상태에 도달한 과정은 중요하지 않을 때 상태 검증 을 사용합니다.
- [행위 검증(behavior verification)](http://xunitpatterns.com/Behavior%20Verification.html) : SUT 실행 시 최종 상태에서는 드러나지 않는 부작용([indirect outputs](http://xunitpatterns.com/indirect%20output.html))이 중요할 때, _행위 검증_ 을 사용합니다. 하지만, 취약한 테스트([_Fragile Tests_](http://xunitpatterns.com/Fragile%20Test.html))를 생성하지 않도록 주의해야 합니다.

> 최종 상태에 드러나지 않는 부작용을 판단하기 위해서는 행위 검증이 필요합니다.

**딥다이브 2 : 실행 순서 명시적으로 검증하기**
실행 순서가 중요한 경우 명시적으로 검증할 필요가 있었습니다. [Mockito InOrder](https://www.javadoc.io/doc/org.mockito/mockito-core/2.6.9/org/mockito/InOrder.html) 활용해서 동작 순서를 검증할 수 있습니다.

```kotlin
@Test 
fun `현재 포인트보다 큰 포인트 전환 요청이면 실패한다`() {  
    // ...
    // When & Then  
    assertThrows<BaseException> {  
        exchangePointsUseCase.exchangePoint(command)  
    }  
  
    // ✅ 순차적으로 실행여부를 판단  
    inOrder.verify(제휴사포인트_서비스).전환최대한도조회(command.userId)  
    inOrder.verify(포인트_서비스).보유포인트조회(command.userId)  
    // ✅ 이 시점에서 포인트 부족으로 인한 예외가 발생하므로 더 이상의 메서드는 호출되지 않음  
    inOrder.verifyNoMoreInteractions()  
}
```

**딥다이브 3 : 실행 흐름 검증 말고 불변식 검증하기**
실패 시나리오 별 상태 검증 필요합니다. [불변식(invariant) 검증](https://getfoundry.sh/forge/advanced-testing/invariant-testing/) 방식으로 실패 시나리오 상태 검증할 필요가 있습니다.

불변식은 항상 참이어야 하는 조건식입니다. 예를 들어 **모든 포인트 거래에서 이후 총 보유량 = 이전 총 보유량**인 건 포인트 거래에서의 불변식입니다.

```kotlin
// 개선된 테스트
@Test
fun `현재 포인트보다 큰 포인트 전환 요청이면 실패한다`()  {
    every { 제휴사포인트_서비스.전환요청(/* ... */) } returns apiResult
	
    val 이전_보유포인트 = 회원.보유_포인트_조회()
    val 이전_제휴사보유포인트 = 내부_포인트_전환(제휴사포인트_서비스.보유_포인트_조회())
	
    assertThrows(교환예외::class.java) {  
        제휴사포인트_유스케이스.포인트전환(/* ... */)  
    } 
    
    val 이후_보유포인트 = 회원.보유_포인트_조회()
    val 이후_제휴사보유포인트 = 내부_포인트_전환(제휴사포인트_서비스.보유_포인트_조회())

    // ✅ 불변!
    assertThat(이후_보유포인트 + 내부_포인트_전환(이후_제휴사보유포인트))
	    .isEqualTo(이전_보유포인트 + 내부_포인트_전환(이전_제휴사보유포인트));     
}
```

### 안건 2 : 차감되기 전에 전환하면 금전적인 손실을 떠안게 돼요.
[토스ㅣSLASH 24 - 보상 트랜잭션으로 분산 환경에서도 안전하게 환전하기](https://www.youtube.com/watch?v=xpwRTu47fqY) 참고했습니다.​

#### 문제 2 : 이미 사용된 포인트는 되돌릴 수 없다.
차감 요청에서 오류가 발생하면 포인트 전환을 취소하는 보상 조치(Compensating Action)를 수행해야 합니다. 그러나 보상 조치(Compensating Action)를 수행한다고 해서 100% 일관성이 보장되지 않습니다. 방금 전환된 포인트가 사용되면 금전적인 손실을 떠안게 됩니다.

> Compensating Actions can fail. For example, reversing a credit to an account can fail if the account owner withdrew the funds in between. A bank will try to deal with this via collections or moving the account into minus. In the end, though banks do have to write off money due to failed Compensating Actions: using a Compensating Action does not guarantee 100% consistency. - [Compensating Transaction Pattern](https://www.enterpriseintegrationpatterns.com/patterns/conversation/CompensatingAction.html)

#### 원인 및 해결 2 : 가장 되돌리기 어려운 조치를 마지막에 적용하자.

서비스에 대한 보상 조치(Compensating Action)가 없는 경우, 되돌려져야 할 가능성을 최소화하기 위해 **가장 되돌리기 어려운 조치를 마지막에 적용**해야 합니다.

> If no _Compensating Action_ is available for a service, the service consumer should apply PERFORM HARDEST TO REVERT ACTION LAST to minimize the chances that this action has to be reverted. - [Compensating Transaction Pattern](https://www.enterpriseintegrationpatterns.com/patterns/conversation/CompensatingAction.html)

그럼 현재 상황에서 차감 기능으로 보상 트랜잭션을 수행하면 어려운 보상 조치를 수행하지 않아도 됩니다.

| ASIS                                 | TOBE                                 |
| ------------------------------------ | ------------------------------------ |
| ![ASIS 보상 트랜잭션 흐름도](/posts/external-api-consistency-and-locking/fig-04.png) | ![TOBE 보상 트랜잭션 흐름도](/posts/external-api-consistency-and-locking/fig-05.png) |

#### 결과 2

- 외부 API 연동을 대화 패턴([Compensating Transaction Pattern](https://www.enterpriseintegrationpatterns.com/patterns/conversation/CompensatingAction.html))임을 알 수 있었고, 해당 패턴으로 어떻게 대응 방법을 빠르게 파악했습니다.
- 외부 API 연동시 정합성 유지할 수 있는 방법이 필요했습니다. -> 보상 조치 필요
- 외부 API 연동시 순서에 따라 결과가 달라졌습니다. -> 가장 되돌리기 어려운 조치를 마지막에 적용

#### 딥다이브 2 : 다른 회사는 어떻게 대응하고 있을까?

추가적으로 고민해볼 수 있는 내용들

**딥다이브1 : 롤백은 무조건적으로 실행할 수 있는 방법 고민하기**
[토스뱅크- 보상 트랜잭션으로 분산 환경에서도 안전하게 환전하기](https://www.youtube.com/watch?v=xpwRTu47fqY)에서 참고했습니다. 토스뱅크에서는 메시징 방식을 활용해 시스템을 구축했습니다.

- 비동기 방식 : 유저가 기다리지 않아도 된다.
- 메시징 방식 : 결과적 정합성을 보장할 수 있다.

![토스뱅크의 메시징 기반 환전 시스템 구조](/posts/external-api-consistency-and-locking/fig-03.png)

**딥다이브2 : 상태머신을 활용해 연동 API 관리하기**
[G마켓 - 오픈마켓 여행 플랫폼의 실전 API 연동 노하우](https://dev.gmarket.com/115)에서 참고했습니다. G마켓에서는 기능을 두 가지 예시를 보여줬고, 각 방식에 따라 관리 방식을 다르게 했습니다.

- 여행 상품 상세 페이지 API
	- 관리 방법 : 빠른 에러가 반환되도록 타임아웃 설정 및 fallback 방식 고려
	- 대상 예시 : 사용자에게 노출되는 정보 (비행기표 리스트, 비행기표 할인 정보 등등)
- 실시간 예약 API
	- 관리 방법 : 일관된 상태 유지되도록 상태머신 고려
	- 대상 예시 : 이미 일어난 사건 (비행기 표 결제 완료 - 계좌 금액 차감 - 비행기 표 예매)

그 중, 실시간 예약 API가 겪는 사례와 유사해서 추가 정리했습니다. 

상태 머신을 도입하면 어떤 위치에 있는지 이해할 수 있습니다. 시스템은 자신만의 고유한 상태를 지닙니다. 세 개의 시스템은 일관된 상태로 동기화돼야 합니다.
![세 개의 시스템이 일관된 상태로 동기화되는 다이어그램](/posts/external-api-consistency-and-locking/fig-06.png)

시스템을 일관된 상태로 동기화하기 위해 세 가지를 고려하고 있습니다.

- 상태머신 : 상태 머신을 만든다.
- 최종일관성 : 대사 배치를 수행해서 일관된 상태로 유지한다.
- 멱등성 : 네트워크 결함 등 분산 시스템 결험을 해소한다.

[토스뱅크- 보상 트랜잭션으로 분산 환경에서도 안전하게 환전하기](https://www.youtube.com/watch?v=xpwRTu47fqY)에서도 상태머신을 도입했습니다.

![토스뱅크가 도입한 환전 상태머신 다이어그램](/posts/external-api-consistency-and-locking/fig-07.png)

상태 머신은 상태 추적에 탁월합니다. 이벤트 단위로 appending하며 트랜잭션의 상태를 추적할 수 있습니다.

![이벤트 단위로 appending하여 트랜잭션 상태를 추적하는 구조](/posts/external-api-consistency-and-locking/fig-08.png)

### 안건 3. 분산락 점유 시간을 65% 줄이는 방법
[kakao tech카카오페이는 어떻게 수천만 결제를 처리할까? 우아한 결제 분산락 노하우 / if(kakaoAI)2024](https://www.youtube.com/watch?v=4wGTavSyLxE) 참고해서 개선했습니다.

#### 상황 3 : 불필요하게 락을 유지하는 상황
포인트 전환시 분산락이 적용됐습니다. 그 중 락 점유 시간의 65%가 외부 API 호출에 사용되고 있었습니다. 즉, 외부 API 호출을 추출하면 락 점유시간을 65% 감소(192ms -> 67ms) 가능합니다.

- 포인트 전환시 p(95)=193ms 소요됩니다.
	- ![포인트 전환 p95 응답시간 193ms 측정 그래프](/posts/external-api-consistency-and-locking/fig-09.png)
- 그 중 외부 API 호출시 p(95)=126ms 소요되고 있습니다.
	- ![외부 API 호출 p95 응답시간 126ms 측정 그래프](/posts/external-api-consistency-and-locking/fig-10.png)

#### 해결 3 : 동시성 제어 영역 좁히기
이 과정에서 람다 함수를 활용한 새로운 방식을 도입했습니다.

**ASIS**
기존에는 `@DistributedLock` 애너테이션을 메서드 레벨에 적용해서 로직 전체가 락 범위에 포함됐었습니다.

```kotlin
@DistributedLock(key = 사용자_포인트_거래키)
fun 포인트전환(/* ... */) {
    포인트_서비스.차감(/* ... */)
    제휴사포인트_서비스.전환요청(/* ... */)
    포인트_서비스.차감롤백(/* ... */)
}
```

**TOBE**
람다 함수를 활용한 `lockPort.lock()` 방식으로 변경하여 선택적으로 락을 적용이 가능하도록 개선했습니다.

```kotlin
fun 포인트전환(/* ... */) {
    lockPort.lock(사용자_포인트_거래키) {  
        포인트_서비스.차감(/* ... */)
    }
	
    제휴사포인트_서비스.전환요청(/* ... */)
	
    lockPort.lock(사용자_포인트_거래키) {  
        포인트_서비스.차감롤백(/* ... */)
    }
}
```

#### 결과 3 : 성능 향상 기대
불필요한 락 범위를 제거하여 성능 향상을 기대할 수 있습니다.

| ASIS                                 | TOBE                                 |
| ------------------------------------ | ------------------------------------ |
| ![ASIS 락 점유 범위 다이어그램](/posts/external-api-consistency-and-locking/fig-11.png) | ![TOBE 락 점유 범위 다이어그램](/posts/external-api-consistency-and-locking/fig-12.png) |

람다 활용으로 얻은 이점은 다음과 같습니다.

- 첫 번째로, 선택적 동시성 제어입니다. 락이 필요한 구간을 유연하게 조정할 수 있어서 유지보수가 편해졌습니다.
- 두 번째로 필요한 부분에만 락을 적용할 수 있게 됐습니다. 메서드 레벨에서 적용되면 호출마다 락 여부를 판단해야 하는 피로도가 있습니다.

#### 딥다이브 3 : 락 점유 시간 모니터링 해보기
꼭 장점만 있진 않습니다. 다음처럼 장단점이 존재했고, 추가 지표를 수집해서 어떤 문제가 발생할지 예상할 필요가 있었습니다.

- 장점 : 락 점유 시간 감소
- 단점 : 락 획득 횟수 증가 -> 락 경합 증가

즉, 락 점유 시간, 락 경합 지표를 획득할 필요가 있습니다. 다음 숫자로 지표를 수집할 필요가 있었습니다.

- 안정성 : **락 조기 방출률, 락 획득 성공률, 락 획득 실패율 수집**
- 락 점유 시간 : **락 해제 시각 - 락 종료 시각 측정** 
- 락 경합 : **키 별 락 획득 완료 시각 - 키 별 락 획득 시작 시각**

spring boot actuator + micrometer prometheus 활용하면 간단하게 지표를 수집할 수 있습니다. 또한 grafana 로 prometheus 지표를 쉽게 시각화할 수도 있습니다.

| actuator + micrometer 지표 간단 수집      | grafana + prometheus 시각화            |
| ----------------------------------- | ----------------------------------- |
| ![actuator와 micrometer로 수집한 지표 화면](/posts/external-api-consistency-and-locking/fig-13.png) | ![grafana와 prometheus로 시각화한 지표 대시보드](/posts/external-api-consistency-and-locking/fig-14.png) |

**딥다이브 1 : 락 조기 방출률, 락 획득 성공률, 락 획득 실패율 수집**
코드에서 tag 를 활용해 백분율을 계산하도록 구현할 수 있습니다.

```kotlin
val lockCounter = Counter.builder("redisson_lock_acquired_total")  
    .tag("status", "total")  
    .register(Metrics.globalRegistry)  
  
val successCounter = Counter.builder("redisson_lock_acquired_total")  
    .tag("status", "success")  
    .register(Metrics.globalRegistry)
      
val preReleaseCounter = Counter.builder("redisson_lock_acquired_total")  
    .tag("status", "preRelease")  
    .register(Metrics.globalRegistry)
  
val errorCounter = Counter.builder("redisson_lock_acquired_total")
    .tag("status", "error")  
    .register(Metrics.globalRegistry)
```

Grafana 에서 다음처럼 PromQL을 다음처럼 설정하면 원하는 지표로 확인 가능합니다.

```promql
// 락 획득 성공률
(sum(redisson_lock_acquired_total{status="success"})/ sum(redisson_lock_acquired_total{status="total"})) * 100

// 락 조기 방출률
(sum(redisson_lock_acquired_total{status="preRelease"})/ sum(redisson_lock_acquired_total{status="total"})) * 100

// 락 획득 실패율
(sum(redisson_lock_acquired_total{status="error"})/ sum(redisson_lock_acquired_total{status="total"})) * 100
```

그라파나에서는 다음처럼 식별 가능합니다.
![그라파나에서 락 획득 성공률과 조기 방출률을 시각화한 그래프](/posts/external-api-consistency-and-locking/fig-15.png)

**딥다이브 2 : 락 경합 시간 측정하기**
락 획득 완료 시각 - 락 획득 시작 시각 측정했습니다.

``` kotlin
val lockAcquisitionTimer = Timer.builder("redisson_lock_acquisition_seconds")  
    .description("Time spent acquiring distributed lock")  
    .register(Metrics.globalRegistry)
```

다음처럼 측정했습니다.

```kotlin
metrics.lockAcquisitionTimer
	.record(acquisitionEnd - acquisitionStart, TimeUnit.NANOSECONDS)
```

Grafana 에서 다음처럼 PromQL을 다음처럼 설정했습니다.

```promql
rate(redisson_lock_acquisition_seconds_sum[5m]) / rate(redisson_lock_acquisition_seconds_count[5m])
```

![그라파나에서 락 경합 시간을 시각화한 그래프](/posts/external-api-consistency-and-locking/fig-16.png)

**딥다이브 3 : 락 점유 시간 측정하기**
락 해제 시각 - 락 종료 시각 측정했습니다. **히스토그램 활용**하면 p(95) 지표 수집 가능합니다.

```kotlin
val lockDurationTimer = Timer.builder("redisson_lock_duration_seconds")   
    .publishPercentileHistogram()  
    .register(Metrics.globalRegistry)
```

Timer 사용 방법은 동일합니다.

```kotlin
metrics.lockDurationTimer
	.record(holdingEnd - holdingStart, TimeUnit.NANOSECONDS)
```

Grafana 에서 다음처럼 PromQL을 다음처럼 설정했습니다.

```promql
histogram_quantile(0.95, rate(redisson_lock_duration_seconds_bucket[5m]))
```

![그라파나에서 락 점유 시간 p95를 시각화한 그래프](/posts/external-api-consistency-and-locking/fig-17.png)

그러나 애플리케이션 레벨에서 버킷에 데이터를 담고 있기 때문에 메모리 소모가 있어보입니다. 추가로 전송되는 데이터양 또한 많아 오용한다면 네트워크 IO 비용 상승으로 이어질 수 있습니다.

![히스토그램 버킷 데이터로 인한 메모리 소모를 보여주는 화면](/posts/external-api-consistency-and-locking/fig-18.png)
