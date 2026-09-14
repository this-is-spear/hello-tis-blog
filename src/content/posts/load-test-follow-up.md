---
title: "[26.09.14] 30시간 soak test와 Splunk 통계 수집 일원화"
description: 30시간 soak test를 마무리하고, FireLens로 Splunk 통계 수집을 일원화하는 PoC를 진행하고 있습니다.
pubDatetime: 2026-09-14T00:00:00Z
tags:
  - Scratchpad
---

[지난 부하테스트](/posts/load-test-database-pool-sizing)에서 DB 풀과 서버 CPU, 태스크 수를 조정했습니다. 같은 설정으로 30시간 soak test를 진행하며 HTTP 응답 시간과 JVM 상태를 확인했습니다.

![30시간 soak test의 HTTP 응답 시간: max·p95·p90·min](@/assets/images/load-test-follow-up/reference-http-duration.png)

일부 요청에서 순간적인 지연이 있었지만, 그래프의 구간별 p90·p95는 대부분 16ms 아래를 유지했습니다. **30시간 동안 JVM 메모리 누수는 관찰되지 않았고, HTTP 응답 시간도 전반적으로 일정했습니다.** 이 결과로 이번 부하테스트를 마무리했습니다.

## Splunk 통계 수집 일원화

Splunk 통계 수집 방식이 서비스마다 다릅니다. API로 보내기도 하고 UF를 사용하기도 합니다. 인프라팀에서는 중간 경로가 많아 관리하기 어렵다는 피드백을 줬습니다.

수집 방식을 일원화하기 위해 ECS의 FireLens를 적용하는 PoC를 진행하고 있습니다. 콘솔 로그를 모아 `logtype`에 따라 목적지를 나누는 방식입니다. 애플리케이션과 Fluent Bit이 각각 어디까지 처리해야 확장하기 쉬울지 고민하고 있습니다.

### CloudWatch 유지

기존 서비스의 동작을 유지하면서 통계 수집 방식을 추가하는 것이 목표입니다. 일반 로그는 계속 CloudWatch로 보내고, 통계 이벤트는 Splunk로 보내기로 했습니다.

![일반 로그는 CONSOLE과 OTEL로, 통계 이벤트는 CONSOLE_RAW로 출력합니다. Fluent Bit은 콘솔 로그를 logtype에 따라 CloudWatch와 Splunk HEC로 보냅니다.](@/assets/images/load-test-follow-up/log-routing.svg)

Logback은 로그의 출력 경로를 정하고, FireLens의 Fluent Bit은 콘솔 로그의 목적지를 나눕니다. OTEL은 별도 경로로 보냅니다.

### Logback 출력 설정

`console-log.xml`과 `otel-log.xml`에서 appender를 정의하고, `click-log.xml`과 `transaction-log.xml`에서 로거별 출력 경로를 정했습니다. root 로거에는 CONSOLE과 OTEL을 연결했습니다.

