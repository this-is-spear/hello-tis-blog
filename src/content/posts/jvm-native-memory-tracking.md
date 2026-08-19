---
title: "JVM 네이티브 메모리 추적기: 힙 밖 1.2GB를 추적한 방법"
description: 힙은 정상인데 컨테이너 RSS가 계속 올랐다. 원인은 누수가 아니라 glibc가 free된 메모리를 보관하는 동작이었다. 장애 기록과 조사 도구의 원리를 정리했다.
pubDatetime: 2026-08-09T00:00:00Z
tags:
  - Operations
---

![컨테이너 안에서 정돈된 JVM 메모리 영역 바깥으로 파편화된 네이티브 메모리 블록이 쌓이는 모습](@/assets/images/jvm-native-memory-tracking/jvm-native-memory-tracking-cover.png)

## 개요

운영 중인 JVM 애플리케이션에서 힙은 정상인데 컨테이너 RSS가 limit까지
오르는 장애를 겪었다. 결론부터 말하면 네이티브 메모리 누수가 아니었다.
애플리케이션은 `free`를 호출했지만, glibc가 그 메모리를 OS에 반환하지 않고
보관하면서 RSS로 남았다.

글은 두 부분으로 나눴다. 앞부분은 장애를 상황, 원인, 문제, 해결, 결과
순서로 정리했다. 뒷부분 딥다이브는 조사에 쓴 도구와 원리를 설명한다.

## 상황

운영 중인 JVM 애플리케이션의 힙은 2GB 안에서 정상적으로 움직이는데,
컨테이너 RSS는 3.7GB까지 올라 4GB limit에 닿았다. 한 인스턴스가 OOMKill로
재시작되면 요청이 남은 인스턴스로 몰렸다. 사용자 기능의 성공률은 유지됐지만
재시작이 반복됐다.

![조치 전 메모리 사용량이 7월 12일 3.44GiB에서 7월 23일 3.63GiB까지 쉬지 않고 올라 4GB limit에 가까워지는 그래프](@/assets/images/jvm-native-memory-tracking/memory-usage-before-fix.png)

장애 당시 측정값은 다음과 같았다.

| 지표           |    측정값 | 해석                              |
| -------------- | --------: | --------------------------------- |
| 컨테이너 limit |       4GB | OOMKill 경계                      |
| Java 힙        | 약 2.05GB | 한 파드는 풀커밋, Xmx 안에서 정상 |
| NMT committed  |  약 2.5GB | JVM이 추적하는 전체 커밋          |
| 프로세스 RSS   |  약 3.7GB | limit의 약 93%                    |
| RSS와 NMT 차이 |  약 1.2GB | NMT 밖을 조사할 이유              |

