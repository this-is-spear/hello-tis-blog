---
title: "JVM 네이티브 메모리 추적기: 힙 밖 1.2GB를 추적한 방법"
description: 힙은 정상인데 컨테이너 RSS가 계속 올랐다. NMT, smaps, malloc 프로파일링과 할당자 A/B 테스트로 glibc 단편화까지 좁힌 과정을 정리했다.
pubDatetime: 2026-08-09T00:00:00Z
tags:
  - Operations
draft: true
---

![컨테이너 안에서 정돈된 JVM 메모리 영역 바깥으로 파편화된 네이티브 메모리 블록이 쌓이는 모습](@/assets/images/jvm-native-memory-tracking/jvm-native-memory-tracking-cover.png)

## 개요

운영 중인 JVM 애플리케이션의 힙은 2GB 안에서 정상적으로 움직이는데,
컨테이너 RSS는 3.7GB까지 올라가 4GB limit에 닿았다. 한 인스턴스가
OOMKill로 재시작된 뒤 요청이 남은 인스턴스로 몰렸지만, 다행히 사용자 기능의
성공률은 유지됐다.

처음 발견한 원인은 NIO 임시 다이렉트 버퍼 캐시였다. 설정으로 축적을 막자
재시작 주기는 1일에서 5일로 늘었다. 그러나 RSS와 Native Memory
Tracking(NMT) committed 사이에는 여전히 1.2GB 차이가 남았다.

결론부터 말하면 애플리케이션의 네이티브 메모리 누수는 아니었다. 샘플링한
`malloc`은 거의 전부 `free`됐지만, glibc가 반환받은 메모리를 arena에
보관하면서 실제 물리 메모리인 RSS가 계속 남았다. 같은 이미지와 부하에서
glibc의 격차는 20분 동안 48MB에서 486MB로 늘었고, jemalloc은 약
240~280MB에서 수렴했다.

이 글은 특정 플래그 하나를 정답으로 제시하는 글이 아니다. JVM 메모리
장애에서 힙만 보고 끝내지 않고, 아래 순서로 범위를 좁힌 기록이다.

```text
컨테이너 RSS
  → JVM이 아는 영역: NMT
  → JVM이 모르는 영역: /proc/<pid>/smaps
  → 실제 할당 주체: malloc/free 프로파일링
  → 할당자 특성: glibc vs jemalloc A/B 테스트
```

## 1. 먼저 RSS와 NMT가 무엇을 보는지 나눈다

JVM 프로세스가 쓰는 메모리는 Java 힙 하나로 끝나지 않는다.

```text
프로세스 RSS
  ├─ Java Heap
  ├─ JVM native: GC, Metaspace, Code Cache, Thread Stack, Compiler ...
  ├─ Direct Buffer
  ├─ JNI·네이티브 라이브러리의 malloc
  ├─ C allocator가 보관 중인 free 페이지
  └─ 공유 라이브러리와 파일 매핑
```

NMT는 이 중 HotSpot 내부 할당을 추적한다. JNI나 서드파티 네이티브
라이브러리가 직접 호출한 `malloc`까지 모두 기록하는 도구는 아니다. 따라서
`NMT committed`가 낮다는 사실만으로 “네이티브 메모리는 정상”이라고 결론 내릴
수 없다.

반대로 RSS는 현재 RAM에 올라온 프로세스 페이지를 보는 OS 지표다. NMT의
committed는 JVM 관점의 커밋이고 RSS는 OS 관점의 상주 페이지이므로, 둘을 빼서
정확한 메모리 명세서를 만들 수도 없다. 공유 페이지, 아직 상주하지 않은 커밋
영역, 할당자 캐시 때문에 기준이 다르다.

> [!warning] `RSS - NMT committed`는 정답이 아니라 조사 신호다
>
> 두 값의 격차가 같은 부하에서 계속 커진다면 NMT 밖 영역을 조사할 이유는 된다.
> 그러나 격차 전체를 곧바로 “누수”나 “glibc 단편화”로 이름 붙이면 안 된다.
> 최종 판별은 `/proc/<pid>/smaps`의 주소와 NMT detail 영역을 대조해야 한다.