통계 이벤트의 전용 로거에는 `CONSOLE_RAW`만 연결했습니다. [`additivity="false"`](https://logback.qos.ch/manual/architecture.html#AppenderAdditivity)로 상위 로거로의 전달을 끊어 콘솔 중복 출력과 OTEL 전송을 막았습니다.

`click-log.xml`의 설정입니다.

```xml file="click-log.xml"
<included>
    <logger name="CLICK_LOGGER" level="INFO" additivity="false">
        <appender-ref ref="CONSOLE_RAW"/>
    </logger>
</included>
```

PoC에서는 통계 이벤트가 한 줄의 JSON으로 출력되고, `logtype`이 최상위 필드에 들어가는지 확인하려고 합니다.

### Fluent Bit 분기 설정

Fluent Bit은 콘솔 로그의 `logtype`을 읽고, `rewrite_tag` 필터로 목적지를 나눕니다. `logtype=splunk`인 로그에는 `altools.splunk` 태그를 붙여 Splunk HEC로 보내고, 나머지는 기존 FireLens 태그를 유지해 CloudWatch로 보냅니다.

```text file="fluent-bit.conf"
[FILTER]
    Name         rewrite_tag
    Match        *-firelens-*
    Rule         $logtype ^splunk$ altools.splunk false
    Emitter_Name altools_splunk_emitter
```

마지막 `false`는 [기존 태그의 로그를 남기지 않는 설정](https://docs.fluentbit.io/manual/data-pipeline/filters/rewrite-tag)으로, Splunk로 분기한 로그가 CloudWatch에도 전송되는 것을 막습니다. `logtype`이 없는 로그도 CloudWatch로 보냅니다.

### 애플리케이션과 Fluent Bit의 역할

현재 `logtype`의 `system`은 로그 종류를, `splunk`는 목적지를 뜻합니다. 목적지가 늘어나면 이 기준도 다시 정해야 할 것 같습니다.

애플리케이션은 로그 종류와 내용을 정하고, Fluent Bit은 목적지와 전송 형식을 정하는 구조를 생각하고 있습니다. 목적지를 추가할 때 애플리케이션 코드를 얼마나 바꿔야 하는지로 추상화 수준을 판단하려고 합니다.

현재 `Splunk_Send_Raw On` 설정은 [`event`를 포함한 HEC 형식을 그대로 전송합니다](https://docs.fluentbit.io/manual/data-pipeline/outputs/splunk). 애플리케이션이 이 형식을 만들고 있다면, 변환을 Fluent Bit에 맡길지 검토하려고 합니다. 콘솔 출력에 추가된 필드까지 포함해 최종 HEC 요청도 확인해야 합니다.

### 버퍼와 전송 실패

Splunk 통신 실패와 태스크 종료 때 로그가 얼마나 쌓이고 유실되는지 확인하려고 합니다.

- **재시도:** `Retry_Limit 5`로 설정했습니다. 전송 단위인 청크가 [재시도 한도를 소진하면 기본적으로 폐기될 수 있습니다](https://docs.fluentbit.io/manual/administration/scheduling-and-retries).
- **버퍼:** `rewrite_tag`의 emitter는 기본적으로 10M 한도의 메모리 버퍼를 씁니다. 한도에 도달하면 [로그 처리가 멈출 수 있습니다](https://docs.fluentbit.io/manual/data-pipeline/filters/rewrite-tag). Splunk 전송 지연이 CloudWatch 전송에도 영향을 주는지 확인해야 합니다.
- **종료:** 메모리에 남은 로그는 프로세스 종료 때 유실될 수 있습니다. `Grace 30`의 종료 대기 시간과 ECS 종료 시간 안에 버퍼의 로그를 전송할 수 있는지 확인하려고 합니다.

통신 실패·복구와 태스크 종료를 재현해 유실·중복 여부를 확인할 계획입니다. 기존 CloudWatch 수집에 미치는 영향까지 보고 공통 적용 여부를 결정하려고 합니다.

### 공통 설정과 서비스별 설정

Fluent Bit 저장소를 만들어 이미지와 설정을 관리하려고 합니다. 먼저 서비스별 설정을 모아 공통으로 쓸 부분과 서비스별로 바꿀 부분을 나눌 계획입니다.

| 항목      | 공통 설정 후보                  | 서비스별 설정 후보                             |
| --------- | ------------------------------- | ---------------------------------------------- |
| 로그 형식 | 로그 종류·발생 시각·이벤트 ID   | 이벤트 내용·추가 필드                          |
| 로그 처리 | 파싱·분기·파싱 실패 처리        | 파서·필드 변환                                 |
| 전송      | CloudWatch·Splunk 연결 방식     | 로그 그룹·스트림·인덱스·sourcetype·비밀값 참조 |
| 실패 처리 | 버퍼·재시도·종료 기본값         | 로그량·유실 허용 범위에 따른 조정              |
| 배포      | 이미지 버전 관리·공통 확인 항목 | 적용 시점·사용 버전                            |

이 목록을 바탕으로 **공통 기본값, 서비스별로 바꿀 수 있는 범위, 예외 허용 기준**을 정하려고 합니다. 여러 서비스에 필요한 설정은 공통으로 관리하고, 한 서비스에만 필요한 설정은 분리할 생각입니다.

한 서비스부터 적용해 기존 CloudWatch 수집과 새 Splunk 수집을 확인한 뒤, 차이와 예외를 정리하며 적용 대상을 늘려가겠습니다.
