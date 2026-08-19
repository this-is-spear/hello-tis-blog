# jemalloc 성능 비교 재료 (추후 트레이드오프 분석글용)

8월 1주차 회고에서 제외한 성능 비교표 재료. 출처는 Jason Evans의 2006년 BSDCan 논문
["A Scalable Concurrent malloc(3) Implementation for FreeBSD"](https://people.freebsd.org/~jasone/jemalloc/bsdcan2006/jemalloc.pdf).

## jemalloc vs dlmalloc vs phkmalloc (논문 벤치마크)

- malloc-test 마이크로벤치마크: 스레드 수 증가에 따라 jemalloc은 성능이 향상·안정 유지
- Super-Smack DB 벤치마크: jemalloc은 클라이언트 수가 늘어도 편차가 작음 (최악 케이스 변동성 낮음)
- 싱글 스레드 정규화 평균 실행 시간: dlmalloc ≈ jemalloc이 짧음
- 정규화 평균 최대 상주 메모리: jemalloc이 가장 적음
- 단편화 시각화(가로: 이벤트 번호, 세로: 메모리 주소): jemalloc은 빨강/파랑(단편화) 영역이 적음

논문 속 그래프 이미지는 PDF 3장 이후에 있음. 인용 시 다시 캡처할 것.

## 함께 쓸 수 있는 실측 (8월 1주차 회고)

- 회고 본문의 glibc vs jemalloc 격차 비교(로컬 Docker 실측)와 `MALLOC_ARENA_MAX` 튜닝 결과
- glibc 튜닝의 락 경합 트레이드오프 (Arcesium이 jemalloc을 택한 이유, 동시성 4에선 미검증)

## 함께 쓸 수 있는 운영 실측 (8월 2주차 회고)

[2026년 8월 2주차 회고](/posts/2026-august-week2-review)의 `MALLOC_ARENA_MAX=4` 운영 검증 결과.

- 운영 적용 결과: 파드 시작 후 8일간 RSS 증가분 605MiB → 175MiB(-71%), 로컬 실측(-75%)과 거의 같은 폭
- 같은 기간 총 요청량·평균 동시 처리 요청 수·평균 응답 시간은 배포 앞뒤가 같았다 — arena 4에서 할당 지연은 나타나지 않았다. 다만 높은 동시성에서의 락 경합은 여전히 미검증
- 값 4의 근거: Hadoop이 2011년부터 `hadoop-env.sh` 기본값으로 쓰고, [Cassandra](https://issues.apache.org/jira/browse/CASSANDRA-6126)도 같은 값
- jemalloc은 폐기 — arena 축소만으로 효과 대부분이 나와서, 이미지에 라이브러리를 넣고 `LD_PRELOAD`를 거는 배포 변경 비용을 낼 이유가 없었다
- 미해결이었던 8일차 점프의 후속 관찰(08/19 기준): 08/11 시작 파드도 8일차에 한 번 뛴 뒤 다시 평평하다. 계속 오르던 arena 기본 파드와 달리 계단 뒤 유지되는 모양. 점프가 왜 8일차마다 생기는지는 아직 모른다

![MALLOC_ARENA_MAX=4 파드의 8일간 운영 RSS 추이 꺾은선 그래프. 시작 직후 약 1.95GiB까지 오른 뒤 7일간 거의 평평하고, 8일차에 한 번 뛰어 약 2.15GiB에서 유지된다](@/assets/images/2026-august-week2-review/rss-arena-max-8day-trend.svg)

## 도식: glibc arena 할당 경로

트레이드오프 분석글에서 락 경합을 설명할 때 쓸 도식. 스타일은 1주차 회고의
top-chunk-pinning, jemalloc-slab-return 도식과 같은 팔레트로 맞췄다.

![워커 스레드가 락이 걸리지 않은 arena를 골라 락을 잡고, 그 안의 free 조각에서 버퍼를 할당하는 glibc arena 도식](@/assets/images/jvm-native-memory-tracking/glibc-arena-allocation.svg)

- 순서: 요청 전달 → 락이 없는 arena를 골라 락 획득 → arena 안 free 조각 선택 → 버퍼 할당
- 스레드는 한 번 붙은 arena를 계속 재사용하고, 락 경합이 나면 다른 arena를 시도하거나 새로 만든다 — arena가 스레드 수를 따라 늘어나는 이유
- arena 수를 줄이면 여러 스레드가 같은 arena 락을 두고 경합한다 — `MALLOC_ARENA_MAX` 축소의 트레이드오프를 이 그림 하나로 설명할 수 있다