이번 장애의 첫 스냅샷은 다음과 같았다.

| 지표           |    측정값 | 해석                              |
| -------------- | --------: | --------------------------------- |
| 컨테이너 limit |       4GB | OOMKill 경계                      |
| Java 힙        | 약 2.05GB | 한 파드는 풀커밋, Xmx 안에서 정상 |
| NMT committed  |  약 2.5GB | JVM이 추적하는 전체 커밋          |
| 프로세스 RSS   |  약 3.7GB | limit의 약 93%                    |
| RSS와 NMT 차이 |  약 1.2GB | NMT 밖 조사가 필요한 신호         |

측정 대상은 운영 파드의 Java 프로세스이며, 같은 시점의 값을 비교했다. 이
숫자는 정확히 더해지는 회계값이 아니라 원인을 좁히기 위한 관찰값이다.

## 2. NMT를 켜고 “어느 JVM 영역이 자라는가”부터 본다

NMT는 실행 중에 새로 켤 수 없으므로 프로세스를 시작할 때 활성화해야 한다.
운영에서는 우선 `summary`, 호출 지점까지 필요한 재현 환경에서는 `detail`을
선택한다.

```text
-XX:NativeMemoryTracking=summary
```

```text
-XX:NativeMemoryTracking=detail
```

Oracle 문서는 NMT 활성화 비용을 약 5~10%로 안내한다. 특히 운영에서
`detail`을 상시 사용하기보다, 부하와 오버헤드를 확인한 뒤 필요한 기간에만
쓰는 편이 안전하다.

현재 상태만 한 번 보는 것보다 기준점을 잡고 증가분을 비교하는 방식이 유용했다.

```bash
jcmd 1 VM.native_memory summary scale=MB
jcmd 1 VM.native_memory baseline

# 같은 부하를 재현하거나 일정 시간 기다린 뒤
jcmd 1 VM.native_memory summary.diff scale=MB
```

호출 지점까지 추적해야 한다면 `detail.diff`를 사용한다.

```bash
jcmd 1 VM.native_memory detail.diff scale=MB
```

여기서 먼저 본 것은 `Java Heap`, `Class`, `Thread`, `Code`, `GC`,
`Compiler`, `Other` 중 어떤 카테고리가 RSS와 함께 자라는지였다. 어느 항목도
1.2GB 증가를 설명하지 못했고, 다이렉트 버퍼도 JMX `BufferPoolMXBean`과 NMT
`Other`를 교차 확인했을 때 약 40MB뿐이었다.

NMT가 용의자를 보여주지 못한 사실도 결과다. 이제 JVM 내부가 아니라 OS의
메모리 매핑과 네이티브 할당자를 볼 차례다.

## 3. 다이렉트 버퍼처럼 “이미 잡힌 원인”을 먼저 분리한다

NMT 밖을 조사하기 전에, 별도 지표로 확인할 수 있는 다이렉트 버퍼부터
배제했다. 이 장애에서는 `MultipartFile#getBytes()`가 PDF를 읽는 과정에서
NIO 임시 다이렉트 버퍼를 만들고 있었다.

```text
PdfService.chat()
 └ StandardMultipartFile.getBytes()
   └ ChannelInputStream.readAllBytes()
     └ FileChannelImpl.read(힙 버퍼)
       └ IOUtil.read
         └ Util.getTemporaryDirectBuffer
           └ Bits.reserveMemory
```

힙 배열로 파일 읽기를 요청해도 NIO는 커널 I/O를 위해 같은 크기의 임시
다이렉트 버퍼를 경유한다. 사용이 끝난 큰 버퍼가 워커 스레드의 로컬 캐시에
남으면서, `워커 스레드 수 × 각 스레드가 읽어본 최대 파일 크기`에 가까운
메모리가 계단식으로 쌓였다.

![NIO 임시 다이렉트 버퍼의 capacity가 요청을 처리할수록 계단식으로 300MB까지 증가하는 그래프](@/assets/images/2026-july-week3-review/direct-buffer-rising.png)

