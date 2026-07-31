---
title: 토스 고양이 키우기를 참고한 게이미피케이션 PoC
description: 게이미피케이션 적용을 시도하며 Event Sourcing과 CQRS, 이벤트 기반 모듈 분리의 필요성을 배운 PoC 기록입니다.
pubDatetime: 2025-12-30T12:34:38Z
tags:
  - Product
---

## 개요

리워드를 제공하는 포인트 앱에 게이미피케이션을 적용해 사용자의 참여를 높일 수 있지 않을까 해서 PoC를 진행했다. 결과적으로 제품 적용에는 실패했지만, 그 과정에서 Event Sourcing과 CQRS 패턴의 필요성, 모듈 간 결합도를 낮추는 설계의 중요성을 체감할 수 있었다.

- 코드: [hello-point-gamification](https://github.com/this-is-spear/hello-point-gamification)

## 게이미피케이션 분석

게이미피케이션을 분석할 때 해당 책을 참고해 기본 원리를 빠르게 학습했다.
![게이미피케이션의 기본 원리를 학습한 참고 서적](@/assets/images/gamification-poc-with-event-sourcing/gamification-book.png)

게임 모델을 정의하면 다음과 같은 특징을 가진다.

1. 게임은 규칙으로 구성된다.
2. 게임의 수행 과정에는 다양하고 측정 가능한 결과물이 발생한다.
3. 게임 결과물에는 서로 다른 가치가 부여된다.
4. 게임은 플레이어의 직접적인 참여와 노력을 요구한다.
5. 플레이어는 게임 결과물에 대한 심리적 애착을 갖는다.
6. 게임은 현실 세계에 대해 협상 가능한 결과를 발생시킨다.

이 기준으로 기존 포인트 앱을 살펴보니 1~4번은 충족했지만, 결과물에 대한 심리적 애착과 협상 가능한 결과에 해당하는 5~6번은 부족했다. 단순히 포인트를 지급하는 데서 그치지 않고 사용자가 결과물에 애착을 갖게 만드는 방법이 필요했다.

| 게임 메커닉스 | 1차 반응 | 2차 반응                     |
| ------------- | -------- | ---------------------------- |
| 점수          | 보상     | 상태, 자아표현, 이타심       |
| 레벨          | 상태     | 자아표현, 성취               |
| 도전          | 성취     | 보상, 상태, 자아표현, 이타심 |
| 가상 재화     | 자기표현 | 보상, 상태                   |
| 순위표        | 경쟁     | 상태, 자아표현, 이타심       |
| 선물, 기부    | 이타심   | 상태, 자아표현               |

### 토스 고양이 키우기 기능 분석

![토스 고양이 키우기의 목표와 미션 구조](@/assets/images/gamification-poc-with-event-sourcing/toss-cat-model.png)

해당 서비스 특징은 다음과 같다.

- `목표 지점`을 결정한다.
- `목표 지점`을 달성하기 위해 `미션`을 수행한다.
- `목표 지점`까지 `미션`을 수행하는 과정을 `고양이 성장`으로 표현한다.

기존 포인트 앱과 같은 점은 다음과 같다.

- `미션`으로 `미션 포인트`를 제공한다.
- `미션 포인트`를 모아 `목표`를 완수한다.

기존 포인트 앱과 다른 점은 다음과 같다.

- `미션 포인트`를 가시적인 형태인 `고양이 키우기`로 이어진다. 미션 결과가 심리적 애착으로 이어진다. (5번 달성)
- 협상 가능한 결과가 존재한다. 원하는 상품을 선택해 목표 지점을 선정한다. (6번 달성)

차이를 분석하면서 포인트를 바로 제공하는 대신, 포인트로 교환할 수 있고 사용자가 애착을 느낄 대상을 제공하는 방식을 고려했다.

## 1 ~ 2 일차: 알 추가, 적립 UI + Event Sourcing 기반 데이터 저장 구현

알 추가와 적립 UI를 만들고 데이터 저장 로직을 구현했다. 이 과정에서 Axon Framework를 활용한 Event Sourcing 패턴을 적용했다.

| 알 추가                                                                                             | 알 깨기                                                                                                  | 알 전부 깨기                                                                                          |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ![게임 세션에 알을 추가하는 화면](@/assets/images/gamification-poc-with-event-sourcing/egg-add.png) | ![알 하나를 깨고 포인트를 얻는 화면](@/assets/images/gamification-poc-with-event-sourcing/egg-break.png) | ![보유한 알을 모두 깨는 화면](@/assets/images/gamification-poc-with-event-sourcing/egg-break-all.png) |

### 시연 영상

<video controls playsinline preload="metadata" aria-label="알 추가와 적립 기능 시연 영상">
  <source src="/media/gamification-poc-with-event-sourcing/egg-demo.m4v" type="video/x-m4v" />
</video>

### 기술 스택: Axon Framework

Event Sourcing과 CQRS를 구현하기 위해 Axon Framework를 선택했다. Axon은 Spring Boot와 자연스럽게 통합되고, Command/Event/Query 메시지 라우팅을 자동화해준다.

### 이벤트 정의

게임 상태 변화를 도메인 이벤트로 정의했다.

- `GameSessionStarted`: 게임 시작 이벤트
- `EggsAcquired`: 알 획득 이벤트
- `EggBroken`: 알 깨기 이벤트 → 포인트 적립으로 이어짐

```kotlin
data class GameSessionStarted(
    val sessionId: String,
    val userId: String,
    val startedAt: Instant
)

data class EggsAcquired(
    val sessionId: String,
    val acquiredCount: Int,
    val source: String
)

data class EggBroken(
    val sessionId: String,
    val pointsEarned: Int
)
```

### Aggregate 설계

세션으로 유지되는 게임이 Aggregate로 선정했다. Aggregate가 유지되는 동안 사용 가능한 알 개수와 포인트가 기록된다.

```kotlin
@Aggregate
class MyGameSession {
    @AggregateIdentifier
    private lateinit var sessionId: String
    private var availableEggs: Int = 0
    private var availablePoints: Int = 0

    @CommandHandler
    fun handle(command: AcquireEggsCommand) {
        AggregateLifecycle.apply(
            EggsAcquired(sessionId, command.count, command.source)
        )
    }

    @EventSourcingHandler
    fun on(event: EggsAcquired) {
        this.availableEggs += event.acquiredCount
    }

    @EventSourcingHandler
    fun on(event: EggBroken) {
        this.availableEggs -= 1
        this.availablePoints += event.pointsEarned
    }
}
```

핵심 어노테이션:

- `@AggregateIdentifier`: Aggregate 인스턴스 식별
- `@CommandHandler`: 커맨드 처리 및 이벤트 발행
- `@EventSourcingHandler`: 이벤트로부터 상태 복원

> Aggregate를 거쳐 알과 포인트 상태가 변경되도록 구현했다.

### Event Store 확인

Axon Server의 Event Store에서 실제 저장된 이벤트를 확인할 수 있다.

![Axon Server Event Store에 순서대로 저장된 이벤트 목록](@/assets/images/gamification-poc-with-event-sourcing/event-store-list.png)
![Aggregate 식별자와 시퀀스 번호를 포함한 이벤트 상세](@/assets/images/gamification-poc-with-event-sourcing/event-store-detail.png)

> 동일한 Aggregate Identifier에 이벤트가 순차적으로 기록된다. Sequence Number가 0부터 증가하며, `GameSessionStarted` → `EggsAcquired` → `EggBroken` 순서로 상태 변화가 추적된다.

## 3 ~ 4 일차: 미션 UI + 미션 API 연결

미션 시작, 진행, 종료 UI와 미션 관련 API 연결 동작을 구현했다. 추가된 API는 다음과 같다.

- 미션 리스트 조회
- 미션 세부 내용 조회
- 미션 시작
- 미션 종료

미션이 종료되면 보상을 제공하도록 하드 코딩했다.

![미션 시작과 진행 상태를 보여주는 사용자 화면](@/assets/images/gamification-poc-with-event-sourcing/mission-ui.png)

### 시연 영상

<video controls playsinline preload="metadata" aria-label="미션 UI와 API 연결 시연 영상">
  <source src="/media/gamification-poc-with-event-sourcing/mission-demo.m4v" type="video/x-m4v" />
</video>

### 여기에서 든 궁금증

첫 번째 궁금증은 보상 처리 위치에 대한 것이다. 완료되면서 보상으로 알 적립을 JS로 구현했다. 만약 포인트로 보상을 제공하고 싶다면 JS에서 변경해야 한다. 맞는 행동처럼 보이지 않는다. 미션이 완료되면 이벤트로 보상하고 싶은 모듈에 전달해야 하는 게 아닐까 생각이 든다.

두 번째 궁금증은 도메인 분리에 대한 것이다. 미션이라는 도메인이 있다. 관리자가 미션을 등록하는 것과 사용자가 시작하는 미션은 엄연히 다르다. 등록한 미션을 가져와 개개인이 사용하는 문제가 있기 때문이다.

둘 사이에 차이점을 만들기 위한 단어가 있을까? 관리자 입장에서 미션을 어떤 단어로 표현할 수 있을까? 사용자 입장에서 미션을 어떤 단어로 표현할 수 있을까?

![관리자 미션과 사용자 미션을 구분하기 위한 도메인 모델 고민](@/assets/images/gamification-poc-with-event-sourcing/mission-domain-question.png)

## 5일차: SSE 방식으로 전환 (Event Driven Architecture 적용)

상태 변경마다 게임 정보 API를 호출하는 로직을 SSE 방식으로 전환했다.

### 문제 상황: 모듈 간 강결합

다른 모듈 간 상태를 호출해야 하는 문제가 있었다. `미션 보상 후 알 적립`, `알 깨기 후 포인트 적립` 기능은 다른 모듈 정보에 접근해서 상태 변경 코드를 호출해야 했다.

- Mission: 미션 정보가 포함된다.
- Egg: 알 정보가 포함된다.
- Point: 포인트 정보가 포함된다.

두 클래스 간 결합력이 생기게 된다.

| 알 깨기 후 포인트 적립 상황                                                                                                   | 미션 완료 후 알 적립 상황                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| ![알 깨기 이후 포인트 모듈을 직접 호출하는 구조](@/assets/images/gamification-poc-with-event-sourcing/egg-point-coupling.png) | ![미션 완료 이후 알 모듈을 직접 호출하는 구조](@/assets/images/gamification-poc-with-event-sourcing/mission-egg-coupling.png) |

### 문제 분석

`미션 클래스`와 `알 클래스`가 연결되면서 자바스크립트가 실행 흐름을 가지게 됐다고 판단했다. 실행 흐름은 클래스 간 결합력을 만들어낸다. 결합력이 많아지면 코드 관리가 어려워진다.

AS-IS 코드의 문제점:

```javascript
async function completeMission(missionId) {
  await missionService.complete(missionId);
  // 미션 모듈이 알 모듈을 직접 알아야 함 (강결합)
  await eggService.acquire(3, "MISSION_REWARD");
}
```

### 해결: Axon Event Handler를 활용한 느슨한 결합

SSE와 Axon의 `@EventHandler`를 이용해 상태 변경을 외부로 추출했다.

```kotlin
// Mission 모듈: 미션 완료 이벤트만 발행
@Aggregate
class Mission {
    @CommandHandler
    fun handle(command: CompleteMissionCommand) {
        AggregateLifecycle.apply(
            MissionCompleted(command.missionId, command.userId)
        )
    }
}

// Egg 모듈: 미션 완료 이벤트를 구독하여 독립적으로 처리
@Component
class EggRewardHandler(private val commandGateway: CommandGateway) {
    @EventHandler
    fun on(event: MissionCompleted) {
        commandGateway.send(
            AcquireEggsCommand(event.userId, 3, "MISSION_REWARD")
        )
    }
}

// Point 모듈: 알 깨기 이벤트를 구독하여 독립적으로 처리
@Component
class PointRewardHandler(private val commandGateway: CommandGateway) {
    @EventHandler
    fun on(event: EggBroken) {
        commandGateway.send(
            EarnPointsCommand(event.sessionId, event.pointsEarned)
        )
    }
}
```

### 아키텍처 변화

사례로 `미션 보상 후 알 적립` 과정을 가져왔다. 이전에는 미션에서 알 상태 변화를 알려줘야 했고 그로 인해 결합력이 생겼던 문제를 해결했다.

| AS-IS                                                                                                                               | TO-BE                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ![미션 모듈이 알 적립을 직접 호출하는 변경 전 흐름](@/assets/images/gamification-poc-with-event-sourcing/mission-reward-before.png) | ![미션 완료 이벤트를 구독해 알을 적립하는 변경 후 흐름](@/assets/images/gamification-poc-with-event-sourcing/mission-reward-after.png) |

AS-IS 문제점:

- 미션 모듈이 알 모듈을 직접 호출 (의존성 방향: Mission → Egg)
- 보상 종류 변경 시 미션 모듈 수정 필요

TO-BE 개선점:

- 미션 모듈은 "미션 완료" 이벤트만 발행 (의존성 역전)
- 새로운 보상 종류 추가 시 새 EventHandler만 추가

전체 결합도를 해소한 과정이다.

| AS-IS                                                                                                                                  | TO-BE                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ![미션과 알과 포인트 모듈이 직접 연결된 변경 전 구조](@/assets/images/gamification-poc-with-event-sourcing/module-coupling-before.png) | ![도메인 이벤트로 모듈 의존성을 분리한 변경 후 구조](@/assets/images/gamification-poc-with-event-sourcing/module-coupling-after.png) |

### SSE를 통한 실시간 상태 동기화

```kotlin
@RestController
class GameEventController(private val queryGateway: QueryGateway) {
    @GetMapping("/events/stream", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun streamEvents(@RequestParam sessionId: String): Flux<ServerSentEvent<GameStateDto>> {
        return queryGateway
            .subscriptionQuery(GameStateQuery(sessionId), GameStateDto::class.java, GameStateDto::class.java)
            .updates()
            .map { state -> ServerSentEvent.builder(state).event("game-state-update").build() }
    }
}
```

앞으로 `포인트 사용 기능`, `미션에서 알 적립이 아닌 포인트 적립이 가능하도록 변경`하는 등의 동작에 쉽게 대응 가능해 보인다.

`미션 후 알 적립` 기능을 구현했다면 이후에 `미션 후 포인트 적립`은 어떻게 대응하지? 고민을 했다. 결합력으로 인해 실행 흐름이 하드 코딩돼 있다면 시간 흐름에 따라 변경이 어려워질 수 있음을 경험했다.

> 결합력 제거 또는 책임 분리는 `연관 없는 기능 연결로 인해 코드가 복잡해지는 상황을 예방`하기 위함임을 경험한 하루다.

## 6일차: 이벤트 설계 고민

미션 진행 과정을 구현했다.

1. 사용자는 등록된 미션을 시작한다.
2. 사용자는 등록된 미션을 완료한다.
3. 사용자는 미션 보상을 받는다.

### 고민 1: 어디까지 이벤트로 기록해야 할까?

미션 등록하는 과정도 이벤트가 필요할까? Event Sourcing에서 이벤트는 비즈니스적으로 의미 있는 상태 변화를 기록해야 한다.

```kotlin
// 이벤트로 기록해야 하는 것
MissionStarted      // 사용자가 미션을 시작함
MissionCompleted    // 사용자가 미션을 완료함

// 이벤트로 기록하지 않아도 되는 것
MissionViewed       // 단순 조회는 상태 변화가 아님
```

### 고민 2: 이벤트 주체자는 누구여야 할까?

사용자가 미션을 진행하고 종료하는 과정을 하나의 이벤트에 기록해야 할까? Aggregate 경계를 기준으로 결정해야 한다.

```kotlin
// Bad: 하나의 거대한 이벤트
data class UserActivity(
    val missionStarted: Boolean,
    val eggsAcquired: Int,
    val pointsEarned: Int
)

// Good: Aggregate별로 분리된 이벤트
data class EggsAcquired(val sessionId: String, val count: Int)
data class MissionCompleted(val missionId: String, val userId: String)
```

책에서는 이벤트 당 100개 정도 이루어지니 클러스터링이 쉽게 된다고 했다. 만약 사용자의 전체 행동을 이벤트로 묶는다면 클러스터링이 어려워진다.

## 마무리

게이미피케이션 PoC를 진행하면서 몇 가지 교훈을 얻었다.

### 게이미피케이션 관점

첫째, 게이미피케이션의 핵심은 심리적 애착과 협상 가능한 결과다. 단순히 포인트를 제공하는 것만으로는 부족하다. 사용자가 결과물에 애착을 가질 수 있는 요소(고양이 키우기 같은)와 목표를 스스로 선택할 수 있는 자유가 필요하다.

비즈니스 모델을 만들어 유기적인 흐름을 연결할 수 있다. 대표적으로 아마존의 플라이 휠이 있다.

![아마존 플라이휠의 성장 순환 구조](@/assets/images/gamification-poc-with-event-sourcing/amazon-flywheel.png)

1. 밑지고 최저가에 팔면서 고객을 사로잡는다.
2. 경쟁자들이 나가떨어지면 아마존은 순식간에 시장을 장악한다.
3. 번 돈을 남김 없이 고객 경험과 신사업 확장에 투자한다.
4. 더 많은 고객을 아마존 생태계 안으로 끌어들인다.
5. 고객이 더 늘어 매출이 커지면 그 돈을 다시 투자한다.
6. 더 많은 고객에게 최저가에 판다.

재방문율을 개선해서 플랫폼 형태로 성장하는 방법을 고민했다. 분업으로 업무 효율도 높일 수 있어 보인다.

![게이미피케이션 고도화를 위한 조직 협업 구조](@/assets/images/gamification-poc-with-event-sourcing/gamification-collaboration.png)

- 디자인팀과 개발팀은 애착 제품을 고도화한다.
- 사업팀과 개발팀은 미션을 다양화한다.

### 기술 아키텍처 관점

둘째, Event Sourcing은 상태 변화의 히스토리를 완벽하게 추적할 수 있게 해준다. Axon Framework의 `@Aggregate`, `@CommandHandler`, `@EventSourcingHandler` 조합으로 비즈니스 로직과 이벤트 발행을 자연스럽게 구현할 수 있었다.

셋째, CQRS 패턴은 읽기와 쓰기를 분리해 각각 최적화할 수 있게 해준다. Command 측은 비즈니스 로직에 집중하고, Query 측은 조회 성능에 집중할 수 있다.

넷째, 모듈 간 결합도를 낮추는 설계가 중요하다. `@EventHandler`를 활용해 도메인 간 의존성을 역전시킴으로써 `미션 → 알 적립`, `알 깨기 → 포인트 적립` 같은 흐름을 유연하게 변경할 수 있게 됐다.

Event Driven Architecture를 활용하면 단계적 확장성까지 노려볼 수 있었다. 내가 목표로 추구했던 구현 과제는 다음과 같다.

![이벤트 기반 아키텍처로 확장하려는 전체 기능 구조](@/assets/images/gamification-poc-with-event-sourcing/event-driven-expansion.png)

그 중 `상품 베타테스터` 기능을 추가한다고 가정하자. 기존 강결합 구조였다면 미션, 알, 포인트, 상품 모듈을 모두 수정해야 한다. 하지만 이벤트 기반 구조에서는:

![상품 베타테스터 기능을 이벤트로 연결한 확장 구조](@/assets/images/gamification-poc-with-event-sourcing/product-tester-expansion.png)

- `상품 베타테스터 완료` 이벤트 발행
- 기존 `EggRewardHandler`가 해당 이벤트 구독 → 알 지급
- 기존 `PointRewardHandler`가 알 깨기 이벤트 구독 → 포인트 지급
- 새로운 `ProductPurchaseHandler` 추가 → 상품 구매 미션 연결

각 모듈은 자신이 관심 있는 이벤트만 구독하면 되므로, 기존 코드 수정 없이 새로운 기능을 연결할 수 있다.

### 도메인 설계 관점

다섯째, 도메인 용어 정의가 명확해야 한다. 관리자가 등록하는 미션과 사용자가 진행하는 미션은 다른 개념이다. 이런 차이를 명확히 구분하는 용어가 필요하다.

여섯째, Aggregate 경계 설계가 중요하다. 이벤트 당 적정 규모를 유지해야 클러스터링이 용이하고, 사용자의 전체 행동을 하나의 이벤트로 묶으면 관리가 어려워진다.

결과적으로 이번 PoC는 적용에 실패했지만, Event Sourcing과 CQRS의 실제 적용 경험, 그리고 Axon Framework를 활용한 구현 방법을 체득할 수 있었다.
