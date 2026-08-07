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

## 함께 쓸 수 있는 이번 주 실측

- 회고 본문의 glibc vs jemalloc 격차 비교(로컬 Docker 실측)와 `MALLOC_ARENA_MAX` 튜닝 결과
- glibc 튜닝의 락 경합 트레이드오프 (Arcesium이 jemalloc을 택한 이유, 동시성 4에선 미검증)