테스트에서 `MaxDirectMemorySize`를 50MB로 낮춰 같은 OOM을 재현했고, 큰 임시
버퍼가 캐시에 남지 않도록 제한했다.

```text
-Djdk.nio.maxCachedBufferSize=262144
```

적용 뒤 다이렉트 버퍼의 우상향은 멈췄다.

![maxCachedBufferSize 적용 후 direct 버퍼 capacity가 더 이상 증가하지 않고 평평해진 그래프](@/assets/images/2026-july-week3-review/direct-buffer-capped.png)

이 조치에는 큰 파일을 읽을 때마다 버퍼를 다시 할당하고 해제하는 비용이 있다.
또한 파일을 통째로 읽는 동작 자체를 없애지는 않으므로, 스트리밍 전환이 근본
해결책이다. 중요한 점은 이 원인을 분리한 뒤에도 RSS가 올랐다는 것이다.

## 4. `/proc/<pid>/smaps`로 NMT 밖의 주소를 찾는다

Linux의 `/proc/<pid>/smaps`는 프로세스의 각 가상 메모리 매핑과 그 안에서
실제로 상주하는 `Rss`, 익명 메모리인 `Anonymous`, private dirty 페이지 등을
보여준다. 합계만 빠르게 볼 때는 `smaps_rollup`, 어떤 주소가 자랐는지 볼 때는
`smaps` 원문이나 `pmap -x`가 필요하다.

```bash
grep -E 'VmRSS|VmSize|RssAnon|RssFile' /proc/1/status
cat /proc/1/smaps_rollup
pmap -x 1
```

이번에는 NMT detail의 주소 범위와 부하 전후 `smaps`를 대조했다. 로컬 Docker
실험에서 RSS는 1,074MB 증가했다.

| 증가 영역         | 증가량 | 판정               |
| ----------------- | -----: | ------------------ |
| Java 힙           | +815MB | Xmx 이내 정상 증가 |
| GC·Metaspace·Code |  +33MB | JVM 내부 정상 증가 |
| NMT 밖 익명 영역  | +225MB | 추가 조사 대상     |

NMT 밖 증가분 225MB 중 223MB는 64MB 경계에 정렬된 익명 매핑 78개에
흩어져 있었다. glibc가 멀티스레드 할당을 위해 만든 arena의 서브힙과 같은
배치였다.

운영에서도 `jcmd 1 System.trim_native_heap` 전후의 매핑을 비교했다. 이 명령은
Linux에서 C heap을 trim해 반환 가능한 페이지를 OS에 돌려보내려 시도한다.

```text
0x7a07e8000000   65516K rw   RSS      8K    (trim 전 RSS 65,516K)
0x7a0850000000   65536K rw   RSS 17,592K    (trim 전 RSS 65,536K)
```

두 파드에서 각각 207MB와 96MB가 회수됐고, 두 번째 trim은 거의 아무것도
회수하지 못했다. 즉 1.2GB가 모두 “반환을 기다리던 빈 메모리”라는 첫 가설은
틀렸다. 약 0.2GB만 즉시 회수 가능했고, 나머지는 live 할당 또는 live와 free가
한 페이지에 섞여 반환할 수 없는 영역이었다.

> [!warning] trim을 해결책으로 먼저 쓰지 않는다
>
> `System.trim_native_heap`은 반환 가능한 C heap이 있는지 확인하는 실험으로는
> 유용하다. 하지만 live 할당, 페이지 내부 단편화, 계속 반복되는 잘못된 할당을
> 해결하지 않는다. 지원 플랫폼과 JDK 버전을 확인하고 테스트 환경에서 영향부터
> 검증해야 한다.

## 5. `malloc`과 `free`를 함께 봐야 누수와 잔류를 구분할 수 있다

`smaps`로 glibc arena 형태를 확인했지만, 아직 두 가설이 남았다.

1. 네이티브 라이브러리가 메모리를 할당하고 `free`하지 않는 진짜 누수
2. 애플리케이션은 `free`했지만 glibc가 페이지를 OS에 반환하지 않는 잔류와
   단편화