RSS와 NMT가 각각 무엇을 보는지, 왜 두 값을 빼서 쓰면 안 되는지는
[딥다이브 1](#1-rss와-nmt는-다른-것을-본다)에서 설명한다.

먼저 찾은 원인은 NIO 임시 다이렉트 버퍼였다. `MultipartFile#getBytes()`가
PDF를 읽는 과정에서 임시 다이렉트 버퍼를 만들고 있었다.

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

테스트에서 `MaxDirectMemorySize`를 50MB로 낮춰 같은 OOM을 재현했고, 큰 임시
버퍼가 캐시에 남지 않도록 제한했다.

```text
-Djdk.nio.maxCachedBufferSize=262144
```

| AS-IS: 제한 적용 전                                                                                                                                                | TO-BE: `maxCachedBufferSize` 적용 후                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![NIO 임시 다이렉트 버퍼의 capacity가 요청을 처리할수록 계단식으로 300MB까지 증가하는 그래프](@/assets/images/jvm-native-memory-tracking/direct-buffer-rising.png) | ![maxCachedBufferSize 적용 후 direct 버퍼 capacity가 더 이상 증가하지 않고 평평해진 그래프](@/assets/images/jvm-native-memory-tracking/direct-buffer-capped.png) |
| capacity가 요청을 처리할수록 계단식으로 300MB까지 증가한다.                                                                                                        | capacity가 더 이상 증가하지 않고 평평하게 유지된다.                                                                                                              |

이 조치로 재시작 주기는 1일에서 5일로 늘었다. 컨테이너 메모리 limit도
2GB에서 4GB로 늘리자 주기는 더 길어졌다.

![조치 후 메모리 사용량이 2GiB에서 시작해 2주 동안 2.7GiB까지 완만하게 오르고, 8월 7일 재시작 뒤 같은 모양으로 다시 오르는 그래프](@/assets/images/jvm-native-memory-tracking/memory-usage-after-fix.png)

그래도 RSS는 계속 올라 NMT committed와의 격차 1.2GB가 남았다. 이 글은 그
격차의 원인을 찾은 기록이다.

## 원인

조사는 아래 순서로 범위를 좁혔다.

```text
컨테이너 RSS
  → JVM이 아는 영역: NMT
  → JVM이 모르는 영역: pmap
  → 실제 할당 주체: malloc/free 프로파일링
```

먼저 NMT에서 baseline을 잡고 부하 전후의 diff를 비교했다. `Java Heap`,
`Class`, `Thread`, `Code`, `GC`, `Compiler`, `Other` 중 어느 카테고리도
1.2GB 증가를 설명하지 못했다. 다이렉트 버퍼도 JMX `BufferPoolMXBean`과 NMT
`Other`를 교차 확인했을 때 약 40MB뿐이었다. NMT를 켜고 diff를 잡는 방법은
[딥다이브 2](#2-nmt-사용법)에서 설명한다.

다음으로 부하 전후의 `pmap -x` 출력을 NMT detail의 주소 범위와 대조했다.
로컬 Docker 실험에서 RSS는 1,074MB 증가했다.

| 증가 영역         | 증가량 | 판정               |
| ----------------- | -----: | ------------------ |
| Java 힙           | +815MB | Xmx 이내 정상 증가 |
| GC·Metaspace·Code |  +33MB | JVM 내부 정상 증가 |
| NMT 밖 익명 영역  | +225MB | 추가 조사 대상     |

NMT 밖 증가분 225MB 중 223MB는 64MB 경계에 정렬된 익명 매핑 78개에 흩어져
있었다. glibc가 멀티스레드 할당을 위해 만드는 arena와 같은 배치였다.

운영 파드에서는 `jcmd 1 System.trim_native_heap` 전후의 매핑을 비교했다.
이 명령은 C heap에서 반환 가능한 페이지를 OS에 돌려보내려 시도한다.

```text
0x7a07e8000000   65516K rw   RSS      8K    (trim 전 RSS 65,516K)
0x7a0850000000   65536K rw   RSS 17,592K    (trim 전 RSS 65,536K)
```

- 첫 번째 trim: 두 파드에서 각각 207MB와 96MB 회수
- 두 번째 trim: 거의 회수하지 못함

격차 1.2GB 전체가 반환을 기다리는 빈 메모리라는 가설은 틀렸다. 즉시 반환할
수 있는 메모리는 약 0.2GB뿐이었고, 나머지는 live 할당이거나 live와 free가
한 페이지에 섞여 반환할 수 없는 영역이었다. trim의 용도와 한계는
[딥다이브 3](#3-pmap과-trim-읽는-법)에서 설명한다.

여기까지 보고도 가설이 둘 남았다.

1. 네이티브 라이브러리가 메모리를 할당하고 `free`하지 않는 누수
2. 애플리케이션은 `free`했지만 glibc가 페이지를 OS에 반환하지 않는 보관

둘을 구분하려고 같은 애플리케이션 이미지에 `malloc`과 `free`를 가로채
기록하는 프로파일러를 붙였다. 부하 중 60초간 두 호출을 기록하고 주소를
짝지어 미해제분을 계산했다.

| 할당자   | 샘플된 malloc | 샘플 할당량 | 미해제량 |
| -------- | ------------: | ----------: | -------: |
| glibc    |         873건 |       5.2MB |   0.02MB |
| jemalloc |       2,123건 |      12.4MB |   0.06MB |

미해제는 샘플 기준 0.1MB 미만이었다. 누수 가설도 틀렸다.

![malloc 호출 스택 대부분이 CompileBroker와 C2 컴파일러에서 시작하고 앱 코드 스택은 보이지 않는 네이티브 메모리 플레임그래프](@/assets/images/2026-august-week1-review/nativemem-flamegraph.png)

할당 스택의 대부분은 `CompileBroker`에서 시작하는 C2 JIT 컴파일 작업이었고,
작업 뒤 전량 해제됐다. NIO 다이렉트 버퍼 live도 6.8KB 한 건뿐이었다. 상황
단계에서 적용한 `maxCachedBufferSize` 제한이 작동하고 있다는 확인이기도
했다.

여기서 질문이 바뀌었다.

```diff
- NMT 밖 1GB를 누가 계속 할당하고 있나?
+ 앱이 free한 메모리를 glibc는 왜 RSS로 계속 들고 있나?
```

남은 설명은 보관 하나였다. 애플리케이션은 `free`했지만 glibc가 그 메모리를
보관하면서 RSS로 남는다. 이 가설은 해결 단계에서 같은 부하에 할당자만 바꾼
A/B 테스트로 확인했다. glibc에서만 격차가 계속 자랐다.

## 문제

glibc는 `free`로 돌려받은 메모리를 다음 할당에 재사용하려고 일부러 갖고
있는다. 잘못된 동작이 아니므로 애플리케이션 코드에는 고칠 곳이 없다. 바꿀
수 있는 것은 할당자다. glibc를 유지하면서 설정을 조정하거나, 다른 할당자로
바꿔야 한다. glibc가 free된 메모리를 왜 OS에 돌려주지 않는지는
[딥다이브 4](#4-glibc가-free된-메모리를-보관하는-구조)에서 설명한다.

glibc 설정 중에서는 arena 수를 제한하는 `MALLOC_ARENA_MAX=2`가 많이
알려져 있다. 바로 적용하지 않고 재현했다. 크기가 다른 `malloc/free`를
스레드 24개로 반복하자 RSS가 30초 만에 137MB에서 1,441MB까지 올랐다.
여기에 `MALLOC_ARENA_MAX=2`를 적용하자 RSS가 오히려 44% 늘었다. arena가
2개로 줄면서 한 arena에 크기가 다른 할당이 몰렸고, 단편화가 더 심해졌기
때문이다.

부하가 다르면 같은 설정에서 반대 결과가 나온다. 그래서 어떤 방법이든 실제
부하로 측정한 뒤 결정하기로 했다.

## 해결

애플리케이션, 컨테이너 이미지, 메모리 limit, JVM 옵션, 부하를 모두 고정하고
할당자 설정만 바꿔 20분씩 측정했다. 비교한 구성은 셋이다.

```text
# glibc 기본
기본 이미지 그대로 실행

# glibc + arena 제한
MALLOC_ARENA_MAX=2

# jemalloc 전환
LD_PRELOAD=<path-to-libjemalloc.so.2>
MALLOC_CONF=background_thread:true
```

jemalloc의 `background_thread:true`는 내부 작업 스레드가 빈 페이지를
비동기로 OS에 반환하게 한다. 1차 실험에서는 이 설정이 없을 때 부하가 멈춘
뒤에도 반환이 진행되지 않았다. jemalloc이 glibc와 다르게 동작하는 구조는
[딥다이브 5](#5-jemalloc이-다른-점)에서 설명한다.

## 결과

같은 부하 20분 동안 glibc의 격차는 계속 늘었고, jemalloc의 격차는 일정
범위에 머물렀다.

![glibc의 RSS-NMT 격차는 275MB에서 486MB까지 증가하지만 jemalloc은 240~280MB에서 수렴하는 비교 그래프](@/assets/images/2026-august-week1-review/gap-glibc-vs-jemalloc.svg)

| 지표      |     glibc |         jemalloc |
| --------- | --------: | ---------------: |
| 격차 시작 |      48MB |         약 240MB |
| 격차 종료 |     486MB |         약 245MB |
| 최종 RSS  |   1,835MB |          1,591MB |
| 추세      | 계속 증가 | 일정 범위에 수렴 |

glibc의 peak RSS는 1,881MB로 2GiB limit의 92%까지 올라 운영 OOMKill
사이클을 재현했다. jemalloc은 기본 보관량이 약 245MB로 더 컸지만, 격차가
누적되지 않았다.

glibc를 유지하면서 arena 수만 제한한 구성도 실제 부하에서 다시 측정했다.

![glibc 기본 격차는 라운드마다 48MB에서 275MB까지 증가하지만 MALLOC_ARENA_MAX=2는 41~75MB에서 움직이는 그래프](@/assets/images/2026-august-week1-review/gap-trend-by-round.svg)

- glibc 기본: 격차 275MB, 부하를 반복할수록 계속 증가
- `MALLOC_ARENA_MAX=2`: 격차 69MB, trim 설정을 더하면 31MB

재현에서는 이 설정으로 RSS가 44% 늘었는데, 실제 부하에서는 격차가 75%
줄었다. 부하가 다르면 결과가 뒤집힌다.

![glibc 기본, MALLOC_ARENA_MAX=2, jemalloc 세 구성에서 부하 전후 격차를 비교한 막대그래프](@/assets/images/2026-august-week1-review/gap-before-after-by-config.svg)

두 방법의 장단점은 다음과 같다.

|                         | `MALLOC_ARENA_MAX=2`   | jemalloc 전환                     |
| ----------------------- | ---------------------- | --------------------------------- |
| 이번 실험의 메모리 결과 | 격차 31~69MB           | 약 245MB에서 수렴                 |
| 적용 난이도             | 환경변수 한 줄         | 이미지 변경과 `LD_PRELOAD` 필요   |
| 동시 할당 경합          | arena 공유로 증가 가능 | 다중 arena 설계로 상대적으로 유리 |
| 기본 보관 메모리        | 작음                   | tcache·dirty 페이지로 큼          |
| 운영 판단에 필요한 지표 | RSS와 응답 지연        | RSS와 반환 추세, 이미지 안정성    |

메모리 숫자만 보면 이 실험에서는 arena를 제한한 glibc가 더 작았다. 하지만
높은 동시성에서 arena 두 개를 여러 워커가 공유할 때의 할당 지연은 아직
확인하지 않았다. jemalloc의 장점은 낮은 격차가 아니라 계속 커지지 않는
상한이었다. 최종 선택은 운영급 트래픽에서 RSS뿐 아니라 처리량과 응답시간까지
함께 보고 결정해야 한다.

## 딥다이브

본문에서 쓴 도구와 원리를 나눠 설명한다. 장애 내용을 몰라도 읽을 수 있다.

### 1. RSS와 NMT는 다른 것을 본다

JVM 프로세스가 쓰는 메모리는 Java 힙 하나로 끝나지 않는다.

```text
프로세스 RSS
  ├─ Java Heap
  ├─ JVM native: GC, Metaspace, Code Cache, Thread Stack, Compiler ...
  ├─ Direct Buffer
  ├─ JNI·네이티브 라이브러리의 malloc
  ├─ 할당자가 보관 중인 free 페이지
  └─ 공유 라이브러리와 파일 매핑
```

NMT는 이 중 HotSpot 내부 할당을 추적한다. JNI나 서드파티 네이티브
라이브러리가 직접 호출한 `malloc`까지 모두 기록하는 도구는 아니다. 따라서
NMT committed가 낮다는 사실만으로 "네이티브 메모리는 정상"이라고 결론 내릴
수 없다.

RSS는 현재 RAM에 올라온 프로세스 페이지를 보는 OS 지표다. NMT committed는
JVM 관점의 커밋이다. 공유 페이지, 아직 상주하지 않은 커밋 영역, 할당자가
보관 중인 페이지 때문에 두 값의 기준이 다르다.

> [!warning] `RSS - NMT committed`는 사용량이 아니다
>
> 기준이 다른 두 값을 뺀 결과라서, 어떤 메모리 영역의 크기와도 일치하지
> 않는다. 이 격차가 같은 부하에서 계속 커지면 NMT 밖을 조사할 이유가 된다.
> 거기까지다. 격차를 바로 "누수"나 "단편화"라고 부르지 말고,
> `pmap`으로 본 주소와 NMT detail을 대조해서 원인을 찾아야 한다.

### 2. NMT 사용법

NMT는 실행 중에 새로 켤 수 없으므로 프로세스를 시작할 때 활성화해야 한다.
운영에서는 우선 `summary`, 호출 지점까지 필요한 재현 환경에서는 `detail`을
선택한다.

```text
-XX:NativeMemoryTracking=summary
-XX:NativeMemoryTracking=detail
```

Oracle 문서는 NMT 활성화 비용을 약 5~10%로 안내한다. 운영에서 `detail`을
상시 사용하기보다, 부하와 오버헤드를 확인한 뒤 필요한 기간에만 쓰는 편이
안전하다.

현재 상태를 한 번 보는 것보다 기준점을 잡고 증가분을 비교하는 방식이
유용하다.

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

### 3. pmap과 trim 읽는 법

`pmap -x <pid>`는 프로세스의 가상 메모리 매핑을 한 줄씩 보여준다. 매핑의
주소, 크기, 실제 상주 크기인 RSS, dirty 페이지를 함께 표시한다. 이 데이터의
원본은 Linux가 매핑마다 상세 값을 기록하는 `/proc/<pid>/smaps` 파일이고,
합계만 빠르게 볼 때는 `smaps_rollup`을 읽는다.

```bash
pmap -x 1
grep -E 'VmRSS|VmSize|RssAnon|RssFile' /proc/1/status
cat /proc/1/smaps_rollup
```

64MB 경계에 정렬된 익명 매핑이 여러 개 보이면 glibc arena를 의심할 수
있다. 다만 배치만 보고 원인을 확정하지 않고, 부하 전후 증가량과 NMT detail
주소를 함께 본다.

`jcmd <pid> System.trim_native_heap`은 C heap에서 반환 가능한 페이지를
OS에 돌려보내려 시도한다. 한 번 trim해서 크게 줄면 반환 가능한 보관 메모리가
있다는 뜻이다. 두 번째 실행에서 더 줄지 않으면 남은 영역은 live 할당이나
반환 불가능한 단편화로 좁힐 수 있다.

> [!warning] trim을 해결책으로 먼저 쓰지 않는다
>
> `System.trim_native_heap`은 반환 가능한 C heap이 있는지 확인하는 실험으로는
> 유용하다. 하지만 live 할당, 페이지 내부 단편화, 계속 반복되는 잘못된 할당을
> 해결하지 않는다. 지원 플랫폼과 JDK 버전을 확인하고 테스트 환경에서 영향부터
> 검증해야 한다.

### 4. glibc가 free된 메모리를 보관하는 구조

glibc의 `free`는 보통 메모리를 곧바로 OS에 돌려주지 않는다. 다음 할당에
재사용할 수 있도록 할당자 안에 보관한다. 멀티스레드 경합을 줄이기 위해
arena를 여러 개 만들면 같은 보관이 arena마다 반복된다.

![워커 스레드가 락이 걸리지 않은 arena를 골라 락을 잡고, 그 안의 free 조각에서 버퍼를 할당하는 glibc arena 도식](@/assets/images/jvm-native-memory-tracking/glibc-arena-allocation.svg)

스레드는 한 번 붙은 arena를 계속 재사용하고, 락 경합이 나면 다른 arena를
시도하거나 새로 만든다. arena가 스레드 수를 따라 늘어나는 이유다.

보관된 메모리가 반환되지 못하는 조건도 있다. 한 페이지에 live와 free 조각이
섞이거나, 반환 가능한 연속 영역 위를 작은 live 할당이 막으면 페이지 전체를
반환하지 못한다.

![힙 꼭대기의 작은 live 할당이 아래의 큰 free 공간 반환을 막는 Top Chunk Pinning 도식](@/assets/images/2026-august-week1-review/top-chunk-pinning.svg)

### 5. jemalloc이 다른 점

jemalloc은 할당 크기 등급별로 slab을 나눠 쓴다. 빈 페이지가 slab 어디에
있든 위치와 무관하게 OS에 반환할 수 있어, glibc처럼 live 할당이 반환을 막는
구조가 되기 어렵다. `background_thread:true`를 켜면 내부 작업 스레드가 이
반환을 비동기로 수행한다.

![glibc와 달리 jemalloc은 크기 등급별 slab의 빈 페이지를 위치와 무관하게 OS에 반환하는 도식](@/assets/images/2026-august-week1-review/jemalloc-slab-return.svg)

### 6. 다음에도 쓸 네이티브 메모리 진단 순서

비슷한 문제가 다시 생기면 아래 순서로 조사한다.

#### 1. 컨테이너와 JVM 지표를 같은 시점에 저장한다

- 컨테이너 working set과 limit
- 프로세스 `VmRSS`, `RssAnon`, `RssFile`
- Java heap committed/used
- NMT summary
- JMX Buffer Pool의 direct/mapped 사용량
- 스레드 수와 스택 크기

#### 2. NMT baseline을 먼저 잡는다

문제가 커진 뒤의 한 장보다, 정상 시점과 문제 시점의 `summary.diff`가 더 많은
정보를 준다. NMT 항목이 RSS 증가를 설명하면 해당 JVM 영역부터 판다.

#### 3. NMT가 설명하지 못하면 `pmap`으로 매핑을 확인한다

익명 매핑, 파일 매핑, 스레드 스택을 나누고 주소 범위를 NMT detail과
대조한다. 64MB 경계 매핑 같은 배치만 보고 바로 원인을 확정하지 않고, 부하
전후 증가량과 함께 본다.

#### 4. trim을 실행해 반환 가능한 메모리가 있는지 확인한다

한 번 trim해 크게 줄면 반환 가능한 보관 메모리가 있다는 뜻이다. 두 번째
실행에서 더 줄지 않으면 남은 영역은 live 할당이나 반환 불가능한 단편화로
좁힐 수 있다.

## 마무리하며

이번 조사로 두 가지를 얻었다.

1. JVM이 메모리를 어떻게 쓰는지 이해도가 높아졌다. 힙 밖에 JVM native
   영역, 다이렉트 버퍼, 할당자가 보관하는 페이지가 있고, RSS와 NMT가 각각
   무엇을 보는지 구분하게 됐다.
2. 메모리 진단 방법을 이해했다. NMT, pmap, trim, malloc/free 프로파일링을
   어떤 순서로 쓰는지 딥다이브 6의 진단 순서로 남겼다.

## 참고 자료

- [Oracle Java 26: Troubleshoot Memory Leaks](https://docs.oracle.com/en/java/javase/26/troubleshoot/troubleshooting-memory-leaks.html)
- [Oracle Java 24: `jcmd` 명령](https://docs.oracle.com/en/java/javase/24/docs/specs/man/jcmd.html)
- [Linux man-pages: `/proc/<pid>/smaps`](https://man7.org/linux/man-pages/man5/proc_pid_smaps.5.html)
- [GNU C Library: malloc tunable parameters](https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html)
- [jemalloc manual](https://jemalloc.net/jemalloc.3.html)
- [JDK-8325496: `TrimNativeHeapInterval` product switch](https://bugs.openjdk.org/browse/JDK-8325496)
- [관련 기록: 2026년 7월 3주차 회고](/posts/2026-july-week3-review)
- [관련 기록: 2026년 8월 1주차 회고](/posts/2026-august-week1-review)