이를 구분하려고 동일한 애플리케이션 이미지에 malloc/free 인터포지션
프로파일러를 붙였다. 부하 중 60초간 두 호출을 모두 기록하고 주소를 짝지어
미해제분을 계산했다.

| 할당자   | 샘플된 malloc | 샘플 할당량 | 미해제량 |
| -------- | ------------: | ----------: | -------: |
| glibc    |         873건 |       5.2MB |   0.02MB |
| jemalloc |       2,123건 |      12.4MB |   0.06MB |

측정 대상은 같은 Docker 이미지와 같은 부하이며, jemalloc의 프로파일러 자체
버퍼는 제외했다. 샘플 범위 안에서는 애플리케이션 누수를 설명할 만한 미해제가
없었다.

![malloc 호출 스택 대부분이 CompileBroker와 C2 컴파일러에서 시작하고 앱 코드 스택은 보이지 않는 네이티브 메모리 플레임그래프](@/assets/images/2026-august-week1-review/nativemem-flamegraph.png)

할당 스택의 대부분은 `CompileBroker`에서 시작하는 C2 JIT 컴파일 작업이었고,
작업 뒤 전량 해제됐다. NIO 다이렉트 버퍼 live도 6.8KB 한 건뿐이었다. 앞에서
적용한 `maxCachedBufferSize` 제한이 실제로 작동하고 있다는 확인이기도 했다.

여기서 질문이 바뀌었다.

```diff
- NMT 밖 1GB를 누가 계속 할당하고 있나?
+ 앱이 free한 메모리를 glibc는 왜 RSS로 계속 들고 있나?
```

## 6. glibc arena가 RSS를 남기는 구조를 이해한다

glibc의 `free`는 보통 메모리를 곧바로 OS에 돌려주는 동작이 아니다. 다시 들어올
할당에 재사용할 수 있도록 allocator 내부의 빈 공간으로 보관한다. 멀티스레드
경합을 줄이기 위해 여러 arena를 만들면 같은 현상이 arena마다 반복될 수 있다.

특히 한 페이지에 live와 free 조각이 섞이거나, 반환 가능한 연속 영역 위를 작은
live 할당이 막으면 페이지 전체를 반환하지 못한다.

![힙 꼭대기의 작은 live 할당이 아래의 큰 free 공간 반환을 막는 Top Chunk Pinning 도식](@/assets/images/2026-august-week1-review/top-chunk-pinning.svg)

이번 재현에서는 스레드 24개가 크기가 다른 `malloc/free`를 반복하자 RSS가
30초 만에 137MB에서 1,441MB까지 계단식으로 올랐다. 처음에는 arena 수가
원인이라고 보고 `MALLOC_ARENA_MAX=2`를 적용했지만, 이 단순 재현기에서는
오히려 RSS가 44% 증가했다. 할당이 적은 arena에 몰려 arena당 단편화가 더
심해졌기 때문이다.

이 실패 덕분에 중요한 규칙을 얻었다. arena 수를 줄이면 메모리가 무조건
줄어드는 게 아니다. arena를 공유하는 스레드가 늘면 락 경합과 할당 지연도 생길
수 있다. 정석으로 알려진 플래그라도 실제 애플리케이션 부하로 다시 측정해야
한다.

## 7. 할당자만 바꾼 A/B 테스트로 원인을 확정한다

최종 실험은 애플리케이션, 컨테이너 이미지, 메모리 limit, JVM 옵션, 부하를
모두 고정하고 C allocator만 바꿨다.

```text
# glibc 유지
기본 이미지 그대로 실행

# jemalloc 전환
LD_PRELOAD=<path-to-libjemalloc.so.2>
MALLOC_CONF=background_thread:true
```

jemalloc은 크기 등급별 영역을 사용하고, 사용하지 않는 dirty 페이지를 purge할
수 있다. `background_thread:true`를 켜면 내부 작업 스레드가 이 반환을
비동기로 수행한다. 이번 1차 실험에서는 이 설정이 없을 때 부하가 멈춘 뒤에도
메모리 반환이 진행되지 않았다.

![glibc와 달리 jemalloc은 크기 등급별 slab의 빈 페이지를 위치와 무관하게 OS에 반환하는 도식](@/assets/images/2026-august-week1-review/jemalloc-slab-return.svg)

같은 20분 동안 결과는 분명하게 갈렸다.

![glibc의 RSS-NMT 격차는 275MB에서 486MB까지 증가하지만 jemalloc은 240~280MB에서 수렴하는 비교 그래프](@/assets/images/2026-august-week1-review/gap-glibc-vs-jemalloc.svg)

| 지표      |     glibc |         jemalloc |
| --------- | --------: | ---------------: |
| 격차 시작 |      48MB |         약 240MB |
| 격차 종료 |     486MB |         약 245MB |
| 최종 RSS  |   1,835MB |          1,591MB |
| 추세      | 계속 증가 | 일정 범위에 수렴 |

glibc의 peak RSS는 1,881MB로 2GiB limit의 92%까지 올라 운영 OOMKill
사이클을 재현했다. 반면 jemalloc은 기본 보유량이 약 245MB로 더 높았지만,
격차가 계속 누적되지는 않았다. “앱이 free하지 않는다”가 아니라 “할당자가
free된 페이지를 어떤 방식으로 재사용하고 반환하느냐”가 차이를 만들었다.

glibc를 유지하면서 arena 수만 제한한 실제 애플리케이션 부하도 다시 측정했다.

![glibc 기본 격차는 라운드마다 48MB에서 275MB까지 증가하지만 MALLOC_ARENA_MAX=2는 41~75MB에서 움직이는 그래프](@/assets/images/2026-august-week1-review/gap-trend-by-round.svg)

이 부하에서는 `MALLOC_ARENA_MAX=2`만으로 격차가 275MB에서 69MB로 75%
줄었다. trim 관련 설정을 더했을 때는 31MB까지 내려갔다. 같은 플래그가 단순
재현기에서는 RSS를 44% 늘리고 실제 애플리케이션에서는 75% 줄였다는 점이
핵심이다.

![glibc 기본, MALLOC_ARENA_MAX=2, jemalloc 세 구성에서 부하 전후 격차를 비교한 막대그래프](@/assets/images/2026-august-week1-review/gap-before-after-by-config.svg)

## 결과부터 다시 정리하기

원인과 처방을 한 문장으로 섞으면 판단을 그르치기 쉽다. 이번 조사에서 확인한
사실은 세 단계로 나뉜다.

1. **다이렉트 버퍼 축적은 별도 원인이었다.** 제한 적용으로 우상향을 멈췄지만
   전체 RSS 문제는 끝나지 않았다.
2. **NMT 밖 메모리는 앱 누수가 아니었다.** malloc/free 주소 대조에서 미해제는
   샘플 기준 0.1MB 미만이었다.
3. **RSS 누적은 glibc arena의 잔류와 단편화였다.** smaps 주소 배치와 할당자
   A/B 테스트가 같은 결론을 가리켰다.

처방 후보의 트레이드오프는 다음과 같다.

|                         | `MALLOC_ARENA_MAX=2`   | jemalloc 전환                     |
| ----------------------- | ---------------------- | --------------------------------- |
| 이번 실험의 메모리 결과 | 격차 31~69MB           | 약 245MB에서 수렴                 |
| 적용 난이도             | 환경변수 한 줄         | 이미지 변경과 `LD_PRELOAD` 필요   |
| 동시 할당 경합          | arena 공유로 증가 가능 | 다중 arena 설계로 상대적으로 유리 |
| 기본 보유 메모리        | 작음                   | tcache·dirty 페이지로 큼          |
| 운영 판단에 필요한 지표 | RSS와 응답 지연        | RSS와 반환 추세, 이미지 안정성    |

메모리 숫자만 보면 이 실험에서는 튜닝한 glibc가 더 작았다. 하지만 높은
동시성에서 arena 두 개를 여러 워커가 공유할 때의 할당 지연은 아직 확인하지
않았다. 반대로 jemalloc은 낮은 격차보다 “계속 커지지 않는 상한”이 장점이었다.
최종 선택은 운영급 트래픽에서 RSS뿐 아니라 처리량과 응답시간까지 함께 보고
결정해야 한다.

## 다음에도 쓸 네이티브 메모리 진단 순서

비슷한 문제가 다시 생기면 아래 순서로 조사한다.

### 1. 컨테이너와 JVM 지표를 같은 시점에 저장한다

- 컨테이너 working set과 limit
- 프로세스 `VmRSS`, `RssAnon`, `RssFile`
- Java heap committed/used
- NMT summary
- JMX Buffer Pool의 direct/mapped 사용량
- 스레드 수와 스택 크기

### 2. NMT baseline을 먼저 잡는다

문제가 커진 뒤의 한 장보다, 정상 시점과 문제 시점의 `summary.diff`가 더 많은
정보를 준다. NMT 항목이 RSS 증가를 설명하면 해당 JVM 영역부터 판다.

### 3. NMT가 설명하지 못하면 `smaps`로 내려간다

익명 매핑, 파일 매핑, 스레드 스택을 나누고 주소 범위를 NMT detail과
대조한다. 64MB 경계 매핑 같은 패턴만 보고 바로 원인을 확정하지 않고, 부하
전후 증가량과 함께 본다.

### 4. trim은 분류 실험으로만 사용한다

한 번 trim해 크게 줄면 반환 가능한 잔류가 있다는 뜻이다. 두 번째 실행에서
더 줄지 않으면 남은 영역은 live 할당이나 반환 불가능한 단편화로 좁힐 수 있다.

### 5. 할당과 해제를 같은 주소로 맞춘다

할당 스택만 보면 많이 할당하는 정상 작업을 누수로 오해할 수 있다. `malloc`과
`free`를 함께 기록해 미해제량과 RSS 잔류를 분리한다.

### 6. 튜닝 플래그는 실제 워크로드로 A/B 테스트한다

애플리케이션, 이미지, JVM 옵션, limit, 부하를 고정하고 allocator나 플래그
하나만 바꾼다. 결과는 RSS뿐 아니라 처리량, p95/p99 응답시간, CPU까지 함께
비교한다.

## 마무리하며

이번 조사에서 가장 오래 걸린 이유는 도구가 부족해서가 아니었다. 처음 세운
“NMT 밖 1.2GB는 살아있는 네이티브 할당”이라는 설명을 너무 오래 붙들고 있었기
때문이다. 운영 trim으로 0.2GB만 회수된 사실을 보고 나머지를 live 메모리라고
불렀지만, `free` 여부와 OS 반환 여부는 다른 질문이었다.

NMT는 JVM이 아는 범위를 빠르게 좁히는 도구다. NMT가 모르는 영역은
`smaps`로 주소를 확인하고, malloc/free 프로파일링으로 생명주기를 확인하고,
할당자 A/B 테스트로 배치와 반환 정책을 확인해야 했다. 세 관측이 같은 방향을
가리킬 때 비로소 glibc 단편화라고 말할 수 있었다.

다음부터는 정석 처방을 먼저 적용하지 않는다. 5분짜리 배제 목록을 먼저 돌리고,
가설마다 반증 조건을 정한 뒤, 실제 워크로드에서 하나의 변수만 바꿔 측정한다.

## 참고 자료

- [Oracle Java 26: Troubleshoot Memory Leaks](https://docs.oracle.com/en/java/javase/26/troubleshoot/troubleshooting-memory-leaks.html)
- [Oracle Java 24: `jcmd` 명령](https://docs.oracle.com/en/java/javase/24/docs/specs/man/jcmd.html)
- [Linux man-pages: `/proc/<pid>/smaps`](https://man7.org/linux/man-pages/man5/proc_pid_smaps.5.html)
- [GNU C Library: malloc tunable parameters](https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html)
- [jemalloc manual](https://jemalloc.net/jemalloc.3.html)
- [JDK-8325496: `TrimNativeHeapInterval` product switch](https://bugs.openjdk.org/browse/JDK-8325496)
- [관련 기록: 2026년 7월 3주차 회고](/posts/2026-july-week3-review)
- [관련 기록: 2026년 8월 1주차 회고](/posts/2026-august-week1-review)
